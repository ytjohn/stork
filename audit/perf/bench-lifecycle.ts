/**
 * Startup / shutdown / crash recovery.
 *
 *   npx tsx audit/perf/bench-lifecycle.ts --size 100k [--runs 5] [--parts kdf,open,migrate,server,sigterm,sigkill]
 *        [--kill-after-ms 20000,55000,95000] [--inplace] [--tag name]
 *
 * kdf      Argon2id with production params (m=64MiB, t=3, p=1; @noble/hashes, pure JS) — initializeEncryption + unlockWithPassword
 * open     openDatabase() on the <size> DB (WAL checkpoint, PRAGMA optimize, ATTACH blobs, ensureSchema)
 * migrate  schema migrations on a copy of the <size> DB rewound to v29 (v30 only) and to v24 (v25..v30, incl. FTS rebuild)
 * server   real production bundle (esbuild of src/index.ts, as `npm run build`) as a child process:
 *          spawn -> /api/health 200 -> POST /api/unlock -> first /api/inbox/unified  (x runs)
 * sigterm  server on a copy of <size> DB + 2nd connector at the perf Dovecot (10k msgs); SIGTERM mid initial sync
 * sigkill  same, SIGKILL mid-sync, then restart: integrity_check, FTS integrity-check, duplicates, resume time
 *
 * The server bundle is built into audit/perf/.build/ (gitignored) so it resolves the repo's node_modules.
 */
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { initializeEncryption, setPasswordFromVaultKey, unlockWithPassword } from "../../src/crypto/keys.js";
import { openDatabase } from "../../src/storage/db.js";
import { openBenchDb, resolveDbDir } from "./lib/app.js";
import { IMAP_PORT, MB, PERF_DIR, REPO, WORK, arg, dbFiles, ensureDir, envSnapshot, flag, stats, vaultKey, writeResult } from "./lib/env.js";

if (process.env.STORK_FAST_KDF) throw new Error("unset STORK_FAST_KDF: this benchmark needs production Argon2 params");
const size = arg("size", "100k") as string;
const runs = Number(arg("runs", "5"));
const parts = (arg("parts", "kdf,open,migrate,server,sigterm,sigkill") as string).split(",");
const src = resolveDbDir(size, arg("db"));
const PASSWORD = "perf-benchmark-password-not-secret";
const out: Record<string, unknown> = { env: envSnapshot(), size, src, runs };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checkpoint = (dir: string) => {
	const d = openBenchDb(dir);
	d.pragma("wal_checkpoint(TRUNCATE)");
	d.close();
};
function copyDb(name: string): string {
	const dir = join(WORK, name);
	rmSync(dir, { recursive: true, force: true });
	execSync(`mkdir -p ${dir} && cp ${src}/stork.db ${src}/stork-blobs.db ${dir}/`);
	return dir;
}
function writeKeys(dir: string) {
	const t0 = performance.now();
	initializeEncryption(dir, PASSWORD);
	const initMs = performance.now() - t0;
	const t1 = performance.now();
	setPasswordFromVaultKey(dir, vaultKey(), PASSWORD); // rewrap our fixed bench vault key
	return { initializeEncryptionMs: initMs, setPasswordMs: performance.now() - t1 };
}

// ── kdf ───────────────────────────────────────────────────────────────────
if (parts.includes("kdf")) {
	const dir = ensureDir(join(WORK, "kdf"));
	rmSync(join(dir, "stork.keys"), { force: true });
	const k = writeKeys(dir);
	const xs: number[] = [];
	for (let i = 0; i < runs; i++) {
		const t = performance.now();
		unlockWithPassword(dir, PASSWORD);
		xs.push(performance.now() - t);
	}
	out.kdf = { ...k, unlockWithPasswordMs: stats(xs), note: "synchronous on the event loop (blocks all requests while it runs)" };
	console.log("kdf", JSON.stringify(out.kdf));
	rmSync(dir, { recursive: true, force: true });
}

// ── open ──────────────────────────────────────────────────────────────────
if (parts.includes("open")) {
	checkpoint(src);
	const xs: number[] = [];
	const first: number[] = [];
	for (let i = 0; i < runs; i++) {
		const t = performance.now();
		const d = openDatabase("stork.db", src, vaultKey());
		xs.push(performance.now() - t);
		const t2 = performance.now();
		d.prepare("SELECT m.id FROM message_labels ml JOIN messages m ON m.id=ml.message_id WHERE ml.label_id=(SELECT id FROM labels WHERE name='INBOX') ORDER BY ml.date DESC LIMIT 50").all();
		first.push(performance.now() - t2);
		d.close();
	}
	out.open = { openDatabaseMs: stats(xs), firstInboxQueryMs: stats(first), files: dbFiles(src) };
	console.log("open", JSON.stringify(out.open));
}

// ── migrate ───────────────────────────────────────────────────────────────
if (parts.includes("migrate")) {
	checkpoint(src);
	const res: Record<string, unknown> = {};
	for (const from of [29, 24]) {
		const xs: number[] = [];
		let integrity = "";
		const reps = from === 24 ? Math.min(runs, 3) : runs;
		for (let i = 0; i < reps; i++) {
			const dir = copyDb(`migrate-${from}`);
			const d = openBenchDb(dir);
			// Rewind schema to look like an older install (data stays; see README for fidelity notes)
			d.exec("DROP INDEX idx_message_labels_label_date; ALTER TABLE message_labels DROP COLUMN date; ALTER TABLE inbound_connectors DROP COLUMN cached_message_count; ALTER TABLE inbound_connectors DROP COLUMN cached_unread_count;");
			if (from <= 28) d.exec("ALTER TABLE labels DROP COLUMN icon;");
			if (from <= 24) {
				d.exec("DROP TRIGGER messages_ai; DROP TRIGGER messages_ad; DROP TRIGGER messages_au; DROP TABLE messages_fts; ALTER TABLE messages DROP COLUMN html_text_body;");
				d.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(subject, from_address, from_name, to_addresses, text_body, content=messages, content_rowid=id, tokenize='porter unicode61');`);
			}
			d.prepare("UPDATE schema_version SET version = ?").run(from);
			d.pragma("wal_checkpoint(TRUNCATE)");
			d.close();
			const t = performance.now();
			let d2: ReturnType<typeof openDatabase> | null = null;
			let error: string | null = null;
			try {
				d2 = openDatabase("stork.db", dir, vaultKey());
			} catch (e) {
				// NOTE: on this codebase v29->v30 fails on any DB with message_labels rows:
				// PRE_MIGRATION_HOOKS[30] (db.ts ~:300) UPDATEs message_labels.date before MIGRATIONS[29] adds the column.
				error = (e as Error).message;
			}
			xs.push(performance.now() - t);
			const walMB = MB(dbFiles(dir).mainWal);
			if (d2) {
				integrity = (d2.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check;
				d2.close();
			}
			const d3 = new (await import("better-sqlite3-multiple-ciphers")).default(join(dir, "stork.db"));
			d3.exec(`PRAGMA key = "x'${vaultKey().toString("hex")}'"`);
			const v = (d3.prepare("SELECT version FROM schema_version").get() as { version: number }).version;
			d3.close();
			console.log(`migrate from v${from} run ${i}: ${xs[xs.length - 1].toFixed(0)}ms wal=${walMB}MB -> schema_version=${v} ${error ? `ERROR: ${error}` : `quick_check=${integrity}`}`);
			res[`v${from}_run${i}`] = { ms: Math.round(xs[xs.length - 1]), walMB, schemaVersionAfter: v, error };
			rmSync(dir, { recursive: true, force: true });
		}
		res[`v${from}->v30`] = { openWithMigrationMs: stats(xs), quick_check: integrity };
	}
	// Cost of the v25 migration's main step (and MessageSearch.rebuildIndex()): full FTS rebuild
	{
		const xs: number[] = [];
		for (let i = 0; i < Math.min(runs, 3); i++) {
			const dir = copyDb("fts-rebuild");
			const d = openBenchDb(dir);
			const t = performance.now();
			d.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
			xs.push(performance.now() - t);
			console.log(`fts rebuild run ${i}: ${xs[xs.length - 1].toFixed(0)}ms wal=${MB(dbFiles(dir).mainWal)}MB`);
			d.close();
			rmSync(dir, { recursive: true, force: true });
		}
		res.ftsRebuildMs = stats(xs);
	}
	out.migrate = res;
}

// ── real server helpers ───────────────────────────────────────────────────
const bundle = join(PERF_DIR, ".build/index.js");
if (!existsSync(bundle) || parts.some((p) => ["server", "sigterm", "sigkill"].includes(p))) {
	execSync(`npx esbuild src/index.ts --bundle --outfile=${bundle} --platform=node --format=esm --packages=external --log-level=warning`, { cwd: REPO });
}
let portSeq = 14300 + Math.floor(Math.random() * 80);
interface Srv {
	proc: ChildProcess;
	port: number;
	log: string[];
	exit: Promise<{ code: number | null; signal: string | null; at: number }>;
}
// Never leave an orphaned server behind (an orphan from a crashed run kept syncing for 45 min once).
const spawned = new Set<ChildProcess>();
const killAll = () => {
	for (const p of spawned) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
};
process.on("exit", killAll);
process.on("uncaughtException", (e) => {
	console.error(e);
	killAll();
	process.exit(1);
});
process.on("unhandledRejection", (e) => {
	console.error(e);
	killAll();
	process.exit(1);
});
function startServer(dir: string): Srv {
	const port = portSeq++;
	const log: string[] = [];
	const proc = spawn(process.execPath, [bundle], { cwd: REPO, env: { ...process.env, STORK_DATA_DIR: dir, STORK_PORT: String(port), STORK_FAST_KDF: "" }, stdio: ["ignore", "pipe", "pipe"] });
	spawned.add(proc);
	proc.stdout?.on("data", (b) => log.push(String(b)));
	proc.stderr?.on("data", (b) => log.push(String(b)));
	const exit = new Promise<{ code: number | null; signal: string | null; at: number }>((res) => proc.on("exit", (code, signal) => res({ code, signal, at: performance.now() })));
	return { proc, port, log, exit };
}
async function waitHealth(s: Srv, timeoutMs = 60000) {
	const t0 = performance.now();
	while (performance.now() - t0 < timeoutMs) {
		try {
			const r = await fetch(`http://127.0.0.1:${s.port}/api/health`);
			if (r.ok) return performance.now() - t0;
		} catch {}
		await sleep(20);
	}
	throw new Error(`server did not become healthy: ${s.log.join("").slice(-2000)}`);
}
async function unlock(s: Srv) {
	const t0 = performance.now();
	const r = await fetch(`http://127.0.0.1:${s.port}/api/unlock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
	const body = await r.text();
	if (!r.ok) throw new Error(`unlock failed ${r.status} ${body}`);
	return performance.now() - t0;
}
async function timedGet(s: Srv, path: string) {
	const t0 = performance.now();
	const r = await fetch(`http://127.0.0.1:${s.port}${path}`);
	await r.text();
	return { ms: performance.now() - t0, status: r.status };
}
let statusErrors = 0;
async function syncStatus(s: Srv, cid: number) {
	// The server's event loop is blocked for seconds at a time during sync (sub-batch label apply,
	// refreshLabelCounts), so keep-alive sockets get reset; count and retry instead of failing.
	for (let i = 0; i < 50; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${s.port}/api/sync/status`, { headers: { connection: "close" } });
			const j = (await r.json()) as Record<string, { running: boolean; lastSync: number | null; progress: { messagesNew: number } | null; lastError: string | null }>;
			return j[String(cid)];
		} catch {
			statusErrors++;
			await sleep(200);
		}
	}
	throw new Error("sync status unreachable");
}

// ── server startup ────────────────────────────────────────────────────────
if (parts.includes("server")) {
	// --inplace: use the source DB dir directly (avoids a multi-GB copy at 500k); writes stork.keys there
	const dir = flag("inplace") ? src : copyDb("server-start");
	if (!existsSync(join(dir, "stork.keys"))) writeKeys(dir);
	const r: Record<string, number>[] = [];
	for (let i = 0; i < runs; i++) {
		const t0 = performance.now();
		const s = startServer(dir);
		const healthMs = await waitHealth(s);
		const unlockMs = await unlock(s);
		const first = await timedGet(s, "/api/inbox/unified?limit=50&offset=0");
		const second = await timedGet(s, "/api/inbox/unified?limit=50&offset=0");
		const search = await timedGet(s, "/api/search?q=xylomedianta");
		const rss = Number(execSync(`ps -o rss= -p ${s.proc.pid}`, { encoding: "utf8" }).trim()) / 1024;
		const tStop = performance.now();
		s.proc.kill("SIGTERM");
		const ex = await s.exit;
		r.push({ spawnToHealthyMs: healthMs, unlockMs, firstInboxMs: first.ms, secondInboxMs: second.ms, firstSearchMs: search.ms, readyTotalMs: performance.now() - t0 - (performance.now() - tStop), rssAfterUnlockMB: rss, idleShutdownMs: ex.at - tStop, exitCode: ex.code ?? -1 });
		console.log("server", JSON.stringify(r[r.length - 1]));
	}
	out.server = { runs: r, summary: Object.fromEntries(Object.keys(r[0]).map((k) => [k, stats(r.map((x) => x[k]))])) };
	if (dir !== src) rmSync(dir, { recursive: true, force: true });
}

// ── sigterm / sigkill mid-sync ────────────────────────────────────────────
interface Check {
	quick: string;
	integrity: string;
	ftsIntegrity: string;
	messages: number;
	dupFolderUid: number;
	dupMessageId: number;
	ftsRowsVsMessages: string;
	syncStateVsMax: { folder: string; last_uid: number; max_uid: number }[];
	walMB: number;
}
function checkDb(dir: string, cid: number): Check {
	const walMB = MB(dbFiles(dir).mainWal);
	const d = openDatabase("stork.db", dir, vaultKey());
	const g = <T>(sql: string, ...p: unknown[]) => d.prepare(sql).get(...p) as T;
	let ftsIntegrity = "ok";
	try {
		d.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)");
	} catch (e) {
		ftsIntegrity = (e as Error).message;
	}
	const res: Check = {
		quick: g<{ quick_check: string }>("PRAGMA quick_check").quick_check,
		integrity: (d.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((x) => x.integrity_check).slice(0, 3).join("; "),
		ftsIntegrity,
		messages: g<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE inbound_connector_id=?", cid).n,
		dupFolderUid: g<{ n: number }>("SELECT COUNT(*) n FROM (SELECT folder_id, uid FROM messages GROUP BY folder_id, uid HAVING COUNT(*)>1)").n,
		dupMessageId: g<{ n: number }>("SELECT COUNT(*) n FROM (SELECT folder_id, message_id FROM messages WHERE inbound_connector_id=? GROUP BY folder_id, message_id HAVING COUNT(*)>1)", cid).n,
		ftsRowsVsMessages: `${g<{ n: number }>("SELECT COUNT(*) n FROM messages_fts_docsize").n} docsize rows / ${g<{ n: number }>("SELECT COUNT(*) n FROM messages").n} messages`,
		syncStateVsMax: d
			.prepare("SELECT f.path folder, COALESCE(s.last_uid,0) last_uid, (SELECT MAX(uid) FROM messages m WHERE m.folder_id=f.id) max_uid FROM folders f LEFT JOIN sync_state s ON s.folder_id=f.id WHERE f.inbound_connector_id=?")
			.all(cid) as Check["syncStateVsMax"],
		walMB,
	};
	d.close();
	return res;
}
function prepLifecycleDir(name: string): { dir: string; cid: number } {
	const dir = copyDb(name);
	const d = openBenchDb(dir);
	// Disable the unreachable bulk connector (so only the Dovecot one syncs) and add the Dovecot connector
	d.exec("UPDATE inbound_connectors SET type='disabled-bench' WHERE name='perf-bulk'");
	const cid = Number(d.prepare("INSERT INTO inbound_connectors (name, type, imap_host, imap_port, imap_tls, imap_user, imap_pass) VALUES ('perf-imap-lc','imap','127.0.0.1',?,0,'alice','alicepass')").run(IMAP_PORT).lastInsertRowid);
	d.pragma("wal_checkpoint(TRUNCATE)");
	d.close();
	writeKeys(dir);
	return { dir, cid };
}
// --kill-after-ms 20000,50000,80000 : kill at fixed times after unlock (mid-folder, mid-batch) instead of
// at a progress count (SyncProgress.messagesNew only advances at folder boundaries).
const killAfter = arg("kill-after-ms")?.split(",").map(Number);
async function midSync(kind: "SIGTERM" | "SIGKILL", killAt: number, afterMs?: number) {
	const { dir, cid } = prepLifecycleDir(`lc-${kind}`);
	const s = startServer(dir);
	await waitHealth(s);
	const tUnlock = performance.now();
	await unlock(s);
	let st = await syncStatus(s, cid);
	if (afterMs !== undefined) {
		await sleep(Math.max(0, afterMs - (performance.now() - tUnlock)));
		st = await syncStatus(s, cid);
	} else
		while (!st?.progress || st.progress.messagesNew < killAt) {
			await sleep(50);
			st = await syncStatus(s, cid);
			if (st && !st.running && st.lastSync) break;
		}
	const progressAtKill = st?.progress?.messagesNew ?? null;
	const tKill = performance.now();
	s.proc.kill(kind);
	const ex = await s.exit;
	const shutdownMs = ex.at - tKill;
	const after = checkDb(dir, cid);
	// restart and let the sync finish
	const t0 = performance.now();
	const s2 = startServer(dir);
	const healthMs = await waitHealth(s2);
	const unlockMs = await unlock(s2);
	const readyMs = performance.now() - t0;
	let st2 = await syncStatus(s2, cid);
	while (!(st2 && !st2.running && st2.lastSync)) {
		await sleep(200);
		st2 = await syncStatus(s2, cid);
	}
	const resumeSyncMs = performance.now() - t0;
	s2.proc.kill("SIGTERM");
	await s2.exit;
	const final = checkDb(dir, cid);
	const r = {
		kind,
		killAtTarget: afterMs !== undefined ? `${afterMs}ms after unlock` : killAt,
		progressAtKill,
		syncMsBeforeKill: Math.round(tKill - tUnlock),
		shutdownMs: Math.round(shutdownMs),
		exit: { code: ex.code, signal: ex.signal },
		logTail: s.log.join("").split("\n").filter((l) => /Shutting|Sync|forc|timed out|rror/i.test(l)).slice(-6),
		afterKill: after,
		restart: { healthMs: Math.round(healthMs), unlockMs: Math.round(unlockMs), readyMs: Math.round(readyMs), resumeSyncToCompleteMs: Math.round(resumeSyncMs), lastError: st2?.lastError },
		final,
		statusPollErrors: statusErrors,
		loadavg: envSnapshot().loadavg,
	};
	console.log(JSON.stringify({ ...r, afterKill: { ...after, syncStateVsMax: undefined }, final: { ...final, syncStateVsMax: undefined } }));
	rmSync(dir, { recursive: true, force: true });
	return r;
}
for (const kind of ["sigterm", "sigkill"] as const) {
	if (!parts.includes(kind)) continue;
	const rs = [];
	if (killAfter) for (const ms of killAfter) rs.push(await midSync(kind === "sigterm" ? "SIGTERM" : "SIGKILL", 0, ms));
	else for (const at of [2000, 5000, 8000]) rs.push(await midSync(kind === "sigterm" ? "SIGTERM" : "SIGKILL", at));
	out[kind] = rs;
}
// --tag names the result file (lifecycle-<size>-<tag>.json) so split runs don't overwrite each other
const tag = arg("tag");
writeResult(`lifecycle-${size}${tag ? `-${tag}` : ""}`, out);
process.exit(0);
