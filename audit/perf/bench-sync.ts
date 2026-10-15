/**
 * Initial-ingestion benchmark through the REAL sync path:
 *   Dovecot (127.0.0.1:14203) -> ImapSync.syncAll() (src/sync/imap-sync.ts) -> SQLCipher (openDatabase, src/storage/db.ts)
 *
 *   npx tsx audit/perf/bench-sync.ts --size 10k [--runs 5] [--keep] [--variant nofts] [--user alice|bob]
 *
 * Requires Dovecot to be loaded first:  npx tsx audit/perf/load-maildir.ts --size 10k --reset
 * --keep      leaves the last run's DB at $WORK/db-imap-<size>/ (used by later benchmarks)
 * --variant nofts  drops the messages_ai FTS trigger before syncing (counterfactual: cost of FTS indexing)
 */
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { openDatabase } from "../../src/storage/db.js";
import { ImapSync } from "../../src/sync/imap-sync.js";
import { IMAP_BASE, IMAP_PORT, MB, RssSampler, WORK, arg, dbFiles, ensureDir, envSnapshot, flag, stats, vaultKey, writeResult } from "./lib/env.js";
import { dbstatSummary } from "./lib/dbstat.js";

const size = arg("size", "10k") as string;
const runs = Number(arg("runs", "5"));
const variant = arg("variant", "default") as string;
const keep = flag("keep");
const user = arg("user", "alice") as string; // Dovecot harness user holding the corpus (alice: 10k, bob: 50k)
const pass = `${user}pass`;

function dovecotStatus() {
	const out = execSync(`doveadm -c ${join(IMAP_BASE, "dovecot.conf")} mailbox status -u ${user} 'messages vsize' '*'`, { encoding: "utf8" });
	let messages = 0;
	let vsize = 0;
	for (const line of out.trim().split("\n")) {
		const m = /messages=(\d+) vsize=(\d+)/.exec(line);
		if (m) {
			messages += Number(m[1]);
			vsize += Number(m[2]);
		}
	}
	return { messages, vsize };
}

function dovecotCpuSeconds(): number {
	// Sum utime+stime of all dovecot processes (imap worker does the FETCH work)
	try {
		const pids = execSync("pgrep -u storkaudit", { encoding: "utf8" }).trim().split("\n");
		let ticks = 0;
		for (const pid of pids) {
			try {
				const st = execSync(`cat /proc/${pid}/stat`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
				const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
				ticks += Number(f[11]) + Number(f[12]);
			} catch {}
		}
		return ticks / 100;
	} catch {
		return 0;
	}
}

async function oneRun(i: number) {
	const dir = join(WORK, `sync-run-${size}-${variant}`);
	rmSync(dir, { recursive: true, force: true });
	ensureDir(dir);
	const env = envSnapshot();
	const db = openDatabase("stork.db", dir, vaultKey());
	if (variant === "nofts") db.exec("DROP TRIGGER messages_ai");
	const id = Number(
		db
			.prepare("INSERT INTO inbound_connectors (name, type, imap_host, imap_port, imap_tls, imap_user, imap_pass) VALUES ('perf-imap','imap','127.0.0.1',?,0,?,?)")
			.run(IMAP_PORT, user, pass).lastInsertRowid,
	);
	const sync = new ImapSync({ host: "127.0.0.1", port: IMAP_PORT, secure: false, auth: { user, pass } }, db, id);
	const rss = new RssSampler().start(100);
	const eld = monitorEventLoopDelay({ resolution: 10 });
	eld.enable();
	const cpu0 = process.cpuUsage();
	const dcpu0 = dovecotCpuSeconds();
	const t0 = performance.now();
	const progress: { t: number; n: number; folder?: string }[] = [];
	await sync.connect();
	const res = await sync.syncAll(undefined, (p) => progress.push({ t: performance.now() - t0, n: p.messagesNew, folder: p.currentFolder }));
	const wallMs = performance.now() - t0;
	const cpu = process.cpuUsage(cpu0);
	const dcpu = dovecotCpuSeconds() - dcpu0;
	eld.disable();
	await sync.disconnect();
	const mem = rss.stop();
	const filesBeforeCkpt = dbFiles(dir);
	const counts = db.prepare("SELECT COUNT(*) n, SUM(size) bytes, SUM(has_attachments) att FROM messages").get() as { n: number; bytes: number; att: number };
	const tCk = performance.now();
	db.pragma("wal_checkpoint(TRUNCATE)");
	db.exec("PRAGMA blobs.wal_checkpoint(TRUNCATE)");
	const ckptMs = performance.now() - tCk;
	const filesAfter = dbFiles(dir);
	const dbstat = i === runs - 1 ? dbstatSummary(db) : undefined;
	db.close();
	const r = {
		run: i,
		env,
		wallMs: Math.round(wallMs),
		messages: counts.n,
		withAttachments: counts.att,
		imapBytes: counts.bytes,
		msgsPerSec: +(counts.n / (wallMs / 1000)).toFixed(1),
		mbPerSec: +(MB(counts.bytes) / (wallMs / 1000)).toFixed(2),
		cpuUserS: +(cpu.user / 1e6).toFixed(2),
		cpuSysS: +(cpu.system / 1e6).toFixed(2),
		coresUsed: +((cpu.user + cpu.system) / 1e3 / wallMs).toFixed(2),
		dovecotCpuS: +dcpu.toFixed(2),
		...mem,
		eventLoopDelayMs: { p50: eld.percentile(50) / 1e6, p99: eld.percentile(99) / 1e6, max: eld.max / 1e6 },
		errors: res.totalErrors,
		filesBeforeCheckpointMB: Object.fromEntries(Object.entries(filesBeforeCkpt).map(([k, v]) => [k, MB(v)])),
		filesAfterCheckpointMB: Object.fromEntries(Object.entries(filesAfter).map(([k, v]) => [k, MB(v)])),
		checkpointMs: Math.round(ckptMs),
		progress: progress.filter((_, k) => k % 4 === 0),
		dbstat,
	};
	console.log(JSON.stringify({ ...r, progress: undefined, dbstat: undefined, env: { loadavg: env.loadavg } }));
	if (keep && i === runs - 1) {
		const dst = join(WORK, `db-imap-${size}${variant === "default" ? "" : `-${variant}`}`);
		rmSync(dst, { recursive: true, force: true });
		execSync(`mv ${dir} ${dst}`);
		console.log(`kept DB at ${dst}`);
	}
	return r;
}

const dv = dovecotStatus();
console.log(`dovecot holds ${dv.messages} messages, vsize ${MB(dv.vsize)} MB`);
const results = [];
for (let i = 0; i < runs; i++) results.push(await oneRun(i));
const summary = {
	size,
	variant,
	dovecot: dv,
	runs: results.length,
	wallMs: stats(results.map((r) => r.wallMs)),
	msgsPerSec: stats(results.map((r) => r.msgsPerSec)),
	mbPerSec: stats(results.map((r) => r.mbPerSec)),
	peakRssMB: stats(results.map((r) => r.peakRssMB)),
	coresUsed: stats(results.map((r) => r.coresUsed)),
	dovecotCpuS: stats(results.map((r) => r.dovecotCpuS)),
};
console.log(JSON.stringify(summary, null, 2));
writeResult(`sync-${size}-${variant}`, { summary, results });
process.exit(0);
