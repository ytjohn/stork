/**
 * H2 — SMTP transport sets `tls: { rejectUnauthorized: config.secure }`
 * (src/connectors/smtp.ts:31). For the common STARTTLS-on-587 configuration
 * (secure=false), certificate verification is DISABLED, so a man-in-the-middle
 * presenting a self-signed cert completes the TLS upgrade and harvests the
 * SMTP username/password.
 */
import { afterAll, describe, expect, it } from "vitest";
import { SmtpSendConnector } from "../../src/connectors/smtp.js";
import { StartTlsSmtpTrap } from "./helpers.js";

describe("H2: STARTTLS accepts self-signed cert, leaks credentials", () => {
	const trap = new StartTlsSmtpTrap();
	afterAll(async () => { await trap.stop(); });

	it("sends credentials to a MITM presenting an untrusted self-signed cert", async () => {
		const port = await trap.start();

		// Mirrors how send.ts builds the connector for a port-587 STARTTLS identity
		// (smtp_tls = 0 -> secure = false).
		const connector = new SmtpSendConnector({
			host: "127.0.0.1",
			port,
			secure: false, // STARTTLS -> rejectUnauthorized becomes false
			auth: { user: "victim@corp.example", pass: "SuperSecretPassw0rd" },
		});

		const ok = await connector.verify();

		expect(trap.captured.usedStartTls).toBe(true); // TLS upgrade completed despite bad cert
		expect(ok).toBe(true); // nodemailer accepted the self-signed cert
		expect(trap.captured.user).toBe("victim@corp.example");
		expect(trap.captured.pass).toBe("SuperSecretPassw0rd"); // credentials captured by MITM
	});
});
