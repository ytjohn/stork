/**
 * Child process for the SIGKILL-mid-sync test (fetch-failures.test.ts).
 * Opens a real file-backed Stork DB via openDatabase() (unencrypted for the
 * test) and runs one sync cycle. The parent kills it with SIGKILL mid-way.
 * Usage: tsx audit/sync/kill-child.ts <dataDir> <connectorId> <port>
 */
import { openDatabase } from "../../src/storage/db.js";
import { ImapSync } from "../../src/sync/imap-sync.js";

const [dataDir, connectorId, port] = process.argv.slice(2);
const db = openDatabase("kill.db", dataDir);
const s = new ImapSync(
	{ host: "127.0.0.1", port: Number(port), secure: false, auth: { user: "alice", pass: "alicepass" } },
	db,
	Number(connectorId),
);
await s.connect();
process.stdout.write("SYNCING\n");
await s.syncAll();
await s.disconnect();
process.stdout.write("DONE\n");
