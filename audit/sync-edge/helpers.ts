/**
 * Shared helpers for the sync-edge audit. Drives the REAL ImapSync against a
 * disposable Dovecot (audit/harness/dovecot.sh) — never real accounts.
 */
import { execFileSync } from "node:child_process";
import { chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { ImapFlow } from "imapflow";
import { createTestDb, createTestInboundConnector } from "../../src/test-helpers/test-db.js";
import { type ImapConfig, ImapSync, type SyncAllResult } from "../../src/sync/imap-sync.js";

export const PORT = 14202;
export const BASE = "/tmp/stork-audit-imap-sync-b";
const HARNESS = join(__dirname, "..", "harness", "dovecot.sh");

export interface DovecotVariant {
	/** Hierarchy separator for the inbox namespace (default "/") */
	separator?: string;
	/** Namespace prefix, e.g. "INBOX." for Courier-style servers */
	prefix?: string;
	/** Keep the harness' special_use mailboxes (Sent/Trash/Archive). Default true. */
	specialUse?: boolean;
	/** Override advertised capabilities (drops SPECIAL-USE etc.) */
	capability?: string;
	/** Explicit mailbox list (auto-created, optional special_use); replaces the defaults. */
	mailboxes?: { name: string; specialUse?: string }[];
}

function waitPort(port: number, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const attempt = () => {
			const s = netConnect(port, "127.0.0.1");
			s.once("connect", () => {
				s.destroy();
				resolve();
			});
			s.once("error", () => {
				s.destroy();
				if (Date.now() > deadline) reject(new Error(`port ${port} not up`));
				else setTimeout(attempt, 100);
			});
		};
		attempt();
	});
}

/** Fresh Dovecot instance on PORT (wipes all mail). Optionally rewrite the namespace. */
export async function resetDovecot(variant?: DovecotVariant): Promise<void> {
	execFileSync("bash", [HARNESS, "reset", BASE, String(PORT)], { stdio: "ignore" });
	if (!variant) return;
	const conf = join(BASE, "dovecot.conf");
	let text = readFileSync(conf, "utf8");
	const sep = variant.separator ?? "/";
	const nsLines = [`namespace inbox {`, `  inbox = yes`, `  separator = ${sep}`];
	if (variant.prefix) nsLines.push(`  prefix = ${variant.prefix}`);
	if (variant.mailboxes) {
		for (const m of variant.mailboxes) {
			nsLines.push(
				`  mailbox "${m.name}" {\n${m.specialUse ? `    special_use = ${m.specialUse}\n` : ""}    auto = subscribe\n  }`,
			);
		}
	} else if (variant.specialUse !== false) {
		const p = variant.prefix ?? "";
		nsLines.push(
			`  mailbox "${p}Sent" {\n    special_use = \\Sent\n    auto = create\n  }`,
			`  mailbox "${p}Trash" {\n    special_use = \\Trash\n    auto = create\n  }`,
		);
	}
	nsLines.push("}");
	text = text.replace(/namespace inbox \{[\s\S]*$/, `${nsLines.join("\n")}\n`);
	if (variant.capability) text += `protocol imap {\n  imap_capability = ${variant.capability}\n}\n`;
	writeFileSync(conf, text);
	execFileSync("doveadm", ["-c", conf, "stop"], { stdio: "ignore" });
	// wait for the old master to exit before starting again
	for (let i = 0; i < 50; i++) {
		try {
			execFileSync("bash", ["-c", `exec 3<>/dev/tcp/127.0.0.1/${PORT}`], { stdio: "ignore" });
			await new Promise((r) => setTimeout(r, 100));
		} catch {
			break;
		}
	}
	execFileSync("dovecot", ["-c", conf], { stdio: "ignore" });
	await waitPort(PORT);
}

export function imapConfig(port = PORT, user = "alice", pass = "alicepass"): ImapConfig {
	return { host: "127.0.0.1", port, secure: false, auth: { user, pass } };
}

/** A plain admin client used to seed/mutate the server (not Stork code). */
export async function adminClient(user = "alice", pass = "alicepass"): Promise<ImapFlow> {
	const c = new ImapFlow({ ...imapConfig(PORT, user, pass), logger: false });
	c.on("error", () => {});
	await c.connect();
	return c;
}

export async function ensureMailbox(c: ImapFlow, path: string): Promise<void> {
	try {
		await c.mailboxCreate(path);
	} catch {
		/* exists */
	}
}

export async function appendTo(
	c: ImapFlow,
	path: string,
	raw: string | Buffer,
	flags: string[] = [],
): Promise<number | undefined> {
	await ensureMailbox(c, path);
	const r = await c.append(path, raw, flags);
	return r && typeof r === "object" ? (r as { uid?: number }).uid : undefined;
}

/**
 * Drops a raw message file straight into the Maildir, bypassing APPEND
 * validation (Dovecot rejects NUL bytes etc. on APPEND, but a real server can
 * still hold such messages if they arrived by SMTP/LMTP). Dovecot indexes it
 * on the next SELECT.
 */
let maildirSeq = 0;
export function dropIntoMaildir(raw: Buffer | string, user = "alice", folderDir = ""): void {
	const root = join(BASE, "mail", user, "Maildir", folderDir);
	for (const d of ["new", "cur", "tmp"]) mkdirSync(join(root, d), { recursive: true });
	const name = `${Date.now()}.M${process.pid}P${++maildirSeq}.stork-audit`;
	const path = join(root, "new", name);
	writeFileSync(path, raw);
	const owner = ownerIds();
	if (owner) {
		chownSync(path, owner.uid, owner.gid);
		for (const d of ["", "new", "cur", "tmp"]) chownSync(join(root, d), owner.uid, owner.gid);
	}
}

function ownerIds(): { uid: number; gid: number } | null {
	if (process.getuid?.() !== 0) return null;
	const users = readFileSync(join(BASE, "users"), "utf8").split("\n")[0].split(":");
	return { uid: Number(users[2]), gid: Number(users[3]) };
}

export interface Ctx {
	db: Database.Database;
	connectorId: number;
}

export function freshDb(name = "Audit Gmail"): Ctx {
	const db = createTestDb();
	const connectorId = createTestInboundConnector(db, {
		name,
		imapHost: "127.0.0.1",
		imapPort: PORT,
		imapUser: "alice",
		imapPass: "alicepass",
	});
	return { db, connectorId };
}

/** Runs one full ImapSync.syncAll() cycle exactly as the scheduler would. */
export async function runSync(
	ctx: Ctx,
	cfg: ImapConfig = imapConfig(),
	extraFlowOpts: Record<string, unknown> = {},
): Promise<SyncAllResult> {
	const sync = new ImapSync({ ...cfg, ...extraFlowOpts } as ImapConfig, ctx.db, ctx.connectorId);
	await sync.connect();
	try {
		return await sync.syncAll();
	} finally {
		await sync.disconnect();
		sync.forceClose();
	}
}

export function count(db: Database.Database, sql: string, ...params: unknown[]): number {
	return (db.prepare(sql).get(...params) as { n: number }).n;
}

export function exists(p: string): boolean {
	return existsSync(p);
}
