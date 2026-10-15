/**
 * Build a large SQLCipher stork DB directly (no IMAP), for 100k/500k search/list benchmarks.
 *
 *   npx tsx audit/perf/build-db.ts --size 100k [--seed 1] [--force]
 *
 * Output: $WORK/db-bulk-<size>/{stork.db,stork-blobs.db,manifest.json}
 *
 * Path used (documented deviation from real sync):
 *  - DB opened with the app's openDatabase() (SQLCipher key, WAL, pragmas, full migrations).
 *  - Folders inserted with the same columns syncFolders() writes.
 *  - Messages inserted with the *identical* INSERT statement used by ImapSync.fetchUidBatch()
 *    (src/sync/imap-sync.ts ~:771), with the same value transforms (compressText for html/raw_headers,
 *    htmlToText for html_text_body, JSON arrays for addresses, comma-joined flags) and
 *    upsertAttachmentBlob() for attachments. FTS rows are produced by the real messages_ai trigger.
 *  - Differences: no IMAP/mailparser (fields come from the generator directly); inserts wrapped
 *    in transactions of 1000 rows (real sync autocommits each message); attachment bytes drawn
 *    from a pool of 64 payloads (bounds stork-blobs.db; dedup via content hash like the real code).
 *  - Labels + cached counts produced by the real ImapSync methods ensureLabelsForFolders(),
 *    applyFolderLabelsToMessages(), ensureIdentityLabel(), applyIdentityLabelToMessages(),
 *    refreshLabelCounts() — their timings at this scale are recorded (they run every sync cycle).
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../src/storage/db.js";
import { upsertAttachmentBlob } from "../../src/storage/attachment-storage.js";
import { compressText } from "../../src/storage/compression.js";
import { htmlToText } from "../../src/storage/html-to-text.js";
import { ImapSync } from "../../src/sync/imap-sync.js";
import { CorpusGenerator, FOLDERS, expectedCounts, headerBlock } from "./lib/corpus.js";
import { dbstatSummary } from "./lib/dbstat.js";
import { MB, WORK, arg, dbFiles, ensureDir, envSnapshot, flag, parseSize, sizeLabel, vaultKey, writeResult } from "./lib/env.js";

const n = parseSize(arg("size", "100k") as string);
const seed = Number(arg("seed", "1"));
const label = sizeLabel(n);
const dir = join(WORK, `db-bulk-${label}`);
if (existsSync(join(dir, "manifest.json")) && !flag("force")) {
	console.log(`${dir} already built (use --force to rebuild)`);
	process.exit(0);
}
rmSync(dir, { recursive: true, force: true });
ensureDir(dir);
const env = envSnapshot();
const db = openDatabase("stork.db", dir, vaultKey());

// Unreachable IMAP endpoint: if a real server/scheduler is ever started on this DB, sync fails fast
// instead of flag-syncing against Dovecot (which would "expunge" every row).
const connectorId = Number(
	db
		.prepare("INSERT INTO inbound_connectors (name, type, imap_host, imap_port, imap_tls, imap_user, imap_pass) VALUES ('perf-bulk','imap','127.0.0.1',1,0,'alice','alicepass')")
		.run().lastInsertRowid,
);
const special: Record<string, string | null> = { INBOX: "\\Inbox", Archive: "\\Archive", Sent: "\\Sent", Trash: "\\Trash", "Lists/dev": null };
const folderIds: Record<string, number> = {};
for (const f of FOLDERS) {
	folderIds[f] = Number(
		db
			.prepare("INSERT INTO folders (inbound_connector_id, path, name, delimiter, flags, special_use, uid_validity) VALUES (?,?,?,?,?,?,?)")
			.run(connectorId, f, f.split("/").pop(), "/", "[]", special[f], 1700000000).lastInsertRowid,
	);
}

// Identical to ImapSync.fetchUidBatch()
const insertMessage = db.prepare(`
			INSERT OR IGNORE INTO messages (
				inbound_connector_id, folder_id, uid, message_id, in_reply_to, "references",
				subject, from_address, from_name, to_addresses, cc_addresses, bcc_addresses,
				date, text_body, html_text_body, html_body, flags, size, has_attachments, raw_headers
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
const insertAttachment = db.prepare(`
			INSERT INTO attachments (message_id, filename, content_type, size, content_id, content_hash)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

const gen = new CorpusGenerator(n, seed, { attachmentMode: "pool" });
const uidNext: Record<string, number> = Object.fromEntries(FOLDERS.map((f) => [f, 1]));
const longThreadIds: Record<number, number[]> = {};
let rawBytes = 0;
const t0 = performance.now();
let genMs = 0;
const BATCH = 1000;
const insertBatch = db.transaction((batch: ReturnType<typeof gen.message>[]) => {
	for (const m of batch) {
		const html = m.html;
		const headers = headerBlock(m).join("\r\n");
		const size = headers.length + m.text.length + (html?.length ?? 0) + m.attachments.reduce((a, x) => a + Math.ceil(x.data.length * 1.37), 0) + 200;
		rawBytes += size;
		const uid = uidNext[m.folder]++;
		const r = insertMessage.run(
			connectorId,
			folderIds[m.folder],
			uid,
			m.messageId,
			m.inReplyTo,
			m.references.length ? JSON.stringify(m.references) : null,
			m.subject,
			m.from.address,
			m.from.name,
			JSON.stringify(m.to.map((p) => p.address)),
			m.cc.length ? JSON.stringify(m.cc.map((p) => p.address)) : null,
			null,
			m.date.toISOString(),
			m.text,
			htmlToText(html),
			html ? compressText(html) : null,
			m.flags.join(","),
			size,
			m.attachments.length > 0 ? 1 : 0,
			compressText(headers),
		);
		if (m.longThread !== null) (longThreadIds[m.longThread] ??= []).push(Number(r.lastInsertRowid));
		for (const a of m.attachments) {
			const hash = upsertAttachmentBlob(db, a.data);
			insertAttachment.run(r.lastInsertRowid, a.filename, a.contentType, a.data.length, null, hash);
		}
	}
});
let batch: ReturnType<typeof gen.message>[] = [];
let tg = performance.now();
for (let i = 0; i < n; i++) {
	batch.push(gen.message(i));
	if (batch.length === BATCH || i === n - 1) {
		genMs += performance.now() - tg;
		insertBatch(batch);
		batch = [];
		tg = performance.now();
		if ((i + 1) % 50000 === 0) console.log(`  ${i + 1}/${n}  ${((performance.now() - t0) / 1000).toFixed(0)}s  main=${MB(dbFiles(dir).main)}MB wal=${MB(dbFiles(dir).mainWal)}MB`);
	}
}
const insertMs = performance.now() - t0;
for (const f of FOLDERS) {
	db.prepare("INSERT INTO sync_state (inbound_connector_id, folder_id, last_uid, last_synced_at) VALUES (?,?,?,datetime('now'))").run(connectorId, folderIds[f], uidNext[f] - 1);
	db.prepare("UPDATE folders SET uid_next=?, message_count=? WHERE id=?").run(uidNext[f], uidNext[f] - 1, folderIds[f]);
}

// Real sync-cycle label maintenance (constructor does not connect).
const sync = new ImapSync({ host: "127.0.0.1", port: 1, secure: false, auth: { user: "x", pass: "x" } }, db, connectorId);
const timeIt = (fn: () => void) => {
	const t = performance.now();
	fn();
	return Math.round(performance.now() - t);
};
const labelTimings = {
	ensureLabelsForFoldersMs: timeIt(() => sync.ensureLabelsForFolders()),
	applyFolderLabelsToMessagesMs: timeIt(() => sync.applyFolderLabelsToMessages()),
	ensureIdentityLabelMs: timeIt(() => sync.ensureIdentityLabel()),
	applyIdentityLabelToMessagesMs: timeIt(() => sync.applyIdentityLabelToMessages()),
	refreshLabelCountsMs: timeIt(() => sync.refreshLabelCounts()),
	applyFolderLabelsToMessages_noopMs: timeIt(() => sync.applyFolderLabelsToMessages()),
	applyIdentityLabelToMessages_noopMs: timeIt(() => sync.applyIdentityLabelToMessages()),
	refreshLabelCounts_secondMs: timeIt(() => sync.refreshLabelCounts()),
};
const preCk = dbFiles(dir);
const tc = performance.now();
db.pragma("wal_checkpoint(TRUNCATE)");
db.exec("PRAGMA blobs.wal_checkpoint(TRUNCATE)");
const ckptMs = performance.now() - tc;
const labels = db.prepare("SELECT id, name, source, message_count, unread_count FROM labels").all();
const ds = dbstatSummary(db);
db.close();
const manifest = {
	n,
	seed,
	dir,
	connectorId,
	folderIds,
	labels,
	longThreadIds,
	expected: expectedCounts(n, seed),
};
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
const files = dbFiles(dir);
writeResult(`build-db-${label}`, {
	env,
	n,
	seed,
	path: "direct INSERT (same SQL as ImapSync.fetchUidBatch), txn batches of 1000",
	insertMs: Math.round(insertMs),
	generatorMs: Math.round(genMs),
	insertRowsPerSec: Math.round(n / ((insertMs - genMs) / 1000)),
	approxRawMB: MB(rawBytes),
	labelTimings,
	walBeforeCheckpointMB: MB(preCk.mainWal),
	checkpointMs: Math.round(ckptMs),
	filesMB: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, MB(v)])),
	dbstat: ds,
	labels,
});
process.exit(0);
