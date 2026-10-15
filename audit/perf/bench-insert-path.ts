/**
 * Attribution micro-benchmark for the ingestion path: where does a synced message's time go?
 * Uses the exact INSERT statement from ImapSync.fetchUidBatch and the same value transforms.
 *
 *   npx tsx audit/perf/bench-insert-path.ts [--count 5000] [--runs 5]
 *
 * Variants (fresh DB each run, no IMAP):
 *   enc+autocommit+fts   = what real sync does (one implicit txn per message)
 *   enc+txn100+fts       = same, wrapped per 100-message IMAP batch (counterfactual)
 *   enc+autocommit+nofts = messages_ai trigger dropped
 *   plain+autocommit+fts = no SQLCipher key
 * Plus CPU-only stages: mailparser simpleParser on the RFC822, htmlToText, compressText,
 * and attachment hashing+deflate (upsertAttachmentBlob's CPU work).
 */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import { openDatabase } from "../../src/storage/db.js";
import { compressBuffer, compressText } from "../../src/storage/compression.js";
import { htmlToText } from "../../src/storage/html-to-text.js";
import { CorpusGenerator, headerBlock, toRfc822 } from "./lib/corpus.js";
import { WORK, arg, ensureDir, envSnapshot, stats, vaultKey, writeResult } from "./lib/env.js";

const count = Number(arg("count", "5000"));
const runs = Number(arg("runs", "5"));
const gen = new CorpusGenerator(count, 3, { attachmentMode: "unique" });
const msgs = [...gen.all()];
const raws = msgs.map(toRfc822);

function insertRun(enc: boolean, mode: "auto" | "txn100", fts: boolean) {
	const dir = join(WORK, "insert-path");
	rmSync(dir, { recursive: true, force: true });
	ensureDir(dir);
	const db = openDatabase("stork.db", dir, enc ? vaultKey() : undefined);
	if (!fts) db.exec("DROP TRIGGER messages_ai");
	const cid = Number(db.prepare("INSERT INTO inbound_connectors (name,type) VALUES ('x','imap')").run().lastInsertRowid);
	const fid = Number(db.prepare("INSERT INTO folders (inbound_connector_id,path,name) VALUES (?,?,?)").run(cid, "INBOX", "INBOX").lastInsertRowid);
	const ins = db.prepare(`
			INSERT OR IGNORE INTO messages (
				inbound_connector_id, folder_id, uid, message_id, in_reply_to, "references",
				subject, from_address, from_name, to_addresses, cc_addresses, bcc_addresses,
				date, text_body, html_text_body, html_body, flags, size, has_attachments, raw_headers
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	// pre-compute values so only SQLite time is measured
	const vals = msgs.map((m, i) => [cid, fid, i + 1, m.messageId, m.inReplyTo, m.references.length ? JSON.stringify(m.references) : null, m.subject, m.from.address, m.from.name, JSON.stringify(m.to.map((p) => p.address)), null, null, m.date.toISOString(), m.text, htmlToText(m.html), m.html ? compressText(m.html) : null, m.flags.join(","), raws[i].length, 0, compressText(headerBlock(m).join("\r\n"))]);
	const t0 = performance.now();
	if (mode === "auto") for (const v of vals) ins.run(...v);
	else {
		const tx = db.transaction((b: unknown[][]) => {
			for (const v of b) ins.run(...v);
		});
		for (let i = 0; i < vals.length; i += 100) tx(vals.slice(i, i + 100));
	}
	const ms = performance.now() - t0;
	const segs = (db.prepare("SELECT COUNT(*) c FROM messages_fts_data").get() as { c: number }).c;
	db.close();
	rmSync(dir, { recursive: true, force: true });
	return { ms, perMsgMs: ms / count, ftsDataRows: segs };
}

const env = envSnapshot();
const out: Record<string, unknown> = { env, count, runs };
const variants: [string, boolean, "auto" | "txn100", boolean][] = [
	["enc+autocommit+fts (real sync)", true, "auto", true],
	["enc+txn100+fts", true, "txn100", true],
	["enc+autocommit+nofts", true, "auto", false],
	["plain+autocommit+fts", false, "auto", true],
];
const vres: Record<string, unknown> = {};
for (const [name, enc, mode, fts] of variants) {
	const xs = [];
	for (let k = 0; k < runs; k++) xs.push(insertRun(enc, mode, fts));
	vres[name] = { perMsgMs: stats(xs.map((x) => x.perMsgMs)), msgsPerSec: stats(xs.map((x) => count / (x.ms / 1000))), ftsDataRows: xs[0].ftsDataRows };
	console.log(name, JSON.stringify(vres[name]));
}
out.sqliteInsert = vres;

// CPU-only stages
const cpu: Record<string, unknown> = {};
for (let k = 0; k < runs; k++) {
	const t = { parse: 0, html: 0, compress: 0, attach: 0 };
	for (let i = 0; i < count; i++) {
		let t0 = performance.now();
		const p = await simpleParser(raws[i]);
		t.parse += performance.now() - t0;
		t0 = performance.now();
		htmlToText(typeof p.html === "string" ? p.html : null);
		t.html += performance.now() - t0;
		t0 = performance.now();
		if (typeof p.html === "string") compressText(p.html);
		compressText(headerBlock(msgs[i]).join("\r\n"));
		t.compress += performance.now() - t0;
		t0 = performance.now();
		for (const a of p.attachments) {
			createHash("sha256").update(a.content).digest("hex");
			compressBuffer(a.content);
		}
		t.attach += performance.now() - t0;
	}
	for (const [kk, v] of Object.entries(t)) ((cpu[kk] as number[]) ??= []).push(v / count);
}
out.cpuPerMsgMs = Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, stats(v as number[])]));
const attMsgs = msgs.filter((m) => m.attachments.length);
out.attachmentNote = { messagesWithAttachments: attMsgs.length, avgAttachmentKB: Math.round(attMsgs.reduce((a, m) => a + m.attachments[0].data.length, 0) / attMsgs.length / 1024) };
console.log(JSON.stringify(out.cpuPerMsgMs, null, 1));
writeResult("insert-path", out);
process.exit(0);
