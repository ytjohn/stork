# stork performance audit (fork-readiness)

Every number here was produced by the scripts in this directory and can be reproduced with one command.
I did **not** use `docs/performance.md` or `scripts/benchmark.ts`. Those query `messages_fts` directly with
a 100-word vocabulary and skip `MessageSearch`, snippets, joins and filters.

```bash
# everything (≈4–5 h on a 4-core box; needs ~25 GB free under /tmp; Dovecot must be installed):
npx tsx audit/perf/run-all.ts --size all
# one size, or a few steps:
npx tsx audit/perf/run-all.ts --size 100k
npx tsx audit/perf/run-all.ts --size 500k --steps search,lists
# print the result tables (as at the end of this file) from results/*.json:
npx tsx audit/perf/report.ts all
```

Work data goes to `/tmp/stork-audit-perf/` (override with `STORK_PERF_WORK`). The disposable Dovecot is
started by `audit/harness/dovecot.sh` on `127.0.0.1:14203` with base `/tmp/stork-audit-imap-perf`.
Built DBs are kept for re-runs (≈14 GB): `/tmp/stork-audit-perf/db-imap-10k`, `db-bulk-100k`, and `db-bulk-500k`.
`db-bulk-500k` now also holds the 10k-message Dovecot connector added by the `--inplace` steps. `build-db.ts`
skips a size that is already built unless you pass `--force`. Delete the directory to start clean.
Raw results are in `results/*.json`. Every file embeds an environment snapshot: nproc, CPU model, `free -g`,
node version, `df -h /tmp` and the load average at measurement time. Step logs are in `/tmp/stork-audit-perf/logs/`.

## Environment (all runs)

| | |
|---|---|
| CPU | 4 vCPU, Intel(R) Xeon(R) Processor @ 2.80GHz (Firecracker VM) |
| RAM | 15.7 GB, no swap |
| Disk | virtio `/dev/vda`. Free space under /tmp went from 30 GB to 12 GB during the runs (shared with other agents) |
| Node | v22.22.0. SQLite 3.53.0 (better-sqlite3-multiple-ciphers, SQLCipher, FTS5 + dbstat compiled in) |
| Dovecot | 2.3 via `audit/harness/dovecot.sh`, plaintext on loopback |
| Load | Other audit agents were running concurrently. The 1-min load average was 1.0–4.2 across the runs (each JSON records its own). The 10k sync runs saw 1.8–3.2. The 100k/500k search, list and concurrency runs saw 1.0–2.2. Treat differences under ~20% as noise |

## What each script measures

| script | measures | code path exercised |
|---|---|---|
| `lib/corpus.ts` | deterministic generator (seeded sfc32) | – |
| `load-maildir.ts` | writes the corpus into Dovecot's Maildir, then `doveadm index` | – |
| `bench-sync.ts` | initial ingestion | **real**: Dovecot → `ImapSync.connect()/syncAll()` (`src/sync/imap-sync.ts`) → `openDatabase()` (SQLCipher) |
| `bench-insert-path.ts` | where the per-message cost goes | the exact `fetchUidBatch` INSERT, mailparser, htmlToText, deflate, sha256 |
| `build-db.ts` | 100k / 500k DBs | `openDatabase()` + the identical `fetchUidBatch` INSERT + `upsertAttachmentBlob` + the real `ImapSync` label/count methods (no IMAP, see below) |
| `bench-search.ts` | search latency | `new MessageSearch(db).search(q,{limit,offset})`, exactly as `GET /api/search` calls it. `--http` goes over a real socket |
| `bench-lists.ts` | inbox / label / thread / count endpoints | `createApp()` routes via `app.request()` (routing + SQL + JSON) |
| `diag-columns.ts` | root causes | SQL copied from `search.ts` / `imap-sync.ts`, with `EXPLAIN QUERY PLAN` |
| `bench-flags.ts` | FTS write amplification of flag updates; optimize | `PATCH /api/messages/:id/flags`, the `syncFlags()` UPDATE, two counterfactuals |
| `bench-concurrency.ts` (+`lib/conc-server.ts`) | request latency and event-loop lag during sync | child process running `createApp()` + `ImapSync.syncAll()` in one event loop, as in production. Load is open-loop |
| `bench-lifecycle.ts` | Argon2id unlock, open, migrations, server start, SIGTERM/SIGKILL mid-sync | `src/crypto/keys.ts`, `openDatabase()/ensureSchema()`, the production esbuild bundle of `src/index.ts` (built into `.build/`, gitignored) |
| `report.ts` | renders the tables below | – |

### Corpus (`lib/corpus.ts`)

* 30,000-word pseudo-word vocabulary with Zipf s=1.07. The top ranks are real English function words ("the", "of", …).
* Text body sizes are lognormal: median ≈5.5 KB, σ=0.75, capped at 96 KB. That gives an RFC822 median of ≈8 KB
  (measured 9.4 KB median at 10k, including headers).
* 20% are multipart/alternative with an HTML part. The HTML goes through the app's `htmlToText` into
  `html_text_body`, so it is indexed a second time, as in production.
* 5% carry one attachment of 50 KB–2 MB (log-uniform; random bytes, comparable to PDFs or JPEGs).
* 500 senders (Zipf). 40% of messages reply into a recent thread (In-Reply-To + References). There are also
  8 long threads of 60 messages each.
* Dates are spread evenly over 2021-10-15 … 2026-10-15. 88% of messages are `\Seen`; in the newest 3% only 30% are.
* Folders: INBOX 25%, Archive 55%, Sent 12%, Trash 3%, `Lists/dev` 5%.
* Needles with exact frequencies:
  * `xylorarium`: 10 docs
  * `xylomedianta`: 1%
  * `xylocommona`: 30%
  * phrase `"quantum harvest"`: 0.5%, plus non-adjacent decoys
  * `zqprefix0-9`: 2%
  * sender `needle.sender@known-corp.example`: 2%
  * subjects `Invoice #…`: ≈3%

### Which code path built which DB

* **10k and 50k** were built by the real IMAP sync (`bench-sync.ts`): Dovecot → imapflow → mailparser → `fetchUidBatch`.
* **100k and 500k** were built by `build-db.ts`.
  * Same as the app: `openDatabase()` (SQLCipher key, pragmas, all migrations); the identical
    `INSERT OR IGNORE INTO messages …` statement and value transforms as `fetchUidBatch`; the real `messages_ai` trigger;
    `upsertAttachmentBlob()`; and the real `ImapSync.ensureLabelsForFolders / applyFolderLabelsToMessages /
    ensureIdentityLabel / applyIdentityLabelToMessages / refreshLabelCounts`.
  * Differences: no IMAP or mailparser (generator fields go in directly); inserts are batched 1000 per transaction
    (the real sync autocommits each message); attachment bytes come from a pool of 64 payloads (this bounds
    `stork-blobs.db`; dedup is by content hash, as in production).
  * Each DB has one connector. A Gmail + Namecheap user would have two, but every list and search query is
    global anyway.
  * The 500k concurrency step and the 500k lifecycle step ran `--inplace` to avoid copying 8.6 GB. That added a
    2nd connector with the 10k Dovecot messages, so those two steps saw ≈510k rows. The 500k search, list, diag
    and flags runs happened before this.

## Summary: what a ~200k-message user (Gmail + Namecheap) will feel

Times below are interpolated between the 100k and 500k measurements. Nearly everything scales linearly with
row count. All DB work runs synchronously on the single Node event loop (better-sqlite3), so a slow query
also stalls every other request, including the UI's polling.

| user action / background event | ≈200k | evidence |
|---|---|---|
| **Every sync cycle (default 5 min, per connector)**: no new mail, the server freezes | **~25–30 s per connector**. With 2 connectors that is two freezes every 5 minutes | `refreshLabelCounts()` is 12.6 s at 100k and 66 s at 500k (69–73 s inside a real `syncAll()`). In the concurrency test (8 req/s of fast UI requests), median latency during a no-new-mail resync was 5.9 s at 100k (max 13 s) and 34.5 s at 500k (max 71 s); 84–95% of requests took > 1 s |
| Operator-only search (`from:`, `subject:`, `has:attachment`, `label:`) | 2–3 s | 1.1–1.4 s at 100k, 6.6–8.3 s at 500k |
| `is:unread` search | ~9 s | 4.7 s at 100k, 23 s at 500k |
| Search containing `@ . - ' & + % : ( *` (e.g. an email address, `don't`, `e-mail`, `re:`) | **HTTP 500** | raw input is passed to FTS5 `MATCH` |
| `label:X some words` | 0 results or HTTP 500 | parameter-binding bug |
| Search for a common word (30% of docs) | ~120 ms | 47 ms at 100k, 330 ms at 500k |
| Search for a stopword-like word, or a short prefix (`pl*`) | 1.5–3 s | `the`: 0.95 s / 3.2 s. `pl*`: 1.4 s / 6.9 s |
| Search for distinctive words, phrases, AND | < 25 ms | flat with size |
| Inbox / label page 1–20, open a message, 60-message thread, sidebar counts | < 25 ms | covering index `(label_id, date)` plus cached counts |
| Deep pagination (label page 1000; last page of a big label) | 70–80 ms; 0.1–2 s | OFFSET scan. Last page of a 55k label is 68 ms at 100k; of a 275k label, 4.9 s at 500k |
| `labels/filter/count` (multi-label count) | ~2.5 s | 1.3 s / 7.1 s |
| Mark 1,000 messages read (one PATCH each) | ~4.5 s; FTS index grows | 222 KB written per flag change |
| Unlock after restart | 4–5 s, server unresponsive meanwhile | Argon2id in pure JS on the event loop |
| Initial sync of 200k | ≈ 45–60 min if CPU-bound on this CPU; longer against real Gmail. UI stalls throughout (event-loop pauses up to 1.2–1.9 s at 50k, plus a final `refreshLabelCounts` freeze) | 101 msg/s on one core at 10k, 83 msg/s at 50k (real IMAP sync, 3 runs) |

The whole system is CPU/IO-bound on one core. Dovecot used only ~1–2 s of CPU per 10k messages synced.

## Bottlenecks, ranked, with code references

1. **The per-cycle label maintenance does full scans of the wide `messages` table**
   (`src/sync/imap-sync.ts:1066 refreshLabelCounts`, called at `:363` at the end of every `syncAll()`; `:1042
   applyFolderLabelsToMessages`, called at `:336`, `:358`, and every 500 new messages at `:640`).
   * `refreshLabelCounts` runs two GROUP BY queries that read `messages.flags` for every row.
   * `flags` is stored **after** `text_body`/`html_body` in the row (v19 table in `src/storage/schema.ts`). Reading it
     therefore walks each row's overflow chain, i.e. reads and decrypts almost the entire 1.1 GB (100k) / 5.5 GB
     (500k) table. `diag-columns.ts` shows this directly:
     * `SUM(uid)` (covering index): 4 ms / 21 ms
     * `SUM(length(subject))` (table scan): 1.4 s / 6.4 s
     * `COUNT(flags NOT LIKE '%Seen%')`: 4.6 s / 20 s
   * The no-op `applyFolderLabelsToMessages` costs 1.3 s / 9.3 s when the connector owns 100k / 500k messages (it
     filters by `inbound_connector_id`, so it scales with the *per-connector* count; a 10k connector inside a 100k DB
     takes 7–70 ms). Because it also runs every 500 new messages during sync, initial-sync cost grows quadratically
     with mailbox size.
   * `refreshLabelCounts` is global (all connectors) and runs once per connector per cycle, so two connectors pay it
     twice.
   * Shutdown makes this worse. SIGTERM mid-sync took 13–15 s at 100k (exit code 0, but already past the 10 s
     budget). At 500k, SIGTERM during a resync took ~70 s to exit: the 10 s force-exit timer in
     `src/crypto/lifecycle.ts:59` cannot fire while the event loop is blocked. Under `docker stop` (10 s default grace,
     no `stop_grace_period` in `docker-compose.yml`) that becomes a SIGKILL.
2. **Filter-only search reads the whole table.** In the no-text branch, `src/search/search.ts:194-213` does
   `JOIN folders f` (`:207`). That makes SQLite plan `SCAN f → SEARCH m USING INDEX idx_messages_pending_archive (folder_id=?)
   → USE TEMP B-TREE FOR ORDER BY`: every row is read and sorted before `LIMIT 50`. The same SQL without the join
   uses `SCAN m USING INDEX idx_messages_date` and stops early. `from:` drops from 8,070 ms to 5.9 ms at 500k
   (1,112 → 3.3 ms at 100k). `is:unread`/`/api/inbox/unread-messages` pay the flags overflow cost on top.
3. **FTS ranking cost is proportional to match count.** `ORDER BY rank` (bm25) plus `snippet()` must score every
   matching doc before `LIMIT`, so very common terms and short prefixes take seconds. Deep `offset` on search is no
   cheaper. There is no total-count query, so the UI cannot even say "150,000 results".
4. **Search input is not sanitised** (`src/search/search.ts`: `ftsQuery` goes straight into `MATCH ?`). These queries
   all throw inside `MessageSearch` and return HTTP 500 from `/api/search`:
   `user@example.com`, `AT&T`, `a-b`, `foo:bar`, `c++`, `"unterminated`, `(`, `*`, `NOT`, `-foo`, `alice.perf`,
   `e-mail`, `don't`, `50%`, `re:`. A fork needs a tokenizer-aware quoting layer (quote every bare token; keep only
   whitelisted operators).
5. **`label:` binding bug** (`src/search/search.ts:149-156` vs the JOIN/MATCH order at `:176-179`; `MATCH` value pushed first at `:93`). The label value is pushed onto `params`
   after the `MATCH` value and after earlier filter values, but its `?` appears earlier in the SQL (in the JOIN).
   * `label:INBOX xylocommona` returns 0 rows; the truth is 876 at 10k.
   * `label:Lists/dev term` throws `fts5: syntax error near "/"`.
   * `from:x label:INBOX` returns 0 rows, while `label:INBOX from:x` works.
6. **Flag updates rewrite the whole FTS document.** `messages_au` (`src/storage/schema.ts:1141`) fires on *any*
   column update, including `flags`, `folder_id` and `pending_archive`. It deletes and re-inserts all six indexed
   columns.
   * Measured at 100k: 222 KB written per flag change, ~4 ms, 230–260 updates/s. That holds for both
     `PATCH /api/messages/:id/flags` and the `syncFlags()` UPDATE (`imap-sync.ts:927`, autocommit per row).
   * 150k flag updates grew `messages_fts_data` from 422 to 656 MB (+55%). Nothing ever runs `optimize`.
     `optimize` itself is a blocking 26 s at 100k and 126 s at 500k (writes 1.5 / 5.4 GB).
   * Counterfactual: scoping the trigger with `AFTER UPDATE OF subject, from_address, from_name, to_addresses,
     text_body, html_text_body` gives 1,680 updates/s, 44 KB/update and zero FTS growth.
7. **Ingestion is ~100 msg/s on one core, falling to 83 msg/s by 50k** (`bench-sync.ts`; 4.4 → 3.8 MB/s).
   Per-message attribution (`bench-insert-path.ts`):
   * mailparser `simpleParser`: ≈3.0 ms
   * SQLite INSERT + FTS trigger under per-message autocommit: ≈2.9 ms. Batching per 100-message IMAP batch would
     make it ≈1.36 ms. `fetchUidBatch` (`imap-sync.ts:741`) never opens a transaction.
   * sha256 + deflate-6 of attachment bytes, averaged over all messages: ≈0.9 ms. `upsertAttachmentBlob` deflates
     even when the blob already exists, and deflating incompressible data saves nothing: the 10k blobs DB is 248 MB
     for ≈240 MB of attachment bytes.
   * Dropping the FTS trigger raises throughput from 101 to 146 msg/s.
   * The sync loop also stalls the event loop: p99 ≈ 100 ms, max 0.2–0.55 s at 10k; p99 125 ms, max 1.2–1.85 s at
     50k. That grows with DB size because of the 500-message label pass (bottleneck 1).
8. **IMAP re-fetch every cycle.** The UID search uses `${lastUid + 1}:*` (`imap-sync.ts:550`). Per IMAP semantics
   `N:*` with N > max UID still matches the highest UID, so every cycle re-downloads and re-parses the newest message
   of every folder. `INSERT OR IGNORE` drops it, but `count++` (`:883`) still reports it as new: "5 new" per resync
   with 5 folders. This is cheap for 5 small messages but costly for a large attachment every 5 minutes.
9. **Migrations.**
   * `PRE_MIGRATION_HOOKS[30]` (`src/storage/db.ts:301`) UPDATEs `message_labels.date` *before* `MIGRATIONS[29]`
     adds that column. **Any populated v29 (or older) DB fails to open: "no such column: date".**
   * Simulated v24→v30 at 100k ran for 104 s (the FTS rebuild alone is ≈80 s at 100k, so ≈400 s expected at 500k)
     and then failed the same way. It left `schema_version=24` with v25's `ALTER TABLE … ADD COLUMN html_text_body`
     already applied, so the next start fails differently (duplicate column).
   * Migrations are not wrapped in transactions and the version is bumped only at the end.
   * Fresh installs are unaffected.
10. **Unlock cost.** `@noble/hashes` Argon2id (m=64 MiB, t=3) takes 4.1–5.3 s in pure JS (median per run set), synchronously inside
    `POST /api/unlock`. This is by design, but the whole server is unresponsive meanwhile. A native or worker-thread
    KDF would fix that.
11. **Smaller items.**
    * `GET /messages/:id/thread` (`src/api/routes/messages.ts:67-132`) only finds direct parents and children (`message_id IN refs OR in_reply_to IN refs`),
      so opening the root of a 60-message thread returns 2 messages. From the last message it returns all 60 in
      15–20 ms, as 865–950 KB of JSON (full bodies, HTML and raw headers decompressed).
    * `message_labels` has two identical `(label_id)` indexes (`idx_message_labels_label`,
      `idx_message_labels_label_v15`) on top of `(label_id, date)`.
    * `openDatabase` (`src/storage/db.ts:38-56`) asks for `mmap_size` = min(file size, RAM/2), but SQLite clamps it to
      the compile-time `SQLITE_MAX_MMAP_SIZE` of 2 GiB. `PRAGMA mmap_size` reads back 2147418112 on the 8.6 GB DB, so
      the comment about mapping an entire 16 GB DB is wrong. Process RSS includes up to 1.5 GB of file-backed
      (reclaimable) mmap pages at 100k. The page cache is sized up to 512 MB (`db.ts:58-73`).

### Sizes

* **100k**: main DB 1.65 GB for ≈4.2 GB of raw RFC822 text (attachments excluded). The `messages` table is
  1.11 GB (67%) and FTS is 483 MB (29%).
* **500k**: main DB 8.2 GB, FTS 2.4 GB (29%).
* **10k via real sync**: main 170 MB (FTS 51 MB = 30%), `stork-blobs.db` 248 MB.
* **50k via real sync**: main 828 MB (FTS 244 MB = 29%), `stork-blobs.db` 1.32 GB for ≈2.4 GB of RFC822.
* **WAL**: stayed ≤ 7 MB during real sync. It reaches 116–210 MB with the bulk loader and 230–760 MB with
  single-transaction flag updates or `optimize`.
* Extrapolated for 200k: ≈3.3 GB main DB, ≈1 GB of it FTS, before any Gmail folder duplication. Gmail exposes each
  message in INBOX, `[Gmail]/All Mail` and every label folder, and stork stores one row per folder
  (`UNIQUE(folder_id, uid)`), so expect 1.5–2× rows.

### Memory

* At 500k (≈510k in-place): RSS ≈116 MB right after open; ≈170–178 MB after unlock plus the first queries.
* Peak ≈725–760 MB during sync or heavy search: anon ≈670 MB, which is mostly the 512 MB SQLite page cache plus heap;
  file-backed ≈58 MB.
* At 100k: peak RSS 1.95 GB, of which only 0.41 GB is anon. The other 1.5 GB is the mmap'd DB file, which counts
  toward container memory limits but is reclaimable.
* Initial sync with attachments peaks at ≈400 MB RSS at 10k and ≈555 MB at 50k (mailparser buffers whole
  messages; the page cache grows with the DB).

### Crash safety (SIGTERM / SIGKILL mid-sync, 100k DB + 10k over IMAP)

All 9 runs ended with `PRAGMA integrity_check` = ok, FTS5 `integrity-check` = ok, FTS docsize rows equal to message
rows, zero duplicate `(folder_id, uid)` and zero duplicate Message-IDs. After a restart the sync resumed from
`sync_state.last_uid` and finished with exactly 10,000 rows.

* SIGKILL: tested at folder boundaries (2,861 and 9,279 rows) and at fixed times mid-batch (20 / 55 / 95 s after
  unlock; e.g. 1,607 rows). A partially processed 100-UID batch is simply re-fetched; `INSERT OR IGNORE` on
  `UNIQUE(folder_id, uid)` absorbs it. The WAL left behind was 7.6–12 MB.
* SIGTERM: always exited 0, but took 13–15 s at 100k (≈70 s at 500k, see bottleneck 1).
* Restart to ready (spawn → health → unlock) took 4.6–6.7 s, dominated by Argon2id. Nothing at open time scales
  with DB size: `openDatabase()` is 1.4–1.9 ms even at 500k.

## What I could not run, or ran differently

* **500k (and 100k) through IMAP.** At ~100 msg/s that is 1.4 h (or 17 min) of sync per run, plus ≈20 GB of
  Maildir, on a shared box with 12–30 GB free. These DBs were built with the same INSERT path (see above) instead.
  50k through real IMAP was run 3× (not 5×; ~9 min per run).
* **Real Gmail/Namecheap behaviour** (throttling, `[Gmail]/All Mail` duplication, latency over the internet) was not
  measured. There was no external network and no real accounts. Dovecot was on loopback, so network cost is ≈0
  and all numbers are stork-side lower bounds.
* **Cold OS page cache.** I could not drop caches in this VM. "Cold" here means a fresh SQLite connection with an
  empty SQLCipher page cache and a warm OS cache.
* **Migration timings are partly simulated.** Older schemas were produced by rewinding a current DB (dropping the
  v25–v30 artefacts). Both migration paths fail at v30 (bottleneck 9), so the v24→v30 time is "time until failure".
  `ftsRebuildMs` measures the dominant v25 step on its own.
* **Contamination, and how I handled it.** An orphaned stork server left behind by one of my own crashed runs used
  ~0.7 core for 45 min (13:16–13:58 UTC). Every result that overlapped that window was re-run (10k search/lists/flags,
  500k flags/concurrency/lifecycle); the JSON `env.at` timestamps show which run is current. The harness now kills its
  children on exit. Other agents' load is recorded per result.
* **10k vs bulk DBs are not identical corpora.** The 10k DB went through mailparser (wrapped text, real MIME
  decoding), while 100k/500k used generator fields directly. Compare the 10k column with care; 100k → 500k is the
  apples-to-apples scaling.

## Result tables (generated by `report.ts` from `results/*.json`)

### Search (MessageSearch.search, limit 50, warm connection) — median / p95 ms

| query | 10k median | 100k median | 500k median | 10k p95 | 100k p95 | 500k p95 | matches @500k |
|---|---:|---:|---:|---:|---:|---:|---:|
| rare term (10 docs) | 3.34 | 1.58 | 2.58 | 3.55 | 1.95 | 2.83 | 10 |
| medium term (1%) | 5.14 | 4.91 | 12.7 | 9.26 | 9.78 | 13.6 | 5000 |
| common term (30%) | 6.89 | 47.0 | 330 | 9.23 | 79.8 | 365 | 150007 |
| stopword-like 'the' (~100%) | 580 | 945 | 3219 | 634 | 1091 | 3437 | 500000 |
| two terms AND (1% & 30%) | 7.23 | 7.65 | 21.6 | 9.57 | 9.11 | 23.5 | 1518 |
| OR (1% | 30%) | 11.0 | 54.5 | 339 | 15.0 | 85.3 | 429 | 153489 |
| phrase "quantum harvest" (0.5%) | 9.87 | 6.40 | 11.1 | 22.5 | 6.97 | 11.9 | 2505 |
| prefix zqprefix* (2%) | 4.36 | 8.38 | 22.2 | 5.29 | 9.33 | 22.4 | 10000 |
| broad prefix pl* (many terms) | 155 | 1395 | 6905 | 185 | 1750 | 7548 | 498838 |
| from: only (2%, LIKE scan) | 4.23 | 1159 | 7908 | 9.70 | 1333 | 8200 | rows 50 |
| from: domain only (LIKE scan) | 0.97 | 1239 | 8302 | 1.45 | 1426 | 9002 | rows 50 |
| from: + common term | 16.1 | 61.1 | 298 | 18.8 | 75.3 | 334 | 150007 |
| subject:Invoice only | 1.47 | 1153 | 8015 | 2.93 | 1314 | 8351 | rows 50 |
| subject: + medium term | 0.85 | 8.58 | 21.3 | 1.18 | 8.77 | 21.4 | 5000 |
| has:attachment only | 0.72 | 1120 | 7902 | 1.46 | 1255 | 8235 | rows 50 |
| is:unread only | 0.28 | 4747 | 23300 | 0.43 | 5289 | 23516 | rows 50 |
| label:INBOX only | 0.45 | 1444 | 6648 | 0.55 | 1678 | 6802 | rows 50 |
| label:Lists/dev + common | ERR | ERR | ERR | ERR | ERR | ERR | error: fts5: syntax error near "/" |
| label:INBOX + common | 0.22 | 0.26 | 0.45 | 0.33 | 0.37 | 0.49 | 150007 |
| label:INBOX + from: (no text) | 5.68 | 63.9 | 2633 | 6.60 | 81.0 | 2785 | rows 50 |
| from: + label:INBOX (order swapped) | 11.3 | 0.22 | 0.16 | 15.0 | 0.33 | 0.23 | rows 0 |
| date range only (6 months) | 0.26 | 0.51 | 0.35 | 0.48 | 5.64 | 0.47 | rows 50 |
| date range + common | 8.42 | 50.5 | 325 | 13.3 | 57.3 | 467 | 150007 |
| combined: common+from:domain+has:att+after+is:unread | 9.94 | 128 | 715 | 14.6 | 158 | 777 | 150007 |
| common term, offset 5000 (page 101) | 7.65 | 74.2 | 400 | 11.2 | 93.7 | 455 | 150007 |
| 'the', offset 5000 | 64.2 | 727 | 3300 | 96.2 | 910 | 3653 | 500000 |
| is:unread, offset 5000 | 17.1 | 5058 | 24866 | 19.0 | 5310 | 26762 | rows 50 |
| has:attachment, offset 5000 | 7.82 | 1346 | 8383 | 9.03 | 1545 | 8899 | rows 50 |
| zero-hit term | 0.14 | 0.16 | 0.18 | 0.21 | 0.32 | 0.37 | 0 |

#### Cold (fresh connection) @10k — openDatabase + first query, median/p95 ms (5 samples)

| query | open median | first query median | first query p95 |
|---|---:|---:|---:|
| rare term (10 docs) | 1.40 | 3.81 | 5.45 |
| medium term (1%) | 1.34 | 8.00 | 8.09 |
| common term (30%) | 1.26 | 9.18 | 11.9 |
| from: only (2%, LIKE scan) | 1.49 | 40.5 | 44.6 |
| is:unread only | 1.21 | 3.98 | 4.11 |
| label:INBOX only | 1.16 | 3.89 | 4.25 |
| combined: common+from:domain+has:att+after+is:unread | 1.45 | 65.5 | 69.6 |
| common term, offset 5000 (page 101) | 1.50 | 61.2 | 61.9 |

#### Cold (fresh connection) @100k — openDatabase + first query, median/p95 ms (5 samples)

| query | open median | first query median | first query p95 |
|---|---:|---:|---:|
| rare term (10 docs) | 1.44 | 3.46 | 4.26 |
| medium term (1%) | 1.53 | 15.1 | 15.3 |
| common term (30%) | 1.49 | 59.0 | 64.5 |
| from: only (2%, LIKE scan) | 1.78 | 1505 | 1562 |
| is:unread only | 1.91 | 4842 | 5410 |
| label:INBOX only | 1.71 | 1585 | 1673 |
| combined: common+from:domain+has:att+after+is:unread | 1.73 | 704 | 760 |
| common term, offset 5000 (page 101) | 1.65 | 167 | 198 |

#### Cold (fresh connection) @500k — openDatabase + first query, median/p95 ms (5 samples)

| query | open median | first query median | first query p95 |
|---|---:|---:|---:|
| rare term (10 docs) | 1.82 | 3.85 | 4.29 |
| medium term (1%) | 1.94 | 52.1 | 69.7 |
| common term (30%) | 1.76 | 346 | 403 |
| from: only (2%, LIKE scan) | 2.04 | 8097 | 8654 |
| is:unread only | 2.04 | 23141 | 23741 |
| label:INBOX only | 2.13 | 7151 | 8212 |
| combined: common+from:domain+has:att+after+is:unread | 2.94 | 2623 | 2812 |
| common term, offset 5000 (page 101) | 2.12 | 526 | 610 |

#### HTTP GET /api/search @100k (real socket, JSON) — median/p95 ms

| query | status | bytes | median | p95 |
|---|---:|---:|---:|---:|
| rare term (10 docs) | 200 | 5259 | 5.44 | 8.61 |
| medium term (1%) | 200 | 26852 | 8.81 | 10.7 |
| common term (30%) | 200 | 26602 | 62.8 | 71.9 |
| stopword-like 'the' (~100%) | 200 | 30691 | 1154 | 1267 |
| two terms AND (1% & 30%) | 200 | 26695 | 11.9 | 12.7 |
| OR (1% | 30%) | 200 | 26822 | 57.1 | 76.0 |
| phrase "quantum harvest" (0.5%) | 200 | 25825 | 7.88 | 9.45 |
| prefix zqprefix* (2%) | 200 | 26430 | 9.75 | 10.4 |
| broad prefix pl* (many terms) | 200 | 28837 | 1327 | 1481 |
| from: only (2%, LIKE scan) | 200 | 21206 | 1173 | 1206 |
| from: domain only (LIKE scan) | 200 | 20734 | 1283 | 1487 |
| from: + common term | 200 | 26692 | 88.8 | 99.8 |
| subject:Invoice only | 200 | 21609 | 1174 | 1374 |
| subject: + medium term | 200 | 12552 | 17.2 | 39.5 |
| has:attachment only | 200 | 20748 | 1118 | 1239 |
| is:unread only | 200 | 20695 | 4746 | 5007 |
| label:INBOX only | 200 | 20799 | 1477 | 1718 |
| label:Lists/dev + common | 500 | 21 | 3.15 | 4.17 |
| label:INBOX + common | 200 | 2 | 2.50 | 4.22 |
| label:INBOX + from: (no text) | 200 | 21146 | 55.9 | 64.6 |
| from: + label:INBOX (order swapped) | 200 | 2 | 1.42 | 2.54 |
| date range only (6 months) | 200 | 20738 | 2.11 | 2.94 |
| date range + common | 200 | 25702 | 58.5 | 62.6 |
| combined: common+from:domain+has:att+after+is:unread | 200 | 7713 | 160 | 174 |
| common term, offset 5000 (page 101) | 200 | 26432 | 115 | 119 |
| 'the', offset 5000 | 200 | 29363 | 681 | 815 |
| is:unread, offset 5000 | 200 | 20799 | 5068 | 5804 |
| has:attachment, offset 5000 | 200 | 836 | 1329 | 1379 |
| zero-hit term | 200 | 2 | 1.34 | 2.87 |
| crash? user@example.com | 500 | 21 | 2.30 | 2.56 |
| crash? AT&T | 500 | 21 | 1.52 | 1.61 |
| crash? a-b | 500 | 21 | 1.49 | 1.58 |
| crash? foo:bar | 500 | 21 | 1.84 | 2.31 |
| crash? c++ | 500 | 21 | 1.34 | 1.37 |
| crash? "unterminated | 500 | 21 | 1.37 | 1.38 |
| crash? ( | 500 | 21 | 1.41 | 1.47 |
| crash? * | 500 | 21 | 1.74 | 2.14 |
| crash? NOT | 500 | 21 | 1.44 | 1.52 |
| crash? -foo | 500 | 21 | 1.70 | 1.87 |
| crash? alice.perf | 500 | 21 | 2.02 | 2.42 |
| crash? e-mail | 500 | 21 | 1.51 | 1.57 |
| crash? don't | 500 | 21 | 1.46 | 1.50 |
| crash? 50% | 500 | 21 | 1.83 | 2.34 |
| crash? re: | 500 | 21 | 1.84 | 1.98 |

#### Queries that throw inside MessageSearch (HTTP 500)

| query | result |
|---|---|
| `user@example.com` | throws: fts5: syntax error near "@" |
| `AT&T` | throws: fts5: syntax error near "&" |
| `a-b` | throws: no such column: b |
| `foo:bar` | throws: no such column: foo |
| `c++` | throws: fts5: syntax error near "+" |
| `"unterminated` | throws: unterminated string |
| `(` | throws: fts5: syntax error near "" |
| `*` | throws: unknown special query:  |
| `NOT` | throws: fts5: syntax error near "NOT" |
| `-foo` | throws: no such column: foo |
| `alice.perf` | throws: fts5: syntax error near "." |
| `e-mail` | throws: no such column: mail |
| `don't` | throws: fts5: syntax error near "'" |
| `50%` | throws: fts5: syntax error near "%" |
| `re:` | throws: no such column: re |

### List / thread / count endpoints (app.request, incl. JSON) — median / p95 ms

| endpoint | 10k median | 100k median | 500k median | 10k p95 | 100k p95 | 500k p95 | bytes @largest |
|---|---:|---:|---:|---:|---:|---:|---:|
| unified inbox offset 0 | 1.52 | 1.93 | 1.78 | 2.48 | 3.23 | 2.44 | 30018 |
| label Archive messages offset 0 | 0.92 | 1.10 | 1.51 | 5.23 | 7.02 | 6.60 | 28823 |
| all-messages offset 0 | 0.81 | 0.88 | 1.00 | 0.94 | 1.14 | 1.04 | 30078 |
| unified inbox offset 1000 | 1.54 | 2.40 | 2.84 | 2.76 | 3.87 | 3.04 | 29901 |
| label Archive messages offset 1000 | 2.27 | 2.04 | 2.32 | 9.73 | 6.98 | 2.48 | 28912 |
| all-messages offset 1000 | 1.24 | 0.95 | 1.03 | 1.63 | 1.25 | 1.48 | 29538 |
| all-messages offset 90% deep | 1.56 | 7.96 | 21.2 | 1.74 | 11.3 | 22.4 | 30258 |
| label Archive last page | 8.09 | 67.6 | 4918 | 8.49 | 86.8 | 5648 | 28077 |
| unread-messages offset 0 | 1.44 | 1.08 | 1.06 | 1.85 | 1.43 | 1.83 | 30027 |
| unread-messages offset 5000 | 21.8 | 1461 | 13.4 | 25.2 | 1557 | 14.5 | 30040 |
| unified inbox limit=200 | 3.89 | 5.48 | 3.24 | 9.93 | 13.5 | 4.65 | 119959 |
| labels list | 0.42 | 0.55 | 0.36 | 0.51 | 1.57 | 0.43 | 875 |
| unified/count (cached) | 0.39 | 0.45 | 0.24 | 0.54 | 0.63 | 0.28 | 31 |
| all-messages/count (cached) | 0.36 | 0.40 | 0.26 | 0.51 | 0.49 | 0.29 | 31 |
| labels/filter INBOX∩identity offset 0 | 12.3 | 190 | 874 | 15.6 | 233 | 922 | 29718 |
| labels/filter INBOX∩identity offset 10000 | 13.4 | 149 | 803 | 15.3 | 196 | 966 | 29970 |
| labels/filter/count INBOX∩identity | 14.2 | 1314 | 7096 | 20.9 | 1442 | 7591 | 31 |
| labels/:INBOX/related | 3.90 | 49.3 | 296 | 4.24 | 51.8 | 405 | 98 |
| labels/filter/related INBOX∩Lists | 1.88 | 31.3 | 231 | 2.11 | 35.8 | 237 | 2 |
| thread: last msg of N-msg thread | 14.6 | 15.3 | 19.6 | 23.1 | 21.6 | 32.1 | 950771 |
| thread: middle msg of N-msg thread | 6.94 | 6.28 | 8.23 | 14.1 | 12.6 | 14.9 | 456003 |
| thread: root of N-msg thread | 0.98 | 0.92 | 1.18 | 1.43 | 2.13 | 1.19 | 28612 |
| thread: ordinary reply | 0.75 | 1.12 | 0.91 | 0.90 | 1.60 | 1.11 | 19197 |
| message: largest text body | 0.97 | 1.41 | 1.53 | 1.03 | 7.33 | 1.97 | 106937 |
| message: typical | 0.45 | 0.56 | 0.83 | 0.62 | 1.01 | 0.89 | 21676 |
| unified inbox offset 10000 | – | 16.6 | 20.2 | – | 20.6 | 22.6 | 30270 |
| label Archive messages offset 10000 | – | 13.9 | 15.2 | – | 21.6 | 20.8 | 28998 |
| all-messages offset 10000 | – | 1.54 | 2.63 | – | 2.35 | 3.93 | 29896 |
| label Archive messages offset 49950 | – | 75.7 | 68.3 | – | 85.8 | 76.9 | 29301 |
| all-messages offset 49950 | – | 5.14 | 5.07 | – | 5.50 | 6.39 | 30257 |
| unified inbox offset 49950 | – | – | 81.2 | – | – | 96.5 | 29878 |

### Flag updates @10k (10000 msgs per run, 5 runs)

| variant | total ms median | updates/s median | KB written/update median |
|---|---:|---:|---:|
| A route PATCH /api/messages/:id/flags | 55747 | 179 | 218 |
| B sync-path UPDATE autocommit | 55503 | 180 | 217 |
| C sync-path UPDATE single txn | 17289 | 578 | 40.3 |
| D sync-path UPDATE autocommit, column-scoped trigger | 5724 | 1747 | 43.2 |

FTS data before: {"ftsDataRows":11791,"ftsDataMB":44.6} probe=11.6ms; after churn: {"ftsDataRows":37103,"ftsDataMB":139.59} probe=19.0ms; optimize: 6820ms, wrote 329.48MB, after {"ftsDataRows":11418,"ftsDataMB":42.87} probe=17.1ms; FTS integrity: ok

### Flag updates @100k (10000 msgs per run, 5 runs)

| variant | total ms median | updates/s median | KB written/update median |
|---|---:|---:|---:|
| A route PATCH /api/messages/:id/flags | 40646 | 246 | 222 |
| B sync-path UPDATE autocommit | 38060 | 263 | 222 |
| C sync-path UPDATE single txn | 16753 | 597 | 42.1 |
| D sync-path UPDATE autocommit, column-scoped trigger | 5951 | 1680 | 43.7 |

FTS data before: {"ftsDataRows":112520,"ftsDataMB":422.37} probe=54.1ms; after churn: {"ftsDataRows":174647,"ftsDataMB":655.71} probe=70.6ms; optimize: 25828ms, wrote 1515.36MB, after {"ftsDataRows":111833,"ftsDataMB":420.12} probe=66.3ms; FTS integrity: ok

### Flag updates @500k (10000 msgs per run, 5 runs)

| variant | total ms median | updates/s median | KB written/update median |
|---|---:|---:|---:|
| A route PATCH /api/messages/:id/flags | 41014 | 244 | 224 |
| B sync-path UPDATE autocommit | 36009 | 278 | 225 |
| C sync-path UPDATE single txn | 17086 | 585 | 42.5 |
| D sync-path UPDATE autocommit, column-scoped trigger | 5325 | 1878 | 42.9 |

FTS data before: {"ftsDataRows":571108,"ftsDataMB":2150.08} probe=390ms; after churn: {"ftsDataRows":610072,"ftsDataMB":2295.95} probe=397ms; optimize: 125509ms, wrote 5385.06MB, after {"ftsDataRows":567789,"ftsDataMB":2137.25} probe=418ms; FTS integrity: ok

### DB build (direct INSERT path) and per-cycle label maintenance

| size | insert rows/s | main DB MB | FTS MB (share) | messages table MB | refreshLabelCounts ms | applyFolderLabels no-op ms | applyIdentityLabel no-op ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| 100k | 360 | 1649.65 | 483.2 (29%) | 1109.59 | 12610 | 1301 | 98 |
| 500k | 314 | 8217.82 | 2396.62 (29%) | 5532.86 | 65918 | 9305 | 870 |

### Initial sync via IMAP (Dovecot -> ImapSync.syncAll -> SQLCipher)

| corpus | variant | runs | wall s median | msgs/s median (p95) | MB/s median | peak RSS MB median | cores used | ev-loop p99 / max ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 10k | default | 5 | 99.0 | 101 (103) | 4.44 | 403 | 1.05 | 96.4 / 553 |
| 10k | nofts | 3 | 68.5 | 146 (149) | 6.41 | 418 | 1.06 | 68.6 / 262 |
| 50k | default | 3 | 602 | 83.1 (91.2) | 3.81 | 555 | 1.05 | 125 / 1849 |

### Ingestion cost attribution (bench-insert-path.ts, 3000 msgs x 5 runs) — median

| stage | ms / message | msgs/s |
|---|---:|---:|
| SQLite INSERT: enc+autocommit+fts (real sync) | 2.93 | 342 |
| SQLite INSERT: enc+txn100+fts | 1.36 | 735 |
| SQLite INSERT: enc+autocommit+nofts | 0.82 | 1217 |
| SQLite INSERT: plain+autocommit+fts | 1.79 | 557 |
| CPU: mailparser simpleParser | 3.00 | – |
| CPU: htmlToText | 0.05 | – |
| CPU: deflate html_body + raw_headers | 0.18 | – |
| CPU: sha256 + deflate of attachments (avg over all msgs) | 0.89 | – |

### Root-cause diagnostics (diag-columns.ts) — median ms

| query | 10k | 100k | 500k |
|---|---:|---:|---:|
| COUNT(*) (covering index) | – | 0.04 | 0.21 |
| SUM(uid)  (col #5, before bodies) | – | 4.24 | 20.9 |
| SUM(length(subject)) (col #9) | – | 1394 | 6399 |
| COUNT flags NOT LIKE Seen (col after text_body/html_body) | – | 4589 | 20048 |
| SUM(has_attachments) (after bodies) | – | 1308 | 6296 |
| refreshLabelCounts query 1 (GROUP BY label) | – | 8267 | 44460 |
| applyFolderLabelsToMessages SELECT part (no-op) | – | 1334 | 6960 |
| search from: filter-only, as shipped (JOIN folders) | – | 1112 | 8071 |
| search from: filter-only, without JOIN folders | – | 3.28 | 5.88 |

Plans: filter-only search as shipped `SCAN f → SEARCH m USING INDEX idx_messages_pending_archive (folder_id=?) → USE TEMP B-TREE FOR ORDER BY`; without JOIN folders `SCAN m USING INDEX idx_messages_date`; refreshLabelCounts `SCAN ml USING INDEX idx_message_labels_label_v15 → SEARCH m USING INTEGER PRIMARY KEY (rowid=?)`.

### Concurrency @100k (+10k via IMAP), 8 req/s open-loop

| phase | duration s | requests | >100ms | >1s | latency median | p95 | max | ev-loop p99 | ev-loop max | RSS peak MB (anon / file) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | 30.1 | 240 | 0 | 0 | 4.40 | 11.8 | 17.9 | 10.3 | 46.7 | 132 (77.0 / 55.6) |
| initial-sync-10k (sync 136s, new 10000, refreshLabelCounts 13794ms) | 136 | 1089 | 184 | 107 | 12.0 | 7329 | 13857 | 126 | 13950 | 1944 (419 / 1536) |
| resync-0 (sync 14.7s, new 5, refreshLabelCounts 13124ms) | 14.8 | 119 | 108 | 100 | 5929 | 12532 | 13161 | 23.6 | 13179 | 1944 (409 / 1536) |
| resync-1 (sync 14.3s, new 5, refreshLabelCounts 13020ms) | 14.4 | 115 | 106 | 99 | 6047 | 12405 | 12958 | 20.2 | 13061 | 1947 (412 / 1536) |
| resync-2 (sync 14.4s, new 5, refreshLabelCounts 12966ms) | 14.5 | 116 | 106 | 99 | 5959 | 12300 | 12926 | 20.2 | 13002 | 1948 (413 / 1536) |
| resync-3 (sync 15.2s, new 5, refreshLabelCounts 13623ms) | 15.3 | 122 | 111 | 104 | 6211 | 12907 | 13565 | 22.7 | 13673 | 1949 (414 / 1536) |
| resync-4 (sync 14.1s, new 5, refreshLabelCounts 12546ms) | 14.1 | 113 | 102 | 95 | 5644 | 11838 | 12465 | 23.5 | 12591 | 1950 (414 / 1536) |
| post | 20.1 | 161 | 2 | 0 | 3.92 | 12.2 | 248 | 10.3 | 47.3 | 1950 (414 / 1536) |

### Concurrency @500k (+10k via IMAP), 8 req/s open-loop

| phase | duration s | requests | >100ms | >1s | latency median | p95 | max | ev-loop p99 | ev-loop max | RSS peak MB (anon / file) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | 30.2 | 242 | 0 | 0 | 4.94 | 22.8 | 32.3 | 10.6 | 52.3 | 144 (88.8 / 55.6) |
| initial-sync-10k (sync 189s, new 10000, refreshLabelCounts 72683ms) | 189 | 1516 | 654 | 583 | 37.6 | 63837 | 72769 | 68.9 | 72880 | 725 (668 / 57.8) |
| resync-0 (sync 73.1s, new 5, refreshLabelCounts 69215ms) | 73.3 | 586 | 555 | 555 | 34532 | 65800 | 69176 | 35.8 | 69323 | 727 (669 / 57.8) |
| resync-1 (sync 74.8s, new 5, refreshLabelCounts 70647ms) | 75.0 | 600 | 568 | 568 | 35227 | 67159 | 70673 | 37.6 | 70733 | 727 (670 / 57.8) |
| resync-2 (sync 75.4s, new 5, refreshLabelCounts 71144ms) | 75.6 | 605 | 573 | 573 | 34629 | 67638 | 71120 | 34.1 | 71203 | 727 (670 / 57.8) |
| post | 20.2 | 161 | 3 | 3 | 3.47 | 26.2 | 1868 | 22.0 | 35.4 | 727 (670 / 57.8) |

### Lifecycle: 100k-kdf-open-migrate

- Argon2id (m=64MiB,t=3,p=1, @noble/hashes): unlockWithPassword median 4102 ms (p95 4730); initializeEncryption 4123 ms
- openDatabase(): median 1.36 ms (p95 1.54); first inbox query 1.03 ms
- migration v29->v30: 2.46 ms median then FAILED: "no such column: date" (schema_version left at 29)
- migration v24->v30: 104249 ms median then FAILED: "no such column: date" (schema_version left at 24)
- full FTS rebuild ('rebuild', = v25 SQL / MessageSearch.rebuildIndex): 81545 ms median (p95 82150)

### Lifecycle: 100k-server-signals

- server: spawnToHealthyMs 542 (p95 653); unlockMs 5315 (p95 6195); firstInboxMs 9.34 (p95 14.5); secondInboxMs 6.01 (p95 6.92); firstSearchMs 30.1 (p95 34.9); readyTotalMs 5940 (p95 6904); rssAfterUnlockMB 167 (p95 171); idleShutdownMs 2973 (p95 2986); exitCode 0.00 (p95 0.00)
- SIGTERM at 2861 msgs (folder boundary): shutdown 13039 ms exit={"code":0,"signal":null}; after: quick=ok fts=ok msgs=2861 dupUid=0 dupMsgId=0 wal=0MB; restart ready 6697 ms, resume-to-complete 115508 ms; final msgs=10000 dupMsgId=0 integrity=ok fts=ok
- SIGTERM at 9279 msgs (folder boundary): shutdown 15190 ms exit={"code":0,"signal":null}; after: quick=ok fts=ok msgs=9279 dupUid=0 dupMsgId=0 wal=0MB; restart ready 5968 ms, resume-to-complete 36975 ms; final msgs=10000 dupMsgId=0 integrity=ok fts=ok
- SIGTERM at 9279 msgs (folder boundary): shutdown 14388 ms exit={"code":0,"signal":null}; after: quick=ok fts=ok msgs=9281 dupUid=0 dupMsgId=0 wal=0MB; restart ready 5994 ms, resume-to-complete 32231 ms; final msgs=10000 dupMsgId=0 integrity=ok fts=ok
- SIGKILL at 2861 msgs (folder boundary): shutdown 51 ms exit={"code":null,"signal":"SIGKILL"}; after: quick=ok fts=ok msgs=2861 dupUid=0 dupMsgId=0 wal=7.6MB; restart ready 5318 ms, resume-to-complete 105334 ms; final msgs=10000 dupMsgId=0 integrity=ok fts=ok
- SIGKILL at 9279 msgs (folder boundary): shutdown 58 ms exit={"code":null,"signal":"SIGKILL"}; after: quick=ok fts=ok msgs=9280 dupUid=0 dupMsgId=0 wal=11.92MB; restart ready 5452 ms, resume-to-complete 31709 ms; final msgs=10000 dupMsgId=0 integrity=ok fts=ok
- SIGKILL at 9279 msgs (folder boundary): shutdown 58 ms exit={"code":null,"signal":"SIGKILL"}; after: quick=ok fts=ok msgs=9279 dupUid=0 dupMsgId=0 wal=11.92MB; restart ready 4986 ms, resume-to-complete 33787 ms; final msgs=10000 dupMsgId=0 integrity=ok fts=ok

### Lifecycle: 100k-sigkill-timed

- SIGKILL 20000ms after unlock (1607 rows stored): shutdown 33 ms exit={"code":null,"signal":"SIGKILL"}; after: quick=ok fts=ok msgs=1607 dupUid=0 dupMsgId=0 wal=7.6MB; restart ready 4602 ms, resume-to-complete 106698 ms; final msgs=10000 dupMsgId=0 integrity=ok fts=ok
- SIGKILL 55000ms after unlock (5455 rows stored): shutdown 43 ms exit={"code":null,"signal":"SIGKILL"}; after: quick=ok fts=ok msgs=5455 dupUid=0 dupMsgId=0 wal=7.6MB; restart ready 5184 ms, resume-to-complete 72185 ms; final msgs=10000 dupMsgId=0 integrity=ok fts=ok
- SIGKILL 95000ms after unlock (8884 rows stored): shutdown 65 ms exit={"code":null,"signal":"SIGKILL"}; after: quick=ok fts=ok msgs=8884 dupUid=0 dupMsgId=0 wal=7.95MB; restart ready 5558 ms, resume-to-complete 37091 ms; final msgs=10000 dupMsgId=0 integrity=ok fts=ok

### Lifecycle: 500k

- Argon2id (m=64MiB,t=3,p=1, @noble/hashes): unlockWithPassword median 5254 ms (p95 5685); initializeEncryption 5340 ms
- openDatabase(): median 1.92 ms (p95 3.77); first inbox query 1.15 ms
- server: spawnToHealthyMs 493 (p95 641); unlockMs 4752 (p95 4945); firstInboxMs 13.0 (p95 16.8); secondInboxMs 9.71 (p95 15.9); firstSearchMs 66.9 (p95 91.8); readyTotalMs 5360 (p95 5732); rssAfterUnlockMB 178 (p95 180); idleShutdownMs 3037 (p95 68969); exitCode 0.00 (p95 0.00)
