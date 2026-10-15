# Stork fork-readiness: architecture and maintainability

Scope: upstream `paperkite-hq/stork` at `1b1c0f2` (v0.7.0 plus docs, last upstream commit 2026-04-20), audited on branch `audit` on 2026-10-15.
Companion files:
- `architecture.md`: Mermaid diagrams of what actually exists
- `DEPENDENCIES.md`: dependency inventory
- `evidence/`: raw tool output and the probe scripts
- `jscpd/`: duplication report

Sync correctness, security and performance have their own audits (`audit/sync`, `audit/security`, `audit/perf`). Those areas appear here only as cross-references.

---

## 0. Summary

| Dimension | Score (1–5) | One-line verdict |
|---|:-:|---|
| Architecture clarity | **3.5** | Small, understandable monolith with clear layers. A few large god-units: `App.tsx`, `imap-sync.ts`, `connectors.ts` routes, `ConnectorsTab.tsx`. |
| Coupling and testability | **3** | Routes use DI through `getDb()` closures, which is good. There is one synchronous DB connection and one event loop for everything. Lifecycle and pool code is hard-wired and tested through module mocks or private pokes. |
| Code size and complexity | **3** | About 20.8k production LOC. 17 functions have cyclomatic complexity above 20. Duplication is low at 3.1%, but two parallel message-ingest paths exist. |
| Type safety and build hygiene | **2** | 49 backend `tsc` errors. CI never type-checks the backend, and there is no root `typescript` devDependency. |
| Test suite | **3.5** | 1,849 unit tests plus 44 Playwright tests, all green. Coverage is 90.9%/93.7% (backend stmts/lines) with branches at 80.02%, right on the threshold. The mock IMAP server is thin, and critical paths have no tests (malformed search, migration crash, IMAP write-back). |
| Documentation accuracy | **2** | The docs are extensive but often wrong on security-relevant points (cipher, constant-time compare, key zeroing), on the API surface, and on configuration knobs. |
| Self-hosting friction | **4** | No telemetry and no CDNs. A single native module, with a toolchain already present in the Docker builder. Cloudflare and SES are optional, and SES is broken. Images are amd64-only. |
| Dependency health | **2.5** | Lockfile frozen since April 2026: 7 production advisories, 6 of them high. nodemailer needs two major bumps, imapflow one. Every key mail library has a single maintainer. See DEPENDENCIES.md. |
| **Overall fork-readiness** | **3 / 5** | **A sound base for a personal fork.** Expect about 1–2 weeks of hygiene work (tsc, deps, docs, search escaping, migration safety) before feature work. The two-way IMAP sync that the Gmail/Namecheap "authoritative" goal requires is architectural work, not a tweak. |

The upstream ran for about a month (v0.1.0-alpha on 2026-03-19 to v0.7.0 on 2026-04-06). The clone is shallow (2 commits), so no contributor history is available. Commit trailers and the style suggest the code was largely AI-assisted. That explains the pattern: very high test counts, high line coverage, and docs that drift from the code.

---

## 1. The implementation as it actually is

The diagrams are in `architecture.md`. Key facts:

- **A single Node 22 process.** `src/index.ts` serves Hono via `@hono/node-server`. No worker threads, no child processes, no queue.
- **State machine** (`src/crypto/lifecycle.ts`): `setup | locked | unlocked`, held in a mutable `ContainerContext` object that is passed by reference into `createApp`. `transitionToUnlocked()` opens the DB, runs migrations, zeroes the key Buffer, and constructs and starts `SyncScheduler` and `R2Poller`. Unlocked is one-way until restart.
- **API** (`src/api/server.ts`): CORS `*` → CSP (only on HTML responses) → static files under `/assets/*` and `/stork.svg` → `/api` (always-open lifecycle routes, then the webhook, then the 423 lock middleware, then the demo read-only middleware, then the data routes) → SPA fallback `GET *`. **No authentication of any kind.**
- **Storage**:
  - `stork.db` plus an attached `stork-blobs.db`, both encrypted with **SQLite3MultipleCiphers' default ChaCha20-Poly1305**, not SQLCipher.
  - FTS5 is kept in sync by triggers.
  - Bodies, headers and blobs are compressed with zlib.
  - Attachments are content-addressed by SHA-256.
  - The raw RFC 5322 source is **not** stored.
- **Sync**:
  - `SyncScheduler` runs one `setInterval` per IMAP inbound connector, fixed at 5 minutes, with exponential backoff up to 30 minutes.
  - `ConnectionPool` creates a fresh `ImapSync` and IMAP connection on every acquire. Despite the name, it does not pool connections.
  - `ImapSync` (1,535 LOC) does LIST, then a per-folder UIDVALIDITY/UID incremental fetch in batches of 50, `simpleParser`, inserts, a server→local flag pass, connector-mode deletion, and label count refresh.
  - `R2Poller` polls a Cloudflare R2 bucket with a hand-rolled SigV4 signer.
  - Nothing is written back to IMAP except deletions in connector mode.
- **Connectors**:
  - The `IngestConnector` and `SendConnector` interfaces exist, but the sync engine **bypasses** `ImapIngestConnector`.
  - `CloudflareEmailIngestConnector` is dead code: the webhook writes directly.
  - SES is selectable in the UI but non-functional because the SDK is absent.
- **Search**: a regex extracts Gmail-style operators, and the remainder goes **unescaped** into FTS5 `MATCH`.
- **Demo mode**: unencrypted, seeded, read-only middleware, no scheduler. `/api/sync/status` therefore throws a 500 every 3 s per open tab and logs a stack trace each time (observed in the demo server log).
- **Frontend**:
  - React 19 with Tailwind 3. A 1,057-line `App` component owns all state.
  - The `api.ts` fetch wrapper handles 423 through a window event.
  - `useSyncPoller` polls every 3 s.
  - Drafts live in `localStorage`. The server drafts API is unused by the UI.
  - The mobile layout is a drawer plus a list/detail toggle.

## 2. Coupling, shared state, seams

### Global and shared state

| Item | Where | Impact |
|---|---|---|
| `ContainerContext` (mutable, by reference) | `lifecycle.ts:19`, `server.ts:22` | This is the only "DI container". Routes read `context.state` and `context.db` lazily through closures. It works, but nothing is typed as "unlocked context", so every route relies on the middleware having run. |
| Single `better-sqlite3` connection | `lifecycle.ts:105`, which passes it to the scheduler, pool, `ImapSync`, `R2Poller` and every route | HTTP handlers and sync share one synchronous handle on one thread. A long sync transaction, FTS query or migration stalls **all** HTTP traffic. Details are in the perf audit. |
| Module-level unlock rate-limit counters | `encryption.ts:18-19` | They are shared across every `createApp` instance, which leaks state between tests and future multi-instance setups. |
| `process.env` read at import time | `db.ts:10` `DATA_DIR`, `keys.ts:21` `FAST_KDF` | `STORK_FAST_KDF=1` changes the KDF cost for **new** key files. If someone sets it in production by mistake, the system silently uses Argon2 m=1 MiB/t=1. |
| `process.on('uncaughtException')`, which keeps the process alive | `index.ts:61` | It hides crashes. Under Kubernetes it is usually better to crash and let the pod restart. |
| `console.*` as the only observability | everywhere | There are no metrics, no structured logs and no request log. |

### What can be tested independently today

| Unit | Independent? | How |
|---|---|---|
| Route modules | Yes | `xxxRoutes(getDb, …)` together with `createTestDb()` (in-memory, all migrations) and `app.request()`. `messageRoutes` takes an injectable `imapDelete`. |
| `ImapSync` | Yes, against `MockImapServer` | It needs a TCP mock. There is no transport interface. |
| `SyncScheduler` | Partly | `poolOptions` is injectable, but `ConnectionPool` hard-codes `new ImapSync`, so tests reach in through `as unknown as InternalPool`. |
| `transitionToUnlocked` / `bootContainer` | Only with `vi.mock` | It hard-wires `openDatabase`, `SyncScheduler` and `R2Poller`. |
| `MessageSearch`, compression, html-to-text, keys | Yes | Pure functions or functions of a DB. |
| Frontend components | Yes, but 25 of the 43 frontend test files `vi.mock` the whole `api` module | There is no contract test between `frontend/src/api.ts` and the backend routes. Only the Playwright e2e covers that seam. |

### Seams for a worker-thread split

The natural cut is **"sync worker" versus "HTTP main"**:

1. `ImapSync`, `ConnectionPool`, `SyncScheduler`, `R2Poller` and `storeInboundEmail` touch only `db` plus the network. They can move to a `worker_threads` Worker that opens **its own** connection. WAL already allows one writer plus concurrent readers, and the 30 s `busy_timeout` already handles contention. The vault key would be passed to the worker once, through `postMessage` with a transferred `ArrayBuffer`, and zeroed on both sides.
2. The surface that routes call on the scheduler is small. `connectors.ts` and `sync.ts` use only `addConnector`, `removeConnector`, `getStatus`, `syncNow`, `cleanServerNow` and `relabelFromServerNow`. Wrapping these in a `SyncService` interface with an RPC-over-MessagePort implementation is roughly 1–2 dev-days. Progress callbacks become events.
3. The Argon2id KDF in `keys.ts` is CPU-bound and synchronous. Moving it to a worker, or replacing it with a native or WASM implementation, unblocks the event loop during unlock (about 4 s, 8 s for setup). The effort is small.
4. Read-heavy FTS queries could go to a reader-worker pool later. That is optional.

There is a blocker for **multi-process or horizontal** scale: SQLite on a single volume. That is fine for a personal deployment. Run **exactly one replica** (a Kubernetes `StatefulSet` or a `Deployment` with `replicas: 1` and `strategy: Recreate`) with an RWO PVC. Two pods on the same SQLite file over network storage would corrupt it.

## 3. Size and complexity

### LOC (cloc, code lines only; raw data in `evidence/cloc-by-file.csv`)

| Module | Prod LOC | Test LOC | Test:Prod |
|---|---:|---:|---:|
| src/api (server, 13 route files, validation) | 2,456 | 5,013 | 2.04 |
| src/sync (imap-sync, scheduler, pool, r2) | 1,922 | 4,356 | 2.27 |
| src/storage (db, schema, email-storage, compression) | 1,366 | 723 | 0.53 |
| src/demo (seed data) | 694 | 132 | 0.19 |
| src/connectors | 590 | 957 | 1.62 |
| src/crypto | 386 | 476 | 1.23 |
| src/search | 168 | 504 | 3.00 |
| src/index.ts | 64 | – | – |
| src/test-helpers | – | 975 | – |
| frontend/src root (App, api, hooks, utils, sanitizer) | 2,775 | 5,766 (`__tests__`) | 2.08 |
| frontend/src/components (incl. settings/) | 9,435 | 7,694 | 0.82 |
| tests/ (Playwright e2e, container e2e) | – | 867 | – |
| **Total** | **20,832** | **26,239** | **1.26** |

### Largest files (production)

`ConnectorsTab.tsx` 1,397 · `imap-sync.ts` 1,084 · `AccountSetupWizard.tsx` 976 · `App.tsx` 952 · `schema.ts` 834 (migration SQL) · `hooks.ts` 736 · `routes/connectors.ts` 706 · `seed.ts` 676 · `ComposeModal.tsx` 645 · `MessageList.tsx` 643 · `api.ts` 618.

### Cyclomatic complexity hotspots

These come from an ad-hoc TypeScript-compiler-API script (`evidence/complexity-script.cjs`; the top 60 are in `evidence/complexity-top60.md`). 1,333 functions were analysed: 51 have cyclomatic complexity above 10 and 17 above 20.

| Function | Location | Lines | CC |
|---|---|---:|---:|
| `App` | frontend/src/App.tsx:39 | 1,057 | **91** |
| `MessageListItem` | frontend/src/components/MessageList.tsx:149 | 210 | 44 |
| `POST /send` handler | src/api/routes/send.ts:33 | 177 | 39 |
| `fetchUidBatch` | src/sync/imap-sync.ts:741 | 176 | 39 |
| `Sidebar` | frontend/src/components/Sidebar.tsx:203 | 332 | 38 |
| `ThreadMessage` | frontend/src/components/ThreadMessage.tsx:38 | 176 | 38 |
| `MessageList` | frontend/src/components/MessageList.tsx:402 | 292 | 37 |
| `POST /connectors/inbound` | src/api/routes/connectors.ts:89 | 89 | 36 |
| `syncFolder` | src/sync/imap-sync.ts:457 | 271 | 36 |
| `storeInboundEmail` | src/storage/email-storage.ts:50 | 121 | 35 |
| `sanitizeEmailHtml` | frontend/src/email-sanitizer.ts:12 | 88 | 29 |
| `PUT /connectors/inbound/:id` | src/api/routes/connectors.ts:198 | 80 | 24 |
| `ComposeModal` | frontend/src/components/ComposeModal.tsx:84 | 549 | 23 |
| `MessageSearch.search` | src/search/search.ts:81 | 135 | 22 |

The longest functions are `App` (1,057), `connectorRoutes` (668, a route-registration closure), `ComposeModal` (549), `SearchPanel` (429), `InboundConnectorForm` (415) and `messageRoutes` (358).

**What to refactor first, ordered by risk-adjusted value:**
1. **`fetchUidBatch` and `storeInboundEmail`.** These are two separate implementations of "parse a MIME message and store it" (IMAP path versus webhook/R2 path). Merge them into one `ingestParsedMessage()`. Every bug fix currently has to land twice.
2. **`syncFolder`.** Split it into fetch-new, flags, and connector-mode delete phases. This is also where IDLE, CONDSTORE and write-back changes will land.
3. **`App.tsx`.** Extract navigation state into a reducer or context, and the data loading into hooks. That is a prerequisite for a PWA, because offline state and an SW-message handler would otherwise pile onto this component.
4. **`routes/connectors.ts`.** Split it into inbound, outbound and r2-test routes.

### Duplication (jscpd; report in `audit/arch/jscpd/`)

**61 clones, 742 duplicated lines (3.14%)** across 82 production files. That is low. The clones that matter:
- `connectors/imap.ts:207` ↔ `sync/imap-sync.ts:1496` (21 lines of error-suppression and socket helpers)
- `connectors/ses.ts:119` ↔ `connectors/smtp.ts:39` (nodemailer message mapping)
- `frontend/src/api.ts:277` ↔ `src/api/routes/drafts.ts:5` (hand-copied type shapes, since no shared types package exists)
- `SetupScreen` ↔ `Welcome` ↔ `UnlockScreen`, and `ConnectorsTab` ↔ `AccountSetupWizard` ↔ `OutboundConnectorSetupModal` (form fragments)

There is **no shared type package** between backend and frontend. `frontend/src/api.ts` redeclares every response shape by hand, and nothing checks them against the backend.

## 4. Incomplete features, dead code, type errors

### `tsc --noEmit` (backend): 49 errors (`evidence/tsc-noEmit.txt`)

The root has **no `typescript` devDependency**. The run used the global `tsc` 6.0.2. **CI (`ci.yml`) runs Biome, vitest and esbuild, but never `tsc`.** esbuild strips types without checking them, which is how 49 errors accumulated. The frontend `npm run build` does run `tsc -b`, so the frontend is clean.

| Category | Count | Files | Meaning |
|---|---:|---|---|
| Tests using **stale APIs** (`maxPerIdentity`, `identityId`, `email` on the connector helper, the `aborted` field) | 22 | connection-pool*.test, sync-scheduler.test, labels/messages.test, lifecycle.test | The tests compile only because vitest does not type-check. Some now test something other than their names claim. For example, `ConnectionPool({maxPerIdentity: 3})` silently falls back to the default `maxPerConnector: 1`, and `scheduler.addIdentity({identityId: 1, …})` registers connector `undefined`. |
| `null` passed where the type is `string \| undefined` | 8 | inbox.test.ts | Fixture typing only. |
| `ContainerContext` missing `r2Poller` | 6 | **src/index.ts:25 (demo mode, production code)**, demo-mode.test, encryption/webhook/lifecycle tests, e2e server | The demo context lacks `r2Poller`. It works at runtime because the value is `undefined` rather than `null`, but it shows the type was extended without updating callers. |
| `@aws-sdk/client-sesv2` not found | 5 | **src/connectors/ses.ts** (3), ses.test.ts (2) | See below. |
| `R2SignedHeaders` not assignable to `HeadersInit` | 4 | **src/sync/r2-poller.ts** (3), **src/api/routes/connectors.ts:368** | The interface lacks an index signature. This is harmless at runtime and takes a one-line fix. |
| Mock typing | 3 | messages.test, r2-poller.test | Test-only. |
| Unused `@ts-expect-error` | 1 | ses.test.ts | Test-only. |

There are 10 errors in production files. None is a runtime bug today, but the lack of a type gate is the real problem. **First fork task: add `typescript` as a devDependency, add `"typecheck": "tsc --noEmit"`, run it in CI, and fix the 49 errors (about 0.5–1 dev-day).**

### SES: reachable from the UI, but broken at runtime

- `ses.ts` uses `await import("@aws-sdk/client-sesv2")`. The package is in neither `dependencies` nor `peerDependencies`/`optionalDependencies`, so docs/architecture.md's claim that it is an "optional peer dependency" is false. It is absent from `node_modules` and from the Docker image, which runs `npm prune --omit=dev`, so users cannot add it without rebuilding the image.
- The UI offers "AWS SES" (`ConnectorsTab.tsx:594`), so a user can create an SES outbound connector:
  - **Test** calls `verify()`, which swallows the import error and returns `false`. The UI shows a generic "connection failed".
  - **Send** fails in `getClient()` with "@aws-sdk/client-sesv2 is required… npm install", which the API returns as a **500** (`send.ts:262`).
- The SES unit tests stub the module with a `vi.mock` factory, so the real SDK API has never been exercised.
- Recommendation for a Gmail/Namecheap fork: **delete SES** (ses.ts, registry case, schema columns via migration, UI option), or hide it behind a build flag.

### Dead or unwired code

| Item | Evidence |
|---|---|
| `CloudflareEmailIngestConnector` (in-memory buffer, `acknowledge()`) | Only `registry.ts` and the tests reference it. The webhook route calls `storeInboundEmail()` directly. |
| `cloudflare-email` ingest type | The backend accepts it (`connectors.ts:14`), but the frontend types offer only `imap \| cloudflare-r2` (`api.ts:302`, `AccountSetupWizard.tsx:24`). It can be set up only through the API. |
| `getR2Poller` parameter of `connectorRoutes` | It is never called (`connectors.ts:56`). R2 connectors created or updated at runtime are not polled until the next restart and unlock. **This is a functional bug.** |
| `POST /connectors/inbound/:id/re-label-from-server` | It is implemented and documented, but `frontend/src/api.ts` has no client for it. The README claims the transition wizard does "re-label from server". |
| Server drafts API (`/api/drafts`, `drafts` table) | The UI never calls it. Drafts go to `localStorage` (`compose-utils.ts:30`). |
| `ConnectionPool` "reuse" | `acquire()` always discards idle connections (`connection-pool.ts:55-60`). The idle-eviction timer and its tests exercise dead paths. |
| `ImapIngestConnector` as the sync transport | The sync engine never uses it. It is used only for "test connection" and the connector-mode single-message delete. |
| `@deprecated` aliases | `IdentitySyncConfig`, `addIdentity`, `removeIdentity`, `loadIdentitiesFromDb` (only tests use them), `rotateRecoveryKey` (`keys.ts:321`), `getVaultKey` (`keys.ts:368`, never imported), `AppFactory` type, `MessageSearch.rebuildIndex()` (never called). |
| `ContainerContext._vaultKeyInMemory` | It is never assigned anything but `null`. |
| Legacy `_account_id` columns | They remain on `inbound_connectors` and `outbound_connectors` after the v18/v19 rewrites. |
| `npm run db:migrate` (`src/storage/migrate.ts`) | **Dangerous.** It opens `./data/stork.db` **without a key**. On an encrypted install it fails. On a fresh data dir it creates a **plaintext** DB, after which first-run setup fails with `file is not a database`. Verified with `evidence/` probe logic; the `migrate-then-setup` scenario reproduced. By then `stork.keys` has already been written, which leaves a bricked data dir. CONTRIBUTING.md and docs/configuration.md both recommend running it. CONTRIBUTING.md also points to a `src/storage/migrations/` directory that does not exist. |

There are no `TODO`/`FIXME`/`XXX`/`HACK` markers in `src/` or `frontend/src`. There are no feature flags apart from the env vars `STORK_DEMO_MODE` and `STORK_FAST_KDF` (test-only, but read in production code). `STORK_DATA_DIR` and `STORK_PORT` are the only other configuration. **The sync interval is not configurable**, even though docs/faq.md says it is.

### Misleading documentation

| # | Claim | Doc ref | Reality | Code ref |
|---|---|---|---|---|
| 1 | DB encryption is "AES-256 in CBC mode with HMAC-SHA-512 (via SQLCipher) … SQLCipher v4 defaults". The README says "AES-256 via SQLCipher". | SECURITY.md:72; README.md:30,218,252; docs/encryption-design.md:61,74; docs/architecture.md:18 | The cipher is **ChaCha20-Poly1305 (sqleet)**, the SQLite3MultipleCiphers default. No `PRAGMA cipher` is set. Opening the file as SQLCipher v4 with the right key fails (`evidence/cipher-probe.mjs`). The cipher is still strong, but "use the sqlcipher CLI for recovery or export" will not work, and the docs misdescribe the security properties. | `src/storage/db.ts:33-37` |
| 2 | "Password-equality check: `crypto.timingSafeEqual` (constant-time)" | SECURITY.md:77 | `crypto.timingSafeEqual` is never used. The only comparison is a hand-rolled JS loop, with an early length-mismatch return, for the **webhook secret**. Passwords are never compared; the AES-GCM tag does the verification. | `src/api/routes/webhook.ts:107-114` |
| 3 | "The KEK … is zeroed with `crypto.randomFill`." On shutdown "the MDK Buffer is overwritten with random bytes". | SECURITY.md:106-107 | Buffers are zeroed with `buf.fill(0)`, and the MDK is zeroed **right after DB open**, not on shutdown. The key is also turned into a hex **JS string** for `PRAGMA key` and `ATTACH … KEY`. Strings are immutable and cannot be zeroed. The security audit covers this. | `keys.ts:105`, `lifecycle.ts:108`, `db.ts:15,36` |
| 4 | Attachments are stored in `attachments.db` | SECURITY.md:82 | The file is `stork-blobs.db`. | `db.ts:93` |
| 5 | When locked, "all API endpoints return 423 except `/api/health` and `/api/unlock`" | SECURITY.md:114 | `/api/status`, `/api/setup`, `/api/demo` and `/api/webhook/*` (which returns 503) are also exempt. The change-password and recovery-rotation routes sit before the lock middleware and guard themselves. | `server.ts:55-71` |
| 6 | Connector mode: "Only newly-synced UIDs are deleted — messages already in Stork before the flag was enabled are unaffected." | docs/architecture.md (IMAP Sync Engine) | That holds for the periodic sync path only. `POST /connectors/inbound/:id/clean-server`, used by the transition wizard, deletes **every** locally-synced message of the connector from **every** folder on the server. `DELETE /api/messages/:id` deletes on the server in connector mode and then deletes locally **even if the server delete failed**. For Gmail, deleting from a label folder is not deleting the message. See `audit/sync`. | `sync-scheduler.ts:211-247`; `messages.ts:195-205` |
| 7 | "Sets busy timeout to 5 seconds" | docs/architecture.md (SQLite Storage) | It is 30 s. | `db.ts:72` |
| 8 | "Attachments store binary data directly in SQLite BLOBs" / "per identity" labels | docs/architecture.md | Blobs live in a separate attached DB, content-addressed and compressed (v21/v23/v27). Labels have been global since v15. | `schema.ts`, `db.ts:12` |
| 9 | `GET /api/identities/:identityId/connector-health` exists | docs/architecture.md (Health checks) | No such route. | `evidence/routes-implemented.txt` |
| 10 | The Cloudflare connector "buffers messages in memory … `acknowledge()`" | docs/architecture.md | The class is dead. The webhook stores directly. | `webhook.ts:40-101` |
| 11 | "`@aws-sdk/client-sesv2` is an optional peer dependency" | docs/architecture.md | It is not declared anywhere and is not installable in the image. | `package.json` |
| 12 | "`useSyncPoller(identityId)` polls every 5 seconds" | docs/architecture.md | It polls every 3 s and takes no identity parameter. | `frontend/src/hooks.ts:76-86` |
| 13 | Retry uses "exponential backoff (1s, 2s, 3s)" | docs/architecture.md | It is linear: 1 s, then 2 s (3 attempts, 2 waits). | `imap-sync.ts:1503-1520` |
| 14 | "Shorten the sync interval … see Configuration for the knob"; the configuration table lists "Sync interval: 5 minutes". | docs/faq.md:65; docs/configuration.md:297 | There is no knob. `DEFAULT_INTERVAL_MS` is hard-coded, and `transitionToUnlocked` never passes `defaultIntervalMs`. The only env vars are `STORK_DATA_DIR`, `STORK_PORT`, `STORK_DEMO_MODE` and `STORK_FAST_KDF`. | `sync-scheduler.ts:63`, `lifecycle.ts:124` |
| 15 | API reference documents `GET /identities/:id/folders`, `POST /identities/:id/sync`, `GET /identities/:id/sync-status` | docs/api.md:276,885,933 | None of these exist (the routes moved to `/connectors/inbound/:id/*`). Meanwhile 19 implemented routes are undocumented, including `/messages/bulk`, `/inbox/all-messages`, `/labels/filter*`, `/trusted-senders*` and `/webhook/*`. | `evidence/routes-implemented.txt` |
| 16 | Search takes `identity_id` | docs/api.md:847-860 | The parameter is `inbound_connector_id`, and `identity_id` is silently ignored. The docs also omit that FTS syntax errors return 500. | `routes/search.ts:13` |
| 17 | "Compose & send … with sent-folder sync" | README.md:34 | A sent message is stored **locally only**, in a local "Sent" folder with a negative UID. No IMAP APPEND happens. Namecheap/Private Email will not show it in Sent on other clients; Gmail does, because Gmail SMTP auto-saves. | `send.ts:143-205` |
| 18 | "Desktop notifications — new mail alerts as messages arrive" | README.md:38 | Notifications appear only while a tab is open and unfocused, via `new Notification()`. That constructor **throws on Android Chrome**, where only `ServiceWorkerRegistration.showNotification` works. The icon `/favicon.svg` does not exist and is served as index.html. | `hooks.ts:873-886` |
| 19 | "DB encryption: SQLCipher AES-256 (default 256k KDF iterations)" in the benchmark setup | docs/performance.md (Test setup) | A raw key is supplied (no KDF) with ChaCha20. The "cold cache" methodology is questioned in `audit/perf`. | `db.ts:35` |
| 20 | `npm run db:migrate` is the way to "run migrations manually"; new migrations go "in `src/storage/migrations/`" | docs/configuration.md:149-153; CONTRIBUTING.md:159-165 | It creates or opens an **unencrypted** DB (see above), and the directory does not exist. Migrations are inline strings in `schema.ts`. They run at unlock, not at startup. | `src/storage/migrate.ts`, `schema.ts` |
| 21 | Health endpoint reports the version | docs/api.md:169 | It is hard-coded `"0.1.0"`, while the package is 0.7.0. | `encryption.ts:31` |
| 22 | Directory layout: tests in `tests/`, e2e in `e2e/` | docs/architecture.md (Directory Structure) | Unit tests sit next to the source (`src/**/*.test.ts`), and e2e is `tests/e2e/`. Several route files are missing from the list. | – |

## 5. Test suite quality

### Results (this sandbox)

| Suite | Result | Coverage (stmts / branches / funcs / lines) | Threshold |
|---|---|---|---|
| Backend `STORK_FAST_KDF=1 vitest run --coverage` | **717 passed, 5 skipped** (the Docker container e2e), 43 files, 50 s | **90.93 / 80.02 / 89.19 / 93.68** | 80 on every metric. **Branch coverage passes by 0.02 pp.** |
| Frontend `vitest run --coverage` | **1,132 passed**, 43 files | **91.29 / 85.53 / 86.05 / 92.28** | 80 on every metric |
| Playwright (`tests/e2e`, 2 projects) | **44 passed** (29 s) | – | – |
| `tests/e2e-container.test.ts` | **Not runnable here** (no Docker daemon); it skips itself | – | – |

**Playwright needed a workaround.** Playwright 1.59.1 expects chromium build 1217, but `/opt/pw-browsers` has 1194. I ran it from a scratch copy of the repo with a config override that sets `launchOptions.executablePath` (`audit/pwa-agent/scripts/playwright.audit.config.ts`) and a frontend build in that copy. Without the override, 27 browser tests fail with "Executable doesn't exist". The e2e tests require `frontend/dist`, because the server serves it from a path relative to the cwd.

Coverage exclusions inflate the backend number a little: `src/index.ts`, `src/storage/migrate.ts` and `connectors/index.ts` are excluded. The lowest-covered backend files are:
- `routes/connectors.ts`: 79.6% stmts, 72% funcs (below the per-file threshold, though thresholds are global)
- `imap-sync.ts`: 71.9% branches
- `connectors/imap.ts`: 62.7% branches
- `smtp.ts`: 50% branches

The lowest frontend file is `api.ts` at 67% stmts, consistent with the API layer being mocked in most UI tests.

### Sample of 15 tests

| Test | Real behaviour or mock? | Verdict |
|---|---|---|
| `imap-sync-integration.test.ts` "full syncAll fetches messages" | A real ImapFlow client against `MockImapServer` over TCP, plus a real SQLite DB | **Good.** End-to-end through the parser and DB. |
| …"archive mode only deletes newly synced messages" (L999) | Same harness | Good. It covers the sync path but **not** `clean-server`. |
| …"crash recovery: pending_archive…" (L1089) | Seeds `pending_archive=1` rows, then runs sync | Good. |
| `imap-sync-relabel.test.ts` (7 tests) | Mock server | Reasonable. |
| `routes/messages.test.ts` DELETE in connector mode | An injected `vi.fn()` replaces `imapDelete` | It asserts the call. **It never asserts the "server failed, deleted locally anyway" behaviour as a decision.** |
| `routes/search.test.ts` (5 tests) | Real FTS | Happy paths only. **No test covers malformed input.** |
| `search-operators.test.ts` (30) | Parser unit tests | Good for the operators. None cover characters that are special to FTS. |
| `connection-pool.test.ts` "enforces max total connection limit" | Constructs a pool with the nonexistent `maxPerIdentity` option, then asserts `totalConnections() === 0` | **Tautological.** It cannot fail. |
| `connection-pool-advanced.test.ts` eviction tests | Inject fake connections through `as unknown as InternalPool` | They test private internals of a code path (`evictIdle`) that production never exercises, because connections are never reused. |
| `sync-scheduler.test.ts` "addIdentity throws on duplicate" | Passes `{identityId: 1}` while the API expects `inboundConnectorId` | Passes by accident (the key is `undefined` twice). **The test is wrong.** |
| `lifecycle.test.ts` scheduler-callback tests | `vi.mock` of `openDatabase` and `SyncScheduler`; asserts on console output | Tests log formatting, not lifecycle. Low value. |
| `ses.test.ts` (12) | `vi.mock` factory of an **uninstalled** SDK | Tests the mock, not SES. |
| `crypto/keys.test.ts` (27) | Real crypto, fast KDF | Good. Round-trips, wrong passwords, rotation. |
| `storage/db.test.ts` `ensureSchema` | Runs migrations on fresh and partial DBs | Good for the happy path. **No test interrupts a migration.** |
| `routes/encryption.test.ts` (31) | Real keys and a real DB in temp dirs | Good. |
| `frontend/.../ComposeModal.test.tsx` | `vi.mock("../api")` | Good for UI behaviour. No contract with the backend. |

### How faithful is the mock IMAP server (`src/test-helpers/mock-imap-server.ts`, 719 LOC)?

Supported: plaintext TCP only, `LOGIN`/`AUTHENTICATE PLAIN`, `LIST`/`LSUB`, `SELECT`, `UID FETCH`/`FETCH`, `UID SEARCH` (UID ranges), `UID STORE ±FLAGS`, `EXPUNGE`, `CLOSE`, `NOOP`, `NAMESPACE`, `CAPABILITY` (`IMAP4rev1 AUTH=PLAIN NAMESPACE` only), and `IDLE`, which returns `+ idling` and never sends updates.

Missing, compared with **Gmail** and **Namecheap Private Email** (reportedly Open-Xchange/Dovecot-based; not verified here):
- TLS on 993 and STARTTLS.
- `SPECIAL-USE` and `XLIST` advertising.
- `UIDPLUS` (`UID EXPUNGE`), `MOVE`, `CONDSTORE`/`QRESYNC`, `ENABLE`, `ID`, `STATUS`, `ESEARCH`.
- Gmail's `X-GM-EXT-1` (`X-GM-LABELS`, `X-GM-MSGID`, `X-GM-THRID`).
- Modified-UTF-7 mailbox names and hierarchy delimiters other than `/`. Namecheap may use `.`.
- Unsolicited `EXISTS`/`EXPUNGE`/`FETCH` responses during a session.
- Server-side limits and throttling: Gmail allows about 15 concurrent connections and has bandwidth caps and `[THROTTLED]`/`[OVERQUOTA]` responses.
- Mid-session `BYE`, literal-heavy responses, very large messages.
- The same message appearing in several folders, as with Gmail's `[Gmail]/All Mail` plus labels. This is the critical omission for Gmail, because the whole label model depends on it.

**Verdict:** the mock is good enough for regression-testing the happy-path state machine. It is **not** evidence of correctness against Gmail or Namecheap. The `audit/sync` agent has a real Dovecot harness (`audit/harness/dovecot.sh`); keep something like it in CI for the fork.

### Critical paths without tests

1. **Malformed or realistic search input.** Verified with `evidence/search-probe.ts` through the real route on a test DB:

   | Input | Result |
   |---|---|
   | `"unbalanced`, `AND`, `foo AND`, `NEAR(`, `*`, `hello)`, `from:` | **500** (syntax error) |
   | `-x`, `a:b` | **500** (FTS column-filter error: "no such column") |
   | `john@example.com`, `Re: invoice`, `e-mail`, `follow-up`, `it's`, `C++`, `50%` | **500** |
   | `before:notadate` | Silently ignored |

   The response is a plain-text `Internal Server Error`, not JSON. **Searching for an email address or a hyphenated word fails. That affects every user and every agent.** The fix is to tokenize the free text and quote each term as an FTS5 string (`"term"`), with an opt-in for raw FTS syntax (S, 0.5 day). It also needs tests.
2. **Migration crash safety.** `ensureSchema()` runs all pending migrations and bumps `schema_version` **once at the end**. Most migrations are not wrapped in a transaction (only v14, v15, v18 and v19 use `BEGIN/COMMIT`) and are not idempotent (`ALTER TABLE ADD COLUMN`). `evidence/mig-probe.ts` simulates a process killed after later migrations applied but before the version bump. Re-running from v12, v16, v20, v24, v27 or v29 **always fails** with errors like `duplicate column name` or `no such table: accounts`. The result is a DB that cannot be unlocked without manual SQL surgery. The batched backfills in v23–v25 and v30 are the long-running ones on a large mailbox, which makes a kill during upgrade (an OOM kill or a Kubernetes rollout) plausible. The fix is to bump the version per migration inside its own transaction and to make hooks idempotent (S–M, 1 day).
3. **Connector-mode deletion scope.** `cleanServerNow` across folders, and the DELETE fall-through when the server delete fails. See `audit/sync`.
4. **The `db:migrate` script** creating a plaintext DB, as above.
5. **Unknown `/api/*` paths returning `200 text/html`** when `frontend/dist` exists. No test, because the unit tests run without `dist`.
6. **R2 connector add or update at runtime** not reaching the poller. Untested, and broken.
7. **Demo mode `/api/sync/status`** returns 500 because there is no scheduler. Untested.
8. **No contract tests** between `frontend/src/api.ts` and the routes, beyond the 44 e2e tests.
9. **No test against the production Docker image** in this environment. The container test needs Docker. CI builds the image but never runs it.

## 6. External services and self-hosting complications

| Item | Required? | Notes for a private Kubernetes deployment |
|---|---|---|
| **Telemetry or phone-home** | **None found** | The only `fetch(` calls in `src/` target the user-configured R2 bucket (`r2-poller.ts`, `connectors.ts:368`). The frontend has no analytics, no external fonts and no CDN. Its only external URL is the GitHub link in `DemoBanner.tsx`. CSP is `default-src 'self'`. |
| Cloudflare Email Workers webhook / R2 queue | Optional | Only for the `cloudflare-email` and `cloudflare-r2` ingest types. Not needed for Gmail/Namecheap IMAP. Removing both (`webhook.ts`, `r2-poller.ts`, `r2-sigv4.ts`, `cloudflare-email.ts`, schema columns) would cut about 900 production LOC and a public-ingress requirement. |
| AWS SES | Optional, **broken** | See §4. |
| fly.io demo (`fly.toml`, `deploy-demo.yml`, `docker-compose.demo.yml`) | Upstream-only | Delete in the fork. |
| GHCR images `ghcr.io/paperkite-hq/stork` | Upstream-only | Build your own image. `docker-publish.yml` sets no `platforms:`, so it publishes **linux/amd64 only**. Add `platforms: linux/amd64,linux/arm64` if you need arm64 (Raspberry Pi or Ampere nodes). |
| GitHub Pages coverage site and badge branch push (`ci.yml`) | Upstream-only | Remove. The workflow also has `contents: write` and force-pushes a `badges` branch. |
| Playwright browser download in CI | Dev-only | `npx playwright install --with-deps`. |
| **Native module** `better-sqlite3-multiple-ciphers` (SQLite 3.53.0 with SQLite3MultipleCiphers) | Required | `install` runs `prebuild-install \|\| node-gyp rebuild`, and prebuilds download from GitHub releases at install time. Here it used `…v12.9.0-node-v127-linux-x64`. The Dockerfile builder installs `python3 make g++`, so a missing prebuild (arm64, musl/Alpine, a new Node ABI) falls back to compiling from source, which is slow but works. Engines are `node 20–24`, so check before moving to Node 26. Air-gapped builds need either the toolchain or a mirrored prebuild. |
| `@noble/hashes` Argon2id (pure JS) | Required | About 3.9 s per unlock on this host, during which the event loop is blocked (§2). It needs no native code, which is good for portability. |
| Runtime network egress | IMAP/SMTP to providers only | Gmail: `imap.gmail.com:993` and `smtp.gmail.com:465/587` with an **app password**. Stork has **no OAuth2/XOAUTH2 support**, and Google Workspace admins may disable app passwords. Namecheap: `mail.privateemail.com:993/465`. |
| Health checks | `GET /api/health` | Returns 200 even when locked. Fine for a liveness probe. A readiness probe that tracks "unlocked" would need `/api/status`. |
| Persistence | `STORK_DATA_DIR` (`stork.keys`, `stork.db`, `-wal`, `-shm`, `stork-blobs.db`) | Use an RWO PVC with a single replica (see §2). Back up with the SQLite backup API or a stopped-pod snapshot; a `cp` while running is not consistent. Losing `stork.keys` means losing the data. |
| Unlock after every restart | By design | In Kubernetes, every pod restart (node drain, OOM, upgrade) stops sync until someone unlocks in the browser. Plan for this, for example with an alert on `/api/status != unlocked`. An optional, explicitly insecure "unlock from a mounted secret" mode would be a fork decision. |
| Static assets path | cwd-relative `./frontend/dist` | The container must start with `WORKDIR /app`, which the Dockerfile already sets. |

## 7. Recommended first steps for the fork (ordered)

1. **Hygiene, about 3–5 dev-days:**
   - Add `typescript` and a `typecheck` CI step, and fix the 49 errors.
   - `npm update` within ranges, which fixes hono, `@hono/node-server`, mailparser, imapflow and dompurify advisories.
   - Plan nodemailer 8→10 and imapflow 1→2 (DEPENDENCIES.md).
   - Delete or fix `db:migrate`.
   - Remove SES, the fly demo and GHCR coupling.
   - Pin the CI chromium.
2. **Correctness quick wins, about 2–3 dev-days:**
   - FTS query escaping, with tests.
   - Per-migration version bump in a transaction, with a crash test.
   - Unknown `/api/*` returns a JSON 404.
   - Wire `getR2Poller` (or delete R2).
   - Make the sync interval configurable.
   - Fix the health version.
3. **Docs pass, about 1–2 dev-days.** Rewrite SECURITY.md's crypto table to match the code (ChaCha20 or switch to `PRAGMA cipher='sqlcipher'` with a migration), and regenerate the API reference from the routes.
4. **Then the architectural items:**
   - Two-way IMAP sync (flags, moves, APPEND to Sent): see `audit/sync`.
   - Auth and an API-token model: see `audit/pwa-agent/FEASIBILITY.md` and `audit/security`.
   - Moving sync to a worker thread: see `audit/perf`.
