/**
 * Connector mode (inbound_connectors.sync_delete_from_server = 1): Stork
 * downloads mail and then deletes it from the IMAP server. These tests check
 * whether anything can be deleted from the server WITHOUT a durable local copy.
 */
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { messageRoutes } from "../../src/api/routes/messages.js";
import { SyncScheduler } from "../../src/sync/sync-scheduler.js";
import {
	appendMsgs,
	call,
	folderId,
	imapConfig,
	localRows,
	localSubjects,
	makeDb,
	newSyncOnPort,
	resetImap,
	rowBySubject,
	serverSubjects,
	setConnectorMode,
	startFaultProxy,
	stopImap,
	syncOnce,
} from "./helpers";

beforeEach(() => resetImap());
afterAll(() => stopImap());

describe("connector mode: happy path (control)", () => {
	test("fetched messages are stored, marked deleted_from_server=1 and expunged on the server", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B" }]);
		const { db, connectorId } = makeDb({ connectorMode: true });
		const r = await syncOnce(db, connectorId);
		expect(r.totalErrors).toBe(0);
		expect(localSubjects(db)).toEqual(["A", "B"]);
		expect(localRows(db).every((x) => x.deleted_from_server === 1 && x.pending_archive === 0)).toBe(true);
		expect(await serverSubjects("INBOX")).toEqual([]);
		// Next cycle must not delete the local-only copies (flag sync skips deleted_from_server=1)
		await syncOnce(db, connectorId);
		expect(localSubjects(db)).toEqual(["A", "B"]);
	});
});

describe("connector mode: server deletion of unsaved mail (finding 1)", () => {
	test("DATA LOSS: a message whose local insert throws is still deleted from the server", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "POISON" }, { subject: "C" }]);
		const { db, connectorId } = makeDb({ connectorMode: true });
		// Fault injection in the audit's own DB: make the INSERT for one message
		// fail the way SQLITE_FULL / an I/O error / a parser bug would.
		db.exec(`CREATE TEMP TRIGGER audit_poison BEFORE INSERT ON main.messages
			WHEN NEW.subject = 'POISON' BEGIN SELECT RAISE(ABORT, 'simulated disk full'); END;`);

		const r = await syncOnce(db, connectorId);
		const inbox = r.folders.find((f) => f.folder === "INBOX");

		expect(inbox?.errors.some((e) => e.errorType === "message" && e.message.includes("STORK-E004"))).toBe(true);
		expect(inbox?.newMessages).toBe(2);
		// ...but all three UIDs of the batch were deleted from the server
		expect(inbox?.deletedFromServer).toBe(3);
		expect(await serverSubjects("INBOX")).toEqual([]);
		expect(localSubjects(db)).toEqual(["A", "C"]);
		// POISON now exists nowhere.
	});

	test("DATA LOSS: FETCH returning partial data then NO -> whole batch deleted from server", async () => {
		await appendMsgs("INBOX", [{ subject: "M1" }, { subject: "M2" }, { subject: "M3" }]);
		const { db, connectorId } = makeDb({ connectorMode: true });
		const proxy = await startFaultProxy();
		try {
			proxy.armPartialFetch("no");
			const s = await newSyncOnPort(db, connectorId, proxy.port);
			const r = await s.syncAll();
			await s.disconnect();
			expect(proxy.faultsFired).toBe(1);
			const inbox = r.folders.find((f) => f.folder === "INBOX");
			expect(inbox?.errors.some((e) => e.message.includes("Fetch failed") && e.message.includes("STORK-E002"))).toBe(
				true,
			);
			// The fetch error is recorded, then Phase 1b deletes the requested batch anyway
			expect(inbox?.deletedFromServer).toBe(3);
		} finally {
			await proxy.close();
		}
		expect(localSubjects(db)).toEqual(["M1"]);
		expect(await serverSubjects("INBOX")).toEqual([]);
		// M2 and M3 are gone from both sides.
	});

	test("DATA LOSS: FETCH that silently omits messages (tagged OK) -> omitted messages deleted from server", async () => {
		await appendMsgs("INBOX", [{ subject: "M1" }, { subject: "M2" }, { subject: "M3" }]);
		const { db, connectorId } = makeDb({ connectorMode: true });
		const proxy = await startFaultProxy();
		try {
			proxy.armPartialFetch("ok");
			const s = await newSyncOnPort(db, connectorId, proxy.port);
			const r = await s.syncAll();
			await s.disconnect();
			expect(proxy.faultsFired).toBe(1);
			expect(r.totalErrors).toBe(0); // no signal at all
		} finally {
			await proxy.close();
		}
		expect(localSubjects(db)).toEqual(["M1"]);
		expect(await serverSubjects("INBOX")).toEqual([]);
	});

	test("DATA LOSS: new server mail whose UID collides with a locally-moved row is 'INSERT OR IGNORE'd, then deleted from server", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }]);
		const { db, connectorId } = makeDb({ connectorMode: true });
		await syncOnce(db, connectorId); // A saved locally, expunged from server INBOX
		const a = rowBySubject(db, "A");
		expect(a?.uid).toBe(1);

		// User moves A to Archive in the UI (local-only folder_id rewrite)
		const api = messageRoutes(() => db);
		const mv = await call(api, "POST", `/${a?.id}/move`, { folder_id: folderId(db, "Archive") });
		expect(mv.status).toBe(200);

		// New mail lands in server Archive with UID 1 (fresh folder)
		const [xUid] = await appendMsgs("Archive", [{ subject: "X-new-archive-mail" }]);
		expect(xUid).toBe(1);

		const r = await syncOnce(db, connectorId);
		const arch = r.folders.find((f) => f.folder === "Archive");
		expect(arch?.newMessages).toBe(1); // counted as saved although INSERT was ignored
		expect(arch?.deletedFromServer).toBe(1);
		expect(await serverSubjects("Archive")).toEqual([]);
		expect(localSubjects(db)).toEqual(["A"]); // X never stored
	});
});

describe("connector mode: UI delete and Clean-server act on stale (folder, UID) pairs", () => {
	test("DATA LOSS: UI delete of a locally-moved message deletes a different, unsynced server message", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }]);
		const { db, connectorId } = makeDb({ connectorMode: true });
		await syncOnce(db, connectorId);
		const a = rowBySubject(db, "A");
		const api = messageRoutes(() => db);
		await call(api, "POST", `/${a?.id}/move`, { folder_id: folderId(db, "Archive") });
		await appendMsgs("Archive", [{ subject: "X-unsynced" }]); // uid 1 in Archive

		const del = await call(api, "DELETE", `/${a?.id}`);
		expect(del.status).toBe(200);
		expect(await serverSubjects("Archive")).toEqual([]); // X deleted by UID 1
		expect(localSubjects(db)).toEqual([]);
	});

	test("DATA LOSS: Clean server after a local move deletes the wrong message and leaves the moved one on the server", async () => {
		// Mirror mode first (Clean server is the mirror->connector transition)
		await appendMsgs("INBOX", [{ subject: "A" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const a = rowBySubject(db, "A");
		const api = messageRoutes(() => db);
		await call(api, "POST", "/bulk", { ids: [a?.id], action: "move", folder_id: folderId(db, "Archive") });
		await appendMsgs("Archive", [{ subject: "X-unsynced" }]); // uid 1 in Archive

		setConnectorMode(db, connectorId, true);
		const sched = new SyncScheduler(db, {});
		sched.addConnector({ inboundConnectorId: connectorId, imapConfig: imapConfig() });
		try {
			const res = await sched.cleanServerNow(connectorId);
			expect(res.deleted).toBe(1);
		} finally {
			await sched.stop();
		}
		expect(await serverSubjects("Archive")).toEqual([]); // X gone, never stored locally
		expect(await serverSubjects("INBOX")).toEqual(["A"]); // A still on server
		expect(localSubjects(db)).toEqual(["A"]);
		// Note: Clean server does NOT set deleted_from_server=1 for the rows it
		// deleted? (deleteFromServer does mark them) -> check:
		expect(rowBySubject(db, "A")?.deleted_from_server).toBe(1);
	});

	test("Clean server deletes exactly the locally-present messages (control) and skips mail newer than last sync", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		await appendMsgs("INBOX", [{ subject: "C-after-sync" }]);
		setConnectorMode(db, connectorId, true);
		const sched = new SyncScheduler(db, {});
		sched.addConnector({ inboundConnectorId: connectorId, imapConfig: imapConfig() });
		try {
			expect((await sched.cleanServerNow(connectorId)).deleted).toBe(2);
		} finally {
			await sched.stop();
		}
		expect(await serverSubjects("INBOX")).toEqual(["C-after-sync"]);
	});
});
