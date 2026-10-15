/**
 * D. NETWORK FAILURE / RETRY — real ImapSync / SyncScheduler talking to Dovecot
 * through a fault-injecting proxy (fault-proxy.ts).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ImapSync, type SyncAllResult } from "../../src/sync/imap-sync.js";
import { SyncScheduler } from "../../src/sync/sync-scheduler.js";
import { FaultProxy } from "./fault-proxy.js";
import { adminClient, appendTo, count, type Ctx, freshDb, imapConfig, PORT, resetDovecot, runSync } from "./helpers.js";

const N_INBOX = 30;
const N_OTHER = 5;
const BODY_FETCH = /UID FETCH .*BODY\.PEEK\[\]/i;
const AUTH = /^\S+ (LOGIN|AUTHENTICATE)\b/i;
const observed: Record<string, unknown> = {};

function msg(i: number, folder: string): string {
	return [
		`From: n${i}@example.com`,
		"To: me@example.com",
		`Subject: ${folder} message ${i}`,
		`Message-ID: <net-${folder}-${i}@example.com>`,
		"Date: Tue, 06 Oct 2026 12:00:00 +0000",
		"",
		`${"lorem ipsum ".repeat(400)} ${i}`,
		"",
	].join("\r\n");
}

let proxy: FaultProxy;
let ctx: Ctx;

function inboxRows(): number {
	return count(ctx.db, "SELECT COUNT(*) n FROM messages m JOIN folders f ON f.id=m.folder_id WHERE f.path='INBOX'");
}
function settledWithin<T>(p: Promise<T>, ms: number): Promise<boolean> {
	return Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
}

describe("D. network faults", () => {
	beforeAll(async () => {
		await resetDovecot();
		const c = await adminClient();
		for (let i = 1; i <= N_INBOX; i++) await appendTo(c, "INBOX", msg(i, "INBOX"));
		for (let i = 1; i <= N_OTHER; i++) await appendTo(c, "Other", msg(i, "Other"));
		await c.logout();
	});
	afterAll(() => writeFileSync(join(__dirname, "network-faults.observed.json"), JSON.stringify(observed, null, 2)));

	beforeEach(async () => {
		proxy = new FaultProxy(PORT);
		await proxy.start();
		ctx = freshDb("Net");
	});
	afterEach(async () => {
		await proxy.stop();
		ctx.db.close();
	});

	test("D1 drop mid-FETCH: syncAll RESOLVES (does not throw), errors only in sync_errors; next cycle recovers with no dups/loss", async () => {
		proxy.rules.push({ match: BODY_FETCH, action: { kind: "drop", afterBytes: 20_000 }, connections: [0] });
		const t0 = Date.now();
		const r1 = await runSync(ctx, imapConfig(proxy.port));
		const ms = Date.now() - t0;
		const partial = inboxRows();
		const errs = r1.folders.flatMap((f) => f.errors.map((e) => `${e.folderPath}: ${e.message}`));
		observed.D1 = { ms, partialInboxRows: partial, errors: errs, totalErrors: r1.totalErrors };
		expect(r1.totalErrors).toBeGreaterThan(0);
		expect(partial).toBeGreaterThan(0); // messages before the drop were committed...
		expect(partial).toBeLessThan(N_INBOX);
		// ...but last_uid was NOT advanced for the interrupted batch (update happens after the loop)
		expect(count(ctx.db, "SELECT COUNT(*) n FROM sync_state")).toBe(0);
		// Remaining folders fail too: the dead connection is not re-established inside syncAll
		expect(errs.some((e) => e.startsWith("Other:"))).toBe(true);

		const r2 = await runSync(ctx, imapConfig(proxy.port));
		expect(r2.totalErrors).toBe(0);
		expect(inboxRows()).toBe(N_INBOX);
		expect(count(ctx.db, "SELECT COUNT(*) - COUNT(DISTINCT message_id) n FROM messages")).toBe(0);
		expect(count(ctx.db, "SELECT COUNT(*) n FROM messages")).toBe(N_INBOX + N_OTHER + 0);
	});

	test("D2a stall (no bytes) with Stork's DEFAULT config: sync still hung after 15s (imapflow socketTimeout default 300s); abort unblocks it", async () => {
		proxy.rules.push({ match: BODY_FETCH, action: { kind: "stall", afterBytes: 5_000 } });
		const sync = new ImapSync(imapConfig(proxy.port), ctx.db, ctx.connectorId);
		await sync.connect();
		const ac = new AbortController();
		const p = sync.syncAll(ac.signal);
		expect(await settledWithin(p, 15_000)).toBe(false);
		const t0 = Date.now();
		ac.abort();
		const res = await p;
		observed.D2a = { hungFor: ">15000ms", abortUnblockMs: Date.now() - t0, aborted: res.aborted };
		expect(res.aborted).toBe(true);
		sync.forceClose();
	}, 60_000);

	test("D2b stall with a short socketTimeout (not configurable via ImapConfig) → fails fast and is recorded", async () => {
		proxy.rules.push({ match: BODY_FETCH, action: { kind: "stall", afterBytes: 5_000 }, connections: [0] });
		const t0 = Date.now();
		const r = await runSync(ctx, imapConfig(proxy.port), { socketTimeout: 2000 });
		const errs = r.folders.flatMap((f) => f.errors.map((e) => e.message));
		observed.D2b = { ms: Date.now() - t0, errors: errs };
		expect(Date.now() - t0).toBeLessThan(30_000);
		expect(errs.length).toBeGreaterThan(0);
	}, 60_000);

	test("D2c slow-drip (1 byte / 500ms) defeats the idle socketTimeout entirely → unbounded hang", async () => {
		proxy.rules.push({ match: BODY_FETCH, action: { kind: "drip", afterBytes: 5_000, dripMs: 500 } });
		const sync = new ImapSync({ ...imapConfig(proxy.port), socketTimeout: 2000 } as never, ctx.db, ctx.connectorId);
		await sync.connect();
		const ac = new AbortController();
		const p = sync.syncAll(ac.signal);
		expect(await settledWithin(p, 12_000)).toBe(false);
		ac.abort();
		await p;
		sync.forceClose();
		observed.D2c = { hungFor: ">12000ms with socketTimeout=2000" };
	}, 60_000);

	test("D3 NO [THROTTLED] on every body FETCH: recorded as retriable but response code lost, no backoff within the cycle, nothing lost, recovers next cycle", async () => {
		proxy.rules.push({
			match: BODY_FETCH,
			action: { kind: "reply", response: (t) => `${t} NO [THROTTLED] Account exceeded bandwidth limits\r\n` },
		});
		const t0 = Date.now();
		const r1 = await runSync(ctx, imapConfig(proxy.port));
		const errs = r1.folders.flatMap((f) => f.errors);
		observed.D3 = {
			ms: Date.now() - t0,
			bodyFetchAttempts: proxy.count(BODY_FETCH),
			totalCommands: proxy.commands.length,
			errors: errs.map((e) => [e.folderPath, e.message, e.retriable]),
		};
		expect(errs.length).toBeGreaterThan(0);
		expect(errs.every((e) => e.retriable)).toBe(true);
		// The [THROTTLED] response code is DROPPED: formatImapError() only uses
		// err.responseText; imapflow keeps the code in err.response.attributes.
		expect(errs.some((e) => /THROTTLED/.test(e.message))).toBe(false);
		expect(errs[0].message).toBe("Fetch failed for INBOX: NO: Account exceeded bandwidth limits [STORK-E002]");
		// one FETCH per folder batch, no retry/backoff on throttling within the cycle
		expect(proxy.count(BODY_FETCH)).toBe(2);
		expect(count(ctx.db, "SELECT COUNT(*) n FROM sync_state")).toBe(0);
		proxy.rules = [];
		const r2 = await runSync(ctx, imapConfig(proxy.port));
		expect(r2.totalErrors).toBe(0);
		expect(inboxRows()).toBe(N_INBOX);
	});

	test("D4 untagged BYE mid-session (Gmail bandwidth/'System Error') → same as drop; error text surfaced", async () => {
		proxy.rules.push({
			match: BODY_FETCH,
			action: { kind: "reply", response: () => "* BYE [UNAVAILABLE] Temporary System Error\r\n", close: true },
			connections: [0],
		});
		const r = await runSync(ctx, imapConfig(proxy.port));
		const errs = r.folders.flatMap((f) => f.errors.map((e) => `${e.folderPath}: ${e.message}`));
		observed.D4 = { errors: errs };
		expect(errs.length).toBeGreaterThan(0);
		await runSync(ctx, imapConfig(proxy.port));
		expect(inboxRows()).toBe(N_INBOX);
	});

	test("D5 NO on SELECT of one folder → 3 SELECT attempts (1s+2s delay), folder skipped, others sync", async () => {
		proxy.rules.push({
			match: /SELECT "?Other"?/i,
			action: { kind: "reply", response: (t) => `${t} NO [LIMIT] Too many simultaneous connections\r\n` },
		});
		const t0 = Date.now();
		const r = await runSync(ctx, imapConfig(proxy.port));
		const selects = proxy.count(/(SELECT|EXAMINE) "?Other"?/i);
		const errs = r.folders.flatMap((f) => f.errors.map((e) => e.message));
		observed.D5 = { ms: Date.now() - t0, selectAttempts: selects, errors: errs };
		expect(selects).toBe(3);
		expect(inboxRows()).toBe(N_INBOX);
		expect(errs.some((e) => /LIMIT|Could not lock mailbox Other/.test(e))).toBe(true);
	});

	test("D6 wrong password: connect() retries LOGIN 3x per cycle (auth failure treated as retriable)", async () => {
		const sync = new ImapSync(imapConfig(proxy.port, "alice", "WRONG"), ctx.db, ctx.connectorId);
		const t0 = Date.now();
		let err: Error | null = null;
		try {
			await sync.connect();
		} catch (e) {
			err = e as Error;
		}
		sync.forceClose();
		observed.D6 = { ms: Date.now() - t0, authAttempts: proxy.count(AUTH), tcpConnections: proxy.connections, error: err?.message };
		expect(err).not.toBeNull();
		expect(proxy.count(AUTH)).toBe(3);
		expect(proxy.connections).toBe(3);
	}, 60_000);

	test("D7 scheduler backoff never resets after a success (interval stays at the backed-off value)", async () => {
		// first 2 cycles fail fast at LOGIN (3 attempts each) → backoff; then succeed
		proxy.rules.push({
			match: AUTH,
			action: { kind: "reply", response: (t) => `${t} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n` },
			times: 6,
		});
		const successes: number[] = [];
		const failures: number[] = [];
		const sched = new SyncScheduler(ctx.db, {
			defaultIntervalMs: 2000,
			onSyncComplete: () => successes.push(Date.now()),
			onSyncError: () => failures.push(Date.now()),
		});
		sched.addConnector({ inboundConnectorId: ctx.connectorId, imapConfig: imapConfig(proxy.port) });
		const t0 = Date.now();
		sched.start();
		const deadline = Date.now() + 40_000;
		while (successes.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
		await sched.stop();
		const gaps = successes.slice(1).map((t, i) => t - successes[i]);
		observed.D7 = {
			configuredIntervalMs: 2000,
			failuresAtMs: failures.map((t) => t - t0),
			successesAtMs: successes.map((t) => t - t0),
			gapsBetweenSuccessesMs: gaps,
		};
		expect(failures.length).toBe(2);
		expect(successes.length).toBe(3);
		// After recovery the scheduler keeps the 4000ms backoff interval instead of 2000ms
		for (const g of gaps) expect(g).toBeGreaterThan(3500);
		const status = sched.getStatus().get(ctx.connectorId);
		expect(status?.consecutiveErrors ?? 0).toBe(0);
	}, 60_000);

	test("D8 mid-sync connection loss is reported to the scheduler as SUCCESS (no backoff, lastError null)", async () => {
		proxy.rules.push({ match: BODY_FETCH, action: { kind: "drop", afterBytes: 20_000 } });
		const results: SyncAllResult[] = [];
		let errors = 0;
		const sched = new SyncScheduler(ctx.db, {
			defaultIntervalMs: 60_000,
			onSyncComplete: (_id, r) => results.push(r),
			onSyncError: () => errors++,
		});
		sched.addConnector({ inboundConnectorId: ctx.connectorId, imapConfig: imapConfig(proxy.port) });
		sched.start();
		const deadline = Date.now() + 30_000;
		while (results.length + errors < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
		const st = sched.getStatus().get(ctx.connectorId);
		await sched.stop();
		observed.D8 = { completeCallbacks: results.length, errorCallbacks: errors, totalErrors: results[0]?.totalErrors, lastError: st?.lastError };
		expect(errors).toBe(0);
		expect(results[0].totalErrors).toBeGreaterThan(0);
		expect(st?.lastError).toBeNull();
		expect(st?.consecutiveErrors).toBe(0);
	}, 60_000);
});
