/**
 * Hostile / malformed MIME fixture generator. Every fixture embeds a unique
 * marker token where possible so its row can be located after sync.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Fixture {
	name: string;
	raw: Buffer;
	/** Expected Message-ID in DB if any (with angle brackets) */
	messageId?: string;
}

const CRLF = "\r\n";
const b = (s: string) => Buffer.from(s, "utf8");

function basic(id: string, extraHeaders: string[], body: string, contentType = "text/plain; charset=utf-8"): string {
	return [
		"From: Sender <sender@example.com>",
		"To: me@example.com",
		`Subject: fixture ${id}`,
		`Message-ID: <${id}@fixtures.example>`,
		"Date: Tue, 06 Oct 2026 12:00:00 +0000",
		"MIME-Version: 1.0",
		`Content-Type: ${contentType}`,
		...extraHeaders,
		"",
		body,
		"",
	].join(CRLF);
}

export function deepNest(levels: number, id: string): string {
	let open = "";
	let close = "";
	for (let i = 0; i < levels; i++) {
		open += `--b${i}${CRLF}Content-Type: multipart/mixed; boundary="b${i + 1}"${CRLF}${CRLF}`;
		close = `--b${i}--${CRLF}${close}`;
	}
	const leaf = `--b${levels}${CRLF}Content-Type: text/plain${CRLF}${CRLF}deepleaf${id}${CRLF}--b${levels}--${CRLF}`;
	return [
		"From: deep@example.com",
		"To: me@example.com",
		`Subject: fixture ${id}`,
		`Message-ID: <${id}@fixtures.example>`,
		"Date: Tue, 06 Oct 2026 12:00:00 +0000",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="b0"',
		"",
		open + leaf + close,
	].join(CRLF);
}

function attachmentMsg(id: string, dispositionParams: string, content: Buffer, ctype = "application/octet-stream"): Buffer {
	const head = [
		"From: att@example.com",
		"To: me@example.com",
		`Subject: fixture ${id}`,
		`Message-ID: <${id}@fixtures.example>`,
		"Date: Tue, 06 Oct 2026 12:00:00 +0000",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="XX"',
		"",
		"--XX",
		"Content-Type: text/plain",
		"",
		`body of ${id}`,
		"--XX",
		`Content-Type: ${ctype}`,
		"Content-Transfer-Encoding: base64",
		`Content-Disposition: attachment; ${dispositionParams}`,
		"",
		content.toString("base64").replace(/.{76}/g, `$&${CRLF}`),
		"--XX--",
		"",
	].join(CRLF);
	return Buffer.from(head, "binary");
}

/** Real S/MIME detached signature produced by openssl over a self-signed cert. */
export function smimeSigned(id: string): { raw: Buffer; cert: string; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "stork-smime-"));
	execFileSync(
		"openssl",
		["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=audit@example.com"],
		{ stdio: "ignore" },
	);
	writeFileSync(join(dir, "content.txt"), `Signed content ${id}\r\nSecond line.\r\n`);
	execFileSync(
		"openssl",
		["smime", "-sign", "-in", join(dir, "content.txt"), "-signer", join(dir, "c.pem"), "-inkey", join(dir, "k.pem"), "-out", join(dir, "signed.eml"), "-text"],
		{ stdio: "ignore" },
	);
	const signed = readFileSync(join(dir, "signed.eml"));
	const head = [
		"From: audit@example.com",
		"To: me@example.com",
		`Subject: fixture ${id}`,
		`Message-ID: <${id}@fixtures.example>`,
		"Date: Tue, 06 Oct 2026 12:00:00 +0000",
		"",
	].join(CRLF);
	// openssl writes MIME-Version + Content-Type itself; normalise to CRLF
	const raw = Buffer.concat([b(head.slice(0, -2)), b(CRLF), Buffer.from(signed.toString("binary").replace(/\r?\n/g, CRLF), "binary")]);
	return { raw, cert: join(dir, "c.pem"), dir };
}

export function pgpSigned(id: string): string {
	return [
		"From: pgp@example.com",
		"To: me@example.com",
		`Subject: fixture ${id}`,
		`Message-ID: <${id}@fixtures.example>`,
		"Date: Tue, 06 Oct 2026 12:00:00 +0000",
		"MIME-Version: 1.0",
		'Content-Type: multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="SIG"',
		"",
		"--SIG",
		"Content-Type: text/plain; charset=us-ascii",
		"Content-Transfer-Encoding: 7bit",
		"",
		`PGP signed body ${id}   `,
		"trailing whitespace above is significant for verification",
		"--SIG",
		'Content-Type: application/pgp-signature; name="signature.asc"',
		"",
		"-----BEGIN PGP SIGNATURE-----",
		"",
		"iQEzBAEBCAAdFiEEfakefakefakefakefakefakefakefakeFAKE=",
		"=fake",
		"-----END PGP SIGNATURE-----",
		"--SIG--",
		"",
	].join(CRLF);
}

export function hostileFixtures(): Fixture[] {
	const f: Fixture[] = [];
	const add = (name: string, raw: Buffer | string, messageId?: string) =>
		f.push({ name, raw: typeof raw === "string" ? Buffer.from(raw, "binary") : raw, messageId });

	add(
		"no-message-id",
		["From: a@example.com", "To: me@example.com", "Subject: fixture no-message-id", "Date: Tue, 06 Oct 2026 12:00:00 +0000", "", "no id here", ""].join(CRLF),
	);
	add("dup-msgid-a", basic("dup", [], "first distinct content alpha").replace("fixture dup", "fixture dup-a"), "<dup@fixtures.example>");
	add("dup-msgid-b", basic("dup", [], "second distinct content beta").replace("fixture dup", "fixture dup-b"), "<dup@fixtures.example>");
	add(
		"broken-boundary",
		basic("broken-boundary", [], `--WRONG${CRLF}Content-Type: text/plain${CRLF}${CRLF}orphan part text${CRLF}--NEVERCLOSED`, 'multipart/mixed; boundary="EXPECTED"'),
		"<broken-boundary@fixtures.example>",
	);
	add(
		"invalid-charset",
		Buffer.concat([b(basic("invalid-charset", [], "", "text/plain; charset=x-no-such-charset-42").slice(0, -4)), Buffer.from([0xff, 0xfe, 0x41, 0x80, 0x81, 0x0d, 0x0a])]),
		"<invalid-charset@fixtures.example>",
	);
	add(
		"8bit-headers",
		Buffer.concat([
			b("From: Jürgen Müller <jm@example.com>\r\nTo: me@example.com\r\n"),
			Buffer.from("Subject: fixture 8bit-headers caf\xe9 latin1 \r\n", "latin1"),
			b("Message-ID: <8bit-headers@fixtures.example>\r\nDate: Tue, 06 Oct 2026 12:00:00 +0000\r\n\r\nbody\r\n"),
		]),
		"<8bit-headers@fixtures.example>",
	);
	add(
		"rfc2047-garbage",
		basic("rfc2047-garbage", ["X-Note: =?utf-8?B?!!!!notbase64?= =?bogus-cs?Q?=FF=FE?= =?utf-8?Q?unterminated"], "x").replace(
			"Subject: fixture rfc2047-garbage",
			"Subject: fixture rfc2047-garbage =?utf-8?B?!!!!?= =?x-unknown?Q?=E9t=E9?= =?utf-8?Q?=ZZ?=",
		),
		"<rfc2047-garbage@fixtures.example>",
	);
	add("deep-nesting-20", deepNest(20, "deep-nesting-20"), "<deep-nesting-20@fixtures.example>");
	add("deep-nesting-21", deepNest(21, "deep-nesting-21"), "<deep-nesting-21@fixtures.example>");
	add("deep-nesting-200", deepNest(200, "deep-nesting-200"), "<deep-nesting-200@fixtures.example>");
	add("deep-nesting-2000", deepNest(2000, "deep-nesting-2000"), "<deep-nesting-2000@fixtures.example>");
	add("zero-byte", Buffer.alloc(0));
	add("header-only", "From: h@example.com\r\nSubject: fixture header-only\r\nMessage-ID: <header-only@fixtures.example>", "<header-only@fixtures.example>");
	add("missing-date-from", "To: me@example.com\r\nSubject: fixture missing-date-from\r\nMessage-ID: <missing-date-from@fixtures.example>\r\n\r\nno date no from\r\n", "<missing-date-from@fixtures.example>");
	add("huge-subject-1mb", basic("huge-subject-1mb", [], "body").replace("Subject: fixture huge-subject-1mb", `Subject: fixture huge-subject-1mb ${"A".repeat(1024 * 1024)}`), "<huge-subject-1mb@fixtures.example>");
	add("huge-header-1mb", basic("huge-header-1mb", [`X-Huge: ${"B".repeat(1024 * 1024)}`], "body"), "<huge-header-1mb@fixtures.example>");
	add(
		"10k-recipients",
		basic("10k-recipients", [], "many recipients").replace(
			"To: me@example.com",
			`To: ${Array.from({ length: 10000 }, (_, i) => `r${i}@example.com`).join(",\r\n ")}`,
		),
		"<10k-recipients@fixtures.example>",
	);
	add("path-traversal-filename", attachmentMsg("path-traversal-filename", 'filename="../../etc/passwd"', b("root:x:0:0\n")), "<path-traversal-filename@fixtures.example>");
	add(
		"null-byte-filename",
		Buffer.concat([attachmentMsg("null-byte-filename", 'filename="evil\0.txt.exe"', b("MZ fake exe"))]),
		"<null-byte-filename@fixtures.example>",
	);
	add("rfc2231-nul-filename", attachmentMsg("rfc2231-nul-filename", "filename*=utf-8''evil%00.pdf%2F..%2F..%2Fx", b("pdf?")), "<rfc2231-nul-filename@fixtures.example>");
	add("tnef-winmail", attachmentMsg("tnef-winmail", 'filename="winmail.dat"', Buffer.from([0x78, 0x9f, 0x3e, 0x22, 0x01, 0x06, 0x90, 0x08, 0x00]), "application/ms-tnef"), "<tnef-winmail@fixtures.example>");
	add(
		"calendar-invite",
		basic(
			"calendar-invite",
			[],
			["--CAL", "Content-Type: text/plain", "", "You are invited", "--CAL", "Content-Type: text/calendar; method=REQUEST; charset=utf-8", "", "BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:audit-1", "SUMMARY:Audit meeting", "DTSTART:20261020T100000Z", "END:VEVENT", "END:VCALENDAR", "--CAL--"].join(CRLF),
			'multipart/alternative; boundary="CAL"',
		),
		"<calendar-invite@fixtures.example>",
	);
	add("pgp-mime-signed", pgpSigned("pgp-mime-signed"), "<pgp-mime-signed@fixtures.example>");
	add("nul-in-body", Buffer.concat([b(basic("nul-in-body", [], "before").slice(0, -2)), Buffer.from([0, 0, 0x41, 0]), b("after\r\n")]), "<nul-in-body@fixtures.example>");
	add("bad-base64-body", basic("bad-base64-body", ["Content-Transfer-Encoding: base64"], "!!!!****not base64 at all****"), "<bad-base64-body@fixtures.example>");
	add("sentinel-last", basic("sentinel-last", [], "sentinel ok"), "<sentinel-last@fixtures.example>");
	return f;
}
