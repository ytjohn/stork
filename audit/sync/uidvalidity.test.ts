/**
 * UIDVALIDITY changes (finding 2). Triggered on the real Dovecot either with
 * `doveadm mailbox update --uid-validity` (same messages, new UIDVALIDITY —
 * what a provider migration / index rebuild looks like) or by deleting and
 * recreating a folder from another client (UIDs are reused from 1).
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { messageRoutes } from "../../src/api/routes/messages.js";
import { SyncScheduler } from "../../src/sync/sync-scheduler.js";
import {
	IMAP_BASE,
	addUserLabel,
	appendMsgs,
	call,
	imapConfig,
	labelsOf,
	localRows,
	localSubjects,
	makeDb,
	resetImap,
	rowBySubject,
	serverSnapshot,
	serverSubjects,
	setConnectorMode,
	stopImap,
	syncOnce,
	withImap,
} from "./helpers";

function bumpUidValidity(folder: string, value: number) {
	execFileSync("doveadm", [
		"-c",
		`${IMAP_BASE}/dovecot.conf`,
		"mailbox",
		"update",
		"-u",
		"alice",
		"--uid-validity",
		String(value),
		folder,
	]);
}

beforeEach(() => resetImap());
afterAll(() => stopImap());

describe("UIDVALIDITY change", () => {
	test("mirror mode: all rows of the folder are deleted and re-downloaded; user labels and local flag edits are lost", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const a = rowBySubject(db, "A");
		if (!a) throw new Error("A missing");
		addUserLabel(db, a.id, "Important");
		const api = messageRoutes(() => db);
		await call(api, "PATCH", `/${a.id}/flags`, { add: ["\\Flagged"] }); // local-only star
		expect(labelsOf(db, a.id)).toContain("Important");

		const before = (await serverSnapshot()).INBOX.uidValidity;
		bumpUidValidity("INBOX", Number(before) + 1000);
		expect((await serverSnapshot()).INBOX.uidValidity).not.toBe(before);

		await syncOnce(db, connectorId);
		const a2 = rowBySubject(db, "A");
		expect(localSubjects(db)).toEqual(["A", "B"]); // content comes back from server
		expect(a2?.id).not.toBe(a.id); // ...as new rows
		expect(labelsOf(db, a2?.id ?? -1)).not.toContain("Important"); // user label gone
		expect(a2?.flags).not.toContain("\\Flagged"); // local star gone
	});

	test("DATA LOSS: connector mode: UIDVALIDITY change deletes local-only (deleted_from_server=1) archive copies", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B" }]);
		const { db, connectorId } = makeDb({ connectorMode: true });
		await syncOnce(db, connectorId);
		expect(localRows(db).map((r) => r.deleted_from_server)).toEqual([1, 1]);
		expect(await serverSubjects("INBOX")).toEqual([]); // only copy is local

		const before = (await serverSnapshot()).INBOX.uidValidity;
		bumpUidValidity("INBOX", Number(before) + 1000);
		await syncOnce(db, connectorId);

		expect(localSubjects(db)).toEqual([]); // the only copies are gone
		expect(await serverSubjects("INBOX")).toEqual([]);
	});

	test("DATA LOSS: Clean server after a folder was recreated on the server deletes the NEW messages by stale UID", async () => {
		await withImap((c) => c.mailboxCreate("Work").then(() => undefined));
		await appendMsgs("Work", [{ subject: "W1-old" }, { subject: "W2-old" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		expect(localSubjects(db, "Work")).toEqual(["W1-old", "W2-old"]);

		// Another client deletes and recreates Work; new mail gets UIDs 1,2 again
		await withImap(async (c) => {
			await c.mailboxDelete("Work");
			await c.mailboxCreate("Work");
		});
		const uids = await appendMsgs("Work", [{ subject: "N1-new" }, { subject: "N2-new" }]);
		expect(uids).toEqual([1, 2]);

		setConnectorMode(db, connectorId, true);
		const sched = new SyncScheduler(db, {});
		sched.addConnector({ inboundConnectorId: connectorId, imapConfig: imapConfig() });
		try {
			expect((await sched.cleanServerNow(connectorId)).deleted).toBe(2);
		} finally {
			await sched.stop();
		}
		// The never-synced new messages were deleted; no UIDVALIDITY check.
		expect(await serverSubjects("Work")).toEqual([]);
		expect(localSubjects(db, "Work")).toEqual(["W1-old", "W2-old"]);
	});

	test("folder deleted+recreated between syncs (mirror): old rows wiped, new content downloaded", async () => {
		await withImap((c) => c.mailboxCreate("Work").then(() => undefined));
		await appendMsgs("Work", [{ subject: "W1-old" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		await withImap(async (c) => {
			await c.mailboxDelete("Work");
			await c.mailboxCreate("Work");
		});
		await appendMsgs("Work", [{ subject: "N1-new" }]);
		await syncOnce(db, connectorId);
		expect(localSubjects(db, "Work")).toEqual(["N1-new"]);
	});
});
