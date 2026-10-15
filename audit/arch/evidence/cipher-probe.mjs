import Database from "/home/user/paperkite-hq/stork/node_modules/better-sqlite3-multiple-ciphers/lib/index.js";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = mkdtempSync(join(process.argv[2], "c-"));
const key = randomBytes(32);
const db = new Database(join(dir, "t.db"));
db.exec(`PRAGMA key = "x'${key.toString("hex")}'";`);
db.exec("CREATE TABLE t(x)"); db.prepare("INSERT INTO t VALUES (?)").run("hello secret");
console.log("active cipher after keying:", db.pragma("cipher", { simple: true }));
db.close();
const head = readFileSync(join(dir, "t.db")).subarray(0, 16);
console.log("first 16 bytes:", head.toString("hex"), "plaintext header?", head.toString("latin1").startsWith("SQLite format 3"));
// try opening as sqlcipher v4 with same key
const db2 = new Database(join(dir, "t.db"));
db2.pragma("cipher = 'sqlcipher'"); db2.pragma("legacy = 4");
db2.exec(`PRAGMA key = "x'${key.toString("hex")}'";`);
try { console.log("open as sqlcipher v4:", db2.prepare("select x from t").get()); } catch (e) { console.log("open as sqlcipher v4 FAILED:", e.message); }
