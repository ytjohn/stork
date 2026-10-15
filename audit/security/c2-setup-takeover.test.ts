/**
 * C2 — Pre-setup takeover. An un-provisioned instance accepts the FIRST
 * /api/setup, which chooses the password, unlocks the container, and returns
 * the recovery mnemonic. Whoever reaches a freshly deployed instance first
 * owns it; the legitimate operator is locked out. /api/status leaks that an
 * instance is still in "setup", so the window is discoverable.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/server.js";
import type { ContainerContext } from "../../src/crypto/lifecycle.js";
import { tempDataDir } from "./helpers.js";

describe("C2: first-setup-wins takeover", () => {
	let ctx: ContainerContext | null = null;
	afterEach(async () => {
		try { await ctx?.scheduler?.stop(); } catch {}
		try { await ctx?.r2Poller?.stop(); } catch {}
		try { ctx?.db?.close(); } catch {}
		ctx = null;
	});

	it("leaks setup state and lets the first caller claim the instance", async () => {
		ctx = {
			state: "setup", dataDir: tempDataDir(), db: null,
			scheduler: null, r2Poller: null, _vaultKeyInMemory: null,
		};
		const { app } = createApp(ctx);

		// Anyone can probe that the instance is unclaimed.
		const status = await app.request("/api/status");
		expect(await status.json()).toEqual({ state: "setup" });

		// Attacker wins the race.
		const first = await app.request("/api/setup", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "attacker-password-123" }),
		});
		expect(first.status).toBe(201);
		const body = (await first.json()) as { recoveryMnemonic: string };
		expect(body.recoveryMnemonic.split(" ").length).toBe(24); // attacker gets recovery key
		expect(ctx.state).toBe("unlocked");

		// Legitimate operator now gets 409 — cannot set their own password.
		const second = await app.request("/api/setup", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "legit-operator-pass-9" }),
		});
		expect(second.status).toBe(409);
	});
});
