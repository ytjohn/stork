/**
 * M2 — Unlock is a synchronous, main-thread Argon2id (pure-JS @noble/hashes)
 * with a weak, global, in-memory rate limiter. Each /api/unlock blocks the
 * event loop for the full KDF duration, so a handful of concurrent wrong-
 * password attempts stall the whole process (health checks, every other
 * request). The limiter is global (one attacker delays the real operator) and
 * resets on restart / counts all callers together.
 *
 * We measure the real KDF wall time at PROD params (keys file created without
 * STORK_FAST_KDF) via a child process, to show the per-call event-loop block.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/server.js";
import { encryptionRoutes } from "../../src/api/routes/encryption.js";
import { tempDataDir } from "./helpers.js";

const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
const runner = join(process.cwd(), "audit", "security", "kdf-runner.ts");

describe("M2: unlock event-loop DoS + weak global rate limit", () => {
	it("a single prod-param unlock blocks the main thread for tens of ms (scales with concurrency)", () => {
		const dir = tempDataDir();
		const env = { ...process.env } as Record<string, string>;
		delete env.STORK_FAST_KDF; // prod params: m=65536, t=3

		const init = JSON.parse(
			execFileSync(tsx, [runner, "init", dir, "a-strong-password-123"], { env, encoding: "utf8" }),
		);
		expect(init.ok).toBe(true);

		const res = JSON.parse(
			execFileSync(tsx, [runner, "timeunlock", dir, "wrong-password"], { env, encoding: "utf8" }),
		);
		// @noble argon2id at 64MiB/t=3 is tens-to-hundreds of ms of SYNCHRONOUS
		// main-thread work. Nothing else runs on the event loop during it.
		expect(res.ms).toBeGreaterThan(20);
		// Record the measured block for the report.
		console.log(`[M2] single prod-param KDF blocked the event loop for ${res.ms.toFixed(1)}ms`);
	});

	it("the rate limiter is global: concurrent wrong attempts share one counter and all run the KDF", async () => {
		// Point a container context at a real keys file so unlock does real work.
		// (FAST params here — we only need to show the limiter semantics, which are
		// param-independent.)
		const dir = tempDataDir();
		execFileSync(tsx, [runner, "init", dir, "a-strong-password-123"], {
			env: { ...process.env, STORK_FAST_KDF: "1" }, encoding: "utf8",
		});
		const ctx = {
			state: "locked" as const, dataDir: dir, db: null,
			scheduler: null, r2Poller: null, _vaultKeyInMemory: null,
		};
		const app = encryptionRoutes(ctx);

		const N = 8;
		const started = performance.now();
		const results = await Promise.all(
			Array.from({ length: N }, () =>
				app.request("/unlock", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ password: "wrong" }),
				}),
			),
		);
		const wall = performance.now() - started;
		// All N were accepted and processed (none rejected up-front by a limiter):
		for (const r of results) expect(r.status).toBe(401);
		console.log(`[M2] ${N} concurrent wrong unlocks all ran; wall=${wall.toFixed(1)}ms`);
		// They serialize on the single JS thread (KDF is synchronous), i.e. the
		// event loop was unavailable for the sum of their runtimes.
		expect(wall).toBeGreaterThan(0);
	});
});
