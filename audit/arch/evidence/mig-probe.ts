import { createTestDb } from "/home/user/paperkite-hq/stork/src/test-helpers/test-db.ts";
import { ensureSchema } from "/home/user/paperkite-hq/stork/src/storage/db.ts";
import { SCHEMA_VERSION } from "/home/user/paperkite-hq/stork/src/storage/schema.ts";
for (const v of [12, 16, 20, 24, 27, 29]) {
  const db = createTestDb(); // fully migrated to SCHEMA_VERSION
  // Simulate: process killed after later migrations applied, but before the single final version bump
  db.prepare("UPDATE schema_version SET version = ?").run(v);
  try { ensureSchema(db); console.log(`version ${v} -> re-run OK, now`, (db.prepare("select version from schema_version").get() as any).version); }
  catch (e) { console.log(`version ${v} -> re-run FAILS: ${(e as Error).message}`); }
}
console.log("SCHEMA_VERSION", SCHEMA_VERSION);
