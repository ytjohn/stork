import type Database from "better-sqlite3-multiple-ciphers";

/** Per-object on-disk size via SQLite's dbstat vtab, grouped into readable buckets. */
export function dbstatSummary(db: Database.Database, schema = "main") {
	const rows = db.prepare(`SELECT name, SUM(pgsize) bytes, COUNT(*) pages FROM dbstat(?) GROUP BY name ORDER BY bytes DESC`).all(schema) as {
		name: string;
		bytes: number;
		pages: number;
	}[];
	const total = rows.reduce((a, r) => a + r.bytes, 0);
	const bucket = (name: string) =>
		name.startsWith("messages_fts")
			? "fts"
			: name === "messages"
				? "messages_table"
				: name.startsWith("idx_messages") || name.startsWith("sqlite_autoindex_messages")
					? "messages_indexes"
					: name.includes("message_labels")
						? "message_labels"
						: "other";
	const buckets: Record<string, number> = {};
	for (const r of rows) buckets[bucket(r.name)] = (buckets[bucket(r.name)] ?? 0) + r.bytes;
	const mb = (b: number) => +(b / 2 ** 20).toFixed(2);
	return {
		totalMB: mb(total),
		bucketsMB: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, mb(v)])),
		ftsShare: +((buckets.fts ?? 0) / total).toFixed(3),
		objectsMB: Object.fromEntries(rows.slice(0, 25).map((r) => [r.name, mb(r.bytes)])),
	};
}
