/**
 * B (cont.). Per-message processing failure ("poison message").
 * Fault injection: mailparser's simpleParser is wrapped to throw for one
 * marked message (stands in for any parser/DB exception in fetchUidBatch).
 * Question: does last_uid advance past it, so it is never retried?
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { adminClient, appendTo, count, type Ctx, freshDb, resetDovecot, runSync } from "./helpers.js";

const state = vi.hoisted(() => ({ poison: true }));
vi.mock("mailparser", async (orig) => {
	const real = (await orig()) as typeof import("mailparser");
	return {
		...real,
		simpleParser: async (src: Buffer, ...rest: unknown[]) => {
			if (state.poison && Buffer.from(src).includes("X-Poison: 1")) throw new Error("injected parser failure");
			// biome-ignore lint/suspicious/noExplicitAny: passthrough
			return (real.simpleParser as any)(src, ...rest);
		},
	};
});

const mk = (s: string, extra = "") =>
	`From: p@example.com\r\nTo: me@example.com\r\nSubject: ${s}\r\nMessage-ID: <${s}@poison.example>\r\n${extra}Date: Tue, 06 Oct 2026 12:00:00 +0000\r\n\r\nbody ${s}\r\n`;

let ctx: Ctx;
describe("poison message", () => {
	beforeAll(async () => {
		await resetDovecot();
		const c = await adminClient();
		await appendTo(c, "INBOX", mk("A"));
		await appendTo(c, "INBOX", mk("POISON", "X-Poison: 1\r\n"));
		await appendTo(c, "INBOX", mk("C"));
		await c.logout();
		ctx = freshDb("Poison");
	});
	afterAll(() => ctx?.db.close());

	test("failure is recorded as non-retriable and last_uid jumps past it", async () => {
		const r = await runSync(ctx);
		const errs = r.folders.flatMap((f) => f.errors);
		expect(errs).toHaveLength(1);
		expect(errs[0]).toMatchObject({ uid: 2, errorType: "message", retriable: false });
		expect(count(ctx.db, "SELECT COUNT(*) n FROM messages")).toBe(2);
		expect(count(ctx.db, "SELECT last_uid n FROM sync_state")).toBe(3);
	});

	test("even after the cause is fixed, the message is never fetched again and the error auto-resolves", async () => {
		state.poison = false;
		const r = await runSync(ctx);
		expect(r.totalErrors).toBe(0);
		expect(count(ctx.db, "SELECT COUNT(*) n FROM messages WHERE subject = 'POISON'")).toBe(0);
		expect(count(ctx.db, "SELECT COUNT(*) n FROM sync_errors WHERE resolved = 0")).toBe(0);
	});
});
