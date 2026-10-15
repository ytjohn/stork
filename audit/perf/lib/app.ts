import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { createApp } from "../../../src/api/server.js";
import type { ContainerContext } from "../../../src/crypto/lifecycle.js";
import { openDatabase } from "../../../src/storage/db.js";
import { WORK, vaultKey } from "./env.js";

export interface Manifest {
	n: number;
	seed: number;
	dir: string;
	connectorId: number;
	folderIds: Record<string, number>;
	labels: { id: number; name: string; source: string; message_count: number; unread_count: number }[];
	longThreadIds: Record<string, number[]>;
	expected: Record<string, number>;
}

/** Resolve a DB directory from --db <dir> or --size <label> (db-bulk-<label>, or db-imap-<label>). */
export function resolveDbDir(size?: string, db?: string): string {
	if (db) return db;
	for (const d of [`db-bulk-${size}`, `db-imap-${size}`]) if (existsSync(join(WORK, d, "stork.db"))) return join(WORK, d);
	throw new Error(`no DB for size ${size} under ${WORK}; run build-db.ts / bench-sync.ts --keep first`);
}

export function openBenchDb(dir: string): Database.Database {
	return openDatabase("stork.db", dir, vaultKey());
}

/** Manifest for bulk DBs; for IMAP-synced DBs derive the same info from the DB itself. */
export function loadManifest(dir: string, db: Database.Database): Manifest {
	const p = join(dir, "manifest.json");
	if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
	const n = (db.prepare("SELECT COUNT(*) n FROM messages").get() as { n: number }).n;
	const labels = db.prepare("SELECT id, name, source, message_count, unread_count FROM labels").all() as Manifest["labels"];
	const longThreadIds: Record<string, number[]> = {};
	const rows = db.prepare("SELECT id, subject FROM messages WHERE subject LIKE '%planning thread' ORDER BY date").all() as { id: number; subject: string }[];
	for (const r of rows) (longThreadIds[r.subject.replace(/^Re: /, "")] ??= []).push(r.id);
	return { n, seed: 1, dir, connectorId: 1, folderIds: {}, labels, longThreadIds, expected: {} };
}

export function makeApp(db: Database.Database, dataDir: string) {
	const context: ContainerContext = { state: "unlocked", dataDir, db, scheduler: null, r2Poller: null, _vaultKeyInMemory: null };
	return createApp(context).app;
}
