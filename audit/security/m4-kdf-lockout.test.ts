/**
 * M4 — STORK_FAST_KDF persists into the keys file, and changePassword /
 * setPasswordFromVaultKey rewrap the vault key with the module-level Argon2id
 * params while only updating the salt — never memoryCost/timeCost. If a keys
 * file is ever created under FAST_KDF (m=1024,t=1) and the password is later
 * changed on a normal (prod) process (KEK derived at m=65536,t=3), the stored
 * kdf params still say m=1024, so the NEXT unlock derives the KEK at the wrong
 * cost and GCM unwrap fails — a permanent lockout with the correct password.
 *
 * Reproduced across real child processes toggling STORK_FAST_KDF.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDataDir } from "./helpers.js";

const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
const runner = join(process.cwd(), "audit", "security", "kdf-runner.ts");

function run(
	mode: string, dir: string, args: string[], fast: boolean,
): { code: number; out: Record<string, unknown> } {
	const env = { ...process.env } as Record<string, string>;
	if (fast) env.STORK_FAST_KDF = "1";
	else delete env.STORK_FAST_KDF;
	try {
		const out = execFileSync(tsx, [runner, mode, dir, ...args], { env, encoding: "utf8" });
		return { code: 0, out: JSON.parse(out || "{}") };
	} catch (e) {
		const err = e as { status?: number; stdout?: string };
		let parsed: Record<string, unknown> = {};
		try { parsed = JSON.parse(err.stdout || "{}"); } catch {}
		return { code: err.status ?? 1, out: parsed };
	}
}

describe("M4: KDF param drift lockout", () => {
	it("FAST-created file keeps weak params and locks out after a prod password change", () => {
		const dir = tempDataDir();

		// 1. Setup under STORK_FAST_KDF=1 (the exact condition of the audit test
		//    env, and of any CI-built image that inherits the flag).
		const init = run("init", dir, ["correct horse battery staple!!"], true);
		expect(init.out.ok).toBe(true);

		const keysV1 = JSON.parse(readFileSync(join(dir, "stork.keys"), "utf8"));
		expect(keysV1.kdf.memoryCost).toBe(1024); // weak params persisted to disk
		expect(keysV1.kdf.timeCost).toBe(1);

		// 2. Operator changes password on a normal (prod) process — no FAST flag.
		const change = run("change", dir, ["correct horse battery staple!!", "brand-new-password-2026"], false);
		expect(change.out.ok).toBe(true);

		// Smoking gun: the stored kdf params were NOT upgraded by changePassword...
		const keysV2 = JSON.parse(readFileSync(join(dir, "stork.keys"), "utf8"));
		expect(keysV2.kdf.memoryCost).toBe(1024);
		expect(keysV2.kdf.timeCost).toBe(1);
		// ...yet the new KEK was derived at prod cost (m=65536,t=3). Mismatch.

		// 3. Unlock with the CORRECT new password on the prod process → fails.
		const unlock = run("unlock", dir, ["brand-new-password-2026"], false);
		expect(unlock.out.ok).toBe(false);
		expect(String(unlock.out.error)).toMatch(/Decryption failed/);
		expect(unlock.code).toBe(3); // locked out with the right password
	});
});
