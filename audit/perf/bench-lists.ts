/**
 * List / thread / count endpoint latency through the real Hono app (createApp), in-process
 * via app.request() (routing + SQL + JSON serialisation; no socket).
 *
 *   npx tsx audit/perf/bench-lists.ts --size 100k [--iters 10]
 *
 * Covers src/api/routes/inbox.ts, labels.ts, messages.ts (GET /:id, GET /:id/thread).
 * Page 1000 = offset 49950 at limit 50.
 */
import { loadManifest, makeApp, openBenchDb, resolveDbDir } from "./lib/app.js";
import { MB, arg, dbFiles, envSnapshot, stats, writeResult } from "./lib/env.js";

const size = arg("size", "10k") as string;
const dir = resolveDbDir(size, arg("db"));
const iters = Number(arg("iters", "10"));
const db = openBenchDb(dir);
const manifest = loadManifest(dir, db);
const app = makeApp(db, dir);
const n = (db.prepare("SELECT COUNT(*) n FROM messages").get() as { n: number }).n;
const lab = (name: string) => (db.prepare("SELECT id, message_count FROM labels WHERE name = ?").get(name) as { id: number; message_count: number } | undefined) ?? { id: 0, message_count: 0 };
const inbox = lab("INBOX");
const archive = lab("Archive");
const lists = lab("Lists/dev");
const ident = db.prepare("SELECT id, message_count FROM labels WHERE source='connector' LIMIT 1").get() as { id: number; message_count: number };
console.log(`DB ${dir}: ${n} msgs, INBOX=${inbox.message_count} Archive=${archive.message_count}`);

const endpoints: { name: string; path: string }[] = [];
const add = (name: string, path: string) => endpoints.push({ name, path });
for (const off of [0, 1000, 10000, 49950]) {
	if (off < inbox.message_count) add(`unified inbox offset ${off}`, `/api/inbox/unified?limit=50&offset=${off}`);
	if (off < archive.message_count) add(`label Archive messages offset ${off}`, `/api/labels/${archive.id}/messages?limit=50&offset=${off}`);
	if (off < n) add(`all-messages offset ${off}`, `/api/inbox/all-messages?limit=50&offset=${off}`);
}
const deep = Math.floor(n * 0.9 / 50) * 50;
add(`all-messages offset ${deep} (90% deep)`, `/api/inbox/all-messages?limit=50&offset=${deep}`);
if (archive.message_count > 1000) add(`label Archive last page`, `/api/labels/${archive.id}/messages?limit=50&offset=${archive.message_count - 50}`);
add("unread-messages offset 0", "/api/inbox/unread-messages?limit=50&offset=0");
add("unread-messages offset 5000", "/api/inbox/unread-messages?limit=50&offset=5000");
add("unified inbox limit=200", "/api/inbox/unified?limit=200&offset=0");
add("labels list", "/api/labels");
add("unified/count (cached)", "/api/inbox/unified/count");
add("all-messages/count (cached)", "/api/inbox/all-messages/count");
add("labels/filter INBOX∩identity offset 0", `/api/labels/filter?ids=${inbox.id},${ident.id}&limit=50&offset=0`);
add("labels/filter INBOX∩identity offset 10000", `/api/labels/filter?ids=${inbox.id},${ident.id}&limit=50&offset=10000`);
add("labels/filter/count INBOX∩identity", `/api/labels/filter/count?ids=${inbox.id},${ident.id}`);
add("labels/:INBOX/related", `/api/labels/${inbox.id}/related`);
add("labels/filter/related INBOX∩Lists", `/api/labels/filter/related?ids=${inbox.id},${lists.id}`);

// Threads: longest generated threads (60 msgs) + an ordinary reply
const longIds = Object.values(manifest.longThreadIds).sort((a, b) => b.length - a.length)[0] ?? [];
if (longIds.length) {
	add(`thread: last msg of ${longIds.length}-msg thread`, `/api/messages/${longIds[longIds.length - 1]}/thread`);
	add(`thread: middle msg of ${longIds.length}-msg thread`, `/api/messages/${longIds[Math.floor(longIds.length / 2)]}/thread`);
	add(`thread: root of ${longIds.length}-msg thread`, `/api/messages/${longIds[0]}/thread`);
}
const reply = db.prepare("SELECT id FROM messages WHERE in_reply_to IS NOT NULL AND subject NOT LIKE '%planning thread' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
if (reply) add("thread: ordinary reply", `/api/messages/${reply.id}/thread`);
const bigMsg = db.prepare("SELECT id FROM messages ORDER BY length(text_body) DESC LIMIT 1").get() as { id: number };
add("message: largest text body", `/api/messages/${bigMsg.id}`);
add("message: typical", `/api/messages/${Math.floor(n / 2)}`);

const out: Record<string, unknown>[] = [];
for (const e of endpoints) {
	const xs: number[] = [];
	let status = 0;
	let bytes = 0;
	let rows: number | null = null;
	for (let i = 0; i < iters + 1; i++) {
		const t0 = performance.now();
		const res = await app.request(e.path);
		const body = await res.text();
		const ms = performance.now() - t0;
		status = res.status;
		bytes = body.length;
		try {
			const j = JSON.parse(body);
			rows = Array.isArray(j) ? j.length : null;
		} catch {}
		if (i > 0) xs.push(ms);
	}
	const s = stats(xs);
	out.push({ name: e.name, path: e.path, status, rows, bytes, ...s });
	console.log(`${e.name.padEnd(48)} ${status} rows=${String(rows ?? "-").padStart(4)} bytes=${String(bytes).padStart(8)} median=${s.median.toFixed(2).padStart(9)}ms p95=${s.p95.toFixed(2).padStart(9)}`);
}

// EXPLAIN QUERY PLAN for the main list queries (copied from the route handlers)
const eqp = (sql: string, ...p: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p) as { detail: string }[]).map((r) => r.detail);
const plans = {
	unified: eqp(`SELECT m.id FROM message_labels ml JOIN messages m ON m.id = ml.message_id WHERE ml.label_id = ? ORDER BY ml.date DESC LIMIT 50 OFFSET 0`, inbox.id),
	allMessages: eqp(`SELECT m.id FROM messages m ORDER BY m.date DESC LIMIT 50 OFFSET 0`),
	unread: eqp(`SELECT m.id FROM messages m WHERE (m.flags IS NULL OR m.flags NOT LIKE '%\\Seen%') ORDER BY m.date DESC LIMIT 50 OFFSET 0`),
	threadLookup: eqp(`SELECT DISTINCT m.*, f.path FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.inbound_connector_id = ? AND (m.message_id IN (?,?) OR m.in_reply_to IN (?,?) OR m.id = ?) ORDER BY m.date ASC`, 1, "a", "b", "a", "b", 1),
	filter: eqp(`SELECT ml.message_id, MAX(ml.date) AS latest_date FROM message_labels ml WHERE ml.label_id IN (?,?) GROUP BY ml.message_id HAVING COUNT(DISTINCT ml.label_id) = 2 ORDER BY latest_date DESC LIMIT 50 OFFSET 0`, inbox.id, ident.id),
};
console.log(JSON.stringify(plans, null, 1));
writeResult(`lists-${size}`, { env: envSnapshot(), dir, messages: n, filesMB: Object.fromEntries(Object.entries(dbFiles(dir)).map(([k, v]) => [k, MB(v)])), iters, endpoints: out, plans });
process.exit(0);
