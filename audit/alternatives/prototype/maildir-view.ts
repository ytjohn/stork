/**
 * THROWAWAY PROTOTYPE (audit only — never imported by app code).
 * Stork as a *view* over an mbsync-managed Maildir: mbsync is the only IMAP client;
 * this module (1) reconciles the Maildir into a Stork DB using the app's existing
 * storeInboundEmail(), and (2) writes UI actions back as Maildir renames that mbsync
 * then propagates.  Side table maildir_files maps one logical message -> N files.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { storeInboundEmail } from "../../../src/storage/email-storage.js";

const FLAG_TO_IMAP: Record<string, string> = { S: "\\Seen", F: "\\Flagged", R: "\\Answered", D: "\\Draft", T: "\\Deleted" };
const IMAP_TO_FLAG = Object.fromEntries(Object.entries(FLAG_TO_IMAP).map(([k, v]) => [v, k]));

export interface MFile { folder: string; sub: "cur" | "new"; name: string; uniq: string; flags: string }
/** Maildir unique part = name up to the first ',' (mbsync's ,U=<uid>, ,S=<size>) or ':' (info). */
export const uniqOf = (name: string) => name.split(/[,:]/)[0];
export const flagsOf = (name: string) => (name.includes(":2,") ? name.slice(name.indexOf(":2,") + 3) : "");
const imapFlags = (letters: string) => [...letters].map((c) => FLAG_TO_IMAP[c]).filter(Boolean).join(",");
const fpath = (root: string, f: { folder: string; sub: string; name: string }, layout: Layout) =>
	join(root, folderDir(f.folder, layout), f.sub, f.name);

export type Layout = "verbatim" | "maildir++";
function folderDir(folder: string, layout: Layout): string {
	if (layout === "verbatim") return folder;
	return folder === "INBOX" ? "" : `.${folder.replace(/\//g, ".")}`;
}

/** Walk an mbsync Maildir tree. Folder = any dir with cur/ and new/. */
export function scan(root: string, layout: Layout): MFile[] {
	if (!existsSync(root)) throw new Error(`maildir root missing: ${root} — refusing to reconcile (would delete everything)`);
	const out: MFile[] = [];
	const walk = (dir: string) => {
		const ents = readdirSync(dir, { withFileTypes: true });
		if (ents.some((e) => e.name === "cur") && ents.some((e) => e.name === "new")) {
			const rel = relative(root, dir).split(sep).join("/");
			const folder = layout === "verbatim" ? rel || "INBOX" : rel === "" ? "INBOX" : rel.slice(1).replace(/\./g, "/");
			for (const sub of ["cur", "new"] as const)
				for (const name of readdirSync(join(dir, sub))) out.push({ folder, sub, name, uniq: uniqOf(name), flags: flagsOf(name) });
		}
		for (const e of ents) if (e.isDirectory() && !["cur", "new", "tmp"].includes(e.name) && (layout === "verbatim" || dir === root)) walk(join(dir, e.name));
	};
	walk(root);
	return out;
}

export function ensureSideTable(db: Database.Database) {
	db.exec(`CREATE TABLE IF NOT EXISTS maildir_files (
		connector_id INTEGER NOT NULL, folder TEXT NOT NULL, uniq TEXT NOT NULL,
		sub TEXT NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL,
		message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
		PRIMARY KEY (connector_id, folder, uniq));
	CREATE INDEX IF NOT EXISTS idx_mf_sha ON maildir_files(connector_id, sha256);
	CREATE INDEX IF NOT EXISTS idx_mf_msg ON maildir_files(message_id);`);
}

function folderIdFor(db: Database.Database, cid: number, path: string): number {
	db.prepare(`INSERT INTO folders (inbound_connector_id, path, name, delimiter, flags, message_count, unread_count)
		VALUES (?, ?, ?, '/', '[]', 0, 0) ON CONFLICT DO NOTHING`).run(cid, path, path.split("/").pop());
	db.prepare("INSERT INTO labels (name, source) VALUES (?, 'imap') ON CONFLICT(name) DO NOTHING").run(path);
	return (db.prepare("SELECT id FROM folders WHERE inbound_connector_id = ? AND path = ?").get(cid, path) as { id: number }).id;
}

/** Folder-derived labels = set of folders holding a copy (Gmail labels via mbsync). */
function relabel(db: Database.Database, msgId: number) {
	db.prepare(`DELETE FROM message_labels WHERE message_id = ? AND label_id IN (SELECT id FROM labels WHERE source='imap')`).run(msgId);
	db.prepare(`INSERT OR IGNORE INTO message_labels (message_id, label_id, date)
		SELECT ?, l.id, (SELECT date FROM messages WHERE id = ?) FROM maildir_files f JOIN labels l ON l.name = f.folder
		WHERE f.message_id = ?`).run(msgId, msgId, msgId);
}

export interface ReconcileStats { files: number; inserted: number; copies: number; flagChanges: number; moves: number; removed: number; deletedMsgs: number; hackMsgIdDedupe: number; ms: number }

/** Full reconcile: Maildir is the truth, DB is a rebuildable cache. */
export async function reconcile(db: Database.Database, cid: number, root: string, layout: Layout): Promise<ReconcileStats> {
	const t0 = performance.now();
	ensureSideTable(db);
	const files = scan(root, layout);
	const s: ReconcileStats = { files: files.length, inserted: 0, copies: 0, flagChanges: 0, moves: 0, removed: 0, deletedMsgs: 0, hackMsgIdDedupe: 0, ms: 0 };
	const known = new Map<string, { sub: string; name: string; sha256: string; message_id: number }>();
	for (const r of db.prepare("SELECT folder, uniq, sub, name, sha256, message_id FROM maildir_files WHERE connector_id = ?").all(cid) as any[])
		known.set(`${r.folder}\0${r.uniq}`, r);
	const seen = new Set<string>();
	const fresh: MFile[] = [];
	const upd = db.prepare("UPDATE maildir_files SET sub = ?, name = ? WHERE connector_id = ? AND folder = ? AND uniq = ?");
	const setFlags = db.prepare("UPDATE messages SET flags = ? WHERE id = ?");
	for (const f of files) {
		const k = `${f.folder}\0${f.uniq}`;
		seen.add(k);
		const row = known.get(k);
		if (!row) { fresh.push(f); continue; }
		if (row.name !== f.name || row.sub !== f.sub) {
			upd.run(f.sub, f.name, cid, f.folder, f.uniq);
			if (flagsOf(row.name) !== f.flags) { setFlags.run(imapFlags(f.flags), row.message_id); s.flagChanges++; }
		}
	}
	// Vanished locations, indexed by content hash so a vanish+appear pair is treated as a MOVE.
	const vanished = new Map<string, { folder: string; uniq: string; message_id: number }[]>();
	for (const [k, r] of known) if (!seen.has(k)) {
		const [folder, uniq] = k.split("\0");
		(vanished.get(r.sha256) ?? vanished.set(r.sha256, []).get(r.sha256)!).push({ folder, uniq, message_id: r.message_id });
	}
	const ins = db.prepare("INSERT INTO maildir_files (connector_id, folder, uniq, sub, name, sha256, message_id) VALUES (?,?,?,?,?,?,?)");
	const bySha = db.prepare("SELECT message_id FROM maildir_files WHERE connector_id = ? AND sha256 = ? LIMIT 1");
	const touched = new Set<number>();
	for (const f of fresh) {
		const raw = readFileSync(fpath(root, f, layout));
		const sha = createHash("sha256").update(raw).digest("hex");
		folderIdFor(db, cid, f.folder);
		const mv = vanished.get(sha)?.shift();
		if (mv) {
			db.prepare("DELETE FROM maildir_files WHERE connector_id = ? AND folder = ? AND uniq = ?").run(cid, mv.folder, mv.uniq);
			ins.run(cid, f.folder, f.uniq, f.sub, f.name, sha, mv.message_id);
			db.prepare("UPDATE messages SET folder_id = ?, flags = ? WHERE id = ?").run(folderIdFor(db, cid, f.folder), imapFlags(f.flags), mv.message_id);
			touched.add(mv.message_id); s.moves++; continue;
		}
		const dup = bySha.get(cid, sha) as { message_id: number } | undefined;
		if (dup) { ins.run(cid, f.folder, f.uniq, f.sub, f.name, sha, dup.message_id); touched.add(dup.message_id); s.copies++; continue; }
		// Reuse the app's ingest path unchanged (webhook/R2 share it). It hard-wires folder=INBOX,
		// adds the Inbox label, and silently drops same-Message-ID messages — fixed up below.
		const r = await storeInboundEmail(db, cid, { from: "", to: "", raw: raw.toString("base64"), rawSize: raw.length });
		let id: number;
		// HACK: storeInboundEmail does not return the new row id (last_insert_rowid is clobbered by label inserts).
		if (r.stored) id = (db.prepare("SELECT MAX(id) AS id FROM messages WHERE inbound_connector_id = ?").get(cid) as { id: number }).id;
		else {
			// HACK: storeInboundEmail returned stored=0 (Message-ID dedupe) without telling us which row.
			s.hackMsgIdDedupe++;
			const mid = /^message-id:\s*(\S+)/im.exec(raw.subarray(0, 8192).toString())?.[1];
			id = (db.prepare("SELECT id FROM messages WHERE inbound_connector_id = ? AND message_id = ?").get(cid, mid) as { id: number }).id;
		}
		if (r.stored) {
			// HACK: UNIQUE(folder_id, uid) — Maildir has no per-folder UID we own; use uid = -rowid.
			db.prepare("UPDATE messages SET folder_id = ?, uid = -id, flags = ? WHERE id = ?").run(folderIdFor(db, cid, f.folder), imapFlags(f.flags), id);
			s.inserted++;
		} else s.copies++;
		ins.run(cid, f.folder, f.uniq, f.sub, f.name, sha, id);
		touched.add(id);
	}
	for (const list of vanished.values()) for (const v of list) {
		db.prepare("DELETE FROM maildir_files WHERE connector_id = ? AND folder = ? AND uniq = ?").run(cid, v.folder, v.uniq);
		touched.add(v.message_id); s.removed++;
	}
	for (const id of touched) {
		if (!db.prepare("SELECT 1 FROM maildir_files WHERE message_id = ?").get(id)) {
			db.prepare("DELETE FROM messages WHERE id = ?").run(id); s.deletedMsgs++; // last copy gone upstream
		} else relabel(db, id);
	}
	s.ms = Math.round(performance.now() - t0);
	return s;
}

const locs = (db: Database.Database, msgId: number) =>
	db.prepare("SELECT connector_id, folder, uniq, sub, name FROM maildir_files WHERE message_id = ?").all(msgId) as (MFile & { connector_id: number })[];

/** UI flag change -> rename every copy (new/ -> cur/ as the Maildir spec requires once info is set). */
export function writeFlags(db: Database.Database, root: string, layout: Layout, msgId: number, add: string[], remove: string[]) {
	const row = db.prepare("SELECT flags FROM messages WHERE id = ?").get(msgId) as { flags: string };
	const set = new Set((row.flags ?? "").split(",").filter(Boolean));
	for (const f of add) set.add(f);
	for (const f of remove) set.delete(f);
	const letters = [...set].map((f) => IMAP_TO_FLAG[f]).filter(Boolean).sort().join("");
	for (const l of locs(db, msgId)) {
		const base = l.name.includes(":2,") ? l.name.slice(0, l.name.indexOf(":2,")) : l.name;
		const next = { folder: l.folder, sub: "cur", name: `${base}:2,${letters}` };
		renameSync(fpath(root, l, layout), fpath(root, next, layout)); // atomic; ENOENT => mbsync raced us, rescan+retry
		db.prepare("UPDATE maildir_files SET sub='cur', name=? WHERE connector_id=? AND folder=? AND uniq=?").run(next.name, l.connector_id, l.folder, l.uniq);
	}
	db.prepare("UPDATE messages SET flags = ? WHERE id = ?").run([...set].join(","), msgId);
}

/** UI move -> rename into target folder, stripping mbsync's ,U=<uid> (else mbsync sees a duplicate UID). */
export function writeMove(db: Database.Database, cid: number, root: string, layout: Layout, msgId: number, from: string, to: string) {
	const l = locs(db, msgId).find((x) => x.folder === from);
	if (!l) throw new Error(`message ${msgId} has no copy in ${from}`);
	const name = `${l.uniq}.stork-mv${l.name.includes(":2,") ? l.name.slice(l.name.indexOf(":2,")) : ":2,"}`;
	const next = { folder: to, sub: "cur", name };
	statSync(join(root, folderDir(to, layout), "cur")); // target must exist (mbsync Create Both / Near)
	renameSync(fpath(root, l, layout), fpath(root, next, layout));
	db.prepare("UPDATE maildir_files SET folder=?, uniq=?, sub='cur', name=? WHERE connector_id=? AND folder=? AND uniq=?").run(to, uniqOf(name), name, cid, from, l.uniq);
	db.prepare("UPDATE messages SET folder_id = ? WHERE id = ?").run(folderIdFor(db, cid, to), msgId);
	relabel(db, msgId);
}

/** Gmail "archive"/"remove label" = remove that folder's copy only; mbsync propagates the expunge. */
export function writeRemoveCopy(db: Database.Database, cid: number, root: string, layout: Layout, msgId: number, folder: string) {
	const l = locs(db, msgId).find((x) => x.folder === folder);
	if (!l) return;
	unlinkSync(fpath(root, l, layout));
	db.prepare("DELETE FROM maildir_files WHERE connector_id=? AND folder=? AND uniq=?").run(cid, folder, l.uniq);
	relabel(db, msgId);
}

/** Lazy raw source straight from disk — no RFC822 duplication in SQLCipher needed. */
export function readRaw(db: Database.Database, root: string, layout: Layout, msgId: number): Buffer {
	const l = locs(db, msgId)[0];
	return readFileSync(fpath(root, l, layout));
}
