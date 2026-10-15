/**
 * Child process for C (large attachments): runs ONE real ImapSync.syncAll()
 * against the audit Dovecot and reports peak RSS, wall time, and the sha256 of
 * every attachment as served by the real download route.
 *   npx tsx audit/sync-edge/large-attach-child.ts <port>
 */
import { createHash } from "node:crypto";
import { attachmentRoutes } from "../../src/api/routes/attachments.js";
import { ImapSync } from "../../src/sync/imap-sync.js";
import { createTestDb, createTestInboundConnector } from "../../src/test-helpers/test-db.js";

async function main() {
	const port = Number(process.argv[2]);
	let peak = process.memoryUsage().rss;
	const baseline = peak;
	const sampler = setInterval(() => {
		const r = process.memoryUsage().rss;
		if (r > peak) peak = r;
	}, 20);
	const db = createTestDb();
	const id = createTestInboundConnector(db, { name: "Large" });
	const sync = new ImapSync(
		{ host: "127.0.0.1", port, secure: false, auth: { user: "alice", pass: "alicepass" } },
		db,
		id,
	);
	const t0 = Date.now();
	await sync.connect();
	const res = await sync.syncAll();
	await sync.disconnect();
	const syncMs = Date.now() - t0;
	const syncPeak = peak;

	const app = attachmentRoutes(() => db);
	const atts = db
		.prepare("SELECT a.id, a.filename, a.size, a.content_hash, m.subject FROM attachments a JOIN messages m ON m.id = a.message_id ORDER BY a.id")
		.all() as { id: number; filename: string; size: number; content_hash: string; subject: string }[];
	const downloads = [];
	for (const a of atts) {
		const r = await app.request(`/${a.id}`);
		const buf = Buffer.from(await r.arrayBuffer());
		downloads.push({
			subject: a.subject,
			filename: a.filename,
			size: a.size,
			downloadedBytes: buf.length,
			sha256: createHash("sha256").update(buf).digest("hex"),
			contentHash: a.content_hash,
		});
	}
	clearInterval(sampler);
	const blobRows = (db.prepare("SELECT COUNT(*) n, SUM(LENGTH(data)) bytes FROM blobs.attachment_blobs").get() as { n: number; bytes: number });
	const out = {
		syncMs,
		newMessages: res.totalNew,
		errors: res.folders.flatMap((f) => f.errors),
		baselineRssMB: Math.round(baseline / 2 ** 20),
		peakRssDuringSyncMB: Math.round(syncPeak / 2 ** 20),
		peakRssIncludingDownloadMB: Math.round(peak / 2 ** 20),
		maxRssKernelMB: Math.round(process.resourceUsage().maxRSS / 1024),
		blobRows: blobRows.n,
		blobBytes: blobRows.bytes,
		attachmentRows: atts.length,
		downloads,
	};
	process.stdout.write(`${JSON.stringify(out)}\n`);
	process.exit(0);
}

main().catch((e) => {
	process.stderr.write(String(e?.stack ?? e));
	process.exit(1);
});
