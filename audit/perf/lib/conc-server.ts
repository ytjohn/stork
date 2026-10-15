/**
 * Child process for bench-concurrency.ts: the real Hono app + ImapSync in ONE process/event loop,
 * as in production (src/index.ts -> SyncScheduler -> ConnectionPool -> ImapSync.syncAll).
 * Controlled over IPC: {cmd:"phase"} resets/returns event-loop-delay + RSS stats; {cmd:"sync"} runs syncAll.
 */
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { ImapSync } from "../../../src/sync/imap-sync.js";
import { makeApp, openBenchDb } from "./app.js";
import { IMAP_PORT, MB } from "./env.js";

const dir = process.argv[2];
const port = Number(process.argv[3]);
const connectorId = Number(process.argv[4]);
const tOpen = performance.now();
const db = openBenchDb(dir);
const openMs = performance.now() - tOpen;
const app = makeApp(db, dir);
serve({ port, fetch: app.fetch, hostname: "127.0.0.1" });

let eld = monitorEventLoopDelay({ resolution: 5 });
eld.enable();
let peakRss = 0;
let rssSamples: number[] = [];
let peakAnon = 0;
let peakFile = 0;
const procStatus = () => {
	const s = readFileSync("/proc/self/status", "utf8");
	const kb = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(s)?.[1] ?? 0) * 1024;
	return { anon: kb("RssAnon"), file: kb("RssFile") };
};
setInterval(() => {
	const r = process.memoryUsage().rss;
	rssSamples.push(r);
	if (r > peakRss) peakRss = r;
	const p = procStatus();
	if (p.anon > peakAnon) peakAnon = p.anon;
	if (p.file > peakFile) peakFile = p.file;
}, 200).unref();

function phaseStats() {
	const s = {
		eventLoopDelayMs: { p50: eld.percentile(50) / 1e6, p90: eld.percentile(90) / 1e6, p99: eld.percentile(99) / 1e6, max: eld.max / 1e6, mean: eld.mean / 1e6 },
		rssMB: { peak: MB(peakRss), last: MB(process.memoryUsage().rss), min: MB(Math.min(...rssSamples, process.memoryUsage().rss)), peakAnon: MB(peakAnon), peakFileBacked: MB(peakFile) },
	};
	peakAnon = 0;
	peakFile = 0;
	eld.disable();
	eld = monitorEventLoopDelay({ resolution: 5 });
	eld.enable();
	peakRss = 0;
	rssSamples = [];
	return s;
}

// exit if the parent benchmark dies (IPC channel closes) so no orphan keeps syncing
process.on("disconnect", () => process.exit(0));
process.on("message", async (m: { cmd: string; id: number }) => {
	if (m.cmd === "phase") process.send?.({ id: m.id, stats: phaseStats() });
	else if (m.cmd === "sync") {
		const sync = new ImapSync({ host: "127.0.0.1", port: IMAP_PORT, secure: false, auth: { user: "alice", pass: "alicepass" } }, db, connectorId);
		// Instrument (not modify) the synchronous per-cycle maintenance calls made inside syncAll()
		const timings: Record<string, number[]> = {};
		for (const name of ["refreshLabelCounts", "applyFolderLabelsToMessages", "applyIdentityLabelToMessages"] as const) {
			const orig = sync[name].bind(sync);
			(sync as unknown as Record<string, () => void>)[name] = () => {
				const t = performance.now();
				orig();
				(timings[name] ??= []).push(Math.round(performance.now() - t));
			};
		}
		const t0 = performance.now();
		await sync.connect();
		const res = await sync.syncAll();
		await sync.disconnect();
		const ms = performance.now() - t0;
		process.send?.({ id: m.id, syncMs: ms, totalNew: res.totalNew, errors: res.totalErrors, updatedFlags: res.folders.reduce((a, f) => a + f.updatedFlags, 0), refreshLabelCountsMs: timings.refreshLabelCounts?.reduce((a, b) => a + b, 0) ?? 0, maintenanceMs: timings });
	} else if (m.cmd === "exit") process.exit(0);
});
process.send?.({ ready: true, openMs, rssMB: MB(process.memoryUsage().rss) });
