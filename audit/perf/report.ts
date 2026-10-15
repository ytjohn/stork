/**
 * Print markdown tables from audit/perf/results/*.json (used to build README.md).
 *   npx tsx audit/perf/report.ts [search|lists|flags|sync|concurrency|lifecycle|build|all]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RESULTS_DIR } from "./lib/env.js";

const what = process.argv[2] ?? "all";
const J = (f: string) => {
	const p = join(RESULTS_DIR, `${f}.json`);
	return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const f1 = (x: number | undefined | null) => (x === undefined || x === null || Number.isNaN(x) ? "–" : x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
const sizes = ["10k", "100k", "500k"];

if (what === "search" || what === "all") {
	const rs = sizes.map((s) => J(`search-${s}`));
	const names: string[] = rs.find(Boolean)?.warm.map((w: { name: string }) => w.name) ?? [];
	console.log(`\n### Search (MessageSearch.search, limit 50, warm connection) — median / p95 ms\n`);
	console.log(`| query | ${sizes.map((s) => `${s} median`).join(" | ")} | ${sizes.map((s) => `${s} p95`).join(" | ")} | matches @${sizes.filter((_, i) => rs[i]).at(-1)} |`);
	console.log(`|---|${sizes.map(() => "---:").join("|")}|${sizes.map(() => "---:").join("|")}|---:|`);
	for (const nm of names) {
		const cells = rs.map((r) => r?.warm.find((w: { name: string }) => w.name === nm));
		const last = cells.filter(Boolean).at(-1);
		const fmt = (c: Record<string, number | string> | undefined, k: string) => (c ? (c.error ? "ERR" : f1(c[k] as number)) : "–");
		console.log(`| ${nm} | ${cells.map((c) => fmt(c, "median")).join(" | ")} | ${cells.map((c) => fmt(c, "p95")).join(" | ")} | ${last?.error ? `error: ${last.error}` : (last?.ftsMatches ?? `rows ${last?.rows}`)} |`);
	}
	for (const [i, r] of rs.entries()) {
		if (!r?.cold) continue;
		console.log(`\n#### Cold (fresh connection) @${sizes[i]} — openDatabase + first query, median/p95 ms (5 samples)\n\n| query | open median | first query median | first query p95 |\n|---|---:|---:|---:|`);
		for (const c of r.cold) console.log(`| ${c.name} | ${f1(c.openDb.median)} | ${f1(c.firstQuery.median)} | ${f1(c.firstQuery.p95)} |`);
	}
	for (const [i, r] of rs.entries()) {
		if (!r?.http) continue;
		console.log(`\n#### HTTP GET /api/search @${sizes[i]} (real socket, JSON) — median/p95 ms\n\n| query | status | bytes | median | p95 |\n|---|---:|---:|---:|---:|`);
		for (const c of r.http) console.log(`| ${c.name} | ${c.status} | ${c.bytes} | ${f1(c.median)} | ${f1(c.p95)} |`);
	}
	const r = rs.find(Boolean);
	if (r) {
		console.log(`\n#### Queries that throw inside MessageSearch (HTTP 500)\n\n| query | result |\n|---|---|`);
		for (const c of r.crash) console.log(`| \`${c.q}\` | ${c.ok ? `ok (${c.rows} rows)` : `throws: ${c.error}`} |`);
	}
}
if (what === "lists" || what === "all") {
	const rs = sizes.map((s) => J(`lists-${s}`));
	const all = new Map<string, (Record<string, number> | undefined)[]>();
	rs.forEach((r, i) => {
		for (const e of r?.endpoints ?? []) {
			const key = e.name.replace(/\d+-msg thread/, "N-msg thread").replace(/offset \d+ \(90% deep\)/, "offset 90% deep");
			if (!all.has(key)) all.set(key, [undefined, undefined, undefined]);
			(all.get(key) as unknown[])[i] = e;
		}
	});
	console.log(`\n### List / thread / count endpoints (app.request, incl. JSON) — median / p95 ms\n\n| endpoint | ${sizes.map((s) => `${s} median`).join(" | ")} | ${sizes.map((s) => `${s} p95`).join(" | ")} | bytes @largest |\n|---|${sizes.map(() => "---:").join("|")}|${sizes.map(() => "---:").join("|")}|---:|`);
	for (const [k, v] of all) console.log(`| ${k} | ${v.map((c) => (c ? f1(c.median) : "–")).join(" | ")} | ${v.map((c) => (c ? f1(c.p95) : "–")).join(" | ")} | ${v.filter(Boolean).at(-1)?.bytes} |`);
}
if (what === "flags" || what === "all") {
	for (const s of sizes) {
		const r = J(`flags-${s}`);
		if (!r) continue;
		console.log(`\n### Flag updates @${s} (${r.count} msgs per run, ${r.runs} runs)\n\n| variant | total ms median | updates/s median | KB written/update median |\n|---|---:|---:|---:|`);
		for (const [k, v] of Object.entries(r.summary as Record<string, Record<string, Record<string, number>>>)) console.log(`| ${k} | ${f1(v.totalMs.median)} | ${f1(v.updatesPerSec.median)} | ${f1(v.bytesWrittenPerUpdateKB.median)} |`);
		console.log(`\nFTS data before: ${JSON.stringify(r.before.fts)} probe=${f1(r.before.probeSearchMs)}ms; after churn: ${JSON.stringify(r.afterChurn.fts)} probe=${f1(r.afterChurn.probeSearchMs)}ms; optimize: ${r.optimize.ms}ms, wrote ${r.optimize.bytesWrittenMB}MB, after ${JSON.stringify(r.optimize.fts)} probe=${f1(r.optimize.probeSearchMs)}ms; FTS integrity: ${r.ftsIntegrityAfter}`);
	}
}
if (what === "build" || what === "all") {
	console.log(`\n### DB build (direct INSERT path) and per-cycle label maintenance\n\n| size | insert rows/s | main DB MB | FTS MB (share) | messages table MB | refreshLabelCounts ms | applyFolderLabels no-op ms | applyIdentityLabel no-op ms |\n|---|---:|---:|---:|---:|---:|---:|---:|`);
	for (const s of sizes) {
		const r = J(`build-db-${s}`);
		if (!r) continue;
		console.log(`| ${s} | ${r.insertRowsPerSec} | ${r.filesMB.main} | ${r.dbstat.bucketsMB.fts} (${(r.dbstat.ftsShare * 100).toFixed(0)}%) | ${r.dbstat.bucketsMB.messages_table} | ${r.labelTimings.refreshLabelCounts_secondMs} | ${r.labelTimings.applyFolderLabelsToMessages_noopMs} | ${r.labelTimings.applyIdentityLabelToMessages_noopMs} |`);
	}
}
if (what === "sync" || what === "all") {
	console.log(`\n### Initial sync via IMAP (Dovecot -> ImapSync.syncAll -> SQLCipher)\n\n| corpus | variant | runs | wall s median | msgs/s median (p95) | MB/s median | peak RSS MB median | cores used | ev-loop p99 / max ms |\n|---|---|---:|---:|---:|---:|---:|---:|---:|`);
	for (const s of ["10k", "50k"])
		for (const v of ["default", "nofts"]) {
			const r = J(`sync-${s}-${v}`);
			if (!r) continue;
			const el = r.results.map((x: { eventLoopDelayMs: { p99: number; max: number } }) => x.eventLoopDelayMs);
			console.log(`| ${s} | ${v} | ${r.summary.runs} | ${f1(r.summary.wallMs.median / 1000)} | ${f1(r.summary.msgsPerSec.median)} (${f1(r.summary.msgsPerSec.p95)}) | ${f1(r.summary.mbPerSec.median)} | ${f1(r.summary.peakRssMB.median)} | ${f1(r.summary.coresUsed.median)} | ${f1(el.at(-1).p99)} / ${f1(Math.max(...el.map((e: { max: number }) => e.max)))} |`);
		}
}
if (what === "insert" || what === "all") {
	const r = J("insert-path");
	if (r) {
		console.log(`\n### Ingestion cost attribution (bench-insert-path.ts, ${r.count} msgs x ${r.runs} runs) — median\n\n| stage | ms / message | msgs/s |\n|---|---:|---:|`);
		for (const [k, v] of Object.entries(r.sqliteInsert as Record<string, { perMsgMs: { median: number }; msgsPerSec: { median: number } }>)) console.log(`| SQLite INSERT: ${k} | ${f1(v.perMsgMs.median)} | ${f1(v.msgsPerSec.median)} |`);
		const names: Record<string, string> = { parse: "mailparser simpleParser", html: "htmlToText", compress: "deflate html_body + raw_headers", attach: "sha256 + deflate of attachments (avg over all msgs)" };
		for (const [k, v] of Object.entries(r.cpuPerMsgMs as Record<string, { median: number }>)) console.log(`| CPU: ${names[k] ?? k} | ${f1(v.median)} | – |`);
	}
}
if (what === "diag" || what === "all") {
	const rs = sizes.map((s) => J(`diag-columns-${s}`));
	if (rs.some(Boolean)) {
		const keys = Object.keys(rs.find(Boolean)).filter((k) => (rs.find(Boolean) as Record<string, { median?: number }>)[k]?.median !== undefined);
		console.log(`\n### Root-cause diagnostics (diag-columns.ts) — median ms\n\n| query | ${sizes.join(" | ")} |\n|---|${sizes.map(() => "---:").join("|")}|`);
		for (const k of keys) console.log(`| ${k} | ${rs.map((r) => (r?.[k] ? f1(r[k].median) : "–")).join(" | ")} |`);
		const r = rs.filter(Boolean).at(-1);
		console.log(`\nPlans: filter-only search as shipped \`${r.plans.searchFilterOnlyShipped?.join(" → ")}\`; without JOIN folders \`${r.plans.searchFilterOnlyNoFolderJoin?.join(" → ")}\`; refreshLabelCounts \`${r.plans.refresh.join(" → ")}\`.`);
	}
}
if (what === "concurrency" || what === "all") {
	for (const s of sizes) {
		const r = J(`concurrency-${s}`);
		if (!r) continue;
		console.log(`\n### Concurrency @${s} (+10k via IMAP), ${r.rate} req/s open-loop\n\n| phase | duration s | requests | >100ms | >1s | latency median | p95 | max | ev-loop p99 | ev-loop max | RSS peak MB (anon / file) |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
		for (const p of r.phases) {
			const l = r.latencyByPhase[p.phase];
			if (!l) continue;
			console.log(`| ${p.phase}${p.syncMs ? ` (sync ${f1(p.syncMs / 1000)}s, new ${p.totalNew}, refreshLabelCounts ${f1(p.refreshLabelCountsMs)}ms)` : ""} | ${f1(p.durationMs / 1000)} | ${l.requests} | ${l.over100ms} | ${l.over1s} | ${f1(l.all.median)} | ${f1(l.all.p95)} | ${f1(l.all.max)} | ${f1(p.server.eventLoopDelayMs.p99)} | ${f1(p.server.eventLoopDelayMs.max)} | ${f1(p.server.rssMB.peak)}${p.server.rssMB.peakAnon ? ` (${f1(p.server.rssMB.peakAnon)} / ${f1(p.server.rssMB.peakFileBacked)})` : ""} |`);
		}
	}
}
if (what === "lifecycle" || what === "all") {
	const files = readdirSync(RESULTS_DIR).filter((f) => f.startsWith("lifecycle-")).map((f) => f.replace(/\.json$/, "")).sort();
	for (const f of files) {
		const r = J(f);
		if (!r) continue;
		console.log(`\n### Lifecycle: ${f.replace("lifecycle-", "")}\n`);
		if (r.kdf) console.log(`- Argon2id (m=64MiB,t=3,p=1, @noble/hashes): unlockWithPassword median ${f1(r.kdf.unlockWithPasswordMs.median)} ms (p95 ${f1(r.kdf.unlockWithPasswordMs.p95)}); initializeEncryption ${f1(r.kdf.initializeEncryptionMs)} ms`);
		if (r.open) console.log(`- openDatabase(): median ${f1(r.open.openDatabaseMs.median)} ms (p95 ${f1(r.open.openDatabaseMs.p95)}); first inbox query ${f1(r.open.firstInboxQueryMs.median)} ms`);
		if (r.migrate) {
			for (const [k, v] of Object.entries(r.migrate as Record<string, Record<string, unknown>>)) {
				if (k.includes("->")) {
					const runs = Object.entries(r.migrate as Record<string, { error?: string; schemaVersionAfter?: number }>).filter(([kk]) => kk.startsWith(k.split("->")[0]) && kk.includes("_run"));
					const err = runs.find(([, x]) => x.error)?.[1];
					console.log(`- migration ${k}: ${f1((v.openWithMigrationMs as { median: number }).median)} ms median${err ? ` then FAILED: "${err.error}" (schema_version left at ${err.schemaVersionAfter})` : `, quick_check=${v.quick_check}`}`);
				}
			}
			if (r.migrate.ftsRebuildMs) console.log(`- full FTS rebuild ('rebuild', = v25 SQL / MessageSearch.rebuildIndex): ${f1(r.migrate.ftsRebuildMs.median)} ms median (p95 ${f1(r.migrate.ftsRebuildMs.p95)})`);
		}
		if (r.server) console.log(`- server: ${Object.entries(r.server.summary as Record<string, { median: number; p95: number }>).map(([k, v]) => `${k} ${f1(v.median)} (p95 ${f1(v.p95)})`).join("; ")}`);
		for (const kind of ["sigterm", "sigkill"]) for (const x of r[kind] ?? []) console.log(`- ${x.kind} ${typeof x.killAtTarget === "string" ? `${x.killAtTarget} (${x.afterKill.messages} rows stored)` : `at ${x.progressAtKill} msgs (folder boundary)`}: shutdown ${x.shutdownMs} ms exit=${JSON.stringify(x.exit)}; after: quick=${x.afterKill.quick} fts=${x.afterKill.ftsIntegrity} msgs=${x.afterKill.messages} dupUid=${x.afterKill.dupFolderUid} dupMsgId=${x.afterKill.dupMessageId} wal=${x.afterKill.walMB}MB; restart ready ${x.restart.readyMs} ms, resume-to-complete ${x.restart.resumeSyncToCompleteMs} ms; final msgs=${x.final.messages} dupMsgId=${x.final.dupMessageId} integrity=${x.final.integrity} fts=${x.final.ftsIntegrity}`);
	}
}
