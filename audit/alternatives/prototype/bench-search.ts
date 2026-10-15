/**
 * THROWAWAY PROTOTYPE (audit only). Same Maildir -> (a) Stork FTS5 via reconcile(), (b) notmuch.
 *   npx tsx audit/alternatives/prototype/gen-maildir.ts --n 10000 --dir /tmp/stork-audit-maildir-10k
 *   npx tsx audit/alternatives/prototype/bench-search.ts --dir /tmp/stork-audit-maildir-10k
 * notmuch timings include CLI process spawn (~ms); Stork timings are in-process (no HTTP).
 */
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MessageSearch } from "../../../src/search/search.js";
import { createTestDb } from "../../../src/test-helpers/test-db.js";
import { arg, stats } from "../../perf/lib/env.js";
import { reconcile } from "./maildir-view.js";

const dir = arg("dir", "/tmp/stork-audit-maildir-10k") as string;
const db = createTestDb();
const res: Record<string, unknown> = {};
let i = 0;
for (const [name, layout] of [["gmail", "verbatim"], ["namecheap", "maildir++"]] as const) {
	db.prepare("INSERT INTO inbound_connectors (name, type) VALUES (?, 'maildir')").run(name);
	res[`stork-ingest-${name}`] = await reconcile(db, ++i, join(dir, name), layout);
}
const t = performance.now();
res["stork-rescan-noop-ms"] = (await reconcile(db, 1, join(dir, "gmail"), "verbatim")).ms + (await reconcile(db, 2, join(dir, "namecheap"), "maildir++")).ms;

const nmHome = "/tmp/stork-audit-notmuch";
rmSync(nmHome, { recursive: true, force: true });
mkdirSync(nmHome, { recursive: true });
const cfg = join(nmHome, "config");
writeFileSync(cfg, `[database]\npath=${dir}\n[user]\nprimary_email=alice@perf.example\n[new]\ntags=unread;inbox;\n[maildir]\nsynchronize_flags=true\n`);
const env = { ...process.env, NOTMUCH_CONFIG: cfg };
const t0 = performance.now();
execSync("notmuch new --quiet", { env });
res["notmuch-new-initial-ms"] = Math.round(performance.now() - t0);
const t1 = performance.now();
execSync("notmuch new --quiet", { env });
res["notmuch-new-noop-ms"] = Math.round(performance.now() - t1);
res["notmuch-db-bytes"] = Number(execSync(`du -sb ${dir}/.notmuch | cut -f1`).toString());

const search = new MessageSearch(db);
const queries: [string, string][] = [
	["xylorarium", "xylorarium"],
	["xylomedianta", "xylomedianta"],
	["xylocommona", "xylocommona"],
	['"quantum harvest"', '"quantum harvest"'],
	["zqprefix*", "zqprefix*"],
	["from:needle.sender@known-corp.example", "from:needle.sender@known-corp.example"],
	["subject:Invoice", "subject:Invoice"],
];
const rows: unknown[] = [];
for (const [sq, nq] of queries) {
	const st: number[] = [], nt: number[] = [];
	let sHits = 0, nHits = 0;
	for (let k = 0; k < 15; k++) {
		let a = performance.now();
		sHits = search.search(sq, { limit: 100000 }).length;
		st.push(performance.now() - a);
		a = performance.now();
		nHits = Number(execSync(`notmuch count --output=messages '${nq.replace(/'/g, "'\\''")}'`, { env }).toString());
		nt.push(performance.now() - a);
	}
	const nsearch = performance.now();
	execSync(`notmuch search --output=messages --limit=50 '${nq.replace(/'/g, "'\\''")}' >/dev/null`, { env, shell: "/bin/bash" });
	rows.push({ query: sq, storkHits: sHits, storkP50ms: +stats(st).median.toFixed(2), notmuchHits: nHits, notmuchCountP50ms: +stats(nt).median.toFixed(2), notmuchSearch50ms: +(performance.now() - nsearch).toFixed(1) });
}
const spawn = performance.now();
execSync("true");
res["process-spawn-ms"] = +(performance.now() - spawn).toFixed(1);
console.log(JSON.stringify(res, null, 1));
console.table(rows);
writeFileSync(join(import.meta.dirname, "bench-search.results.json"), JSON.stringify({ res, rows, at: new Date().toISOString() }, null, 1));
void t;
