/**
 * THROWAWAY PROTOTYPE (audit only). Cost of change detection at 200k files.
 *   npx tsx audit/alternatives/prototype/bench-scan.ts [--n 200000]
 * Creates N empty mbsync-named files across 20 folders, times a full scan() (readdir only,
 * flags come from filenames so no stat/read), then times recursive fs.watch event delivery.
 */
import { closeSync, mkdirSync, openSync, renameSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import { arg } from "../../perf/lib/env.js";
import { scan } from "./maildir-view.js";

const n = Number(arg("n", "200000"));
const root = "/tmp/stork-audit-maildir-scan";
rmSync(root, { recursive: true, force: true });
const folders = Array.from({ length: 20 }, (_, i) => (i === 0 ? "INBOX" : `F${i}`));
for (const f of folders) for (const s of ["cur", "new", "tmp"]) mkdirSync(join(root, f, s), { recursive: true });
for (let i = 0; i < n; i++) closeSync(openSync(join(root, folders[i % 20], "cur", `17000${i}.1_${i}.host,U=${i}:2,S`), "w"));
const runs: number[] = [];
for (let k = 0; k < 5; k++) {
	const t = performance.now();
	const files = scan(root, "verbatim");
	runs.push(performance.now() - t);
	if (files.length !== n) throw new Error("count mismatch");
}
// FINDING: watch(root, { recursive: true }) on Linux/Node 22 adds one inotify watch PER FILE and
// dies with ENOSPC near fs.inotify.max_user_watches. Watch each cur/ and new/ dir non-recursively
// instead (2 watches per folder). Opt in to the failing variant with --recursive.
let recursiveResult = "skipped";
if (process.argv.includes("--recursive")) {
	try { const rw = watch(root, { recursive: true }); await new Promise((r) => setTimeout(r, 2000)); rw.close(); recursiveResult = "ok"; }
	catch (e) { recursiveResult = (e as Error).message; }
}
const t0 = performance.now();
let events = 0;
let lastAt = 0;
const ws = folders.flatMap((f) => ["cur", "new"].map((s) => watch(join(root, f, s), () => { events++; lastAt = performance.now(); })));
const w = { close: () => { for (const x of ws) x.close(); } };
const setupMs = performance.now() - t0;
await new Promise((r) => setTimeout(r, 300));
const tr = performance.now();
for (let i = 0; i < 1000; i++) {
	const f = folders[i % 20];
	renameSync(join(root, f, "cur", `17000${i}.1_${i}.host,U=${i}:2,S`), join(root, f, "cur", `17000${i}.1_${i}.host,U=${i}:2,FS`));
}
await new Promise((r) => setTimeout(r, 1000));
w.close();
console.log(JSON.stringify({ n, fullScanMs: runs.map((x) => Math.round(x)), watchSetupMs: Math.round(setupMs), watches: ws.length, recursiveResult, renames: 1000, watchEvents: events, lastEventAfterMs: Math.round(lastAt - tr) }));
rmSync(root, { recursive: true, force: true });
