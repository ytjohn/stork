/**
 * C. LARGE ATTACHMENTS — 25MB (x2, same bytes → dedup) and 100MB through the
 * real sync path in a child process so RSS is measured in isolation.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { adminClient, dropIntoMaildir, PORT, resetDovecot } from "./helpers.js";

function bigMessage(id: string, payload: Buffer): Buffer {
	const head = [
		"From: big@example.com",
		"To: me@example.com",
		`Subject: big ${id}`,
		`Message-ID: <${id}@big.example>`,
		"Date: Tue, 06 Oct 2026 12:00:00 +0000",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="BIG"',
		"",
		"--BIG",
		"Content-Type: text/plain",
		"",
		"see attached",
		"--BIG",
		"Content-Type: application/octet-stream",
		"Content-Transfer-Encoding: base64",
		`Content-Disposition: attachment; filename="${id}.bin"`,
		"",
		"",
	].join("\r\n");
	const b64 = payload.toString("base64").replace(/.{76}/g, "$&\r\n");
	return Buffer.concat([Buffer.from(head), Buffer.from(b64), Buffer.from("\r\n--BIG--\r\n")]);
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface ChildOut {
	syncMs: number;
	newMessages: number;
	errors: unknown[];
	baselineRssMB: number;
	peakRssDuringSyncMB: number;
	peakRssIncludingDownloadMB: number;
	maxRssKernelMB: number;
	blobRows: number;
	blobBytes: number;
	attachmentRows: number;
	downloads: { subject: string; size: number; downloadedBytes: number; sha256: string; contentHash: string }[];
}

function runChild(): ChildOut {
	const out = execFileSync("npx", ["tsx", join(__dirname, "large-attach-child.ts"), String(PORT)], {
		cwd: join(__dirname, "..", ".."),
		env: { ...process.env, STORK_FAST_KDF: "1" },
		maxBuffer: 1 << 24,
		timeout: 600_000,
	});
	return JSON.parse(out.toString().trim().split("\n").pop() as string);
}

const observed: Record<string, unknown> = {};

describe("C. large attachments", () => {
	test("25MB attachment in two messages: byte-exact download + blob dedup", async () => {
		await resetDovecot();
		const payload = randomBytes(25 * 1024 * 1024);
		const c = await adminClient();
		dropIntoMaildir(bigMessage("dup25-a", payload));
		await c.status("INBOX", { messages: true });
		dropIntoMaildir(bigMessage("dup25-b", payload));
		await c.status("INBOX", { messages: true });
		await c.logout();
		const r = runChild();
		observed.case25x2 = { ...r, downloads: r.downloads.map(({ sha256, contentHash, ...d }) => d) };
		expect(r.errors).toEqual([]);
		expect(r.newMessages).toBe(2);
		expect(r.attachmentRows).toBe(2);
		expect(r.blobRows).toBe(1); // content-addressed dedup works
		for (const d of r.downloads) {
			expect(d.downloadedBytes).toBe(payload.length);
			expect(d.sha256).toBe(sha(payload));
			expect(d.contentHash).toBe(sha(payload));
		}
	}, 600_000);

	test("100MB attachment: stored and byte-exact; peak RSS recorded", async () => {
		await resetDovecot();
		const payload = randomBytes(100 * 1024 * 1024);
		const c = await adminClient();
		dropIntoMaildir(bigMessage("big100", payload));
		await c.status("INBOX", { messages: true });
		await c.logout();
		const r = runChild();
		observed.case100 = { ...r, downloads: r.downloads.map(({ sha256, contentHash, ...d }) => d) };
		expect(r.errors).toEqual([]);
		expect(r.downloads).toHaveLength(1);
		expect(r.downloads[0].sha256).toBe(sha(payload));
		// The entire message is buffered (FETCH BODY[] → Buffer → mailparser → deflate → SQLite):
		// peak RSS during sync is a multiple of the attachment size.
		expect(r.peakRssDuringSyncMB - r.baselineRssMB).toBeGreaterThan(300);
		writeFileSync(join(__dirname, "large-attachments.observed.json"), JSON.stringify(observed, null, 2));
	}, 600_000);
});
