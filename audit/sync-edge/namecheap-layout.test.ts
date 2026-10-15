/**
 * E. Namecheap Private Email-style layout: Dovecot with hierarchy separator "."
 * and namespace prefix "INBOX." (Courier-compatible), NO special_use
 * attributes and SPECIAL-USE removed from CAPABILITY.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { inboxRoutes } from "../../src/api/routes/inbox.js";
import { adminClient, appendTo, count, type Ctx, freshDb, resetDovecot, runSync } from "./helpers.js";

const CAPS_NO_SPECIAL_USE =
	"IMAP4rev1 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE SORT SORT=DISPLAY THREAD=REFERENCES THREAD=REFS THREAD=ORDEREDSUBJECT MULTIAPPEND URL-PARTIAL CATENATE UNSELECT CHILDREN NAMESPACE UIDPLUS LIST-EXTENDED I18NLEVEL=1 CONDSTORE QRESYNC ESEARCH ESORT SEARCHRES WITHIN CONTEXT=SEARCH LIST-STATUS BINARY MOVE LITERAL+";

const FOLDERS = ["INBOX.Sent", "INBOX.Drafts", "INBOX.Trash", "INBOX.Spam", "INBOX.Archive", "INBOX.Work", "INBOX.Work.Clients", "INBOX.Sent Items"];

const m = (i: number, f: string) =>
	`From: x${i}@example.com\r\nTo: me@example.org\r\nSubject: nc ${f} ${i}\r\nMessage-ID: <nc-${i}-${f.replace(/\W/g, "")}@example.org>\r\nDate: Tue, 06 Oct 2026 12:00:00 +0000\r\n\r\nbody ${i}\r\n`;

let ctx: Ctx;
let slashFolderCreated = false;
let capabilities: string[] = [];

describe("E. Namecheap-style '.' separator, INBOX. prefix, no SPECIAL-USE", () => {
	beforeAll(async () => {
		await resetDovecot({ separator: ".", prefix: "INBOX.", specialUse: false, capability: CAPS_NO_SPECIAL_USE });
		const c = await adminClient();
		capabilities = [...c.capabilities.keys()];
		await appendTo(c, "INBOX", m(1, "INBOX"));
		for (const [i, f] of FOLDERS.entries()) await appendTo(c, f, m(i + 10, f));
		try {
			await c.mailboxCreate("INBOX.a/b");
			await appendTo(c, "INBOX.a/b", m(99, "slash"));
			slashFolderCreated = true;
		} catch {
			slashFolderCreated = false;
		}
		await c.logout();
		ctx = freshDb("Namecheap");
		const r = await runSync(ctx);
		expect(r.totalErrors).toBe(0);
	});
	afterAll(async () => {
		writeFileSync(
			join(__dirname, "namecheap-layout.observed.json"),
			JSON.stringify({ slashFolderCreated, capabilities, folders: ctx.db.prepare("SELECT path, name, delimiter, special_use FROM folders ORDER BY path").all() }, null, 2),
		);
		ctx?.db.close();
		await resetDovecot(); // leave the shared port in the default layout
	});

	test("server really lacks SPECIAL-USE", () => {
		expect(capabilities).not.toContain("SPECIAL-USE");
		expect(capabilities).toContain("IMAP4rev1");
	});

	test("all folders synced with delimiter '.', every message stored", () => {
		const rows = ctx.db.prepare("SELECT path, name, delimiter, special_use FROM folders ORDER BY path").all() as {
			path: string;
			name: string;
			delimiter: string;
			special_use: string | null;
		}[];
		const paths = rows.map((r) => r.path);
		for (const f of ["INBOX", ...FOLDERS]) expect(paths).toContain(f);
		expect(rows.every((r) => r.delimiter === ".")).toBe(true);
		expect(count(ctx.db, "SELECT COUNT(*) n FROM messages")).toBe(1 + FOLDERS.length + (slashFolderCreated ? 1 : 0));
		const nested = rows.find((r) => r.path === "INBOX.Work.Clients");
		expect(nested?.name).toBe("Clients");
	});

	test("special-use inferred from LEAF names by imapflow (Stork's own fallback would miss 'INBOX.Sent')", () => {
		const su = Object.fromEntries(
			(ctx.db.prepare("SELECT path, special_use FROM folders").all() as { path: string; special_use: string | null }[]).map((r) => [r.path, r.special_use]),
		);
		expect(su["INBOX.Sent"]).toBe("\\Sent");
		expect(su["INBOX.Drafts"]).toBe("\\Drafts");
		expect(su["INBOX.Trash"]).toBe("\\Trash");
		expect(su["INBOX.Spam"]).toBe("\\Junk");
		expect(su["INBOX.Archive"]).toBe("\\Archive");
		// imapflow picks ONE winner per special-use; the second "Sent"-like folder gets none
		expect(su["INBOX.Sent Items"]).toBeNull();
		expect(su.INBOX).toBe("\\Inbox");
	});

	test("labels are full dotted paths; unified inbox works (label 'INBOX')", async () => {
		const names = (ctx.db.prepare("SELECT name FROM labels WHERE source='imap'").all() as { name: string }[]).map((r) => r.name);
		expect(names).toContain("INBOX.Work.Clients");
		expect(names).toContain("INBOX.Sent");
		// Sidebar.tsx derives the icon/leaf by name.split("/") → whole "INBOX.Sent" string, so no Sent icon
		expect("INBOX.Sent".split("/").pop()?.toLowerCase()).not.toBe("sent");
		const unified = (await (await inboxRoutes(() => ctx.db).request("/unified")).json()) as unknown[];
		expect(unified).toHaveLength(1);
	});

	test("every non-INBOX folder has name != path, so relabelFromServer's `folders.name = labels.name` join never matches (see gmail-layout relabel test)", () => {
		const mismatched = count(ctx.db, "SELECT COUNT(*) n FROM folders f WHERE f.name != f.path AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.name = f.name)");
		expect(mismatched).toBe(FOLDERS.length);
	});

	test("folder name containing '/' under '.' separator", () => {
		// recorded either way; if created it must sync as a single label containing '/'
		if (slashFolderCreated) {
			expect(count(ctx.db, "SELECT COUNT(*) n FROM folders WHERE path = 'INBOX.a/b'")).toBe(1);
			expect(count(ctx.db, "SELECT COUNT(*) n FROM labels WHERE name = 'INBOX.a/b'")).toBe(1);
		}
	});
});
