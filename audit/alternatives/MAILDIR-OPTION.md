# Alternatives to Stork's IMAP sync: Stork as a Maildir view, and three other options

Audit branch `audit`, 2026-10-15. Evidence for this report is the code with file:line citations, a throwaway prototype in `audit/alternatives/prototype/` (not imported by app code), and web sources where noted. Anything marked **[unverified]** is from memory or documentation that could not be checked offline.

## Verdict

**(B) is feasible: Stork as a UI/API/search layer over the user's mbsync Maildir, with mbsync as the only IMAP client.**

The prototype reuses `storeInboundEmail()` and `MessageSearch` unchanged. Against a real mbsync ↔ Dovecot pair it showed:

- flag write-back
- move write-back
- delete write-back
- server-side flag changes coming back down
- Gmail-style duplicate copies collapsed to one row per message

Two things decide whether B is worth it:

1. **Gmail semantics through mbsync are lossy.** mbsync has no Gmail COPY or X-GM-LABELS, so "add label" and "move into label" become APPEND plus expunge upstream. That creates duplicate copies in Gmail's All Mail. Archive, remove-label and flags are clean. Delete needs care (see Risks).
2. **Encryption at rest becomes theatre unless the disk is encrypted.** The Maildir is plaintext. SQLCipher would only protect a second copy of the same text.

Recommendation among A/B/C/D: see the end of this report.

## 1. How mail gets in today, and what a Maildir connector reuses

- **Shared ingest path:** `src/storage/email-storage.ts:50-170` `storeInboundEmail(db, connectorId, {raw base64,…})` is used by the webhook (`src/api/routes/webhook.ts:456`) and the R2 poller. It:
  - parses with mailparser (`:57`)
  - dedupes on `(inbound_connector_id, message_id)` (`:78-83`)
  - **hard-wires the folder to INBOX** (`findOrCreateInbox`, `:109`, `:173-191`)
  - synthesises `uid = MAX(uid)+1` (`:110`, `:194-201`)
  - stores `flags = ''` (`:90`)
  - attaches a connector label plus an Inbox label (`:154-163`)
  - bumps INBOX unread (`:165-167`)
- **Connector plumbing:**
  - The `IngestConnector` interface (`src/connectors/types.ts:9-26`) is IMAP-shaped (`fetchMessages(folder, sinceUid)`).
  - `cloudflare-r2` already bypasses it: `src/connectors/registry.ts:41-44` says it is "managed by R2Poller".
  - A `maildir` connector should follow the R2 pattern: a poller/watcher started in `src/crypto/lifecycle.ts:181-192` next to `R2Poller`, loaded from `inbound_connectors WHERE type='maildir'`.
  - Type allow-lists that would need the new type: `src/connectors/registry.ts:7`, `src/api/routes/connectors.ts:14`, `:93-160`, and `frontend/src/components/Welcome.tsx:12`, `settings/ConnectorsTab.tsx`, `settings/AccountSetupWizard.tsx`.
- **What a `messages` row needs** (schema v19+: `src/storage/schema.ts:820-846`):
  - `folder_id INTEGER NOT NULL`, `uid INTEGER NOT NULL`, `UNIQUE(folder_id, uid)` (`:845`)
  - `inbound_connector_id`
- **IMAP assumptions in the schema:**
  - `UNIQUE(folder_id, uid)`: schema.ts:845
  - `folders.uid_validity/uid_next`: :797-798
  - `sync_state.last_uid`, `UNIQUE(inbound_connector_id, folder_id)`: :886-892
  - `deleted_from_server` and `pending_archive`: :842-844, :281-289
  - `inbound_connectors.sync_delete_from_server`: :489
  - folder unique index `(inbound_connector_id, path)`: :816
  - global `labels UNIQUE(name)`: :462 (two accounts' "INBOX" share one label, same as today)
- **How labels are assigned:**
  - IMAP sync makes one label per folder **path** with `source='imap'` (`src/sync/imap-sync.ts:1017-1034`).
  - It applies the labels via `applyFolderLabelsToMessages()` (`:1042-1055`), which respects `label_overrides` (schema v28, `:1195-1208`).
  - Special-use detection is name-based: `resolveSpecialUse` (`imap-sync.ts:1419-1433`) already knows `[gmail]/all mail`.
  - The Sent lookup knows `'[Gmail]/Sent Mail'` and `'INBOX.Sent'` (`src/api/routes/send.ts:238`).
- **Mapping Maildir folders to labels works directly:**
  - mbsync `SubFolders Verbatim` gives `gmail/[Gmail]/All Mail/` → label `[Gmail]/All Mail`.
  - Maildir++ `.Sent`, `.Lists.dev` → `Sent`, `Lists/dev`. The root `cur/new` is INBOX.
  - Namecheap's `INBOX.Sent` arrives as `INBOX/Sent` or `.INBOX.Sent` depending on mbsync's `Patterns`/`Flatten` settings. A per-connector special-use map should be config, not name guessing.
  - Prototype: `scan()` in `prototype/maildir-view.ts`.
  - **Gmail:** one logical message has N files: INBOX, `[Gmail]/All Mail`, each label folder. Stork's model is one row per (folder, uid), so IMAP sync already duplicates these (see `audit/sync-edge/gmail-layout.test.ts:1-7`). The prototype collapses copies by **sha256 of file bytes** into one row. A side table `maildir_files` holds the N locations, and the row gets one `source='imap'` label per folder. Measured on 10k messages: 7,219 Gmail files became 5,000 rows.

## 2. Identity

| Candidate | Verdict |
| --- | --- |
| Filename "unique" part, before the first `,` or `:` (e.g. `1700000000.123_4.host` in `…,U=17:2,FS`) | **Primary key, together with the folder.** Stable across flag renames and new→cur. Changes on a move, because mbsync and the UI both write a new name in the target folder. |
| `,U=<n>` | mbsync's *near-side* UID. Do not use it as identity. It **must be stripped when moving** a file to another folder, otherwise mbsync sees a duplicate UID. Verified: after the prototype's move, mbsync rewrote the name to `…stork-mv,U=1:2,S`. |
| sha256(file) | **Secondary key.** Pairs a vanish in A with an appear in B as a *move*, keeping row id and user labels. Also collapses Gmail copies. Bytes are identical across Gmail label folders. A message edited upstream gets a new hash, which is correct because it is a new message. |
| Message-ID | Not unique: drafts, resent mail, broken senders. Hash plus location is safer. Note that `storeInboundEmail` itself silently drops a second message with the same Message-ID (`email-storage.ts:78-83`); the prototype had to work around that. |
| X-TUID | Only present on messages mbsync propagated in one direction (a transient header for finding appended mail) **[unverified detail]**. Not usable as a general key. |

## 3. Change detection

- **Filenames carry the flags** (`:2,DFPRST`). A full reconcile is a `readdir` of every `cur/` and `new/` plus a diff against the side table. No `stat()` or `read()` is needed except for new files.
- **Measured on 200,000 empty mbsync-named files in 20 folders:** full scan took **304–513 ms** (5 runs). No-op reconcile including the DB diff took 276 ms at 12k files; the 200k figure is estimated at about 5 s **[extrapolated]**.
- **Event-driven:** use `fs.watch(dir)` **non-recursively on each `cur/` and `new/`**, which is 2 inotify watches per folder. Measured: 40 watches, 1,000 renames gave 2,000 events, all delivered within 36 ms.
- **Finding:** `fs.watch(root, {recursive: true})` on Linux with Node 22 registers a watch **per file**. It crashed with `ENOSPC` at about 100k files (`max_user_watches = 130054`). Do not use it.
- **inotify can overflow and does not survive restarts.** Keep a periodic full reconcile, e.g. every 5 minutes and after each mbsync run. Debounce events 200–500 ms, because mbsync renames in bursts.
- **Signals:**
  - flag change = same (folder, unique part), different suffix
  - new→cur = same unique part, different subdirectory
  - move = vanish plus appear with the same sha256
  - upstream expunge = vanish with no match
  - new mail = appear with no match
- **Safety guard:** if the root or a whole folder disappears (unmounted volume, mbsync misconfig), refuse to reconcile. The prototype does this for the root (`scan()`).
- **Ingest cost:** about 80 messages/s through `storeInboundEmail`. 10k corpus messages (422 MB with attachments) took 125 s. That is a one-time cost.

## 4. Write-back (Stork action → file op → mbsync)

| Stork code path | Today | Under B |
| --- | --- | --- |
| `PATCH /messages/:id/flags`, `src/api/routes/messages.ts:134-153`; bulk flag `:277-298` | local `UPDATE messages SET flags` only | rename every copy `…:2,<letters>` (`S`=\Seen, `F`=\Flagged, `R`=\Answered, `D`=\Draft, `T`=\Deleted), moving new→cur. mbsync `Sync Flags` pushes it upstream. **Verified with Dovecot:** `:2,FS` arrived as `\Flagged \Seen`. |
| `POST /messages/:id/move`, `:155-171`; bulk move `:313-327` | local `UPDATE folder_id`; the file stays put upstream | rename into `<target>/cur/<unique>.<tag>:2,<flags>`, **with `,U=` stripped**. mbsync makes it **APPEND to target + \Deleted/EXPUNGE in source**. Verified: rt2 appeared in Archive with a **new server UID**. Consequences: new UID, possibly new INTERNALDATE **[unverified]**, and on **Gmail a new copy in All Mail** (see Risks). |
| `DELETE /messages/:id`, `:173-211`; bulk delete `:226-275` | local `DELETE`, optional IMAP delete via `imapDelete` (`:199-201`) | Namecheap: set `T` (or move to Trash). mbsync with `Expunge Both` expunges it upstream. Verified: rt3 was gone from the server. Gmail: see Risks. Then **remove the row only after the file is gone**. |
| Archive button = remove current label (`frontend/src/App.tsx:457-472`, `MessageList.tsx:386-389`) → `DELETE /messages/:id/labels/:labelId`, `messages.ts:387-399` (`label_overrides` for imap labels, `:18-22`) | local `message_labels` only | for a folder-backed label, unlink (or `T`-flag) **that folder's copy only**. On Gmail this is archive or remove-label, which is clean. Verified in the prototype: INBOX label gone, `[Gmail]/All Mail` remains. |
| `POST /messages/:id/labels`, `:355-385` | local | user labels (`source='user'`) stay local or become notmuch tags (§6). Folder labels would need a file *copy*, which on Gmail is a duplicate APPEND. Disable this for Gmail folder labels. |
| `POST /send`, `src/api/routes/send.ts:143-200` (`findOrCreateSentFolder` `:233-250`, inserts a local row with `'\\Seen'`) | local Sent row only | Gmail SMTP saves Sent automatically, so do **not** append (it would duplicate). Namecheap: write the RFC822 file into `.Sent/cur/…:2,S` and mbsync APPENDs it. Then let reconcile ingest it; do not insert the row directly. |
| Drafts, `src/api/routes/drafts.ts:57-130` | local `drafts` table | can stay local (simplest). Optional: mirror to a `Drafts` maildir with `D`. |
| Attachments, `src/api/routes/attachments.ts:9-44`; message body `messages.ts:51-65` | from SQLCipher blobs / compressed `html_body` | may read lazily from the file (§5). |
| IMAP sync deletes (`imap-sync.ts:433`, `:521-524`, `:1001`) and the `sync_delete_from_server`, `pending_archive` machinery | the dangerous paths from the earlier audit | **not used**: a maildir connector never instantiates `ImapSync`. Upstream safety moves to mbsync config (`Expunge`, `Remove None`, `Create Near`, `Sync`). |

Races: `rename()` is atomic. If mbsync or `notmuch new` renamed the file first you get `ENOENT`; rescan that folder and retry. notmuch's `synchronize_flags` already does the same renames alongside mbsync in the user's current setup, so the pattern is proven. Serialise Stork's write-back with the mbsync run, either with a lock file the mbsync wrapper honours or by triggering `mbsync <channel>` right after a write-back.

## 5. Raw source, lazy bodies, encryption

- The raw RFC822 is on disk, so Stork can store **headers + FTS text only** and serve "view source", attachments and HTML by parsing the file on demand. The prototype's `readRaw()` reads the original bytes. Removing `html_body`/blob duplication shrinks SQLCipher a lot, since blobs are most of a 16 GB mailbox (`schema.ts:1155-1162`). Cost: rewrite the read paths in `messages.ts:51-65`, `attachments.ts:9-80` and `compression.ts` to parse the file (mailparser, with a cache). This is optional for v1; duplicating is simpler.
- **Encryption:** the Maildir is plaintext on disk, as are notmuch's Xapian index and mbsync's state. SQLCipher would protect only a *second* copy, whose `text_body` and `html_text_body` are also plaintext elsewhere. **Stork's encryption-at-rest selling point is moot under B unless the volume is encrypted** (LUKS, or an encrypted k8s PV/StorageClass). Recommend volume encryption for every option. SQLCipher's remaining value under B is the lock/unlock UX gate for the web UI, not data protection.

## 6. Coexistence with notmuch

- Same Maildir, three writers: mbsync, `notmuch new` (with `synchronize_flags=true`, which renames S/F/R/D/T as tags change) and Stork. All of them use atomic renames and re-scan, so this works. Stork just observes notmuch's renames as flag changes; test 2 in the prototype simulates exactly this.
- **Tags vs labels:** notmuch tags live in Xapian, not in files, so mbsync never propagates them; neither does it propagate Stork user labels. A clean split:
  - folder-derived labels: from files
  - user labels: notmuch tags
  - Stork reads and writes them via `notmuch tag` or python3-notmuch2, so agents and the UI see one tag set
  - this is size M and optional
- **Measured, same 10k corpus in Maildir** (`prototype/bench-search.results.json`):

| query | Stork FTS5 hits / p50 | notmuch `count` hits / p50 |
| --- | --- | --- |
| `xylorarium` (rare) | 10 / 4.2 ms | 10 / 37 ms |
| `xylomedianta` (1%) | 100 / 19 ms | 100 / 30 ms |
| `xylocommona` (30%) | 2977 / **545 ms** (all hits with snippets) | 2977 / 32 ms |
| `"quantum harvest"` | 50 / 12 ms | 50 / 30 ms |
| `zqprefix*` | 200 / 38 ms | 200 / 32 ms |
| `from:needle.sender@…` | 200 / 27 ms | 200 / 33 ms |
| `subject:Invoice` | 306 / 25 ms | 306 / 31 ms |

  Hit counts agree exactly. notmuch numbers include about 20 ms of process spawn. Stork's figures are in-process with `limit=100000`; its 545 ms is snippet generation for 2,977 rows, and a UI page of 50 would be far cheaper.

  Index build: notmuch `new` took 222 s, and its Xapian DB was **450 MB** for a 422 MB corpus. Stork ingest took 125 s. A no-op `notmuch new` takes 44 ms. Both are fast enough; notmuch also gives agents thread/JSON output for free.
- **Pre-existing Stork bug found while doing this:** `label:X` combined with free text binds parameters in the wrong order. `src/search/search.ts:93` pushes the MATCH param before the label JOIN param (`:149-153`), which appears earlier in the SQL. `label:Lists/dev xylocommona` → `fts5: syntax error near "/"`. With `label:inbox foo` it would silently search the FTS index for "inbox" and filter labels on "foo". This happens with IMAP too, not just Maildir.

## 7. Prototype results

Files are in `audit/alternatives/prototype/`, about 600 lines including benches. The core (`maildir-view.ts`, `demo.ts`, `gen-maildir.ts`) is about 350 lines.

```bash
cd /home/user/paperkite-hq/stork
npx tsx audit/alternatives/prototype/gen-maildir.ts --n 1000            # /tmp/stork-audit-maildir (gmail verbatim + namecheap Maildir++)
npx tsx audit/alternatives/prototype/demo.ts                              # ingest + search + 7 round-trip checks
bash    audit/alternatives/prototype/mbsync-roundtrip.sh                  # needs apt-get install -y isync; Dovecot :14204
npx tsx audit/alternatives/prototype/gen-maildir.ts --n 10000 --dir /tmp/stork-audit-maildir-10k
npx tsx audit/alternatives/prototype/bench-search.ts                      # needs apt-get install -y notmuch; ~6 min
npx tsx audit/alternatives/prototype/bench-scan.ts --n 200000             # add --recursive to reproduce ENOSPC
bash    audit/alternatives/prototype/stalwart-smoke.sh                    # option D; see header for the binary
```

**demo.ts** passed all checks:
- 1,354 files became 1,000 rows (Gmail copies collapsed)
- rescan is idempotent
- FTS works
- flag write-back renames every copy, and that does not echo back as a change on rescan
- an external rename is detected as a flag change
- an external move is detected via hash, keeping row id and labels
- a UI move renames into `.Archive/cur` with `,U=` stripped, stable on rescan
- Gmail archive keeps the message and drops INBOX
- an upstream expunge of the last copy removes the row
- raw source is readable from disk

**mbsync-roundtrip.sh** used isync 1.4.4 against Dovecot 2.3.21:
- local `:2,FS` reached the server as `\Flagged \Seen`
- a local move became an Archive APPEND with a new UID plus an INBOX expunge
- local `T` was expunged upstream
- a server-side `-\Seen` came back down as a local rename `:2,F`
- mbsync 1.4 puts new mail in `new/` with a `:2,` suffix; `uniqOf()` handles that

**What broke or needed hacks:**
1. `storeInboundEmail` returns `{stored}`, not the row id. `last_insert_rowid()` is clobbered by its label inserts, which caused an FK failure. Hack: `MAX(id)`. Fix: return the id.
2. It hard-wires INBOX, the Inbox label, a synthetic uid and empty flags. Hack: post-UPDATE `folder_id`, `uid = -id` and flags, then relabel. Fix: a `storeRawMessage(db, cid, raw, {folderPath, flags})` variant.
3. `UNIQUE(folder_id, uid)` collided when the row's folder changed (synthetic uids are per-INBOX). Hack: `uid = -rowid`.
4. Message-ID dedupe silently drops distinct files. Hack: look up by Message-ID.
5. Base64 round-trip of raw bytes. This is an API wart, not a blocker.
6. The search bug in §6.
7. Recursive `fs.watch` ENOSPC.

## Required changes for B

| File | Change | Size |
| --- | --- | --- |
| `src/storage/schema.ts` | migration v31: `maildir_files(connector_id, folder, uniq, sub, name, sha256, message_id, PK(connector_id, folder, uniq))`, indexes on sha256 and message_id; `inbound_connectors` += `maildir_root`, `maildir_layout`, `maildir_special_use` (JSON); relax the meaning of `messages.uid` for maildir rows (keep NOT NULL, store `-id`) or make it nullable (table rebuild) | M |
| `src/storage/email-storage.ts` | split into `storeRawMessage(db, cid, raw: Buffer, {folderPath, flags}) → id`, used by webhook/R2 (INBOX) and maildir; return the id; make Message-ID dedupe optional | S |
| `src/sync/maildir-sync.ts` (new) | `scan`/`reconcile` (from the prototype), debounced per-dir watchers, periodic full reconcile, root/folder-vanish guard, per-connector mutex | M |
| `src/sync/maildir-writeback.ts` (new) | `writeFlags`, `writeMove`, `writeRemoveCopy`, `writeSent`; ENOENT rescan/retry; optional "run mbsync channel now" hook | M |
| `src/crypto/lifecycle.ts:181-196` | start a `MaildirWatcher` like `R2Poller`; stop it on lock | S |
| `src/connectors/registry.ts:7`, `src/api/routes/connectors.ts:14,93-208` | `maildir` type: validation, root path must exist and be readable | S |
| `src/api/routes/messages.ts:134-327,355-399` | branch on connector type: maildir → write-back modules (file first, DB after); block add-folder-label/move-into-label for Gmail | M |
| `src/api/routes/send.ts:143-200` | maildir: write the Sent file (Namecheap) or skip (Gmail); let reconcile insert | S |
| `src/api/routes/messages.ts:51-65`, `attachments.ts` | optional lazy body/attachment from file | M |
| `src/search/search.ts:84-160` | fix param ordering (also needed without B) | S |
| `src/sync/imap-sync.ts:1066-1124` | reuse `refreshLabelCounts()`; extract it to a shared module | S |
| `frontend/src/components/Welcome.tsx`, `settings/ConnectorsTab.tsx`, `AccountSetupWizard.tsx`, `api.ts` | "Local Maildir (mbsync)" connector form; hide IMAP mirror/connector-mode copy | S–M |
| tests | port the prototype checks to vitest; property tests for rename/move/vanish sequences; mbsync+Dovecot integration test using `audit/harness/dovecot.sh` | M |
| deploy | one pod or volume shared by mbsync (cron/systemd timer or a sidecar loop), notmuch and Stork; volume encryption | S |

**Effort for B:** about 3–5 focused weeks for one developer, roughly 2 weeks core, 1 week write-back and UI, 1–2 weeks Gmail semantics and testing on a throwaway Gmail account. Lazy bodies and notmuch-tag labels each add about a week.

## Risks under B

1. **Gmail through mbsync** has no X-GM-LABELS or COPY. Folder-label *add* or *move* is an APPEND, which gives a second copy in All Mail. **Delete:** removing only the INBOX copy is archive, not delete. A real delete must remove all copies (INBOX, labels and All Mail), relying on Gmail's IMAP setting "when a message is expunged from the last visible folder → move to Trash" **[unverified: test on a throwaway Gmail account first]**. mbsync then pulls the Trash copy as new mail.
2. **mbsync config is now the safety system.** `Expunge Both` plus a bug in Stork's T-flagging deletes mail upstream. Mitigations:
   - start with `Expunge Near` or `None` and `Remove None`
   - a dry-run period
   - Gmail Trash/IMAP settings as a backstop
3. **Volume loss or an unmounted path** would look like "everything deleted". The guard refuses reconcile on a missing root or folder, and the DB is a rebuildable cache, so recovery is a rescan. For mbsync itself, do not run `Expunge` against an empty near side **[known mbsync caveat]**.
4. **Concurrent writers** (mbsync, notmuch, Stork). Renames are atomic, but use ENOENT-retry plus serialised mbsync runs.
5. **Plaintext at rest** (§5).
6. **Polling latency** is mbsync's interval. mbsync has no IDLE **[known]**. Pair it with `goimapnotify` (IMAP IDLE → run mbsync) for push-like latency **[unverified on this box]**.
7. **Two models in one codebase** (IMAP rows vs maildir rows) until IMAP sync is deleted or disabled.

---

## (D) Stalwart + Bulwark: what was verified

**What Bulwark is (verified 2026-10-15, [github.com/bulwarkmail/webmail](https://github.com/bulwarkmail/webmail), [bulwarkmail.org](https://www.bulwarkmail.org/)):**
- A self-hosted **JMAP** webmail suite (mail, calendar, contacts, files), AGPL-3.0, built with Next.js 16, React 19 and TypeScript.
- Built and tested primarily against Stalwart. Full feature set requires Stalwart ≥ 0.16.
- PWA install and web push; about 1.3k stars and 2.6k commits.
- Threads, unified inbox, FTS, Sieve, S/MIME.
- Labels/keywords UI not mentioned. No native Android app.

**Stalwart (verified via GitHub releases):**
- Latest release **v0.16.26, 2026-10-11**, then 0.16.25 (10-05), 0.16.24 (09-27), 0.16.23 (09-21), 0.16.22 (09-13), i.e. roughly weekly.
- Still **0.x**. The 0.16 line changed configuration fundamentally: in the local smoke test, `-c` takes a JSON data-store bootstrap (`{"@type":"RocksDb","path":…}`), the rest lives in a DB-stored registry, TOML was rejected, and the old `/api/principal` admin REST returned 404.
- The docs site `stalw.art` was blocked by this sandbox's proxy, so doc claims below come from search-engine extracts **[partly unverified]**.

**Ingestion.** Stalwart is a server, not an IMAP client.
- No built-in continuous "fetch remote IMAP" was found. Search results describe **Vandelay** (a migration tool: IMAP → SQLite archive → JMAP, resumable, incremental), a migration proxy, and a CLI import of mbox/Maildir/JMAP. The forum recommends imapsync or mbsync. ([stalw.art/docs/migration](https://stalw.art/docs/migration/) **[via search extract]**)
- So continuous two-way sync means **mbsync IMAP↔IMAP** (Far = Gmail/Namecheap, Near = Stalwart). imapsync is one-way.
- **Smoke-tested here** with Stalwart v0.16.26 binary (sha256 `ed5095ff…2bd2211` for the gnu tarball), recovery admin, Dovecot `:14204`, mbsync 1.4.4:
  - initial copy of 499 messages in 3 folders took **1.4 s**; a no-op resync took 0.27–0.40 s
  - a flag set in Stalwart over IMAP reached Dovecot (flagged count 11 → 12)
  - Stalwart pre-creates `Deleted Items`/`Sent Items`/`Junk Mail`/`Drafts`, which sit *next to* the synced `Trash`/`Sent` with no role. Exclude them and map roles by hand.
  - **Danger reproduced:** when mbsync's SyncState was lost while both sides held mail, mbsync **duplicated everything in both directions**. Dovecot (standing in for Gmail) went INBOX 306 → 612. With Gmail as Far, that uploads your whole mailbox again. Mitigations: protect the state dir, use `Sync Pull Flags`-style limits so mbsync never pushes *new* messages upstream **[exact option combo unverified]**, and keep backups of state.
- **Gmail labels:** each label folder becomes separate IMAP APPENDs, so N separate Email objects in Stalwart (no `mailboxIds` merge) and duplicate search hits **[unverified whether Stalwart dedupes on append; not observed]**.
- **Not tested:** search (`Email/query` returned `serverUnavailable` and IMAP SEARCH returned `[CONTACTADMIN] Account ID must be specified` for the recovery-mode admin; creating a normal user needs the 0.16 registry API, which the blocked docs would have explained), Bulwark (not run), encryption, OAuth.

**Search:**
- built-in FTS on the data store (RocksDB/SQLite/Postgres/FoundationDB), or external **Elasticsearch** or **Meilisearch** (Meilisearch strings are present in the binary)
- no indication that FTS is enterprise-only ([stalw.art/docs/storage/fts](https://stalw.art/docs/storage/fts) **[via search extract]**)
- quality and speed not measured here

**Agent API:**
- JMAP (RFC 8620/8621): structured `Email/query` with filters, `Email/changes` and `/queryChanges` with state tokens (incremental, resumable), `Email/set` with `ifInState` (optimistic concurrency), blob download, push via EventSource/WebSocket (the session advertised `urn:ietf:params:jmap:websocket` with `supportsPush`, plus web-push VAPID).
- This is a far better agent contract than Stork's ad-hoc REST, and comparable to notmuch JSON in richness plus remote access.
- Credentials: app passwords (Bulwark lists them for 0.16), OAUTHBEARER/XOAUTH2 advertised on IMAP. Fine-grained scoped API keys and audit logging are **[unverified]**. The enterprise tier lists "telemetry and alerts".

**Android:**
- JMAP client Ltt.rs is a proof of concept (v0.4.4, 2025-04-13, per [F-Droid](https://f-droid.org/packages/rs.ltt.android/)).
- Realistically you would use IMAP clients (K-9/Thunderbird, FairEmail) against Stalwart, or the Bulwark PWA with web push.
- Note: under every option, Android can also simply talk to **Gmail/Namecheap directly**, because they are authoritative.

**notmuch:** it needs a Maildir. With Stalwart as the store you need either a **second mbsync channel** (upstream → Maildir, doubling upstream traffic and state) or a Stalwart → Maildir channel, or you move agents to JMAP and drop notmuch.

**Licence:**
- AGPL-3.0 or SEL (proprietary), dual-licensed. The vendor promises not to move OSS features to paid.
- Enterprise-only per search extracts: multi-tenancy, admin dashboards, AI spam/LLM features, archiving/**un-deletion**, live telemetry/alerts, masked email, read replicas/sharding ([stalw.art/enterprise](https://stalw.art/enterprise/), [docs/server/enterprise](https://stalw.art/docs/server/enterprise/) **[via search extract]**).
- None of those is needed for a personal deployment, though "un-deletion" would have been a nice safety net.

**Encryption at rest:**
- Per-account OpenPGP/S/MIME encryption of stored messages; the server keeps no private key.
- **Default off for IMAP/JMAP APPEND** (`encryptOnAppend` defaults to off), which is exactly how mbsync delivers ([stalw.art/docs/encryption](https://stalw.art/docs/encryption/) **[via search extract]**).
- Encrypted bodies presumably cannot be full-text indexed server-side **[inferred]**. Use volume encryption instead.

**Kubernetes:** a single static binary, about 100 MB, with RocksDB/SQLite on one PV or Postgres. Light footprint **[RSS not measured]**. Official Docker image exists.

## (C) mbsync → Maildir → Dovecot → webmail, notmuch for agents

From knowledge, not tested beyond the Dovecot harness already in the repo:
- Dovecot (2.3/2.4, very mature) serves the *same* Maildir mbsync writes (`mail_location = maildir:…`, layout matching mbsync's `SubFolders`). FTS via **fts-flatcurve** (Xapian, the default direction in 2.4) or fts-xapian **[versions unverified]**.
- Webmail: Roundcube (mature, PHP) or SnappyMail.
- Android: any IMAP client to Dovecot or directly upstream.
- notmuch unchanged for agents (CLI `--format=json`; a thin HTTP wrapper if needed).
- Effort: 1–3 days, mostly config.
- Risks:
  - Dovecot and mbsync both rename and copy in one Maildir. Dovecot moves can keep mbsync's `,U=` in names, which gives duplicate-UID warnings **[unverified; test]**.
  - Dovecot's own `dovecot-uidlist` is local only.
  - Gmail-via-mbsync semantics are the same as in B.
- What you lose: Stork's UI and its HTTP agent API (replaced by notmuch, or JMAP if Stalwart), and SQLCipher (moot anyway; use volume encryption).

## Comparison

| | (A) Fork Stork, fix IMAP sync | (B) Stork as view over mbsync Maildir | (C) mbsync + Dovecot + Roundcube/SnappyMail + notmuch | (D) Stalwart + Bulwark (+ mbsync IMAP↔IMAP) |
| --- | --- | --- | --- | --- |
| Who talks to Gmail/Namecheap | Stork (`imapflow`), which has to be rewritten safely: no-hard-delete, write-back, CONDSTORE/QRESYNC, X-GM-EXT-1, IDLE | mbsync only (proven; user already runs it) | mbsync only | mbsync IMAP↔IMAP. **State loss = mass duplication upstream** (reproduced) |
| Data-loss risk | High until proven: the current code hard-deletes (`imap-sync.ts:433,521-524,1001`) | Medium-low: DB is a rebuildable cache; risk sits in mbsync config and Gmail delete semantics | Low (most-trodden path) | Medium: IMAP↔IMAP and a fast-moving 0.x server |
| Gmail labels | Possible properly (X-GM-LABELS/MSGID); most work | Folder copies collapsed by hash; add/move-label duplicates upstream | Folder copies (dupes in UI) | Folder copies become separate Emails (dupes) |
| Search | FTS5 (bug at `search.ts:93/149`) | FTS5 plus notmuch, same Maildir (measured, both fine at 10k) | Dovecot flatcurve plus notmuch | Built-in or Elastic/Meili (not measured) |
| Web UI | Stork | Stork | Roundcube/SnappyMail (dated but solid) | Bulwark (modern, JMAP, PWA; young) |
| Android | IMAP clients upstream; Stork PWA | same | IMAP to Dovecot or upstream | IMAP/JMAP to Stalwart, Bulwark PWA with web push, or upstream |
| Agent API | Stork REST (ad hoc) | Stork REST + notmuch JSON | notmuch JSON (+ wrapper) | **JMAP** (state tokens, push), best contract; notmuch needs a 2nd channel |
| Encryption at rest | SQLCipher (real, since Stork holds the only local copy) | Moot: Maildir is plaintext, so use volume encryption | Volume encryption | Per-account PGP/SMIME, but not for APPENDed mail by default; volume encryption |
| k8s / ops | 1 pod | 1 pod + mbsync sidecar/cron, shared PV | 2–3 containers (Dovecot, webmail, mbsync) | 2 containers (Stalwart, Bulwark) + mbsync; weekly upgrades on a 0.x config model |
| Effort | **6–10+ weeks** plus long soak; highest risk | **3–5 weeks** | **1–3 days** | **2–5 days** setup + learning curve; unverified gaps |
| Personal maintenance | Highest (you own a sync engine) | Medium (you own a UI/index; mbsync owns sync) | Lowest | Low-medium (frequent upgrades, 0.x breaking changes) |

## Recommendation

1. **Now: C-lite.** Keep mbsync → Maildir → notmuch exactly as today, add a read/write web UI over the same Maildir (Dovecot + Roundcube/SnappyMail), and use upstream IMAP on Android. It gives the lowest maintenance with no new sync engine, and agents keep notmuch.
2. **If the Stork UI and its HTTP agent API are the point of the fork: do B, not A.** B gets 90% of the value without owning IMAP sync. The prototype shows the seams are small: one new connector type, a side table and redirected write paths. Restrict Gmail write-back to flags, archive, remove-label and delete-all-copies.
3. **D is the most attractive long-term shape** because of JMAP for agents and Bulwark for the UI. Don't make it the system of record yet: it is still 0.x with weekly releases and a just-changed config model, ingestion needs IMAP↔IMAP mbsync with a reproduced duplication failure mode, Gmail labels dupe, and notmuch would need a second channel. Pilot it read-only (`Sync Pull`) against a throwaway or secondary account.
4. **A: no.** It means rebuilding what mbsync already does well, under the strictest safety requirements.
