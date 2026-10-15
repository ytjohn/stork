/**
 * Concurrency: HTTP request latency + server event-loop lag with and without a sync running
 * in the same process (as in production).
 *
 *   npx tsx audit/perf/bench-concurrency.ts --size 100k [--rate 8] [--baseline-s 30] [--resyncs 5]
 *
 * Setup: copies $WORK/db-bulk-<size> and adds a 2nd IMAP connector pointing at the perf Dovecot
 * (which must hold the 10k seed-1 corpus: load-maildir.ts --size 10k --reset). So the server holds
 * <size> messages and then ingests 10k more over real IMAP while serving traffic.
 * Phases (open-loop load at --rate req/s, fixed request mix):
 *   baseline       no sync
 *   initial-sync   ImapSync.syncAll() ingesting 10k new messages
 *   resync-k       syncAll() with no new mail (flag sync over 10k UIDs, label apply, refreshLabelCounts)
 *   post           no sync again
 */
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IMAP_PORT, WORK, arg, envSnapshot, flag, stats, writeResult } from "./lib/env.js";
import { openBenchDb, resolveDbDir } from "./lib/app.js";
import { NEEDLES } from "./lib/corpus.js";

const size = arg("size", "100k") as string;
const rate = Number(arg("rate", "8"));
const baselineS = Number(arg("baseline-s", "30"));
const resyncs = Number(arg("resyncs", "5"));
const src = resolveDbDir(size, arg("db"));
// --inplace: run against the source DB itself (no multi-GB copy; the DB gains the 10k synced msgs)
const inplace = flag("inplace");
const dir = inplace ? src : join(WORK, `conc-${size}`);
if (!inplace) {
	rmSync(dir, { recursive: true, force: true });
	const d = openBenchDb(src);
	d.pragma("wal_checkpoint(TRUNCATE)");
	d.close();
	execSync(`mkdir -p ${dir} && cp ${src}/stork.db ${src}/stork-blobs.db ${dir}/`);
}
const db = openBenchDb(dir);
// In-place reruns: drop the previous run's Dovecot connector (CASCADE removes its folders/messages)
if (inplace) db.prepare("DELETE FROM inbound_connectors WHERE name='perf-imap2'").run();
const cid = Number(
	db
		.prepare("INSERT INTO inbound_connectors (name, type, imap_host, imap_port, imap_tls, imap_user, imap_pass) VALUES ('perf-imap2','imap','127.0.0.1',?,0,'alice','alicepass')")
		.run(IMAP_PORT).lastInsertRowid,
);
const lid = (name: string) => (db.prepare("SELECT id FROM labels WHERE name=?").get(name) as { id: number }).id;
const inbox = lid("INBOX");
const archive = lid("Archive");
const threadMsg = (db.prepare("SELECT id FROM messages WHERE subject LIKE 'Re: Project%planning thread' ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
const n0 = (db.prepare("SELECT COUNT(*) n FROM messages").get() as { n: number }).n;
db.close();

const port = 14280 + Math.floor(Math.random() * 9);
const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./lib/conc-server.ts", import.meta.url)), dir, String(port), String(cid)], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
let msgId = 0;
const pending = new Map<number, (v: unknown) => void>();
let readyInfo: unknown;
const ready = new Promise((res) =>
	child.on("message", (m: { id?: number; ready?: boolean }) => {
		if (m.ready) {
			readyInfo = m;
			res(m);
		} else if (m.id !== undefined) {
			pending.get(m.id)?.(m);
			pending.delete(m.id);
		}
	}),
);
const rpc = (cmd: string) =>
	new Promise<Record<string, unknown>>((res) => {
		const id = ++msgId;
		pending.set(id, res as (v: unknown) => void);
		child.send({ cmd, id });
	});
await ready;
await new Promise((r) => setTimeout(r, 500));

// Light, UI-like mix of requests that are individually fast at this size (<~50 ms at 100k), so the
// baseline is not saturated; slow operator-only searches (from:, is:unread …) are measured in
// bench-search.ts and block the loop for their whole duration anyway.
const mix = [
	{ name: "search medium", path: `/api/search?q=${NEEDLES.medium}` },
	{ name: "unified inbox p1", path: "/api/inbox/unified?limit=50&offset=0" },
	{ name: "label Archive p1", path: `/api/labels/${archive}/messages?limit=50&offset=0` },
	{ name: "search rare", path: `/api/search?q=${NEEDLES.rare}` },
	{ name: "message open", path: `/api/messages/${threadMsg}` },
	{ name: "labels list", path: "/api/labels" },
	{ name: "unified count", path: "/api/inbox/unified/count" },
	{ name: "unified inbox p2", path: "/api/inbox/unified?limit=50&offset=50" },
];
interface Sample {
	phase: string;
	name: string;
	ms: number;
	status: number;
}
const samples: Sample[] = [];
let phase = "warmup";
let running = true;
let k = 0;
const inflight = new Set<Promise<void>>();
const t00 = performance.now();
async function loadLoop() {
	const interval = 1000 / rate;
	let next = performance.now();
	while (running) {
		const req = mix[k++ % mix.length];
		const ph = phase;
		const t0 = performance.now();
		const p = fetch(`http://127.0.0.1:${port}${req.path}`)
			.then(async (r) => {
				await r.arrayBuffer();
				samples.push({ phase: ph, name: req.name, ms: performance.now() - t0, status: r.status });
			})
			.catch(() => samples.push({ phase: ph, name: req.name, ms: performance.now() - t0, status: 0 }))
			.finally(() => inflight.delete(p));
		inflight.add(p);
		next += interval;
		const wait = next - performance.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	}
}
const loop = loadLoop();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const phases: Record<string, unknown>[] = [];
async function runPhase(name: string, body: () => Promise<Record<string, unknown> | undefined>) {
	await rpc("phase"); // reset server-side stats
	phase = name;
	const t0 = performance.now();
	const env = envSnapshot();
	const extra = await body();
	const ms = performance.now() - t0;
	const srv = await rpc("phase");
	phases.push({ phase: name, durationMs: Math.round(ms), loadavgAtStart: env.loadavg, server: srv.stats, ...extra });
	console.log(name, Math.round(ms), "ms", JSON.stringify(srv.stats), extra ? JSON.stringify(extra) : "");
}
await sleep(3000); // warmup
await runPhase("baseline", async () => {
	await sleep(baselineS * 1000);
	return undefined;
});
await runPhase("initial-sync-10k", async () => rpc("sync"));
for (let i = 0; i < resyncs; i++) await runPhase(`resync-${i}`, async () => rpc("sync"));
await runPhase("post", async () => {
	await sleep(Math.min(20, baselineS) * 1000);
	return undefined;
});
running = false;
await loop;
await Promise.all(inflight);
child.send({ cmd: "exit", id: 0 });

const byPhase: Record<string, unknown> = {};
for (const ph of [...new Set(samples.map((s) => s.phase))]) {
	const xs = samples.filter((s) => s.phase === ph);
	const per: Record<string, unknown> = {};
	for (const nm of mix.map((m) => m.name)) {
		const ys = xs.filter((s) => s.name === nm).map((s) => s.ms);
		if (ys.length) per[nm] = stats(ys);
	}
	byPhase[ph.startsWith("resync") ? ph : ph] = {
		requests: xs.length,
		errors: xs.filter((s) => s.status !== 200).length,
		over100ms: xs.filter((s) => s.ms > 100).length,
		over1s: xs.filter((s) => s.ms > 1000).length,
		all: stats(xs.map((s) => s.ms)),
		perEndpoint: per,
	};
}
const resyncAll = samples.filter((s) => s.phase.startsWith("resync")).map((s) => s.ms);
const summary = {
	size,
	messagesBefore: n0,
	rate,
	ready: readyInfo,
	phases,
	latencyByPhase: byPhase,
	resyncCombined: resyncAll.length ? stats(resyncAll) : null,
	totalS: Math.round((performance.now() - t00) / 1000),
};
console.log(JSON.stringify(byPhase, (k, v) => (k === "perEndpoint" ? undefined : v), 1));
writeResult(`concurrency-${size}`, { env: envSnapshot(), inplace, ...summary });
if (!inplace) rmSync(dir, { recursive: true, force: true });
process.exit(0);
