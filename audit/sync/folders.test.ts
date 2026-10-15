/**
 * Server-side folder lifecycle (finding 3): create / rename / delete by another client.
 */
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
	addUserLabel,
	appendMsgs,
	labelsOf,
	localRows,
	localSubjects,
	makeDb,
	resetImap,
	rowBySubject,
	serverSubjects,
	stopImap,
	syncOnce,
	withImap,
} from "./helpers";

beforeEach(() => resetImap());
afterAll(() => stopImap());

function folderPaths(db: ReturnType<typeof makeDb>["db"]): string[] {
	return (db.prepare("SELECT path FROM folders WHERE inbound_connector_id IS NOT NULL ORDER BY path").all() as {
		path: string;
	}[]).map((r) => r.path);
}

describe("server folder create/rename/delete", () => {
	test("folder created on server (incl. nested) appears locally with a full-path label", async () => {
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		await withImap(async (c) => {
			await c.mailboxCreate("Projects");
			await c.mailboxCreate("Projects/2024");
		});
		await appendMsgs("Projects/2024", [{ subject: "P1" }]);
		await syncOnce(db, connectorId);
		expect(folderPaths(db)).toContain("Projects/2024");
		const p1 = rowBySubject(db, "P1");
		expect(p1?.folder).toBe("Projects/2024");
		expect(labelsOf(db, p1?.id ?? -1)).toContain("Projects/2024");
	});

	test("rename on server (mirror): old folder hard-deleted with its rows, renamed folder re-downloaded; user labels lost", async () => {
		await withImap((c) => c.mailboxCreate("Work").then(() => undefined));
		await appendMsgs("Work", [{ subject: "W1" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		const w1 = rowBySubject(db, "W1");
		addUserLabel(db, w1?.id ?? -1, "Taxes");

		await withImap((c) => c.mailboxRename("Work", "Projects").then(() => undefined));
		await syncOnce(db, connectorId);

		expect(folderPaths(db)).not.toContain("Work");
		const w1b = rowBySubject(db, "W1");
		expect(w1b?.folder).toBe("Projects");
		expect(w1b?.id).not.toBe(w1?.id);
		expect(labelsOf(db, w1b?.id ?? -1)).not.toContain("Taxes");
		// Orphaned 'Work' label row remains in labels table
		expect(db.prepare("SELECT 1 FROM labels WHERE name = 'Work'").get()).toBeTruthy();
	});

	test("DATA LOSS: connector mode: deleting the (now empty) server folder cascade-deletes all local-only archived mail in it", async () => {
		await withImap((c) => c.mailboxCreate("Work").then(() => undefined));
		await appendMsgs("Work", [{ subject: "W1" }, { subject: "W2" }]);
		const { db, connectorId } = makeDb({ connectorMode: true });
		await syncOnce(db, connectorId);
		expect(localSubjects(db, "Work")).toEqual(["W1", "W2"]);
		expect(await serverSubjects("Work")).toEqual([]); // emptied by connector mode

		// User tidies up the now-empty folder in another client
		await withImap((c) => c.mailboxDelete("Work").then(() => undefined));
		await syncOnce(db, connectorId);

		expect(folderPaths(db)).not.toContain("Work");
		expect(localSubjects(db)).toEqual([]); // the only copies are gone
	});

	test("DATA LOSS: connector mode: renaming the server folder deletes local archive copies (nothing left on server to re-download)", async () => {
		await withImap((c) => c.mailboxCreate("Work").then(() => undefined));
		await appendMsgs("Work", [{ subject: "W1" }]);
		const { db, connectorId } = makeDb({ connectorMode: true });
		await syncOnce(db, connectorId);
		await withImap((c) => c.mailboxRename("Work", "Work-2026").then(() => undefined));
		await syncOnce(db, connectorId);
		expect(localRows(db)).toEqual([]);
	});

	test("folder deleted on server (mirror): local rows deleted; mail that only lived there is gone everywhere (expected mirror semantics)", async () => {
		await withImap((c) => c.mailboxCreate("Work").then(() => undefined));
		await appendMsgs("Work", [{ subject: "W1" }]);
		const { db, connectorId } = makeDb();
		await syncOnce(db, connectorId);
		await withImap((c) => c.mailboxDelete("Work").then(() => undefined));
		await syncOnce(db, connectorId);
		expect(localSubjects(db)).toEqual([]);
	});
});
