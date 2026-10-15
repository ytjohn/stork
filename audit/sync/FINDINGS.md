# Sync audit — IMAP ↔ local (audit/sync)

## Method

Evidence comes from the real `ImapSync` engine and the real API routes, run against a real Dovecot 2.3.21 on 127.0.0.1:14201. The repo's mock IMAP server was not used. "Another client" is a separate imapflow session.

Faults were injected only on the test side:
- Temporary SQLite `RAISE(ABORT)` triggers in the test DB.
- A fault proxy (`helpers.ts:startFaultProxy`) that rewrites one `UID FETCH BODY.PEEK[]` to fetch only its first UID, then answers NO or OK. It also logs every client command.
- `chmod 000` on a maildir file.
- `doveadm mailbox update --uid-validity`, and deleting/recreating a folder.
- Dovecot restarted without UIDPLUS.
- Wrapping methods on the `ImapSync` instance, used only to time actions by the other client.
- SIGKILL of `kill-child.ts` while it syncs a file DB opened with `openDatabase()`.

Each test asserts the current behaviour, so a passing test means the finding holds.

**Run:** `npx vitest run --config audit/vitest.config.ts audit/sync/` — keep the trailing slash, or the filter also picks up `audit/sync-edge/`.

**Severity scale:**
- **Critical:** silent permanent loss in a normal workflow.
- **High:** loss under a plausible fault or race, or loss of metadata.
- **Medium:** wrong state, or metadata only.
- **Low:** cosmetic.

## 1. Connector mode deletes the requested batch, not what was stored — CONFIRMED, Critical

**Code:**
- `imap-sync.ts:582-661`: Phase 1b calls `deleteFromServer(folderPath, batchUids)`.
- `:616-624`: a fetch error is recorded, then the delete still runs.
- `:884-892`: per-message failure handling.
- `:756` and `:883`: `INSERT OR IGNORE` counts as "saved" even when it inserts nothing.
- `:1232-1270`: `deleteFromServer`.

**Observed (`connector-mode.test.ts` unless noted):**

| Scenario | Server deleted | Stored locally | Result |
|---|---|---|---|
| Insert throws for 1 of 3 messages | 3 | 2 | The failed message exists nowhere |
| FETCH returns partial data, then NO | 3 | 1 | Error E002 recorded; 2 messages lost |
| FETCH silently skips messages, tagged OK | 3 | 1 | 0 errors recorded; 2 messages lost |
| New server UID collides with a row moved locally | 1 | 0 | Reported as newMessages=1, then deleted from server; never stored |
| Second attachment insert throws (`fetch-failures.test.ts`) | 1 | 1 (partial) | Row keeps 1 of 2 attachments; server copy gone |
| Real Dovecot, unreadable file, session dropped (`fetch-failures.test.ts`) | 0 | 0 | See below |

**The real-Dovecot case:**
- Nothing is deleted, because the connection is already dead.
- With no reconnect inside a cycle, every later folder fails for the rest of that cycle.
- Sync fully recovers once the file is readable again.

**"Clean server" (`sync-scheduler.ts:211-248`) — CONFIRMED, Critical.** It deletes by stored (folder, UID) pairs, with no UIDVALIDITY or Message-ID check.
- After a local move: it deleted an unrelated, never-synced message in the target folder, and the moved message stayed on the server.
- After a folder was recreated on the server: it deleted the new messages that had reused UIDs 1 and 2.
- Control: with no local edits, it deletes exactly the local set and leaves newer mail alone.

**Connector-mode UI delete (`messages.ts:173-211`, `:234-275`) — Critical.**
- It has the same stale-pair problem: after a move, it expunged a different, never-synced message.
- If the IMAP delete fails, the local row is deleted anyway. The failure goes only to `console.error` (`:199-206`; tested in `write-paths`).

## 2. UIDVALIDITY change — CONFIRMED, Critical (connector) / High (mirror)

**Code:** `imap-sync.ts:520-526`, `DELETE FROM messages WHERE folder_id=?`.

- **Connector mode:** after a doveadm UIDVALIDITY bump, all local-only archive copies of INBOX were deleted. The server holds none.
- **Mirror mode:** messages were re-downloaded as new rows. The user label and the local star were lost.

## 3. Folder missing from LIST — CONFIRMED, Critical (connector) / High (mirror)

**Code:** `imap-sync.ts:417-418` and `:427-443`, plus the schema's `ON DELETE CASCADE`.

- **Connector mode:** deleting the (now empty) folder on the server wiped all its archived mail. A server-side rename did the same.
- **Mirror mode:** after a rename, messages came back as new rows. The user label was lost, and the label row for the old path was left orphaned.

## 4. UI move only rewrites folder_id — CONFIRMED, Critical

**Code:** `messages.ts:155-171` and `:313-326`; `imap-sync.ts:994-1008`.

- **(a) Lost on next sync.** The next sync deletes the moved row as "expunged". The message is still in INBOX on the server, but `last_uid` is already past it, so it is never re-downloaded.
- **(b) UID squatting.** When new server mail later receives the same UID in the target folder:
  - The new message is skipped by `INSERT OR IGNORE` and never stored, yet newMessages=1 is reported.
  - Its flags are written onto the moved row.
  - In connector mode, it is also deleted from the server.
- **(c) Collision.** Moving onto a UID that already exists in the target folder returns HTTP 500 (violates `UNIQUE(folder_id, uid)`).

## 5. A failed message is never retried — CONFIRMED (single message) / REFUTED (whole FETCH) — High

**Code:**
- `imap-sync.ts:871`: `maxUid` is advanced by later messages in the batch.
- `:790-813`, `:884-892`, `:902-913`: per-message failure paths and the `last_uid` write.
- `:163-171`: errors auto-resolve.

**Single-message failure:**
- A transient failure on a middle message left `last_uid` past it, so it was never fetched again.
- The `sync_errors` row was marked resolved the next cycle, so no signal remains.
- The error is marked `retriable:false`; the "no source" path is marked `retriable:true`. Neither is ever retried.

**Exceptions:**
- A failure on the newest message is retried, but only because of A1.
- A whole-batch FETCH failure does not advance `last_uid`, and is retried.

## 6. Server expunge → local hard delete (mirror) — CONFIRMED, Medium

- The row and its labels are removed, with no tombstone.
- An emptied folder (exists=0) is cleared too.
- Connector-mode copies are unaffected.

## 7. Flags — CONFIRMED, High (mirror)

**Code:** `messages.ts:134-153` and `:277-298` (local UPDATE only); `imap-sync.ts:962-978`.

**Local → server: not supported.**
- Read, unread and star changes made in the UI (single and bulk) are never pushed, and the next sync reverts them.
- Replying never sets `\Answered`.

**Server → local: works.**
- `\Seen`, `\Flagged`, `\Answered`, `\Draft` and keywords propagate, both added and removed.
- Sync uses `BODY.PEEK`, so it never sets `\Seen`.

**Other:**
- In connector mode, local flag edits stick.
- Low: `\Recent` is stored as a flag and then flaps away, with a spurious updatedFlags=1. In connector mode it is frozen into the archive copy.

## 8. Server move by another client — CONFIRMED, High

**Code:** `imap-sync.ts:994-1008`; `:1344-1360` joins `f.name = l.name`, but labels have held the full path since v26.

- The move becomes a new row; the user label and the local star are lost.
- `relabelFromServer` does nothing after a normal sync (0 moves detected).
- With both rows present and a nested folder, it reports labelsUpdated=1, but the `Projects/2024` label stays on the stale row.
- Top-level folders work.

## 9. Copies — CONFIRMED, Medium

- The same Message-ID in two folders becomes two independent rows, and the connector's "all mail" count is 2.
- In connector mode, both copies are downloaded and both are deleted.

## 10. Interrupted sync — REFUTED (resume) / CONFIRMED (attachments) — High

**Resume works:**
- Abort at about 60 of 400, then resume: 400 unique rows, 400 attachments, `last_uid`=400.
- SIGKILL with 186 rows local (85 of them pending_archive), 300 still on the server, nothing lost. Then resume: 400 rows, no duplicates, all `deleted_from_server=1`, server empty.

**Attachments are not atomic:**
- Message and attachment inserts are not in one transaction (`imap-sync.ts:825-869`).
- One attachment failure leaves a partial row that is never repaired. In connector mode the server copy is then deleted.

## 11. Concurrent changes from another client — PARTIAL, Low

- A flag change between FETCH and flag-sync is applied in the same cycle.
- An expunge in that window is applied one cycle late, because the selected session still answers for it.
- Mail appended mid-cycle is picked up next cycle.
- An expunge between SEARCH and FETCH produces a "no source available" error and the UID is skipped (harmless in this case).
- In connector mode, mail that arrives between FETCH and DELETE is not deleted, because deletes are limited to the batch's UIDs.

## 12. Mirror mode writes nothing to the server — CONFIRMED (holds)

**No server writes, from:**
- UI delete (single and bulk)
- flag changes
- move
- label changes
- draft creation
- send

In every case, Dovecot logged no IMAP login and the server state was identical afterwards.

**Send performs no APPEND.** The copy goes to a local-only Sent folder (identity_id, negative UID; `send.ts:143-172`, `:233-251`) and survives later syncs.

**A sync cycle plus relabel puts no write command on the wire.** It does use SELECT rather than EXAMINE, which consumes `\Recent`.

## Extra findings

- **A1 (Medium).** The search `last_uid+1:*` (`imap-sync.ts:550`) always matches the newest UID, because IMAP's `*` means the highest UID in the folder. As a result, the newest message in every non-empty folder:
  - is re-downloaded each cycle and reported as new;
  - comes back after a UI delete;
  - gets duplicated back into its source folder after a UI move.
- **A2 (Medium).** Without UIDPLUS, imapflow's `messageDelete` sends a plain EXPUNGE. That also removed a message another client had only flagged `\Deleted`.
- **A3 (latent).** `connectors/imap.ts:96` `fetchMessages` omits `{uid:true}`, so its UID range is treated as sequence numbers. The function is not currently used.

## IMAP write paths

These are the only mutators in non-test `src/`. On the wire they send `UID STORE +FLAGS (\Deleted)` then `UID EXPUNGE`, or a plain EXPUNGE without UIDPLUS.

| Path | Code | Reached from | Condition |
|---|---|---|---|
| W1 | `imap-sync.ts:1252` `deleteFromServer` | Phase 1b (`:646-660`) | `sync_delete_from_server=1` |
| W2 | same function | Phase 3 crash recovery (`:696-724`) | pending_archive rows exist |
| W3 | same function | `cleanServerNow` (`sync-scheduler.ts:211-248`), via `POST /connectors/inbound/:id/clean-server` (`connectors.ts:403`) | Always; deletes every row with `deleted_from_server=0` |
| W4 | `connectors/imap.ts:168` `deleteMessages` | `messages.ts:30-43`, via `DELETE /messages/:id` (`:199`) and bulk delete (`:255`) | `type='imap'` and `sync_delete_from_server=1` |

Read-only commands used: LIST (including `identities.ts:193` test-connection), UID SEARCH, UID FETCH.

## Sync matrix

| Operation | Direction | Status | Observed | Test |
|---|---|---|---|---|
| Initial sync | S→L | ✔ | Flags kept, `\Seen` never set; abort/kill resume correct | flags, fetch-failures |
| Incremental new mail | S→L | ✔ with quirks | A1; a failed middle message is skipped forever | local-ops, fetch-failures |
| `\Seen` / `\Flagged` / `\Draft` | S→L | ✔ | Adds and removes propagate | flags |
| `\Seen` / `\Flagged` / `\Draft` | L→S | unsupported, reverted | Never pushed; next sync overwrites the local change | flags |
| `\Answered` | S→L / L→S | ✔ / unsupported | Replying never sets it | flags, local-ops |
| `\Recent` | S→L | wrong | Stored, then flaps | flags |
| Local delete (mirror) | L→S | local only | The newest message comes back (A1) | local-ops |
| Local delete (connector) | L→S | destructive | A stale UID can hit the wrong message; local delete proceeds even if IMAP fails | connector-mode, write-paths |
| Server expunge | S→L | destructive (mirror) | Hard delete, no tombstone | server-changes |
| Local move | L→S | unsupported, destructive | Row deleted next sync; UID squatting; HTTP 500 on collision | local-ops |
| Server move | S→L | delete + new | Labels and flags lost; relabel ineffective | server-changes |
| Copy | S→L | duplicate | Two rows per Message-ID | server-changes |
| Folder create (server) | S→L | ✔ | Full-path label created | folders |
| Folder rename/delete (server) | S→L | destructive | Cascade delete; connector archive lost | folders |
| Folder ops (local) | L→S | unsupported | No API path | — |
| Local label ops | local | local only | Overrides honoured; labels lost on move, rename or UIDVALIDITY change | local-ops |
| UIDVALIDITY reset | S→L | destructive | Folder wiped, including the connector archive | uidvalidity |
| Send (Sent folder) | L→S | unsupported | No APPEND; local Sent folder only | local-ops |
| Drafts | L→S | unsupported | Stored only in the drafts table | local-ops |
| Clean server | L→S | destructive | Stale (folder, UID) pairs; no UIDVALIDITY check | connector-mode, uidvalidity |
| Connector-mode sync | L→S | destructive | Deletes the requested batch, not the stored set | connector-mode |

## Could not test

- **A kill between the message INSERT and the attachment INSERTs.** better-sqlite3 is synchronous, so this was shown with an injected exception instead.
- **A real server sending partial data and then NO.** Dovecot drops the session instead, so this was reproduced through the proxy.
- **The "no envelope" path.**
- **IDLE.** Stork doesn't use it.
- **Gmail-specific behaviour and CONDSTORE/QRESYNC.** Gmail layout is covered in `audit/sync-edge`.
- **Scheduler backoff.** Covered in `audit/sync-edge` (D4).
- **A3.** The code path is unused.

## Final suite result (authoring run)

```
Test Files  8 passed (8)
     Tests  61 passed (61)
  Duration  214.68s
```
