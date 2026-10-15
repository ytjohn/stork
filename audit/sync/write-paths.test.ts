/**
 * Wire-level evidence of every IMAP write Stork issues. All Stork traffic is
 * routed through the logging proxy and the command verbs are asserted.
 *
 * Static enumeration (grep for imapflow mutators in src/, non-test):
 *   src/sync/imap-sync.ts:1252   client.messageDelete(batch, {uid:true})   (ImapSync.deleteFromServer)
 *       <- imap-sync.ts:648 Phase 1b, :711 Phase 3, sync-scheduler.ts:241 cleanServerNow
 *   src/connectors/imap.ts:168   client.messageDelete(uids, {uid:true})    (ImapIngestConnector.deleteMessages)
 *       <- api/routes/messages.ts:39 defaultImapDelete <- DELETE /messages/:id (:199), POST /messages/bulk delete (:255)
 * No append / messageMove / messageCopy / messageFlagsAdd|Remove|Set / mailboxCreate|Delete|Rename|Subscribe anywhere.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { messageRoutes } from "../../src/api/routes/messages.js";
import {
	IMAP_BASE,
	IMAP_WRITE_VERBS,
	appendMsgs,
	call,
	commandVerbs,
	localSubjects,
	makeDb,
	newSyncOnPort,
	resetImap,
	rowBySubject,
	serverSubjects,
	setConnectorMode,
	setConnectorPort,
	startFaultProxy,
	stopImap,
	syncOnce,
	withImap,
} from "./helpers";

beforeEach(() => resetImap());
afterAll(() => stopImap());

const writes = (cmds: string[]) => commandVerbs(cmds).filter((v) => IMAP_WRITE_VERBS.includes(v));

describe("IMAP commands on the wire", () => {
	test("mirror mode sync cycle + relabelFromServer issue no write commands", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B" }]);
		await appendMsgs("Archive", [{ subject: "C" }], ["\\Seen"]);
		const { db, connectorId } = makeDb();
		const proxy = await startFaultProxy();
		try {
			for (let i = 0; i < 2; i++) {
				const s = await newSyncOnPort(db, connectorId, proxy.port);
				await s.syncAll();
				await s.relabelFromServer();
				await s.disconnect();
			}
			expect(writes(proxy.commands)).toEqual([]);
			// SELECT (read-write) is used rather than EXAMINE: harmless except that it consumes \Recent
			expect(commandVerbs(proxy.commands)).toContain("SELECT");
			expect(commandVerbs(proxy.commands)).not.toContain("EXAMINE");
			expect(proxy.commands.some((c) => /BODY\.PEEK\[\]/i.test(c))).toBe(true); // never sets \Seen
		} finally {
			await proxy.close();
		}
	});

	test("connector mode cycle writes exactly: UID STORE +FLAGS (\\Deleted) and UID EXPUNGE, scoped to fetched UIDs", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B" }]);
		const { db, connectorId } = makeDb({ connectorMode: true });
		const proxy = await startFaultProxy();
		try {
			const s = await newSyncOnPort(db, connectorId, proxy.port);
			await s.syncAll();
			await s.disconnect();
			expect(writes(proxy.commands)).toEqual(["UID EXPUNGE", "UID STORE"]);
			expect(proxy.commands.filter((c) => /^UID (STORE|EXPUNGE)/i.test(c))).toEqual([
				"UID STORE 1,2 +FLAGS (\\Deleted)",
				"UID EXPUNGE 1,2",
			]);
		} finally {
			await proxy.close();
		}
	});

	test("connector mode UI delete opens a NEW IMAP connection and issues UID STORE \\Deleted + UID EXPUNGE", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId); // mirror copy
		setConnectorMode(db, connectorId, true);
		const proxy = await startFaultProxy();
		try {
			setConnectorPort(db, connectorId, proxy.port);
			const api = messageRoutes(() => db);
			await call(api, "DELETE", `/${rowBySubject(db, "A")?.id}`);
			expect(writes(proxy.commands)).toEqual(["UID EXPUNGE", "UID STORE"]);
		} finally {
			await proxy.close();
		}
		expect(await serverSubjects("INBOX")).toEqual(["B"]);
	});

	test("connector mode UI delete: if the IMAP delete fails, the local copy is deleted anyway (best-effort, logged only)", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		setConnectorMode(db, connectorId, true);
		setConnectorPort(db, connectorId, 1); // unreachable
		const api = messageRoutes(() => db);
		const res = await call(api, "DELETE", `/${rowBySubject(db, "A")?.id}`);
		expect(res.status).toBe(200);
		expect(localSubjects(db)).toEqual([]);
		expect(await serverSubjects("INBOX")).toEqual(["A"]); // server copy remains (mirror-like)
	}, 60000);
});

describe("server without UIDPLUS", () => {
	function restartWithoutUidplus() {
		const conf = `${IMAP_BASE}/dovecot.conf`;
		execFileSync("doveadm", ["-c", conf, "stop"], { stdio: "ignore" });
		appendFileSync(
			conf,
			"\nprotocol imap {\n  imap_capability = IMAP4rev1 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE LITERAL+ NAMESPACE MOVE SPECIAL-USE\n}\n",
		);
		execFileSync("dovecot", ["-c", conf], { stdio: "ignore" });
		execFileSync("bash", ["-c", "for i in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/14201) 2>/dev/null && exit 0; sleep 0.1; done; exit 1"]);
	}

	test("connector mode UI delete issues a plain EXPUNGE that also removes messages another client only flagged \\Deleted", async () => {
		restartWithoutUidplus();
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "B-marked-deleted-elsewhere" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		// Another client (IMAP "mark as deleted" model, e.g. Thunderbird) flags B \Deleted without expunging
		await withImap(async (c) => {
			const lock = await c.getMailboxLock("INBOX");
			try {
				await c.messageFlagsAdd("2", ["\\Deleted"], { uid: true });
			} finally {
				lock.release();
			}
		});
		setConnectorMode(db, connectorId, true);
		const proxy = await startFaultProxy();
		try {
			setConnectorPort(db, connectorId, proxy.port);
			await call(messageRoutes(() => db), "DELETE", `/${rowBySubject(db, "A")?.id}`);
			expect(commandVerbs(proxy.commands)).toContain("EXPUNGE");
			expect(commandVerbs(proxy.commands)).not.toContain("UID EXPUNGE");
		} finally {
			await proxy.close();
		}
		expect(await serverSubjects("INBOX")).toEqual([]); // B expunged too
	});
});
