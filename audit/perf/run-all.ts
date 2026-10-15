/**
 * One-command runner for the stork performance audit.
 *
 *   npx tsx audit/perf/run-all.ts --size 100k            # all steps for one size
 *   npx tsx audit/perf/run-all.ts --size all             # 10k (IMAP) + 100k + 500k + 50k IMAP sync
 *   npx tsx audit/perf/run-all.ts --size 100k --steps search,lists
 *
 * Sizes / steps:
 *   10k  : maildir, sync, sync-nofts, insert-path, search, lists, flags        (DB built by the REAL IMAP sync)
 *   50k  : maildir50k (into Dovecot user bob), sync50k (3 runs)
 *   100k : build, search(+cold,+http), lists, diag, flags, concurrency, lifecycle    (DB built by direct INSERT, see build-db.ts)
 *   500k : build, search(+cold), lists, diag, flags(--inplace), concurrency(--inplace), lifecycle(kdf,open,server)
 * Results: audit/perf/results/*.json ; step logs: $WORK/logs/
 * Env: STORK_PERF_WORK (default /tmp/stork-audit-perf), STORK_PERF_IMAP_PORT (14203), STORK_PERF_IMAP_BASE.
 */
import { spawnSync } from "node:child_process";
// NOTE: bench-lifecycle needs production Argon2 params; STORK_FAST_KDF is removed from the child env below.
import { createWriteStream, existsSync } from "node:fs";
import { join } from "node:path";
import { IMAP_BASE, IMAP_PORT, PERF_DIR, REPO, WORK, arg, ensureDir, envSnapshot } from "./lib/env.js";

const size = arg("size", "100k") as string;
const only = arg("steps")?.split(",");
const tsx = join(REPO, "node_modules/.bin/tsx");
const logs = ensureDir(join(WORK, "logs"));
const P = (s: string) => join(PERF_DIR, s);
const maildirHas = (n: number) => {
	try {
		const out = spawnSync("doveadm", ["-c", join(IMAP_BASE, "dovecot.conf"), "mailbox", "status", "-u", "alice", "messages", "*"], { encoding: "utf8" }).stdout;
		return out.split("\n").reduce((a, l) => a + Number(/messages=(\d+)/.exec(l)?.[1] ?? 0), 0) === n;
	} catch {
		return false;
	}
};

type Step = [name: string, script: string, args: string[], when?: () => boolean];
const plans: Record<string, Step[]> = {
	"10k": [
		["maildir", "load-maildir.ts", ["--size", "10k", "--reset"], () => !maildirHas(10000)],
		["sync", "bench-sync.ts", ["--size", "10k", "--runs", "5", "--keep"]],
		["sync-nofts", "bench-sync.ts", ["--size", "10k", "--runs", "3", "--variant", "nofts"]],
		["insert-path", "bench-insert-path.ts", ["--count", "5000", "--runs", "5"]],
		["search", "bench-search.ts", ["--size", "10k", "--cold"]],
		["lists", "bench-lists.ts", ["--size", "10k"]],
		["flags", "bench-flags.ts", ["--size", "10k", "--count", "10000", "--runs", "5"]],
	],
	"50k": [
		["maildir50k", "load-maildir.ts", ["--size", "50k", "--user", "bob", "--wipe-user"]],
		["sync50k", "bench-sync.ts", ["--size", "50k", "--runs", "3", "--user", "bob"]],
	],
	"100k": [
		["build", "build-db.ts", ["--size", "100k"]],
		["search", "bench-search.ts", ["--size", "100k", "--cold", "--http"]],
		["lists", "bench-lists.ts", ["--size", "100k"]],
		["diag", "diag-columns.ts", ["--size", "100k"]],
		["flags", "bench-flags.ts", ["--size", "100k", "--count", "10000", "--runs", "5"]],
		["maildir", "load-maildir.ts", ["--size", "10k", "--reset"], () => !maildirHas(10000)],
		["concurrency", "bench-concurrency.ts", ["--size", "100k", "--rate", "8", "--baseline-s", "30", "--resyncs", "5"]],
		["lifecycle", "bench-lifecycle.ts", ["--size", "100k", "--runs", "5", "--parts", "kdf,open,migrate", "--tag", "kdf-open-migrate"]],
		["lifecycle-signals", "bench-lifecycle.ts", ["--size", "100k", "--runs", "5", "--parts", "server,sigterm,sigkill", "--tag", "server-signals"]],
		["lifecycle-sigkill-timed", "bench-lifecycle.ts", ["--size", "100k", "--parts", "sigkill", "--kill-after-ms", "20000,55000,95000", "--tag", "sigkill-timed"]],
	],
	"500k": [
		["build", "build-db.ts", ["--size", "500k"]],
		["search", "bench-search.ts", ["--size", "500k", "--cold", "--iters", "5"]],
		["lists", "bench-lists.ts", ["--size", "500k", "--iters", "5"]],
		["diag", "diag-columns.ts", ["--size", "500k"]],
		["flags", "bench-flags.ts", ["--size", "500k", "--count", "10000", "--runs", "5", "--inplace"]],
		["maildir", "load-maildir.ts", ["--size", "10k", "--reset"], () => !maildirHas(10000)],
		["concurrency", "bench-concurrency.ts", ["--size", "500k", "--rate", "8", "--baseline-s", "30", "--resyncs", "3", "--inplace"]],
		["lifecycle", "bench-lifecycle.ts", ["--size", "500k", "--runs", "5", "--parts", "kdf,open,server", "--inplace"]],
	],
};
const sizes = size === "all" ? ["10k", "100k", "500k", "50k"] : [size];
console.log("env", JSON.stringify(envSnapshot()));
// Make sure the disposable Dovecot (127.0.0.1:14203) is up; load-maildir --reset recreates it when needed.
// stdio ignored: the daemonised dovecot would otherwise hold our stdout pipe open (e.g. under `| tee`)
const dv = spawnSync("bash", ["-c", `(exec 3<>/dev/tcp/127.0.0.1/${IMAP_PORT}) 2>/dev/null || bash ${join(REPO, "audit/harness/dovecot.sh")} start ${IMAP_BASE} ${IMAP_PORT}`], { stdio: "ignore" });
console.log(`dovecot on 127.0.0.1:${IMAP_PORT}: ${dv.status === 0 ? "up" : `start failed (exit ${dv.status})`}`);
let failed = 0;
for (const sz of sizes) {
	for (const [name, script, args, when] of plans[sz] ?? []) {
		if (only && !only.includes(name)) continue;
		if (when && !when()) {
			console.log(`== ${sz}/${name}: skipped (precondition already satisfied)`);
			continue;
		}
		const logPath = join(logs, `${sz}-${name}.log`);
		console.log(`== ${sz}/${name}: ${script} ${args.join(" ")}  (log ${logPath})`);
		const t0 = Date.now();
		const env = { ...process.env };
		delete env.STORK_FAST_KDF;
		const r = spawnSync(tsx, [P(script), ...args], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 1 << 28 });
		const log = createWriteStream(logPath);
		log.write(r.stdout ?? "");
		log.write(r.stderr ?? "");
		log.end();
		const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n");
		console.log(`${tail}\n   -> exit ${r.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
		if (r.status !== 0) failed++;
	}
}
if (!existsSync(join(PERF_DIR, "results"))) console.log("no results dir?");
process.exit(failed ? 1 : 0);
