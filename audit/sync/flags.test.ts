/**
 * Flag sync in both directions (finding 7).
 */
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { messageRoutes } from "../../src/api/routes/messages.js";
import {
	appendMsgs,
	call,
	makeDb,
	resetImap,
	rowBySubject,
	serverFlags,
	stopImap,
	syncOnce,
	withImap,
} from "./helpers";

beforeEach(() => resetImap());
afterAll(() => stopImap());

// \Recent is session-scoped (RFC 3501) and is filtered out here; it is
// documented separately in the "\Recent" test below.
const flagList = (s: string | undefined) =>
	(s ?? "")
		.split(",")
		.filter((f) => f && f !== "\\Recent")
		.sort();
const srvFlags = async (folder: string, uid: number) =>
	(await serverFlags(folder, uid)).filter((f) => f !== "\\Recent");

describe("server -> local flag propagation", () => {
	test("initial sync does not mark messages \\Seen on the server (uses BODY.PEEK)", async () => {
		const [uid] = await appendMsgs("INBOX", [{ subject: "U" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		expect(await srvFlags("INBOX", uid)).toEqual([]);
		expect(flagList(rowBySubject(db, "U")?.flags)).toEqual([]);
	});

	test("initial sync imports existing \\Seen \\Flagged \\Answered \\Draft and keywords", async () => {
		await appendMsgs("INBOX", [{ subject: "F" }], ["\\Seen", "\\Flagged", "\\Answered", "\\Draft", "$Work"]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		expect(flagList(rowBySubject(db, "F")?.flags)).toEqual(["$Work", "\\Answered", "\\Draft", "\\Flagged", "\\Seen"]);
	});

	test("flag add/remove by another client propagates down on next sync (\\Seen, \\Flagged, \\Answered, \\Draft)", async () => {
		const [uid] = await appendMsgs("INBOX", [{ subject: "F" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		await withImap(async (c) => {
			const lock = await c.getMailboxLock("INBOX");
			try {
				await c.messageFlagsAdd(String(uid), ["\\Seen", "\\Flagged", "\\Answered", "\\Draft"], { uid: true });
			} finally {
				lock.release();
			}
		});
		const r = await syncOnce(db, connectorId);
		expect(r.folders.find((f) => f.folder === "INBOX")?.updatedFlags).toBe(1);
		expect(flagList(rowBySubject(db, "F")?.flags)).toEqual(["\\Answered", "\\Draft", "\\Flagged", "\\Seen"]);

		await withImap(async (c) => {
			const lock = await c.getMailboxLock("INBOX");
			try {
				await c.messageFlagsRemove(String(uid), ["\\Flagged", "\\Draft"], { uid: true });
			} finally {
				lock.release();
			}
		});
		await syncOnce(db, connectorId);
		expect(flagList(rowBySubject(db, "F")?.flags)).toEqual(["\\Answered", "\\Seen"]);
	});
});

describe("\\Recent handling", () => {
	test("session-scoped \\Recent is persisted as a message flag on first sync and then flaps away on the next session", async () => {
		await appendMsgs("INBOX", [{ subject: "N" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		expect(rowBySubject(db, "N")?.flags).toContain("\\Recent");
		const r = await syncOnce(db, connectorId);
		// Dovecot only reports \\Recent to the first session that SELECTs the mailbox
		expect(r.folders.find((f) => f.folder === "INBOX")?.updatedFlags).toBe(1);
		expect(rowBySubject(db, "N")?.flags).not.toContain("\\Recent");
	});

	test("connector mode: stale \\Recent is frozen into the local-only copy forever", async () => {
		await appendMsgs("INBOX", [{ subject: "N" }]);
		const { db, connectorId } = makeDb({ connectorMode: true });
		await syncOnce(db, connectorId);
		await syncOnce(db, connectorId);
		expect(rowBySubject(db, "N")?.flags).toContain("\\Recent");
	});
});

describe("local (UI) -> server flag propagation", () => {
	test("UI mark-read (\\Seen) is never written to IMAP and is REVERTED by the next sync", async () => {
		const [uid] = await appendMsgs("INBOX", [{ subject: "R" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const api = messageRoutes(() => db);
		const row = rowBySubject(db, "R");
		const res = await call(api, "PATCH", `/${row?.id}/flags`, { add: ["\\Seen"] });
		expect(res.status).toBe(200);
		expect(flagList(rowBySubject(db, "R")?.flags)).toEqual(["\\Seen"]);
		expect(await srvFlags("INBOX", uid)).toEqual([]); // not pushed

		await syncOnce(db, connectorId);
		expect(flagList(rowBySubject(db, "R")?.flags)).toEqual([]); // server state wins, read-state lost
	});

	test("UI star (\\Flagged) via bulk action is never written to IMAP and is REVERTED by the next sync", async () => {
		const [uid] = await appendMsgs("INBOX", [{ subject: "S" }], ["\\Seen"]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const api = messageRoutes(() => db);
		const row = rowBySubject(db, "S");
		await call(api, "POST", "/bulk", { ids: [row?.id], action: "flag", add: ["\\Flagged"] });
		expect(await srvFlags("INBOX", uid)).toEqual(["\\Seen"]);
		await syncOnce(db, connectorId);
		expect(flagList(rowBySubject(db, "S")?.flags)).toEqual(["\\Seen"]);
	});

	test("UI mark-unread (remove \\Seen) is reverted by the next sync", async () => {
		await appendMsgs("INBOX", [{ subject: "S" }], ["\\Seen"]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const api = messageRoutes(() => db);
		await call(api, "PATCH", `/${rowBySubject(db, "S")?.id}/flags`, { remove: ["\\Seen"] });
		await syncOnce(db, connectorId);
		expect(flagList(rowBySubject(db, "S")?.flags)).toEqual(["\\Seen"]);
	});

	test("connector mode: UI flag edits stick (rows with deleted_from_server=1 are excluded from flag sync)", async () => {
		await appendMsgs("INBOX", [{ subject: "C" }]);
		const { db, connectorId } = makeDb({ connectorMode: true });
		await syncOnce(db, connectorId);
		const api = messageRoutes(() => db);
		await call(api, "PATCH", `/${rowBySubject(db, "C")?.id}/flags`, { add: ["\\Seen"] });
		await syncOnce(db, connectorId);
		expect(flagList(rowBySubject(db, "C")?.flags)).toEqual(["\\Seen"]);
	});
});
