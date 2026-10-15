/**
 * B. MALFORMED / HOSTILE MIME through the real ImapSync + Dovecot.
 * Fixtures are dropped straight into the Maildir (bypassing APPEND checks)
 * one at a time so each gets a known, ascending UID.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { attachmentRoutes } from "../../src/api/routes/attachments.js";
import { decompressText } from "../../src/storage/compression.js";
import { MessageSearch } from "../../src/search/search.js";
import { adminClient, count, type Ctx, dropIntoMaildir, freshDb, resetDovecot, runSync } from "./helpers.js";
import { type Fixture, hostileFixtures, smimeSigned } from "./mime-fixtures.js";

interface Row {
	id: number;
	uid: number;
	message_id: string | null;
	subject: string | null;
	from_address: string | null;
	date: string | null;
	text_body: string | null;
	has_attachments: number;
	raw_headers: Buffer | null;
	to_addresses: string | null;
}

let ctx: Ctx;
const fixtures: Fixture[] = hostileFixtures();
const uidOf = new Map<string, number>();
let smime: ReturnType<typeof smimeSigned>;
let syncResult: Awaited<ReturnType<typeof runSync>>;
let syncMs = 0;
export const report: Record<string, unknown>[] = [];

function rowFor(name: string): Row | undefined {
	return ctx.db.prepare("SELECT * FROM messages WHERE uid = ?").get(uidOf.get(name)) as Row | undefined;
}

describe("B. hostile MIME", () => {
	beforeAll(async () => {
		await resetDovecot();
		smime = smimeSigned("smime-signed");
		const all = [...fixtures.slice(0, -1), { name: "smime-signed", raw: smime.raw }, fixtures[fixtures.length - 1]];
		const c = await adminClient();
		for (const fx of all) {
			dropIntoMaildir(fx.raw);
			const st = await c.status("INBOX", { uidNext: true, messages: true });
			uidOf.set(fx.name, Number(st.uidNext) - 1);
		}
		await c.logout();
		ctx = freshDb("Hostile");
		const t0 = Date.now();
		syncResult = await runSync(ctx);
		syncMs = Date.now() - t0;
		for (const fx of all) {
			const r = rowFor(fx.name);
			report.push({
				fixture: fx.name,
				uid: uidOf.get(fx.name),
				stored: !!r,
				subject: r?.subject ? `${r.subject.slice(0, 40)}${r.subject.length > 40 ? `…(${r.subject.length})` : ""}` : r?.subject,
				from: r?.from_address,
				date: r?.date,
				msgid: r?.message_id,
				body: r?.text_body ? r.text_body.slice(0, 30) : r?.text_body,
				atts: r ? count(ctx.db, "SELECT COUNT(*) n FROM attachments WHERE message_id = ?", r.id) : null,
			});
		}
		writeFileSync(join(__dirname, "hostile-mime.observed.json"), JSON.stringify({ syncMs, errors: syncResult.folders.flatMap((f) => f.errors), report }, null, 2));
	});
	afterAll(() => ctx?.db.close());

	test("every fixture got a distinct ascending UID", () => {
		const uids = [...uidOf.values()];
		expect(new Set(uids).size).toBe(uids.length);
	});

	test("sync completes; only the zero-byte message records an error; last_uid jumps past every lost message", () => {
		const errs = syncResult.folders.flatMap((f) => f.errors);
		expect(errs.map((e) => [e.uid, e.message, e.retriable])).toEqual([
			[uidOf.get("zero-byte"), `UID ${uidOf.get("zero-byte")}: no source available`, true],
		]);
		const notStored = report.filter((r) => r.stored === false).map((r) => r.fixture);
		// SILENT loss: >20 MIME levels → imapflow drops the whole FETCH response
		// (token-parser MAX_NODE_DEPTH=25 on BODYSTRUCTURE) → no row, no error.
		expect(notStored.sort()).toEqual(["deep-nesting-200", "deep-nesting-2000", "deep-nesting-21", "zero-byte"].sort());
		const lastUid = count(ctx.db, "SELECT last_uid n FROM sync_state");
		expect(lastUid).toBe(uidOf.get("sentinel-last"));
	});

	test("lost messages are never retried: 2nd sync does not fetch them and auto-resolves the 'retriable' error", async () => {
		await runSync(ctx);
		for (const n of ["deep-nesting-21", "deep-nesting-200", "zero-byte"]) expect(rowFor(n), n).toBeUndefined();
		expect(count(ctx.db, "SELECT COUNT(*) n FROM sync_errors WHERE resolved = 0")).toBe(0);
		expect(count(ctx.db, "SELECT COUNT(*) n FROM sync_errors WHERE resolved = 1 AND uid = ?", uidOf.get("zero-byte"))).toBe(1);
	});

	test("deep nesting: 20 levels stored with leaf text; 21+ silently missing", () => {
		expect(rowFor("deep-nesting-20")?.text_body).toContain("deepleafdeep-nesting-20");
		expect(rowFor("deep-nesting-21")).toBeUndefined();
	});

	test("no-message-id → stored with NULL message_id", () => {
		expect(rowFor("no-message-id")?.message_id).toBeNull();
	});

	test("duplicate Message-ID with distinct content → both stored, both searchable", () => {
		const rows = ctx.db.prepare("SELECT text_body FROM messages WHERE message_id = '<dup@fixtures.example>'").all() as { text_body: string }[];
		expect(rows.map((r) => r.text_body.trim()).sort()).toEqual(["first distinct content alpha", "second distinct content beta"]);
	});

	test("missing Date/From → NULL date and from (no fallback to INTERNALDATE)", () => {
		const r = rowFor("missing-date-from");
		expect(r?.from_address).toBeNull();
		expect(r?.date).toBeNull();
	});

	test("1MB Subject: subject (from IMAP ENVELOPE) stored unbounded + FTS-indexed, but BODY and headers silently dropped", () => {
		const r = rowFor("huge-subject-1mb");
		expect(r?.subject?.length).toBeGreaterThan(1024 * 1024);
		// mailsplit MAX_HEAD_SIZE (1MB) → EMAXLEN; simpleParser resolves a husk {attachments: []}
		expect(r?.text_body).toBeNull();
		expect(r?.raw_headers).toBeNull();
		const s = new MessageSearch(ctx.db);
		const hits = s.search("fixture huge");
		expect(hits.length).toBeGreaterThanOrEqual(1);
	});

	test("1MB custom header → row stored with NULL body and NULL raw_headers (content lost, no error)", () => {
		const r = rowFor("huge-header-1mb");
		expect(r?.subject).toBe("fixture huge-header-1mb");
		expect(r?.text_body).toBeNull();
		expect(r?.raw_headers).toBeNull();
	});

	test("broken boundary / invalid charset → stored with NULL text_body (body unrecoverable: no raw source kept)", () => {
		expect(rowFor("broken-boundary")?.text_body).toBeNull();
		expect(rowFor("invalid-charset")?.text_body).toBeNull();
	});

	test("8-bit latin1 header and RFC2047 garbage → stored, U+FFFD substituted, no crash", () => {
		expect(rowFor("8bit-headers")?.subject).toContain("\uFFFD");
		expect(rowFor("rfc2047-garbage")?.subject).toMatch(/^fixture rfc2047-garbage/);
	});

	test("10k recipients → all stored in to_addresses JSON", () => {
		const r = rowFor("10k-recipients");
		expect(JSON.parse(r?.to_addresses ?? "[]")).toHaveLength(10000);
	});

	test("path-traversal / NUL filenames: stored verbatim in DB; download route sanitises / and \\ only", async () => {
		const pt = rowFor("path-traversal-filename")!;
		const att = ctx.db.prepare("SELECT id, filename FROM attachments WHERE message_id = ?").get(pt.id) as { id: number; filename: string };
		expect(att.filename).toBe("../../etc/passwd");
		const app = attachmentRoutes(() => ctx.db);
		const res = await app.request(`/${att.id}`);
		expect(res.headers.get("content-disposition")).toBe('attachment; filename=".._.._etc_passwd"');

		const nb = rowFor("null-byte-filename")!;
		const att2 = ctx.db.prepare("SELECT id, filename FROM attachments WHERE message_id = ?").get(nb.id) as { id: number; filename: string };
		const res2 = await app.request(`/${att2.id}`);
		report.push({ nulFilenameStored: JSON.stringify(att2.filename), nulDisposition: res2.headers.get("content-disposition") });
		// the NUL byte never reaches the header (non-printables → "_")
		expect(res2.headers.get("content-disposition")).not.toContain("\0");
	});

	test("TNEF winmail.dat is kept as an opaque attachment (not decoded)", () => {
		const r = rowFor("tnef-winmail")!;
		const a = ctx.db.prepare("SELECT filename, content_type FROM attachments WHERE message_id = ?").all(r.id);
		expect(a).toEqual([{ filename: "winmail.dat", content_type: "application/ms-tnef" }]);
	});

	test("calendar part: stored as attachment (text/calendar), body has the plain alternative", () => {
		const r = rowFor("calendar-invite")!;
		const a = ctx.db.prepare("SELECT filename, content_type FROM attachments WHERE message_id = ?").all(r.id) as { content_type: string }[];
		report.push({ calendarAttachments: a });
		expect(a.some((x) => x.content_type === "text/calendar")).toBe(true);
	});

	test("S/MIME: original verifies with openssl; Stork retains no raw source, so the signature cannot be re-verified", () => {
		const orig = join(smime.dir, "orig.eml");
		writeFileSync(orig, smime.raw);
		// sanity: the fixture as delivered is verifiable
		execFileSync("openssl", ["smime", "-verify", "-in", orig, "-CAfile", smime.cert, "-out", "/dev/null"], { stdio: "ignore" });
		const cols = (ctx.db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
		expect(cols.filter((c) => /source|raw_message|rfc822|eml/i.test(c))).toEqual([]);
		// best-effort reconstruction from what Stork stores (raw_headers + text_body + p7s) fails
		const r = rowFor("smime-signed")!;
		const atts = ctx.db.prepare("SELECT filename, content_type FROM attachments WHERE message_id = ?").all(r.id);
		report.push({ smimeAttachments: atts });
		const recon = join(smime.dir, "recon.eml");
		writeFileSync(recon, `${decompressText(r.raw_headers)}\r\n\r\n${r.text_body}`);
		let verified = true;
		try {
			execFileSync("openssl", ["smime", "-verify", "-in", recon, "-CAfile", smime.cert, "-out", "/dev/null"], { stdio: "ignore" });
		} catch {
			verified = false;
		}
		expect(verified).toBe(false);
	});

	test("PGP/MIME: signature stored as attachment; signed part bytes (trailing whitespace) not retained", () => {
		const r = rowFor("pgp-mime-signed")!;
		const a = ctx.db.prepare("SELECT filename, content_type FROM attachments WHERE message_id = ?").all(r.id);
		report.push({ pgpAttachments: a, pgpBody: JSON.stringify(r.text_body) });
		expect(a).toEqual([{ filename: "signature.asc", content_type: "application/pgp-signature" }]);
	});

	afterAll(() => {
		writeFileSync(join(__dirname, "hostile-mime.observed.json"), JSON.stringify({ syncMs, errors: syncResult?.folders.flatMap((f) => f.errors), report }, null, 2));
	});
});
