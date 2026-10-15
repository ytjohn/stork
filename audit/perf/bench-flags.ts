/**
 * FTS5 write amplification of flag updates (messages_au trigger, src/storage/schema.ts ~:1141),
 * plus FTS optimize behaviour. Runs on a COPY of a benchmark DB.
 *
 *   npx tsx audit/perf/bench-flags.ts --size 100k [--count 10000] [--runs 5]
 *
 * Variants (each run toggles \Seen on the same --count messages, alternating add/remove):
 *  A route   PATCH /api/messages/:id/flags via app.request (src/api/routes/messages.ts), one msg per request
 *  B sync    "UPDATE messages SET flags=? WHERE folder_id=? AND uid=?" autocommit per row — exactly what
 *            ImapSync.syncFlags() does when the server reports changed flags (src/sync/imap-sync.ts ~:953)
 *  C sync-txn   same statement, all rows in one transaction (counterfactual)
 *  D sync-colTrigger  B with messages_au narrowed to "AFTER UPDATE OF <indexed columns>" (counterfactual)
 * Bytes written measured from /proc/self/io wchar (bytes handed to write/pwrite: WAL frames + checkpoint copies).
 */
import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { MessageSearch } from "../../src/search/search.js";
import { makeApp, openBenchDb, resolveDbDir } from "./lib/app.js";
import { NEEDLES, rngFor } from "./lib/corpus.js";
import { dbstatSummary } from "./lib/dbstat.js";
import { MB, WORK, arg, dbFiles, envSnapshot, flag, stats, writeResult } from "./lib/env.js";

const size = arg("size", "100k") as string;
const src = resolveDbDir(size, arg("db"));
const count = Number(arg("count", "10000"));
const runs = Number(arg("runs", "5"));
// --inplace: operate on the source DB (no multi-GB copy). Flags of the sampled messages end up toggled
// and the original messages_au trigger is restored at the end.
const inplace = flag("inplace");
const dir = inplace ? src : join(WORK, `flags-copy-${size}`);
{
	const d0 = openBenchDb(src);
	d0.pragma("wal_checkpoint(TRUNCATE)");
	d0.close();
}
if (!inplace) {
	rmSync(dir, { recursive: true, force: true });
	execSync(`mkdir -p ${dir} && cp ${src}/stork.db ${src}/stork-blobs.db ${dir}/`);
}
let db = openBenchDb(dir);
const app = makeApp(db, dir);
const n = (db.prepare("SELECT COUNT(*) n FROM messages").get() as { n: number }).n;
const allIds = (db.prepare("SELECT id FROM messages").all() as { id: number }[]).map((r) => r.id);
const r = rngFor(5, 5);
for (let i = allIds.length - 1; i > 0; i--) {
	const j = Math.floor(r() * (i + 1));
	[allIds[i], allIds[j]] = [allIds[j], allIds[i]];
}
const ids = allIds.slice(0, Math.min(count, allIds.length));
const rows = ids.map((id) => db.prepare("SELECT id, folder_id, uid, flags FROM messages WHERE id = ?").get(id) as { id: number; folder_id: number; uid: number; flags: string });

// wchar = bytes passed to write()/pwrite() (SQLite WAL + checkpoint writes); write_bytes (block layer) is unreliable on this VM
const ioWrite = () => Number(/wchar:\s*(\d+)/.exec(readFileSync("/proc/self/io", "utf8"))?.[1] ?? 0);
const ftsInfo = (d: Database.Database) => {
	const seg = d.prepare("SELECT COUNT(*) c, SUM(length(block)) b FROM messages_fts_data").get() as { c: number; b: number };
	return { ftsDataRows: seg.c, ftsDataMB: MB(seg.b) };
};
const probe = (d: Database.Database) => {
	const s = new MessageSearch(d);
	s.search(NEEDLES.common);
	const xs: number[] = [];
	for (let i = 0; i < 7; i++) {
		const t = performance.now();
		s.search(NEEDLES.common);
		s.search(NEEDLES.medium);
		xs.push(performance.now() - t);
	}
	return stats(xs).median;
};

const flagsWith = (f: string, add: boolean) => {
	const s = new Set(f.split(",").filter(Boolean));
	if (add) s.add("\\Seen");
	else s.delete("\\Seen");
	return [...s].join(",");
};

const results: Record<string, unknown>[] = [];
async function variant(name: string, fn: (add: boolean) => Promise<number[]> | number[]) {
	for (let k = 0; k < runs; k++) {
		const add = k % 2 === 0;
		const w0 = ioWrite();
		const f0 = ftsInfo(db);
		const walBefore = dbFiles(dir).mainWal;
		const t0 = performance.now();
		const per = await fn(add);
		const ms = performance.now() - t0;
		const wrote = ioWrite() - w0;
		const f1 = ftsInfo(db);
		const res = {
			variant: name,
			run: k,
			op: add ? "add \\Seen" : "remove \\Seen",
			count: ids.length,
			totalMs: Math.round(ms),
			perUpdateMs: per.length ? stats(per) : undefined,
			updatesPerSec: Math.round(ids.length / (ms / 1000)),
			bytesWrittenMB: MB(wrote),
			bytesWrittenPerUpdateKB: +(wrote / ids.length / 1024).toFixed(1),
			walFileMB: { before: MB(walBefore), after: MB(dbFiles(dir).mainWal) },
			fts: { before: f0, after: f1 },
			loadavg: envSnapshot().loadavg,
		};
		results.push(res);
		console.log(JSON.stringify({ ...res, perUpdateMs: res.perUpdateMs && { median: res.perUpdateMs.median, p95: res.perUpdateMs.p95 } }));
	}
}

const env = envSnapshot();
const before = { fts: ftsInfo(db), dbstat: dbstatSummary(db), probeSearchMs: probe(db) };
const flagState = new Map(rows.map((r) => [r.id, r.flags]));

await variant("A route PATCH /api/messages/:id/flags", async (add) => {
	const per: number[] = [];
	for (const row of rows) {
		const t = performance.now();
		const res = await app.request(`/api/messages/${row.id}/flags`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(add ? { add: ["\\Seen"] } : { remove: ["\\Seen"] }) });
		await res.text();
		per.push(performance.now() - t);
	}
	return per;
});
const upd = () => db.prepare("UPDATE messages SET flags = ? WHERE folder_id = ? AND uid = ?");
await variant("B sync-path UPDATE autocommit", (add) => {
	const st = upd();
	const per: number[] = [];
	for (const row of rows) {
		const nf = flagsWith(flagState.get(row.id) ?? "", add);
		flagState.set(row.id, nf);
		const t = performance.now();
		st.run(nf, row.folder_id, row.uid);
		per.push(performance.now() - t);
	}
	return per;
});
await variant("C sync-path UPDATE single txn", (add) => {
	const st = upd();
	db.transaction(() => {
		for (const row of rows) {
			const nf = flagsWith(flagState.get(row.id) ?? "", add);
			flagState.set(row.id, nf);
			st.run(nf, row.folder_id, row.uid);
		}
	})();
	return [];
});
const afterChurn = { fts: ftsInfo(db), probeSearchMs: probe(db) };

// Optimize (merges all segments into one b-tree)
const w0 = ioWrite();
const tOpt = performance.now();
db.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
const optimizeMs = performance.now() - tOpt;
const optimize = { ms: Math.round(optimizeMs), bytesWrittenMB: MB(ioWrite() - w0), walAfterMB: MB(dbFiles(dir).mainWal), fts: ftsInfo(db), probeSearchMs: probe(db) };
db.pragma("wal_checkpoint(TRUNCATE)");
console.log("optimize", JSON.stringify(optimize));

// D: column-scoped trigger counterfactual
db.exec(`DROP TRIGGER messages_au;
CREATE TRIGGER messages_au AFTER UPDATE OF subject, from_address, from_name, to_addresses, text_body, html_text_body ON messages BEGIN
	INSERT INTO messages_fts(messages_fts, rowid, subject, from_address, from_name, to_addresses, text_body, html_text_body)
	VALUES ('delete', old.id, old.subject, old.from_address, old.from_name, old.to_addresses, old.text_body, old.html_text_body);
	INSERT INTO messages_fts(rowid, subject, from_address, from_name, to_addresses, text_body, html_text_body)
	VALUES (new.id, new.subject, new.from_address, new.from_name, new.to_addresses, new.text_body, new.html_text_body);
END;`);
await variant("D sync-path UPDATE autocommit, column-scoped trigger", (add) => {
	const st = upd();
	const per: number[] = [];
	for (const row of rows) {
		const nf = flagsWith(flagState.get(row.id) ?? "", add);
		flagState.set(row.id, nf);
		const t = performance.now();
		st.run(nf, row.folder_id, row.uid);
		per.push(performance.now() - t);
	}
	return per;
});
const integ = (() => {
	try {
		db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)");
		return "ok";
	} catch (e) {
		return (e as Error).message;
	}
})();
const finalDbstat = dbstatSummary(db);
// restore the production trigger (schema.ts v25 definition)
db.exec(`DROP TRIGGER messages_au;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
		INSERT INTO messages_fts(messages_fts, rowid, subject, from_address, from_name, to_addresses, text_body, html_text_body)
		VALUES ('delete', old.id, old.subject, old.from_address, old.from_name, old.to_addresses, old.text_body, old.html_text_body);
		INSERT INTO messages_fts(rowid, subject, from_address, from_name, to_addresses, text_body, html_text_body)
		VALUES (new.id, new.subject, new.from_address, new.from_name, new.to_addresses, new.text_body, new.html_text_body);
	END;`);
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();
db = null as unknown as Database.Database;
if (!inplace) rmSync(dir, { recursive: true, force: true });
const summary = Object.fromEntries(
	[...new Set(results.map((x) => x.variant as string))].map((v) => {
		const rs = results.filter((x) => x.variant === v);
		return [v, { totalMs: stats(rs.map((x) => x.totalMs as number)), updatesPerSec: stats(rs.map((x) => x.updatesPerSec as number)), bytesWrittenPerUpdateKB: stats(rs.map((x) => x.bytesWrittenPerUpdateKB as number)) }];
	}),
);
console.log(JSON.stringify(summary, null, 1));
writeResult(`flags-${size}`, { env, size, inplace, messages: n, count: ids.length, runs, before, afterChurn, optimize, ftsIntegrityAfter: integ, summary, results, finalDbstat });
process.exit(0);
