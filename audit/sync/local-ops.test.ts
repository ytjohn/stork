/**
 * Local (UI/API) operations and how they interact with sync:
 *   finding 4 (UI move), finding 12 (mirror mode must never touch the server),
 *   local delete, local label ops, send (Sent), drafts.
 */
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { draftRoutes } from "../../src/api/routes/drafts.js";
import { messageRoutes } from "../../src/api/routes/messages.js";
import { sendRoutes } from "../../src/api/routes/send.js";
import { createTestIdentity } from "../../src/test-helpers/test-db.js";
import { MockSmtpServer } from "../../src/test-helpers/mock-smtp-server.js";
import {
	addUserLabel,
	appendMsgs,
	call,
	dovecotLoginCount,
	folderId,
	labelsOf,
	lastUid,
	localRows,
	localSubjects,
	makeDb,
	resetImap,
	rowBySubject,
	serverSnapshot,
	serverSubjects,
	stopImap,
	syncOnce,
} from "./helpers";

beforeEach(() => resetImap());
afterAll(() => stopImap());

/** Server state minus the session-scoped \Recent flag. */
async function stableSnapshot() {
	const s = await serverSnapshot();
	for (const f of Object.values(s)) for (const m of f.messages) m.flags = m.flags.filter((x) => x !== "\\Recent");
	return s;
}

describe("UI move (finding 4) — local folder_id rewrite only", () => {
	test("DATA LOSS (mirror): moved message is treated as expunged in the target folder and deleted; source never re-downloads it", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const api = messageRoutes(() => db);
		const a = rowBySubject(db, "A");
		const mv = await call(api, "POST", `/${a?.id}/move`, { folder_id: folderId(db, "Archive") });
		expect(mv.status).toBe(200);
		expect(rowBySubject(db, "A")?.folder).toBe("Archive");
		expect(await serverSubjects("Archive")).toEqual([]); // nothing moved on server

		await syncOnce(db, connectorId);
		expect(localSubjects(db)).toEqual(["B"]); // A vanished locally
		expect(await serverSubjects("INBOX")).toEqual(["A", "B"]); // still on server
		expect(lastUid(db, "INBOX")).toBe(2); // and INBOX will never fetch UID 1 again
		await syncOnce(db, connectorId);
		expect(localSubjects(db)).toEqual(["B"]);
	});

	test("move into a folder that already has a local row with the same UID fails with a 500 (UNIQUE(folder_id, uid))", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }]);
		await appendMsgs("Archive", [{ subject: "X" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		expect(rowBySubject(db, "A")?.uid).toBe(rowBySubject(db, "X")?.uid);
		const api = messageRoutes(() => db);
		const res = await call(api, "POST", "/bulk", {
			ids: [rowBySubject(db, "A")?.id],
			action: "move",
			folder_id: folderId(db, "Archive"),
		});
		expect(res.status).toBe(500);
		expect(rowBySubject(db, "A")?.folder).toBe("INBOX");
	});

	test("DATA LOSS (mirror): moved row squats on a UID that new server mail later gets -> new mail never stored, its flags applied to the wrong row", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const api = messageRoutes(() => db);
		await call(api, "POST", `/${rowBySubject(db, "A")?.id}/move`, { folder_id: folderId(db, "Archive") });
		const [xuid] = await appendMsgs("Archive", [{ subject: "X" }], ["\\Seen", "\\Flagged"]);
		expect(xuid).toBe(1);

		const r = await syncOnce(db, connectorId);
		expect(r.folders.find((f) => f.folder === "Archive")?.newMessages).toBe(1); // reported as new...
		// X was INSERT OR IGNOREd. (A second "A" appears in INBOX because of the
		// UID "last+1:*" quirk — see the resurrection test below.)
		expect(localSubjects(db)).toEqual(["A", "A"]);
		expect(localSubjects(db, "Archive")).toEqual(["A"]);
		const a = localRows(db).find((r) => r.subject === "A" && r.folder === "Archive");
		expect(a?.folder).toBe("Archive");
		expect(a?.flags).toContain("\\Flagged"); // X's flags now on A
		expect(a?.flags).toContain("\\Seen");
		expect(await serverSubjects("Archive")).toEqual(["X"]);
	});
});

describe("mirror mode never writes to the server (finding 12)", () => {
	test("UI delete (single + bulk), flag, move, label add/remove, drafts: zero IMAP logins, server state unchanged", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B" }, { subject: "C" }, { subject: "D" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const before = await stableSnapshot();
		const logins = dovecotLoginCount();

		const api = messageRoutes(() => db);
		const id = (s: string) => rowBySubject(db, s)?.id;
		expect((await call(api, "DELETE", `/${id("A")}`)).status).toBe(200);
		expect((await call(api, "POST", "/bulk", { ids: [id("B")], action: "delete" })).status).toBe(200);
		await call(api, "PATCH", `/${id("C")}/flags`, { add: ["\\Seen", "\\Flagged", "\\Answered"] });
		await call(api, "POST", "/bulk", { ids: [id("C")], action: "flag", add: ["\\Draft"] });
		const lbl = addUserLabel(db, id("C") ?? -1, "Taxes");
		await call(api, "DELETE", `/${id("C")}/labels/${lbl}`);
		await call(api, "POST", `/${id("D")}/move`, { folder_id: folderId(db, "Trash") });
		const ident = createTestIdentity(db, { email: "alice@audit.local" });
		const drafts = draftRoutes(() => db);
		expect((await call(drafts, "POST", "/", { identity_id: ident, subject: "draft", text_body: "x" })).status).toBe(
			201,
		);

		expect(dovecotLoginCount()).toBe(logins);
		expect(await stableSnapshot()).toEqual(before);
	});

	test("local delete is one-way and sticky: message stays on server and is not re-downloaded", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const api = messageRoutes(() => db);
		await call(api, "DELETE", `/${rowBySubject(db, "A")?.id}`);
		await syncOnce(db, connectorId);
		expect(localSubjects(db)).toEqual(["B"]);
		expect(await serverSubjects("INBOX")).toEqual(["A", "B"]);
	});

	test("local delete of the NEWEST message in a folder is undone by the next sync (UID SEARCH 'last+1:*' always matches the highest UID)", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const api = messageRoutes(() => db);
		await call(api, "DELETE", `/${rowBySubject(db, "B")?.id}`);
		expect(localSubjects(db)).toEqual(["A"]);
		await syncOnce(db, connectorId);
		expect(localSubjects(db)).toEqual(["A", "B"]); // B is back
	});

	test("every cycle re-downloads the newest message of every non-empty folder and reports it as 'new'", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const r2 = await syncOnce(db, connectorId);
		expect(r2.folders.find((f) => f.folder === "INBOX")?.newMessages).toBe(1); // nothing actually new
		expect(r2.totalNew).toBe(1);
		expect(localSubjects(db)).toEqual(["A", "B"]); // no duplicate thanks to UNIQUE(folder_id, uid)
	});

	test("removing the folder label (UI 'archive') stays local and is not re-applied by sync (label_overrides)", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const a = rowBySubject(db, "A");
		const inboxLabel = (db.prepare("SELECT id FROM labels WHERE name = 'INBOX'").get() as { id: number }).id;
		const api = messageRoutes(() => db);
		await call(api, "DELETE", `/${a?.id}/labels/${inboxLabel}`);
		await syncOnce(db, connectorId);
		expect(labelsOf(db, a?.id ?? -1)).not.toContain("INBOX");
		expect(await serverSubjects("INBOX")).toEqual(["A"]);
	});

	test("user labels survive ordinary incremental syncs", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const a = rowBySubject(db, "A");
		addUserLabel(db, a?.id ?? -1, "Taxes");
		await appendMsgs("INBOX", [{ subject: "B" }]);
		await syncOnce(db, connectorId);
		expect(labelsOf(db, a?.id ?? -1)).toContain("Taxes");
	});

	test("send: no APPEND to the IMAP Sent folder; copy stored in a separate local-only Sent folder; replied message not marked \\Answered", async () => {
		await appendMsgs("INBOX", [{ subject: "Orig", messageId: "<orig@audit.local>" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const smtp = new MockSmtpServer({});
		const smtpPort = await smtp.start();
		try {
			const ident = createTestIdentity(db, { email: "alice@audit.local", smtpHost: "127.0.0.1", smtpPort, smtpUser: "u", smtpPass: "p" });
			const logins = dovecotLoginCount();
			const send = sendRoutes(() => db);
			const res = await call(send, "POST", "/", {
				identity_id: ident,
				to: ["bob@audit.local"],
				subject: "Re: Orig",
				text_body: "reply",
				in_reply_to: "<orig@audit.local>",
				references: ["<orig@audit.local>"],
			});
			expect(res.status).toBe(200);
			expect(smtp.messages.length).toBe(1);
			expect(dovecotLoginCount()).toBe(logins); // no IMAP connection at all
		} finally {
			await smtp.stop();
		}
		expect(await serverSubjects("Sent")).toEqual([]);
		const sentRow = db
			.prepare("SELECT m.uid, f.path, f.inbound_connector_id, f.identity_id FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.subject = 'Re: Orig'")
			.get() as { uid: number; path: string; inbound_connector_id: number | null; identity_id: number | null };
		expect(sentRow.path).toBe("Sent");
		expect(sentRow.inbound_connector_id).toBeNull(); // not the IMAP Sent folder
		expect(sentRow.uid).toBeLessThan(0); // negative local UID
		expect(rowBySubject(db, "Orig")?.flags ?? "").not.toContain("\\Answered");

		// The local Sent copy survives the next sync (not pruned, not flag-synced)
		await syncOnce(db, connectorId);
		expect(localRows(db).some((r) => r.subject === "Re: Orig")).toBe(true);
	});
});
