/**
 * Search latency through the real MessageSearch (src/search/search.ts), exactly as
 * GET /api/search calls it (src/api/routes/search.ts): new MessageSearch(db).search(q, {limit, offset}).
 *
 *   npx tsx audit/perf/bench-search.ts --size 100k [--iters 15] [--http] [--cold]
 *
 *  warm:  same connection, 1 discarded warm-up then --iters timed runs -> median/p95
 *  cold:  (--cold) fresh openDatabase() connection per sample (SQLCipher page cache empty,
 *         OS page cache warm) x 5 samples — what the first search after unlock feels like
 *  http:  (--http) same queries over real HTTP (@hono/node-server + createApp) incl. JSON serialisation
 */
import { serve } from "@hono/node-server";
import { MessageSearch } from "../../src/search/search.js";
import { loadManifest, makeApp, openBenchDb, resolveDbDir } from "./lib/app.js";
import { NEEDLES } from "./lib/corpus.js";
import { MB, arg, dbFiles, envSnapshot, flag, stats, writeResult } from "./lib/env.js";

const size = arg("size", "10k") as string;
const dir = resolveDbDir(size, arg("db"));
const iters = Number(arg("iters", "15"));
const db = openBenchDb(dir);
const manifest = loadManifest(dir, db);
const n = (db.prepare("SELECT COUNT(*) n FROM messages").get() as { n: number }).n;
console.log(`DB ${dir}: ${n} messages, files ${JSON.stringify(dbFiles(dir))}`);

interface Q {
	name: string;
	q: string;
	offset?: number;
	limit?: number;
}
const S = NEEDLES.sender;
const queries: Q[] = [
	{ name: "rare term (10 docs)", q: NEEDLES.rare },
	{ name: "medium term (1%)", q: NEEDLES.medium },
	{ name: "common term (30%)", q: NEEDLES.common },
	{ name: "stopword-like 'the' (~100%)", q: "the" },
	{ name: "two terms AND (1% & 30%)", q: `${NEEDLES.medium} ${NEEDLES.common}` },
	{ name: "OR (1% | 30%)", q: `${NEEDLES.medium} OR ${NEEDLES.common}` },
	{ name: 'phrase "quantum harvest" (0.5%)', q: `"${NEEDLES.phrase}"` },
	{ name: "prefix zqprefix* (2%)", q: `${NEEDLES.prefix}*` },
	{ name: "broad prefix pl* (many terms)", q: "pl*" },
	{ name: "from: only (2%, LIKE scan)", q: `from:${S}` },
	{ name: "from: domain only (LIKE scan)", q: "from:example.org" },
	{ name: "from: + common term", q: `from:${S} ${NEEDLES.common}` },
	{ name: "subject:Invoice only", q: "subject:Invoice" },
	{ name: "subject: + medium term", q: `subject:Invoice ${NEEDLES.medium}` },
	{ name: "has:attachment only", q: "has:attachment" },
	{ name: "is:unread only", q: "is:unread" },
	{ name: "label:INBOX only", q: "label:INBOX" },
	{ name: "label:Lists/dev + common", q: `label:Lists/dev ${NEEDLES.common}` },
	{ name: "label:INBOX + common", q: `label:INBOX ${NEEDLES.common}` },
	{ name: "label:INBOX + from: (no text)", q: `label:INBOX from:${S}` },
	{ name: "from: + label:INBOX (order swapped)", q: `from:${S} label:INBOX` },
	{ name: "date range only (6 months)", q: "after:2025-01-01 before:2025-07-01" },
	{ name: "date range + common", q: `after:2025-01-01 before:2025-07-01 ${NEEDLES.common}` },
	{ name: "combined: common+from:domain+has:att+after+is:unread", q: `${NEEDLES.common} from:example.org has:attachment after:2023-01-01 is:unread` },
	{ name: "common term, offset 5000 (page 101)", q: NEEDLES.common, offset: 5000 },
	{ name: "'the', offset 5000", q: "the", offset: 5000 },
	{ name: "is:unread, offset 5000", q: "is:unread", offset: 5000 },
	{ name: "has:attachment, offset 5000", q: "has:attachment", offset: 5000 },
	{ name: "zero-hit term", q: "zzznotawordqqq" },
];
const crashQueries = ["user@example.com", "AT&T", "a-b", "foo:bar", "c++", '"unterminated', "(", "*", "NOT", "-foo", "alice.perf", "e-mail", "don't", "50%", "re:"];

const search = new MessageSearch(db);
const time = (fn: () => unknown) => {
	const t = process.hrtime.bigint();
	const r = fn();
	return { ms: Number(process.hrtime.bigint() - t) / 1e6, r };
};
const ftsCount = (q: string) => {
	try {
		const { ftsQuery } = { ftsQuery: q };
		return (db.prepare("SELECT COUNT(*) c FROM messages_fts WHERE messages_fts MATCH ?").get(ftsQuery) as { c: number }).c;
	} catch {
		return null;
	}
};

const warm: Record<string, unknown>[] = [];
for (const q of queries) {
	const opts = { limit: q.limit ?? 50, offset: q.offset ?? 0 };
	let first: { ms: number; r: unknown };
	try {
		first = time(() => search.search(q.q, opts));
	} catch (e) {
		warm.push({ name: q.name, q: q.q, offset: opts.offset, error: (e as Error).message });
		console.log(`${q.name.padEnd(56)} ERROR ${(e as Error).message}`);
		continue;
	}
	const xs: number[] = [];
	let rows = 0;
	for (let i = 0; i < iters; i++) {
		const t = time(() => search.search(q.q, opts));
		xs.push(t.ms);
		rows = (t.r as unknown[]).length;
	}
	const s = stats(xs);
	const hasText = !/^(from|subject|has|is|label|after|before):/.test(q.q) || /\s[^:\s]+(\s|$)/.test(` ${q.q.replace(/\b\w+:\S+/g, "")} `);
	const matches = hasText ? ftsCount(q.q.replace(/\b(from|to|subject|has|is|before|after|label):\S+/g, "").trim()) : null;
	warm.push({ name: q.name, q: q.q, offset: opts.offset, rows, ftsMatches: matches, firstMs: +first.ms.toFixed(2), ...s });
	console.log(`${q.name.padEnd(56)} rows=${String(rows).padStart(3)} matches=${String(matches ?? "-").padStart(7)} first=${first.ms.toFixed(1).padStart(8)}ms median=${s.median.toFixed(1).padStart(8)} p95=${s.p95.toFixed(1).padStart(8)}`);
}

const crash: Record<string, unknown>[] = [];
for (const q of crashQueries) {
	try {
		const r = search.search(q, { limit: 50, offset: 0 });
		crash.push({ q, ok: true, rows: r.length });
	} catch (e) {
		crash.push({ q, ok: false, error: (e as Error).message });
	}
}
console.table(crash);

let cold: Record<string, unknown>[] | undefined;
if (flag("cold")) {
	cold = [];
	const pick = ["rare term (10 docs)", "medium term (1%)", "common term (30%)", "from: only (2%, LIKE scan)", "is:unread only", "label:INBOX only", "combined: common+from:domain+has:att+after+is:unread", "common term, offset 5000 (page 101)"];
	for (const q of queries.filter((x) => pick.includes(x.name))) {
		const openMs: number[] = [];
		const qMs: number[] = [];
		for (let i = 0; i < 5; i++) {
			const t0 = performance.now();
			const d2 = openBenchDb(dir);
			openMs.push(performance.now() - t0);
			const s2 = new MessageSearch(d2);
			qMs.push(time(() => s2.search(q.q, { limit: 50, offset: q.offset ?? 0 })).ms);
			d2.close();
		}
		cold.push({ name: q.name, openDb: stats(openMs), firstQuery: stats(qMs) });
		console.log(`cold ${q.name.padEnd(52)} open median=${stats(openMs).median.toFixed(0)}ms  firstQuery median=${stats(qMs).median.toFixed(1)}ms p95=${stats(qMs).p95.toFixed(1)}`);
	}
}

let http: Record<string, unknown>[] | undefined;
if (flag("http")) {
	http = [];
	const app = makeApp(db, dir);
	const port = 14290 + Math.floor(Math.random() * 9);
	const server = serve({ port, fetch: app.fetch });
	await new Promise((r) => setTimeout(r, 300));
	for (const q of [...queries, ...crashQueries.map((c) => ({ name: `crash? ${c}`, q: c }))]) {
		const url = `http://127.0.0.1:${port}/api/search?q=${encodeURIComponent(q.q)}&limit=50&offset=${(q as Q).offset ?? 0}`;
		const xs: number[] = [];
		let status = 0;
		let bytes = 0;
		let body = "";
		const reps = q.name.startsWith("crash?") ? 1 : Math.max(5, Math.floor(iters / 2));
		for (let i = 0; i < reps + 1; i++) {
			const t0 = performance.now();
			const res = await fetch(url);
			body = await res.text();
			const ms = performance.now() - t0;
			status = res.status;
			bytes = body.length;
			if (i > 0 || reps === 1) xs.push(ms);
		}
		http.push({ name: q.name, q: q.q, status, bytes, ...(status >= 400 ? { body: body.slice(0, 200) } : {}), ...stats(xs) });
		console.log(`http ${q.name.padEnd(52)} status=${status} bytes=${String(bytes).padStart(7)} median=${stats(xs).median.toFixed(1)}ms p95=${stats(xs).p95.toFixed(1)}`);
	}
	server.close();
}

writeResult(`search-${size}`, { env: envSnapshot(), dir, messages: n, filesMB: Object.fromEntries(Object.entries(dbFiles(dir)).map(([k, v]) => [k, MB(v)])), expected: manifest.expected, iters, rssMB: MB(process.memoryUsage().rss), warm, crash, cold, http });
process.exit(0);
