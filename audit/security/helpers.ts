/**
 * Shared helpers for the security audit PoCs.
 *
 * Audit-only. Never imported by src/. Uses 127.0.0.1 and ephemeral ports only.
 */
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";

/** A throwaway temp data dir for a real on-disk stork instance. */
export function tempDataDir(): string {
	return mkdtempSync(join(tmpdir(), "stork-audit-"));
}

/** Generate a self-signed cert/key pair with openssl into a temp dir. */
export function selfSignedCert(): { cert: string; key: string } {
	const dir = mkdtempSync(join(tmpdir(), "stork-audit-cert-"));
	const keyPath = join(dir, "key.pem");
	const certPath = join(dir, "cert.pem");
	execFileSync("openssl", [
		"req", "-x509", "-newkey", "rsa:2048",
		"-keyout", keyPath, "-out", certPath,
		"-days", "1", "-nodes",
		"-subj", "/CN=evil-mitm.invalid",
	]);
	return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
}

export interface CapturedSmtpAuth {
	user?: string;
	pass?: string;
	usedStartTls: boolean;
}

/**
 * Minimal STARTTLS SMTP server with a self-signed certificate.
 *
 * Advertises STARTTLS on EHLO; on STARTTLS it upgrades the socket using a
 * self-signed cert and then captures the AUTH LOGIN credentials the client
 * sends. This models an attacker who has intercepted the SMTP connection
 * (e.g. DNS/ARP spoof) and presents a cert the client should reject.
 */
export class StartTlsSmtpTrap {
	private net: Server;
	private port = 0;
	private creds: { cert: string; key: string };
	public captured: CapturedSmtpAuth = { usedStartTls: false };

	constructor() {
		this.creds = selfSignedCert();
		this.net = createNetServer((sock) => this.handlePlain(sock));
	}

	async start(): Promise<number> {
		return new Promise((resolve, reject) => {
			this.net.listen(0, "127.0.0.1", () => {
				const a = this.net.address();
				if (a && typeof a === "object") { this.port = a.port; resolve(this.port); }
				else reject(new Error("bind failed"));
			});
			this.net.on("error", reject);
		});
	}
	getPort(): number { return this.port; }
	async stop(): Promise<void> {
		return new Promise((r) => this.net.close(() => r()));
	}

	private handlePlain(sock: Socket) {
		sock.on("error", () => {});
		let buf = "";
		sock.write("220 evil-mitm.invalid ESMTP\r\n");
		const onData = (chunk: Buffer) => {
			buf += chunk.toString();
			let idx: number;
			while ((idx = buf.indexOf("\r\n")) >= 0) {
				const line = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				const up = line.toUpperCase();
				if (up.startsWith("EHLO") || up.startsWith("HELO")) {
					sock.write("250-evil-mitm.invalid\r\n250-STARTTLS\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n");
				} else if (up.startsWith("STARTTLS")) {
					sock.write("220 Go ahead\r\n");
					sock.removeListener("data", onData);
					this.upgrade(sock, buf);
					return;
				} else if (up.startsWith("QUIT")) {
					sock.write("221 Bye\r\n"); sock.end();
				} else {
					sock.write("250 OK\r\n");
				}
			}
		};
		sock.on("data", onData);
	}

	private upgrade(sock: Socket, _leftover: string) {
		// Wrap the already-connected TCP socket in a server-side TLS socket.
		// nodemailer waits for our "220 Go ahead" before starting the handshake,
		// so nothing is buffered past the STARTTLS line.
		const secureContext = createSecureContext({ cert: this.creds.cert, key: this.creds.key });
		const tlsSock = new TLSSocket(sock, { isServer: true, secureContext });
		tlsSock.on("secure", () => { this.captured.usedStartTls = true; });
		this.handleTls(tlsSock);
	}

	private handleTls(sock: TLSSocket) {
		sock.on("error", () => {});
		let buf = "";
		let step: "none" | "user" | "pass" = "none";
		// No greeting after STARTTLS; the client sends EHLO over TLS immediately.
		sock.on("data", (chunk: Buffer) => {
			buf += chunk.toString();
			let idx: number;
			while ((idx = buf.indexOf("\r\n")) >= 0) {
				const line = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				const up = line.toUpperCase();
				if (step === "user") {
					this.captured.user = Buffer.from(line, "base64").toString();
					sock.write("334 UGFzc3dvcmQ6\r\n");
					step = "pass";
				} else if (step === "pass") {
					this.captured.pass = Buffer.from(line, "base64").toString();
					sock.write("235 Authentication successful\r\n");
					step = "none";
				} else if (up.startsWith("EHLO") || up.startsWith("HELO")) {
					sock.write("250-secured\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n");
				} else if (up.startsWith("AUTH LOGIN")) {
					sock.write("334 VXNlcm5hbWU6\r\n");
					step = "user";
				} else if (up.startsWith("AUTH PLAIN")) {
					const enc = line.slice(11).trim();
					if (enc) {
						const parts = Buffer.from(enc, "base64").toString().split("\0");
						this.captured.user = parts[1] || parts[0];
						this.captured.pass = parts[2] || parts[1];
						sock.write("235 Authentication successful\r\n");
					} else sock.write("334 \r\n");
				} else if (up.startsWith("QUIT")) {
					sock.write("221 Bye\r\n"); sock.end();
				} else {
					sock.write("250 OK\r\n");
				}
			}
		});
	}
}

/** A bare TCP listener that records the first bytes it receives (for SSRF proofs). */
export class TcpCapture {
	private srv: Server;
	private port = 0;
	public hits: string[] = [];
	constructor(private respond = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n") {
		this.srv = createNetServer((sock) => {
			sock.on("error", () => {});
			let got = "";
			let flushed = false;
			const flush = () => {
				if (flushed) return;
				flushed = true;
				this.hits.push(got);
				try { sock.write(this.respond); } catch {}
				sock.end();
			};
			sock.on("data", (c) => {
				got += c.toString();
				// Capture the first inbound request/handshake bytes, then close.
				if (got.length > 8192) flush();
				else setTimeout(flush, 40);
			});
			sock.on("end", flush);
		});
	}
	async start(): Promise<number> {
		return new Promise((resolve, reject) => {
			this.srv.listen(0, "127.0.0.1", () => {
				const a = this.srv.address();
				if (a && typeof a === "object") { this.port = a.port; resolve(this.port); }
				else reject(new Error("bind failed"));
			});
			this.srv.on("error", reject);
		});
	}
	getPort(): number { return this.port; }
	async stop(): Promise<void> { return new Promise((r) => this.srv.close(() => r())); }
}

/** Write a minimal valid stork.keys-less data dir marker (unused placeholder). */
export function noop(): void { writeFileSync; }
