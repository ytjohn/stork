/**
 * A. GMAIL SEMANTICS — simulated Gmail folder/label layout on Dovecot.
 *
 * Gmail exposes labels as IMAP folders and the same message appears once per
 * label plus once in "[Gmail]/All Mail". Stork has no X-GM-EXT-1 support
 * (no X-GM-MSGID / X-GM-LABELS), so it can only see per-folder copies.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { inboxRoutes } from "../../src/api/routes/inbox.js";
import { MessageSearch } from "../../src/search/search.js";
import { ImapSync } from "../../src/sync/imap-sync.js";
import { adminClient, appendTo, count, type Ctx, freshDb, imapConfig, resetDovecot, runSync } from "./helpers.js";

const GMAIL_MAILBOXES = [
	{ name: "[Gmail]/All Mail", specialUse: "\\All" },
	{ name: "[Gmail]/Sent Mail", specialUse: "\\Sent" },
	{ name: "[Gmail]/Starred", specialUse: "\\Flagged" },
	{ name: "[Gmail]/Important", specialUse: "\\Important" },
	{ name: "[Gmail]/Spam", specialUse: "\\Junk" },
	{ name: "[Gmail]/Trash", specialUse: "\\Trash" },
	{ name: "[Gmail]/Drafts", specialUse: "\\Drafts" },
	{ name: "Work" },
	{ name: "Work/Clients" },
	{ name: "Receipts" },
];

function gmailMsg(id: string, subject: string, body: string): string {
	return [
		"From: Client <client@example.com>",
		"To: me@gmail.example",
		`Subject: ${subject}`,
		`Message-ID: <${id}>`,
		"Date: Mon, 05 Oct 2026 10:00:00 +0000",
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		body,
		"",
	].join("\r\n");
}

// the "same message" in INBOX + All Mail + 2 user labels (Work/Clients, Receipts)
const M1 = gmailMsg("gm1@mail.gmail.example", "Invoice zebracorn", "Please pay the zebracorn invoice.");
const M1_FOLDERS = ["INBOX", "[Gmail]/All Mail", "Work/Clients", "Receipts"];

let ctx: Ctx;

describe("A. Gmail layout simulated on Dovecot", () => {
	beforeAll(async () => {
		await resetDovecot({ mailboxes: GMAIL_MAILBOXES });
		const c = await adminClient();
		for (const f of M1_FOLDERS) await appendTo(c, f, M1);
		// archived message: only in All Mail
		await appendTo(c, "[Gmail]/All Mail", gmailMsg("gm2@mail.gmail.example", "Old archived", "archived body"));
		// spam: in Spam only (Gmail does NOT put spam in All Mail)
		await appendTo(c, "[Gmail]/Spam", gmailMsg("spam1@spam.example", "Cheap pills zebracorn", "spammy"));
		await c.logout();
		ctx = freshDb("Gmail");
		const r = await runSync(ctx);
		expect(r.totalErrors).toBe(0);
	});

	afterAll(() => ctx?.db.close());

	test("no X-GM-EXT-1 support anywhere in src/", () => {
		// verified by grep: no X-GM-MSGID, X-GM-LABELS, X-GM-THRID in src/
		const src = readFileSync(join(__dirname, "../../src/sync/imap-sync.ts"), "utf8");
		expect(src).not.toMatch(/X-GM|gmail.*labels|xGm/i);
	});

	test("folder list and special-use as recorded", () => {
		const rows = ctx.db
			.prepare("SELECT path, name, special_use FROM folders WHERE inbound_connector_id = ? ORDER BY path")
			.all(ctx.connectorId) as { path: string; name: string; special_use: string | null }[];
		const map = Object.fromEntries(rows.map((r) => [r.path, r.special_use]));
		// Every Gmail folder is synced, including Spam and Trash; [Gmail] parent is \Noselect → skipped
		expect(Object.keys(map).sort()).toEqual(
			[
				"INBOX",
				"Receipts",
				"Work",
				"Work/Clients",
				"[Gmail]/All Mail",
				"[Gmail]/Drafts",
				"[Gmail]/Important",
				"[Gmail]/Sent Mail",
				"[Gmail]/Spam",
				"[Gmail]/Starred",
				"[Gmail]/Trash",
			].sort(),
		);
		expect(map["[Gmail]/All Mail"]).toBe("\\All");
		expect(map["[Gmail]/Spam"]).toBe("\\Junk");
		// \Important is not an RFC 6154 flag; imapflow drops it
		expect(map["[Gmail]/Important"]).toBeNull();
	});

	test("same Message-ID → one local row PER FOLDER, one FTS row per copy", () => {
		const rows = count(ctx.db, "SELECT COUNT(*) n FROM messages WHERE message_id = ?", "<gm1@mail.gmail.example>");
		expect(rows).toBe(4);
		const fts = count(
			ctx.db,
			"SELECT COUNT(*) n FROM messages_fts WHERE messages_fts MATCH 'zebracorn' AND rowid IN (SELECT id FROM messages WHERE message_id = ?)",
			"<gm1@mail.gmail.example>",
		);
		expect(fts).toBe(4);
		// bodies are stored 4x (no content-level dedup for text)
		const bodyBytes = count(
			ctx.db,
			"SELECT SUM(LENGTH(text_body)) n FROM messages WHERE message_id = ?",
			"<gm1@mail.gmail.example>",
		);
		expect(bodyBytes).toBe(4 * "Please pay the zebracorn invoice.\n".length);
	});

	test("search returns duplicates (one hit per folder copy) and includes Spam", () => {
		const s = new MessageSearch(ctx.db);
		const hits = s.search("zebracorn");
		const byFolder = hits.map((h) => h.folder_path).sort();
		expect(byFolder).toEqual([...M1_FOLDERS, "[Gmail]/Spam"].sort());
		expect(hits.filter((h) => h.subject === "Invoice zebracorn")).toHaveLength(4);
	});

	test("/api/inbox/all-messages lists the same message 4 times", async () => {
		const app = inboxRoutes(() => ctx.db);
		const res = await app.request("/all-messages?limit=100");
		const list = (await res.json()) as { message_id: string }[];
		expect(list.filter((m) => m.message_id === "<gm1@mail.gmail.example>")).toHaveLength(4);
	});

	test("labels are derived from folder PATHS; each copy carries exactly one folder label", () => {
		const labels = ctx.db
			.prepare("SELECT name, source FROM labels ORDER BY name")
			.all() as { name: string; source: string }[];
		const names = labels.map((l) => l.name);
		expect(names).toContain("Work/Clients");
		expect(names).toContain("[Gmail]/All Mail");
		expect(names).toContain("[Gmail]/Spam");
		const perRow = ctx.db
			.prepare(`
				SELECT m.id, f.path, GROUP_CONCAT(l.name, '|') AS labels
				FROM messages m JOIN folders f ON f.id = m.folder_id
				JOIN message_labels ml ON ml.message_id = m.id JOIN labels l ON l.id = ml.label_id
				WHERE m.message_id = ? GROUP BY m.id ORDER BY f.path`)
			.all("<gm1@mail.gmail.example>") as { path: string; labels: string }[];
		// Labels are NOT merged across copies: the INBOX row does not know it is also "Receipts"
		for (const r of perRow) {
			expect(r.labels.split("|").sort()).toEqual([r.path, "Gmail"].sort());
		}
	});

	test("label removed (expunged from Receipts only) → only that copy row is deleted", async () => {
		const c = await adminClient();
		const lock = await c.getMailboxLock("Receipts");
		await c.messageDelete("1:*");
		lock.release();
		await c.logout();
		await runSync(ctx);
		const paths = (
			ctx.db
				.prepare("SELECT f.path FROM messages m JOIN folders f ON f.id=m.folder_id WHERE m.message_id = ? ORDER BY f.path")
				.all("<gm1@mail.gmail.example>") as { path: string }[]
		).map((r) => r.path);
		expect(paths).toEqual(["INBOX", "Work/Clients", "[Gmail]/All Mail"].sort());
	});

	test("archive (removed from INBOX, still in All Mail) → INBOX row deleted, All Mail row survives", async () => {
		const c = await adminClient();
		const lock = await c.getMailboxLock("INBOX");
		await c.messageDelete("1:*");
		lock.release();
		await c.logout();
		await runSync(ctx);
		const paths = (
			ctx.db
				.prepare("SELECT f.path FROM messages m JOIN folders f ON f.id=m.folder_id WHERE m.message_id = ? ORDER BY f.path")
				.all("<gm1@mail.gmail.example>") as { path: string }[]
		).map((r) => r.path);
		expect(paths).toEqual(["Work/Clients", "[Gmail]/All Mail"].sort());
		const app = inboxRoutes(() => ctx.db);
		const unified = (await (await app.request("/unified?limit=100")).json()) as unknown[];
		expect(unified).toHaveLength(0);
	});

	test("relabelFromServer: label lookup joins folder LEAF name to label (labels are PATHS) → no-op for nested/[Gmail] folders", async () => {
		// Simulate a Gmail label MOVE: message moved Work/Clients → Receipts.
		const c = await adminClient();
		const lock = await c.getMailboxLock("Work/Clients");
		await c.messageMove("1:*", "Receipts");
		lock.release();
		await c.logout();
		// Sync new copy into Receipts, but use relabel BEFORE flag-sync could delete the old row
		// by syncing only Receipts.
		const sync = new ImapSync(imapConfig(), ctx.db, ctx.connectorId);
		await sync.connect();
		await sync.syncFolders();
		await sync.syncFolder("Receipts");
		sync.applyFolderLabelsToMessages();
		const res = await sync.relabelFromServer();
		await sync.disconnect();
		// detected the move via Message-ID ...
		expect(res.crossFolderMovesDetected).toBeGreaterThanOrEqual(1);
		// ... but the stale "Work/Clients" label is still attached to the old row,
		// because removeLabelStmt matches labels.name = folders.name ("Clients").
		const stale = count(
			ctx.db,
			`SELECT COUNT(*) n FROM messages m JOIN folders f ON f.id=m.folder_id
			 JOIN message_labels ml ON ml.message_id=m.id JOIN labels l ON l.id=ml.label_id
			 WHERE f.path='Work/Clients' AND l.name='Work/Clients'`,
		);
		expect(stale).toBe(1);
	});

	test("relabelFromServer control: FLAT folder names (path == name) DO get the stale label removed", async () => {
		const c = await adminClient();
		await appendTo(c, "Receipts", gmailMsg("gm3@mail.gmail.example", "flat move", "flat"));
		await c.logout();
		await runSync(ctx);
		const c2 = await adminClient();
		const lock = await c2.getMailboxLock("Receipts");
		await c2.messageMove({ header: { "message-id": "gm3@mail.gmail.example" } } as never, "INBOX");
		lock.release();
		await c2.logout();
		const sync = new ImapSync(imapConfig(), ctx.db, ctx.connectorId);
		await sync.connect();
		await sync.syncFolders();
		await sync.syncFolder("INBOX");
		sync.applyFolderLabelsToMessages();
		await sync.relabelFromServer();
		await sync.disconnect();
		const stale = count(
			ctx.db,
			`SELECT COUNT(*) n FROM messages m JOIN folders f ON f.id=m.folder_id
			 JOIN message_labels ml ON ml.message_id=m.id JOIN labels l ON l.id=ml.label_id
			 WHERE m.message_id='<gm3@mail.gmail.example>' AND f.path='Receipts' AND l.name='Receipts'`,
		);
		expect(stale).toBe(0);
	});

	test("no per-folder sync exclusion exists (schema has no such column)", () => {
		const cols = (ctx.db.prepare("PRAGMA table_info(folders)").all() as { name: string }[]).map((c) => c.name);
		expect(cols.some((c) => /exclude|enabled|skip|ignore|subscribed/i.test(c))).toBe(false);
		const icCols = (ctx.db.prepare("PRAGMA table_info(inbound_connectors)").all() as { name: string }[]).map(
			(c) => c.name,
		);
		expect(icCols.some((c) => /folder|exclude/i.test(c))).toBe(false);
	});
});
