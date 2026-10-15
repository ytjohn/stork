import { defineConfig } from "vitest/config";

// Audit-only test config. Kept separate from the app's vitest.config.ts so the
// audit never changes what upstream CI runs.
//   npx vitest run --config audit/vitest.config.ts            # everything
//   npx vitest run --config audit/vitest.config.ts audit/sync  # one phase
export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 120000,
		hookTimeout: 120000,
		include: ["audit/**/*.test.ts"],
		// Dovecot-backed tests share fixed ports per file; run files serially.
		fileParallelism: false,
		env: { STORK_FAST_KDF: "1" },
	},
	resolve: { conditions: ["node", "import", "default"] },
});
