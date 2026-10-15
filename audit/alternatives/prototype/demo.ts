/**
 * THROWAWAY PROTOTYPE (audit only). Ingest a generated mbsync Maildir into a fresh
 * Stork DB, search it with the app's MessageSearch, and round-trip UI actions to files.
 *
 *   npx tsx audit/alternatives/prototype/gen-maildir.ts --n 1000
 *   npx tsx audit/alternatives/prototype/demo.ts [--dir /tmp/stork-audit-maildir]
 */
import { existsSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { MessageSearch } from "../../../src/search/search.js";
import { createTestDb } from "../../../src/test-helpers/test-db.js";
import { arg } from "../../perf/lib/env.js";
import { type Layout, reconcile, readRaw, scan, writeFlags, writeMove, writeRemoveCopy } from "./maildir-view.js";

const dir = arg("dir", "/tmp/stork-audit-maildir") as string;
const db = createTestDb();
const accts: { name: string; root: string; layout: Layout; cid: number }[] = [
	{ name: "Gmail", root: join(dir, "gmail"), layout: "verbatim", cid: 0 },
	{ name: "Namecheap", root: join(dir, "namecheap"), layout: "maildir++", cid: 0 },
];
for (const a of accts) {
	db.prepare("INSERT INTO inbound_connectors (name, type) VALUES (?, 'maildir')").run(a.name);
	a.cid = (db.prepare("SELECT last_insert_rowid() id").get() as { id: number }).id;
}
const out: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail?: unknown) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`, detail ?? ""); out[name] = { ok, detail }; };

const [g, nc] = accts;
for (const a of accts) out[`initial-${a.name}`] = await reconcile(db, a.cid, a.root, a.layout);
console.log(out);
const q = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as any;
const files = scan(g.root, g.layout).length + scan(nc.root, nc.layout).length;
const msgs = q("SELECT COUNT(*) n FROM messages").n;
check("one row per logical message (Gmail All Mail copies collapsed)", msgs < files, { files, msgs });
check("idempotent rescan", (await reconcile(db, g.cid, g.root, g.layout)).inserted === 0);

// Search through the unchanged app search module.
const search = new MessageSearch(db);
for (const query of ["xylomedianta", '"quantum harvest"', "label:Lists/dev xylocommona", "label:Lists/dev", "from:needle.sender@known-corp.example"]) {
	const t = performance.now();
	try {
		const r = search.search(query, { limit: 1000 });
		console.log(`search ${query}: ${r.length} hits ${(performance.now() - t).toFixed(1)}ms`);
	} catch (e) {
		// Pre-existing app bug (not Maildir-specific): label: + free text binds params in the wrong
		// order (search.ts pushes the MATCH param before the label JOIN param that precedes it in SQL).
		console.log(`search ${query}: ERROR ${(e as Error).message}`);
	}
}
check("FTS finds Maildir-ingested mail", search.search("xylomedianta").length > 0);

// 1. UI flag write-back: star + read an INBOX message that has an All Mail copy.
const m = q(`SELECT f.message_id id FROM maildir_files f WHERE f.connector_id = ? AND f.folder = 'INBOX'
	AND f.sub = 'new' AND (SELECT COUNT(*) FROM maildir_files x WHERE x.message_id = f.message_id) = 2 LIMIT 1`, g.cid);
writeFlags(db, g.root, g.layout, m.id, ["\\Seen", "\\Flagged"], []);
const names = (db.prepare("SELECT folder, sub, name FROM maildir_files WHERE message_id = ?").all(m.id) as any[]);
check("flag write-back renames every copy to :2,FS in cur/", names.every((n) => n.sub === "cur" && n.name.endsWith(":2,FS") && existsSync(join(g.root, n.folder, "cur", n.name))), names);
check("write-back is not seen as a change on rescan", (await reconcile(db, g.cid, g.root, g.layout)).flagChanges === 0);

// 2. External flag change (what mbsync does after a phone marks mail read).
const inbox = join(nc.root, "cur");
const victim = readdirSync(inbox).find((n) => n.endsWith(":2,"))!;
renameSync(join(inbox, victim), join(inbox, `${victim}S`));
const r2 = await reconcile(db, nc.cid, nc.root, nc.layout);
check("external rename picked up as flag change", r2.flagChanges === 1 && r2.inserted === 0, r2);

// 3. External move (mbsync: server-side move = expunge in A + new file in B, new name).
const mv = readdirSync(inbox).find((n) => n.endsWith(":2,"))!;
renameSync(join(inbox, mv), join(nc.root, ".Archive", "cur", `9${mv.replace(/,U=\d+/, ",U=99999")}`));
const r3 = await reconcile(db, nc.cid, nc.root, nc.layout);
check("external move detected via content hash (row id + labels kept)", r3.moves === 1 && r3.inserted === 0 && r3.deletedMsgs === 0, r3);

// 4. UI move write-back (Namecheap): file lands in target cur/ with ,U= stripped.
const mm = q("SELECT message_id id FROM maildir_files WHERE connector_id = ? AND folder = 'INBOX' LIMIT 1", nc.cid);
writeMove(db, nc.cid, nc.root, nc.layout, mm.id, "INBOX", "Archive");
const moved = q("SELECT name FROM maildir_files WHERE message_id = ?", mm.id).name as string;
check("UI move -> file renamed into .Archive/cur without ,U=", !moved.includes(",U=") && existsSync(join(nc.root, ".Archive", "cur", moved)), moved);
check("UI move stable on rescan", (await reconcile(db, nc.cid, nc.root, nc.layout)).moves === 0);

// 5. Gmail archive = drop INBOX copy, keep All Mail copy; message + labels survive.
const ga = q(`SELECT f.message_id id FROM maildir_files f WHERE f.connector_id = ? AND f.folder='INBOX'
	AND EXISTS (SELECT 1 FROM maildir_files x WHERE x.message_id=f.message_id AND x.folder='[Gmail]/All Mail') LIMIT 1`, g.cid);
writeRemoveCopy(db, g.cid, g.root, g.layout, ga.id, "INBOX");
const labels = (db.prepare("SELECT l.name FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = ?").all(ga.id) as any[]).map((x) => x.name);
check("Gmail archive keeps message, drops INBOX label", !labels.includes("INBOX") && labels.includes("[Gmail]/All Mail"), labels);

// 6. Upstream expunge of last copy removes row (DB is a cache; raw stays authoritative upstream).
const del = q("SELECT message_id id, name FROM maildir_files WHERE connector_id = ? AND folder='Sent' LIMIT 1", nc.cid);
unlinkSync(join(nc.root, ".Sent", "cur", del.name));
const r6 = await reconcile(db, nc.cid, nc.root, nc.layout);
check("upstream expunge of last copy removes row", r6.deletedMsgs === 1 && !q("SELECT 1 x FROM messages WHERE id=?", del.id), r6);

// 7. Raw source available lazily from disk.
check("raw RFC822 readable from Maildir", readRaw(db, g.root, g.layout, m.id).toString().startsWith("Return-Path:"));
console.log(JSON.stringify(out, null, 1).length, "bytes of results");
