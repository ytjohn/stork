/**
 * Changes made on the server by ANOTHER client:
 *   finding 6 (expunge), 8 (MOVE between folders / relabelFromServer),
 *   9 (COPY / duplicates), 11 (changes racing a sync cycle).
 */
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { messageRoutes } from "../../src/api/routes/messages.js";
import {
	addUserLabel,
	appendMsgs,
	call,
	labelsOf,
	localRows,
	localSubjects,
	makeDb,
	newSync,
	resetImap,
	rowBySubject,
	serverSubjects,
	stopImap,
	syncOnce,
	withImap,
} from "./helpers";

beforeEach(() => resetImap());
afterAll(() => stopImap());

async function onServer(folder: string, fn: (c: import("imapflow").ImapFlow) => Promise<unknown>) {
	await withImap(async (c) => {
		const lock = await c.getMailboxLock(folder);
		try {
			await fn(c);
		} finally {
			lock.release();
		}
	});
}

describe("server expunge (finding 6)", () => {
	test("mirror: expunge by another client hard-deletes the local row (no tombstone, labels gone)", async () => {
		const [ua] = await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const a = rowBySubject(db, "A");
		addUserLabel(db, a?.id ?? -1, "Taxes");
		await onServer("INBOX", (c) => c.messageDelete(String(ua), { uid: true }));
		await syncOnce(db, connectorId);
		expect(localSubjects(db)).toEqual(["B"]);
		expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = ?").get(a?.id)).toEqual({ n: 0 });
		expect(db.prepare("SELECT COUNT(*) AS n FROM message_labels WHERE message_id = ?").get(a?.id)).toEqual({ n: 0 });
	});

	test("mirror: expunging the only message of a folder (exists=0) still removes it locally", async () => {
		await appendMsgs("Archive", [{ subject: "Z" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		await onServer("Archive", (c) => c.messageDelete("1:*", { uid: true }));
		await syncOnce(db, connectorId);
		expect(localSubjects(db, "Archive")).toEqual([]);
	});

	test("connector mode: server-side expunge does not affect local archive copies", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }]);
		const { db, connectorId } = makeDb({ connectorMode: true });
		await syncOnce(db, connectorId);
		await syncOnce(db, connectorId);
		expect(localSubjects(db)).toEqual(["A"]);
	});
});

describe("server MOVE by another client (finding 8)", () => {
	test("mirror: MOVE shows up as delete + new row; user labels and local flag edits are lost", async () => {
		const [ua] = await appendMsgs("INBOX", [{ subject: "A", messageId: "<a@audit.local>" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const a = rowBySubject(db, "A");
		addUserLabel(db, a?.id ?? -1, "Taxes");
		await call(messageRoutes(() => db), "PATCH", `/${a?.id}/flags`, { add: ["\\Flagged"] });

		await onServer("INBOX", (c) => c.messageMove(String(ua), "Archive", { uid: true }));
		await syncOnce(db, connectorId);

		const rows = localRows(db);
		expect(rows.map((r) => [r.folder, r.subject])).toEqual([["Archive", "A"]]);
		expect(rows[0].id).not.toBe(a?.id); // new row
		expect(labelsOf(db, rows[0].id)).toEqual(["Archive", "Audit IMAP"]); // Taxes gone
		expect(rows[0].flags).not.toContain("\\Flagged");
	});

	test("relabelFromServer is a no-op after a normal sync (source row already deleted by flag sync)", async () => {
		const [ua] = await appendMsgs("INBOX", [{ subject: "A", messageId: "<a@audit.local>" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		await onServer("INBOX", (c) => c.messageMove(String(ua), "Archive", { uid: true }));
		await syncOnce(db, connectorId);
		const s = await newSync(db, connectorId);
		try {
			const r = await s.relabelFromServer();
			expect(r.crossFolderMovesDetected).toBe(0);
		} finally {
			await s.disconnect();
		}
	});

	test("relabelFromServer: label matching uses folder NAME (leaf) vs label full PATH -> nested-folder label never removed", async () => {
		await withImap(async (c) => {
			await c.mailboxCreate("Projects");
			await c.mailboxCreate("Projects/2024");
		});
		const [up] = await appendMsgs("Projects/2024", [{ subject: "P", messageId: "<p@audit.local>" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const old = rowBySubject(db, "P");
		expect(labelsOf(db, old?.id ?? -1)).toContain("Projects/2024");

		await onServer("Projects/2024", (c) => c.messageMove(String(up), "INBOX", { uid: true }));
		// Sync only the destination, so both rows exist when relabel runs
		const s = await newSync(db, connectorId);
		try {
			await s.syncFolders();
			s.ensureLabelsForFolders();
			await s.syncFolder("INBOX");
			s.applyFolderLabelsToMessages();
			const r = await s.relabelFromServer();
			expect(r.crossFolderMovesDetected).toBe(1);
			expect(r.labelsUpdated).toBe(1); // claims an update...
		} finally {
			await s.disconnect();
		}
		// ...but the stale nested label is still on the old row (f.name '2024' != l.name 'Projects/2024')
		expect(labelsOf(db, old?.id ?? -1)).toContain("Projects/2024");
	});

	test("relabelFromServer: top-level folder (name == path) works when both rows exist", async () => {
		const [ua] = await appendMsgs("Archive", [{ subject: "A", messageId: "<a@audit.local>" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const old = rowBySubject(db, "A");
		await onServer("Archive", (c) => c.messageMove(String(ua), "INBOX", { uid: true }));
		const s = await newSync(db, connectorId);
		try {
			await s.syncFolders();
			await s.syncFolder("INBOX");
			s.applyFolderLabelsToMessages();
			const r = await s.relabelFromServer();
			expect(r.crossFolderMovesDetected).toBe(1);
		} finally {
			await s.disconnect();
		}
		expect(labelsOf(db, old?.id ?? -1)).not.toContain("Archive");
	});
});

describe("server COPY (finding 9)", () => {
	test("same message in two folders becomes two independent local rows (no Message-ID identity)", async () => {
		const [ua] = await appendMsgs("INBOX", [{ subject: "A", messageId: "<a@audit.local>" }]);
		await onServer("INBOX", (c) => c.messageCopy(String(ua), "Archive", { uid: true }));
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const rows = localRows(db).filter((r) => r.message_id === "<a@audit.local>");
		expect(rows.map((r) => r.folder).sort()).toEqual(["Archive", "INBOX"]);
		expect(labelsOf(db, rows[0].id)).not.toEqual(labelsOf(db, rows[1].id)); // labels not merged
		const counted = db.prepare("SELECT message_count FROM labels WHERE name = 'Audit IMAP'").get() as {
			message_count: number;
		};
		expect(counted.message_count).toBe(2); // counted twice in the connector's "all mail"
	});

	test("connector mode: the copy in each folder is downloaded AND deleted -> two local rows, zero server copies", async () => {
		const [ua] = await appendMsgs("INBOX", [{ subject: "A", messageId: "<a@audit.local>" }]);
		await onServer("INBOX", (c) => c.messageCopy(String(ua), "Archive", { uid: true }));
		const { db, connectorId } = makeDb({ connectorMode: true });
		await syncOnce(db, connectorId);
		expect(localRows(db).filter((r) => r.message_id === "<a@audit.local>").length).toBe(2);
		expect(await serverSubjects("INBOX")).toEqual([]);
		expect(await serverSubjects("Archive")).toEqual([]);
	});
});

describe("concurrent changes during a sync cycle (finding 11)", () => {
	test("expunge + flag change + new mail between FETCH and flag sync: flag applied now, expunge + new mail converge next cycle", async () => {
		const [u1, u2] = await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B" }]);
		const { db, connectorId } = makeDb();
		const s = await newSync(db, connectorId);
		// Test instrumentation (not app code): run other-client actions right
		// before Phase 2 (flag sync) of INBOX.
		const priv = s as unknown as { syncFlags: (...a: unknown[]) => Promise<number> };
		const orig = priv.syncFlags.bind(s);
		let fired = false;
		priv.syncFlags = async (...a: unknown[]) => {
			const fid = a[0] as number;
			const isInbox = (db.prepare("SELECT path FROM folders WHERE id = ?").get(fid) as { path: string }).path === "INBOX";
			if (isInbox && !fired) {
				fired = true;
				await onServer("INBOX", async (c) => {
					await c.messageDelete(String(u2), { uid: true });
					await c.messageFlagsAdd(String(u1), ["\\Flagged"], { uid: true });
				});
				await appendMsgs("INBOX", [{ subject: "C-during-sync" }]);
			}
			return orig(...a);
		};
		try {
			await s.syncAll();
		} finally {
			await s.disconnect();
		}
		expect(fired).toBe(true);
		// Stork's selected session has not processed the other session's EXPUNGE
		// yet, so B still answers the flag FETCH: removal lags one cycle.
		expect(localSubjects(db)).toEqual(["A", "B"]);
		expect(rowBySubject(db, "A")?.flags).toContain("\\Flagged");
		await syncOnce(db, connectorId);
		expect(localSubjects(db)).toEqual(["A", "C-during-sync"]);
	});

	test("expunge between SEARCH and FETCH: UID skipped with a 'no source' error, no stale row", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B" }, { subject: "C" }]);
		const { db, connectorId } = makeDb();
		const s = await newSync(db, connectorId);
		const priv = s as unknown as { fetchUidBatch: (...a: unknown[]) => Promise<number> };
		const orig = priv.fetchUidBatch.bind(s);
		priv.fetchUidBatch = async (...a: unknown[]) => {
			// Expunge B from another client after SEARCH returned it (the mailbox lock
			// is held by this session, but locks are client-side only)
			await onServer("INBOX", (c) => c.messageDelete("2", { uid: true }));
			return orig(...a);
		};
		let r: Awaited<ReturnType<typeof s.syncAll>>;
		try {
			r = await s.syncAll();
		} finally {
			await s.disconnect();
		}
		// Dovecot still returns a FETCH item for the expunged UID in this session,
		// without a body. Stork records a "retriable" error, skips it, and advances
		// last_uid past it (harmless here because the message is really gone).
		const errs = r.folders.flatMap((f) => f.errors);
		expect(errs.map((e) => [e.uid, e.message, e.retriable])).toEqual([[2, "UID 2: no source available", true]]);
		expect(localSubjects(db)).toEqual(["A", "C"]);
	});

	test("connector mode: mail arriving between FETCH and DELETE is not deleted (deletes are UID-scoped to the fetched batch)", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }]);
		const { db, connectorId } = makeDb({ connectorMode: true });
		const s = await newSync(db, connectorId);
		const orig = s.deleteFromServer.bind(s);
		let fired = false;
		s.deleteFromServer = async (folder: string, uids: number[]) => {
			if (folder === "INBOX" && !fired) {
				fired = true;
				await appendMsgs("INBOX", [{ subject: "Late" }]);
			}
			return orig(folder, uids);
		};
		try {
			await s.syncAll();
		} finally {
			await s.disconnect();
		}
		expect(fired).toBe(true);
		expect(await serverSubjects("INBOX")).toEqual(["Late"]);
		await syncOnce(db, connectorId);
		expect(localSubjects(db)).toEqual(["A", "Late"]);
		expect(await serverSubjects("INBOX")).toEqual([]);
	});
});
