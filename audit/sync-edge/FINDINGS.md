# Sync edge cases — findings (audit/sync-edge)

Scope: Gmail semantics, hostile MIME, large attachments, network faults and retry, Namecheap-style layout. Core flag/move/UIDVALIDITY/expunge semantics live in `audit/sync/` and are not repeated here.

Every test drives the real `ImapSync` / `SyncScheduler` against a disposable Dovecot 2.3.21 on 127.0.0.1:14202. Faults come from `fault-proxy.ts` (a node `net` proxy) or from `vi.mock` (the poison-message test only). No real accounts were contacted.

Environment: 4 vCPU, 15 GiB RAM, no swap, Node v22.22.0, imapflow 1.3.2, mailparser 3.9.8, better-sqlite3-multiple-ciphers 12.9.0. The DB is SQLite in memory.

**Run:** `npx vitest run --config audit/vitest.config.ts audit/sync-edge`. Tests assert current behaviour, so a pass means the finding holds.

**Results:**
- The authoring run passed 6 files / 48 tests in ~208 s.
- An independent re-run during heavy concurrent load (load average ~3 on 4 cores) had one failure: D8, the timing-sensitive scheduler test.
- D8 then passed 3/3 when run in isolation (`-t D8`).
- Treat D8 as load-sensitive. Its finding was reproduced.

## Summary table

| # | Finding | Verdict | Severity |
|---|---|---|---|
| A1 | No X-GM-EXT-1. Each Gmail label folder gets its own row and FTS entry; search, all-messages and counts return N copies | CONFIRMED | High (Gmail) |
| A2 | Labels derived from folder path, one per row; copies are never merged | CONFIRMED | Medium |
| A3 | Label removal and archive work correctly through expunge detection | CONFIRMED (works) | — |
| A4 | No way to exclude folders from sync (Spam, Trash, All Mail all synced) | CONFIRMED | Medium |
| A5 | `relabelFromServer` joins `folders.name` (leaf) against `labels.name` (full path), so stale labels are never removed for nested, `[Gmail]/…` or `INBOX.*` folders | CONFIRMED | Medium |
| B1 | MIME nesting of 21+ levels: imapflow silently drops the FETCH; message lost forever with no error | CONFIRMED | High |
| B2 | Zero-byte message: error marked "retriable" but `last_uid` advances past it, so it is never retried | CONFIRMED | Medium |
| B3 | Poison message (any parse or DB exception): `last_uid` advances past it; lost forever; error auto-resolves next cycle | CONFIRMED | High |
| B4 | Header block over 1 MB: row stored with NULL body and NULL raw_headers, no error | CONFIRMED | Medium |
| B5 | Raw source not kept: S/MIME and PGP can't be re-verified; unparseable MIME bodies can't be recovered | CONFIRMED | Medium |
| B6 | Other hostile inputs stored without crashing | CONFIRMED (handled) | Low |
| C1 | 100 MB attachment peaks at ~1.1 GB RSS; 25 MB (two copies) at ~470 MB; `fly.toml` allows 256 MB | CONFIRMED | High |
| C2 | Downloads byte-exact; blob dedup works | CONFIRMED (works) | — |
| D1 | Dropped connection not re-established within a cycle; ~3 s of retries per remaining folder | CONFIRMED | Medium |
| D2 | A stall hangs a sync for up to 300 s (not configurable); a slow drip hangs it indefinitely | CONFIRMED | High |
| D3 | `[THROTTLED]` and other response codes dropped from error text; no throttle-aware backoff | CONFIRMED | Medium |
| D4 | Backoff never resets after a success | CONFIRMED | Medium |
| D5/D8 | Connection loss mid-sync reported to the scheduler as success | CONFIRMED (load-sensitive test) | Medium |
| D6 | Wrong password: 3 LOGINs and 3 TCP connections per cycle, ~6 per hour at the 30-min cap; no lockout risk | CONFIRMED | Low |
| D7 | No duplicates or loss after a mid-batch drop and resume | CONFIRMED (works) | — |
| E1 | "." separator, `INBOX.` prefix, no SPECIAL-USE: sync works; imapflow infers special-use from leaf names | CONFIRMED (works) | Low |
| E2 | Labels are dotted paths; the sidebar splits on "/", so there are no icons or nesting | CONFIRMED | Low |
| A-opt | hoodiecrow-imap cross-check | NOT TESTED | — |

## A. Gmail semantics (`gmail-layout.test.ts`, 11 tests)

**Setup.** Dovecot was configured with Gmail's special-use layout:
- All Mail (`\All`), Sent Mail, Starred (`\Flagged`), Important, Spam (`\Junk`), Trash and Drafts.
- Labels Work, Work/Clients and Receipts.
- Message M1 (same Message-ID) is in INBOX, All Mail, Work/Clients and Receipts.

**A1 — No X-GM-EXT-1 support (High).**
- grep finds only:
  - the `[gmail]/all mail` fallback at `imap-sync.ts:1429`
  - `'[Gmail]/Sent Mail'` in `send.ts:238`
  - comments
- Nothing requests X-GM-MSGID, X-GM-LABELS or X-GM-THRID.
- Measured for M1:
  - 4 `messages` rows and 4 FTS rows; the body is stored 4×.
  - `MessageSearch.search("zebracorn")` returns 5 hits: the 4 copies plus a Spam message.
  - `/api/inbox/all-messages` lists M1 4×.
- A real Gmail account will have at least 2× the rows, FTS size, counts and download bandwidth, because every message is in All Mail plus at least one label.
- Attachment blobs are SHA-256-deduplicated, so they are not multiplied.

**A2 — Labels.**
- Each folder path becomes one label (`imap-sync.ts:1031`).
- Each row carries only its own folder's label plus the connector label (`:1042-1055`). Rows are never merged by Message-ID.
- `[Gmail]/Important` gets `special_use` NULL.
- `[Gmail]` is `\Noselect` and is skipped (`:400`).

**A3 — Works.**
- Expunging M1 from Receipts deletes only that copy's row (`:994-1009`).
- Archive (expunge from INBOX) deletes the INBOX row. The All Mail and Work/Clients rows survive, and the unified inbox becomes empty.

**A4 — No folder exclusion.**
- Neither `folders` nor `inbound_connectors` has a column for choosing which folders sync.
- `syncFolders` syncs every selectable folder (`:380-421`).
- On Gmail that means All Mail, Spam and Trash are all downloaded and indexed.

**A5 — Relabel join bug.**
- The join is `JOIN folders f ON f.name = l.name` (`:1349`, `:1358`), but labels are named by full path.
- A move from Work/Clients to Receipts is detected, but the stale Work/Clients label remains.
- A flat Receipts → INBOX move works as a control.

**A-opt — NOT TESTED.** hoodiecrow-imap 3.0.0–3.3.1 were all published 6–7 Oct 2026, less than two weeks before this audit. The only older release is 2.1.0 (2016). Skipped; the grep already answers the X-GM question.

## B. Hostile MIME (`hostile-mime.test.ts` 17 tests, `poison-message.test.ts` 2 tests, `mime-fixtures.ts`)

**Setup.** 28 fixtures are delivered into the Maildir one at a time, so their UIDs are known and ascending. A sentinel message goes last. One sync takes ~2.1 s.

**B1 — Deep nesting (High).**
- 20 levels: stored, with the leaf text.
- 21, 200 and 2000 levels:
  - no row and no `sync_errors` entry
  - `last_uid` jumps to the sentinel
  - never retried
- Cause:
  - `bodyStructure: true` is requested (`imap-sync.ts:778`) but never used.
  - imapflow's `token-parser.js:19` has `MAX_NODE_DEPTH = 25`. It throws and drops the untagged FETCH.
- Dovecot's raw response is valid, and mailparser alone parses 200 levels fine. Without `bodyStructure`, every depth is fetched.
- Anyone can send such a message, and it becomes invisible in Stork.

**B2 — Zero-byte message.**
- The error `"UID n: no source available"` is recorded with `retriable: true` (`:790-798`).
- Later UIDs still raise `maxUid` (`:871`, `:903`), so the message is never retried.
- `resolveStaleErrors` (`:278`) clears the error on the next cycle.

**B3 — Poison message (High).**
- An injected `simpleParser` throw is recorded as `retriable: false` (`:884-891`).
- `last_uid` becomes 3, past UID 2.
- After the fault is removed, UID 2 is still never fetched and no errors remain unresolved.

**B4 — Header block over 1 MB.**
- mailsplit's `MAX_HEAD_SIZE` throws EMAXLEN, but `simpleParser` resolves with an empty result instead of rejecting.
- The row keeps the ENVELOPE subject (unbounded, and FTS-indexed), but `text_body` and `raw_headers` are NULL. No error.

**B5 — No raw source.**
- No source column exists; only a re-serialised `raw_headers` is kept (`formatHeaders`, `:1447`).
- The openssl S/MIME fixture verifies as delivered, but a reconstruction from the stored data fails verification.
- PGP: `signature.asc` is stored, but the exact signed bytes are lost.
- Broken-boundary and invalid-charset messages have NULL bodies and can't be re-parsed.

**B6 — Stored without crashing:**

| Input | Outcome |
|---|---|
| No Message-ID | NULL `message_id` |
| Duplicate Message-ID with distinct content | Both stored and searchable |
| 8-bit latin1 headers | Decoded with U+FFFD |
| RFC2047 garbage | Best-effort decode |
| Header-only message | NULL body |
| Missing Date/From | NULL; no INTERNALDATE fallback |
| 10k recipients | All kept |
| `../../etc/passwd` filename | Stored verbatim; download header becomes `.._.._etc_passwd` (`attachments.ts:27`). Blobs live in SQLite, never on disk |
| NUL in filename | Mangled to U+0080; header becomes `evil_.txt.exe` |
| TNEF | Kept as an opaque `application/ms-tnef` part |
| Calendar invite | `text/calendar` stored as an unnamed attachment |
| NUL bytes or bad base64 in body | Stored as garbage |

## C. Large attachments (`large-attachments.test.ts`, `large-attach-child.ts`)

The sync runs in a child process. RSS is sampled every 20 ms. Payloads are random bytes.

| Case | Sync time | Baseline RSS | Peak RSS | Kernel maxRSS |
|---|---|---|---|---|
| 25 MB × 2 (same bytes) | 7.3 s | 103 MB | 439 MB | 470 MB |
| 100 MB | 20.5 s | 99 MB | 970 MB | 1103 MB |

About 100 MB of the 100 MB case's figures is the in-memory test DB.

**C1 (High).**
- The whole message is buffered at every stage: source → mailparser → `att.content` → `deflateSync` → SQLite.
- `fly.toml` allows only 256 MB.
- Inferred, not tested: an OOM kill would re-fetch the same batch on restart, because `last_uid` is written after the batch (`:903`). That makes a crash loop likely.

**C2 (works).**
- Downloads match by sha256, byte for byte.
- Two messages carrying the same attachment produce 2 `attachments` rows and 1 `attachment_blobs` row.

## D. Network (`network-faults.test.ts` 10 tests, `fault-proxy.ts`)

**Setup.** INBOX holds 30 messages of ~5 KB each; a second folder, Other, holds 5.

**D1 — Drop mid-FETCH.**
- `syncAll` resolves and reports 6 errors.
- The connection is never re-established within the cycle.
- Each remaining folder fails to acquire its lock 3× (`withRetry`, `:1503`). The cycle takes 15.1 s.

**D7 — Resume works.** The next cycle stores all 35 messages with no duplicates (`INSERT OR IGNORE` + `UNIQUE(folder_id, uid)`).

**D2 — Stalls (High).**
- Stork sets no `socketTimeout`, and `ImapConfig` has no field for one.
- With the defaults, a stall was still pending at 15 s; imapflow's default timeout is 300 s.
- An abort unblocks it in 2 ms, but the scheduler only aborts on `stop()`.
- With `socketTimeout: 2000` injected, the cycle fails, after 17 s.
- A drip of 1 byte every 500 ms was still pending at 12 s, even with the 2 s timeout.

**D3 — `NO [THROTTLED]`.**
- Errors are retriable and nothing is lost.
- But the `[THROTTLED]` code is dropped: `formatImapError` (`:1528`) reads only `responseText`.
- There is no throttle backoff: 2 FETCHes and 18 commands were sent within 64 ms.
- imapflow's own throttle handling only recognises Microsoft 365's message.

**BYE / LIMIT.**
- `* BYE` behaves like D1.
- `NO [LIMIT]` on SELECT is retried 3× over 3.1 s, then that folder is skipped and the others still sync.

**D4 — Backoff never resets (Medium).**
- `sync-scheduler.ts:400` resets `consecutiveErrors`, but the interval timer at `:424` is never restored.
- Measured after recovery: syncs every 3941 and 3995 ms instead of 2000 ms.
- In production this can mean polling every 30 min until the next restart.

**D5/D8 — Partial failure reported as success.**
- Observed: `onSyncComplete` called once, `onSyncError` 0×, `totalErrors` 6, `lastError` null.
- Only connect or LIST failures reach the scheduler's backoff.
- The test is timing-sensitive under heavy CPU load; see the note at the top.

**D6 — Wrong password (Low).**
- 3 AUTHENTICATE attempts on 3 TCP connections per cycle (16.6 s).
- Steady state is ~6 attempts per hour.
- The `[AUTHENTICATIONFAILED]` response code is lost.
- Stork polls; it has no IDLE.

## E. Namecheap-style layout (`namecheap-layout.test.ts`, 6 tests)

**Setup.** "." separator, `INBOX.` prefix, no special_use flags, and SPECIAL-USE removed from CAPABILITY.

**E1 (works).**
- All 9 folders sync, with delimiter ".".
- Special-use is inferred for Sent, Drafts, Trash, Spam (as `\Junk`) and Archive. This comes from imapflow's leaf-name table.
- Stork's own `resolveSpecialUse` (`imap-sync.ts:1419-1432`) compares full paths and would miss these.
- `INBOX.Sent Items` gets NULL, because imapflow picks one winner for each special-use.
- The unified inbox works.

**E2 (Low).**
- Labels are dotted paths, but `Sidebar.tsx:30` splits on "/", so there are no icons or nesting.
- Every non-INBOX folder has `name != path`, so A5 applies to all of them.
- A "/" inside a folder name under the "." separator was rejected by Maildir, so it is NOT TESTED.

## Files

- Helpers: `helpers.ts`, `fault-proxy.ts`, `mime-fixtures.ts`
- The 6 test files, plus `large-attach-child.ts`
- `*.observed.json` — raw numbers
