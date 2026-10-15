/**
 * Child-process helper for the KDF audit (M2/M4). Run via tsx with/without
 * STORK_FAST_KDF so we can produce keys files at different Argon2id params in
 * the same test run.
 *
 *   tsx kdf-runner.ts init     <dir> <password>
 *   tsx kdf-runner.ts change   <dir> <oldPassword> <newPassword>
 *   tsx kdf-runner.ts unlock   <dir> <password>
 *   tsx kdf-runner.ts timeunlock <dir> <wrongPassword>   # prints KDF wall-clock ms
 *
 * Exit code 0 = success; non-zero = the operation threw (e.g. lockout).
 */
import {
	changePassword,
	initializeEncryption,
	unlockWithPassword,
} from "../../src/crypto/keys.js";

const [, , mode, dir, a, b] = process.argv;

try {
	if (mode === "init") {
		const mnemonic = initializeEncryption(dir, a);
		process.stdout.write(JSON.stringify({ ok: true, words: mnemonic.split(" ").length }));
	} else if (mode === "change") {
		changePassword(dir, a, b);
		process.stdout.write(JSON.stringify({ ok: true }));
	} else if (mode === "unlock") {
		const vk = unlockWithPassword(dir, a);
		process.stdout.write(JSON.stringify({ ok: true, len: vk.length }));
	} else if (mode === "timeunlock") {
		const t0 = performance.now();
		try { unlockWithPassword(dir, a); } catch { /* wrong pw still runs full KDF */ }
		const ms = performance.now() - t0;
		process.stdout.write(JSON.stringify({ ok: true, ms }));
	} else {
		throw new Error(`unknown mode ${mode}`);
	}
	process.exit(0);
} catch (e) {
	process.stdout.write(JSON.stringify({ ok: false, error: (e as Error).message }));
	process.exit(3);
}
