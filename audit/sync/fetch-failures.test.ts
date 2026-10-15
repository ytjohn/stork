/**
 * Fetch failures, retry semantics and interrupted syncs (findings 5 and 10).
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { openDatabase } from "../../src/storage/db.js";
import {
	IMAP_PORT,
	appendMsgs,
	findMaildirFile,
	lastUid,
	localRows,
	localSubjects,
	maildirSubjects,
	makeDb,
	newSync,
	newSyncOnPort,
	resetImap,
	rowBySubject,
	serverSubjects,
	startFaultProxy,
	stopImap,
	syncOnce,
	withImap,
} from "./helpers";

beforeEach(() => resetImap());
afterAll(() => stopImap());

const poison = (db: Database.Database, subject: string) =>
	db.exec(`CREATE TEMP TRIGGER audit_poison BEFORE INSERT ON main.messages
		WHEN NEW.subject = '${subject}' BEGIN SELECT RAISE(ABORT, 'simulated transient failure'); END;`);

describe("per-message failure and last_uid (finding 5)", () => {
	test("DATA LOSS (mirror): a message that fails to store once is skipped forever (last_uid advances past it); error auto-resolves", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "POISON" }, { subject: "C" }]);
		const { db, connectorId } = makeDb();
		poison(db, "POISON");
		const r1 = await syncOnce(db, connectorId);
		expect(r1.totalErrors).toBe(1);
		const e = r1.folders.flatMap((f) => f.errors)[0];
		expect(e.retriable).toBe(false);
		expect(lastUid(db, "INBOX")).toBe(3);

		db.exec("DROP TRIGGER audit_poison"); // the transient cause goes away
		await syncOnce(db, connectorId);
		await syncOnce(db, connectorId);
		expect(localSubjects(db)).toEqual(["A", "C"]); // POISON never retried
		expect(await serverSubjects("INBOX")).toEqual(["A", "C", "POISON"]);
		// The only signal (sync_errors row) is marked resolved at the start of the next cycle
		const open = db.prepare("SELECT COUNT(*) AS n FROM sync_errors WHERE resolved = 0").get() as { n: number };
		expect(open.n).toBe(0);
	});

	test("a failure on the NEWEST message is retried (only because of the 'last+1:*' quirk)", async () => {
		await appendMsgs("INBOX", [{ subject: "A" }, { subject: "POISON" }]);
		const { db, connectorId } = makeDb();
		poison(db, "POISON");
		await syncOnce(db, connectorId);
		expect(lastUid(db, "INBOX")).toBe(1);
		db.exec("DROP TRIGGER audit_poison");
		await syncOnce(db, connectorId);
		expect(localSubjects(db)).toEqual(["A", "POISON"]);
	});

	test("whole-batch FETCH failure (partial data + NO) in mirror mode: last_uid NOT advanced, batch retried and completed next cycle", async () => {
		await appendMsgs("INBOX", [{ subject: "M1" }, { subject: "M2" }, { subject: "M3" }]);
		const { db, connectorId } = makeDb();
		const proxy = await startFaultProxy();
		try {
			proxy.armPartialFetch("no");
			const s = await newSyncOnPort(db, connectorId, proxy.port);
			const r = await s.syncAll();
			await s.disconnect();
			expect(r.totalErrors).toBeGreaterThan(0);
		} finally {
			await proxy.close();
		}
		expect(localSubjects(db)).toEqual(["M1"]);
		expect(lastUid(db, "INBOX")).toBeUndefined();
		await syncOnce(db, connectorId);
		expect(localSubjects(db)).toEqual(["M1", "M2", "M3"]);
	});

	test("unreadable message on real Dovecot (server disconnects on FETCH): nothing deleted in connector mode, later folders fail this cycle, full recovery once readable", async () => {
		await appendMsgs("Archive", [{ subject: "A1" }, { subject: "BAD" }, { subject: "A3" }]);
		await appendMsgs("INBOX", [{ subject: "I1" }]);
		const file = findMaildirFile("Archive", "BAD");
		if (!file) throw new Error("maildir file not found");
		chmodSync(file, 0o000);
		const { db, connectorId } = makeDb({ connectorMode: true });
		const r = await syncOnce(db, connectorId);
		const arch = r.folders.find((f) => f.folder === "Archive");
		expect(arch?.errors.some((e) => e.message.includes("STORK-E002"))).toBe(true);
		expect(arch?.deletedFromServer).toBe(0); // delete failed: connection already dead
		// Collateral: no reconnect within a cycle, so every folder after Archive fails too
		const idx = r.folders.findIndex((f) => f.folder === "Archive");
		for (const later of r.folders.slice(idx + 1)) expect(later.errors.length).toBeGreaterThan(0);
		// Checked on disk: an IMAP envelope FETCH of BAD would itself kill the session.
		expect(maildirSubjects("Archive")).toEqual(["A1", "A3", "BAD"]);

		// Dovecot may have renamed new/ -> cur/ meanwhile; locate it again
		chmodSync(findMaildirFile("Archive", "BAD") ?? file, 0o644);
		await syncOnce(db, connectorId);
		expect(localSubjects(db).sort()).toEqual(["A1", "A3", "BAD", "I1"]);
		expect(await serverSubjects("Archive")).toEqual([]);
		expect(new Set(localRows(db).map((x) => `${x.folder}/${x.uid}`)).size).toBe(4);
	});
});

describe("attachments are not atomic with the message row (finding 10)", () => {
	const twoAtt = { subject: "ATT", attachments: [{ filename: "a.bin", content: "AAAA" }, { filename: "b.bin", content: "BBBB" }] };
	const attTrigger = (db: Database.Database) =>
		db.exec(`CREATE TEMP TRIGGER audit_att BEFORE INSERT ON main.attachments
			WHEN NEW.filename = 'b.bin' BEGIN SELECT RAISE(ABORT, 'simulated disk full'); END;`);

	test("mirror: second attachment insert fails -> message row kept with 1 of 2 attachments, never repaired", async () => {
		await appendMsgs("INBOX", [twoAtt, { subject: "LATER" }]);
		const { db, connectorId } = makeDb();
		attTrigger(db);
		const r = await syncOnce(db, connectorId);
		expect(r.totalErrors).toBe(1);
		db.exec("DROP TRIGGER audit_att");
		await syncOnce(db, connectorId);
		const row = rowBySubject(db, "ATT");
		const atts = db.prepare("SELECT filename FROM attachments WHERE message_id = ?").all(row?.id) as { filename: string }[];
		expect(atts.map((a) => a.filename)).toEqual(["a.bin"]);
	});

	test("DATA LOSS: connector mode: partially-saved message (1 of 2 attachments) is deleted from the server", async () => {
		await appendMsgs("INBOX", [twoAtt]);
		const { db, connectorId } = makeDb({ connectorMode: true });
		attTrigger(db);
		await syncOnce(db, connectorId);
		expect(await serverSubjects("INBOX")).toEqual([]);
		const row = rowBySubject(db, "ATT");
		const atts = db.prepare("SELECT filename FROM attachments WHERE message_id = ?").all(row?.id) as { filename: string }[];
		expect(atts.map((a) => a.filename)).toEqual(["a.bin"]); // b.bin lost
	});
});

describe("interrupted initial sync (finding 10)", () => {
	const N = 400;
	const bulk = () =>
		Array.from({ length: N }, (_, i) => ({
			subject: `bulk-${String(i + 1).padStart(4, "0")}`,
			attachments: [{ filename: `f${i}.txt`, content: `payload ${i}` }],
		}));

	test("AbortSignal mid-sync then resume: no duplicates, no gaps, every attachment present", async () => {
		await appendMsgs("INBOX", bulk());
		const { db, connectorId } = makeDb();
		const ac = new AbortController();
		const timer = setInterval(() => {
			const n = (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
			if (n >= 60) ac.abort();
		}, 5);
		const r = await syncOnce(db, connectorId, ac.signal).finally(() => clearInterval(timer));
		expect(r.aborted).toBe(true);
		const partial = localRows(db).length;
		expect(partial).toBeGreaterThan(0);
		expect(partial).toBeLessThan(N);

		await syncOnce(db, connectorId);
		const rows = localRows(db);
		expect(rows.length).toBe(N);
		expect(new Set(rows.map((x) => x.uid)).size).toBe(N);
		const attCount = (db.prepare("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n;
		expect(attCount).toBe(N);
		expect(lastUid(db, "INBOX")).toBe(N);
	});

	test("SIGKILL mid-sync (connector mode, real file DB) then resume: no duplicates, no loss, server emptied", async () => {
		await appendMsgs("INBOX", bulk());
		const dir = mkdtempSync(join(tmpdir(), "stork-audit-sync-kill-"));
		try {
			const db0 = openDatabase("kill.db", dir);
			db0.prepare(
				`INSERT INTO inbound_connectors (name, type, imap_host, imap_port, imap_tls, imap_user, imap_pass, sync_delete_from_server)
				 VALUES ('Audit IMAP', 'imap', '127.0.0.1', ?, 0, 'alice', 'alicepass', 1)`,
			).run(IMAP_PORT);
			const cid = Number((db0.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
			db0.close();

			const child = spawn(
				resolve(__dirname, "../../node_modules/.bin/tsx"),
				[resolve(__dirname, "kill-child.ts"), dir, String(cid), String(IMAP_PORT)],
				{ stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
			);
			let stderr = "";
			child.stderr.on("data", (d) => (stderr += d));
			const exited = new Promise<number | null>((res) => child.on("exit", (code, sig) => res(sig ? -1 : code)));
			const ro = new Database(join(dir, "kill.db"), { readonly: true, fileMustExist: true });
			let killedAt = -1;
			const deadline = Date.now() + 60000;
			while (Date.now() < deadline) {
				let n = 0;
				try {
					n = (ro.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
				} catch {
					/* schema may be mid-creation */
				}
				if (n >= 150) {
					child.kill("SIGKILL");
					killedAt = n;
					break;
				}
				await new Promise((r) => setTimeout(r, 2));
			}
			ro.close();
			const code = await exited;
			expect(code, stderr).toBe(-1); // killed, not finished
			expect(killedAt).toBeGreaterThan(0);

			const srvAfterKill = (await serverSubjects("INBOX")).length;
			const db = openDatabase("kill.db", dir);
			const localAfterKill = (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
			const pend = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE pending_archive = 1").get() as { n: number }).n;
			process.stderr.write(`[kill] killedAt>=${killedAt} local=${localAfterKill} pending_archive=${pend} server=${srvAfterKill}\n`);
			// Nothing deleted from the server that is not stored locally
			expect(localAfterKill + srvAfterKill).toBeGreaterThanOrEqual(N);

			const s = new (await import("../../src/sync/imap-sync.js")).ImapSync(
				{ host: "127.0.0.1", port: IMAP_PORT, secure: false, auth: { user: "alice", pass: "alicepass" } },
				db,
				cid,
			);
			await s.connect();
			await s.syncAll();
			await s.disconnect();
			const rows = db.prepare("SELECT uid FROM messages").all() as { uid: number }[];
			expect(rows.length).toBe(N);
			expect(new Set(rows.map((r) => r.uid)).size).toBe(N);
			expect((db.prepare("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n).toBe(N);
			expect((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE deleted_from_server = 1").get() as { n: number }).n).toBe(N);
			db.close();
			expect(await serverSubjects("INBOX")).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// keep imports used
void newSync;
void withImap;
