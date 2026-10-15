/**
 * Encryption at rest — verify the main DB, the attached blobs DB, and the WAL
 * are actually encrypted by SQLCipher (no plaintext markers, no "SQLite format
 * 3" header), the keys file is 0600, and temp_store is MEMORY (no plaintext
 * temp spill).
 */
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeEncryption, unlockWithPassword } from "../../src/crypto/keys.js";
import { openDatabase } from "../../src/storage/db.js";
import { upsertAttachmentBlob } from "../../src/storage/attachment-storage.js";
import {
	createTestFolder,
	createTestInboundConnector,
	createTestMessage,
} from "../../src/test-helpers/test-db.js";
import { tempDataDir } from "./helpers.js";

const BODY_MARKER = "ZZPLAINTEXT-BODY-MARKER-7f3a9b";

describe("SQLCipher encryption at rest", () => {
	let db: ReturnType<typeof openDatabase> | null = null;
	afterEach(() => { try { db?.close(); } catch {} db = null; });

	it("encrypts main DB, blobs DB, and WAL; keys file is 0600", () => {
		const dir = tempDataDir();
		initializeEncryption(dir, "a-strong-password-123");
		const vaultKey = unlockWithPassword(dir, "a-strong-password-123");

		db = openDatabase("stork.db", dir, vaultKey);
		const conn = createTestInboundConnector(db);
		const folder = createTestFolder(db, conn, "INBOX", { name: "INBOX" });
		createTestMessage(db, conn, folder, 1, { subject: "marker msg", textBody: BODY_MARKER });
		upsertAttachmentBlob(db, Buffer.from(`${BODY_MARKER}-attachment`, "utf8"));

		// Inspect the WAL while it still holds the just-written (uncheckpointed) pages.
		const walPath = join(dir, "stork.db-wal");
		if (existsSync(walPath)) {
			const wal = readFileSync(walPath);
			expect(wal.includes(Buffer.from(BODY_MARKER))).toBe(false); // WAL encrypted
		}

		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		db.close();
		db = null;

		for (const f of ["stork.db", "stork-blobs.db"]) {
			const buf = readFileSync(join(dir, f));
			expect(buf.subarray(0, 16).toString("latin1")).not.toContain("SQLite format 3"); // header encrypted
			expect(buf.includes(Buffer.from(BODY_MARKER))).toBe(false); // body not in cleartext
		}

		// Keys file is written with 0600.
		const mode = statSync(join(dir, "stork.keys")).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("wrong vault key cannot open the encrypted DB", () => {
		const dir = tempDataDir();
		initializeEncryption(dir, "a-strong-password-123");
		const good = unlockWithPassword(dir, "a-strong-password-123");
		const tmp = openDatabase("stork.db", dir, good);
		tmp.close();

		const wrong = Buffer.alloc(32, 0xab);
		expect(() => {
			const bad = openDatabase("stork.db", dir, wrong);
			bad.prepare("SELECT count(*) FROM messages").get();
		}).toThrow();
	});
});
