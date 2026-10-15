/**
 * Diagnostic: why are flag-based scans (is:unread, /unread-messages, refreshLabelCounts) slow?
 * messages.flags is stored AFTER text_body/html_body in the row (src/storage/schema.ts v19 table),
 * so reading it for a row whose body spilled into overflow pages walks the overflow chain.
 *
 *   npx tsx audit/perf/diag-columns.ts --size 100k
 */
import { openBenchDb, resolveDbDir } from "./lib/app.js";
import { arg, envSnapshot, stats, writeResult } from "./lib/env.js";

const size = arg("size", "100k") as string;
const dir = resolveDbDir(size, arg("db"));
const db = openBenchDb(dir);
const t = (sql: string) => {
	db.prepare(sql).all();
	const xs: number[] = [];
	for (let i = 0; i < 5; i++) {
		const t0 = performance.now();
		db.prepare(sql).all();
		xs.push(performance.now() - t0);
	}
	return stats(xs);
};
const cols = (db.prepare("SELECT name FROM pragma_table_info('messages')").all() as { name: string }[]).map((r) => r.name);
const q = {
	"COUNT(*) (covering index)": "SELECT COUNT(*) FROM messages",
	"SUM(uid)  (col #5, before bodies)": "SELECT SUM(uid) FROM messages",
	"SUM(length(subject)) (col #9)": "SELECT SUM(length(subject)) FROM messages",
	"COUNT flags NOT LIKE Seen (col after text_body/html_body)": "SELECT COUNT(*) FROM messages WHERE flags IS NULL OR flags NOT LIKE '%\\Seen%'",
	"SUM(has_attachments) (after bodies)": "SELECT SUM(has_attachments) FROM messages",
	"refreshLabelCounts query 1 (GROUP BY label)": "SELECT ml.label_id, COUNT(*), SUM(CASE WHEN m.flags IS NULL OR m.flags NOT LIKE '%\\Seen%' THEN 1 ELSE 0 END) FROM message_labels ml JOIN messages m ON m.id = ml.message_id GROUP BY ml.label_id",
	"applyFolderLabelsToMessages SELECT part (no-op)": "SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id JOIN labels l ON l.name = f.path LEFT JOIN message_labels ml ON ml.message_id = m.id AND ml.label_id = l.id LEFT JOIN label_overrides lo ON lo.message_id = m.id AND lo.label_id = l.id WHERE m.inbound_connector_id = 1 AND ml.message_id IS NULL AND lo.message_id IS NULL",
};
const out: Record<string, unknown> = { env: envSnapshot(), dir, columnOrder: cols };
for (const [k, sql] of Object.entries(q)) {
	const s = t(sql);
	out[k] = s;
	console.log(`${k.padEnd(62)} median ${s.median.toFixed(1)} ms`);
}
// Filter-only search SQL as built by MessageSearch (search.ts ~:200) vs the same without JOIN folders
const fromSql = (join: boolean) =>
	`SELECT m.id, m.subject, SUBSTR(m.text_body, 1, 200) as snippet FROM messages m ${join ? "JOIN folders f ON f.id = m.folder_id" : ""} WHERE (m.from_address LIKE '%needle.sender@known-corp.example%' COLLATE NOCASE OR m.from_name LIKE '%needle.sender@known-corp.example%' COLLATE NOCASE) ORDER BY m.date DESC LIMIT 50 OFFSET 0`;
for (const [k, sql] of Object.entries({ "search from: filter-only, as shipped (JOIN folders)": fromSql(true), "search from: filter-only, without JOIN folders": fromSql(false) })) {
	const s = t(sql);
	out[k] = s;
	console.log(`${k.padEnd(62)} median ${s.median.toFixed(1)} ms`);
}
const eqp = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail);
out.plans = {
	refresh: eqp(q["refreshLabelCounts query 1 (GROUP BY label)"]),
	apply: eqp(q["applyFolderLabelsToMessages SELECT part (no-op)"]),
	searchFilterOnlyShipped: eqp(fromSql(true)),
	searchFilterOnlyNoFolderJoin: eqp(fromSql(false)),
};
console.log(JSON.stringify(out.plans, null, 1));
writeResult(`diag-columns-${size}`, out);
process.exit(0);
