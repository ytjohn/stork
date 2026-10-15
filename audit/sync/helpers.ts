/**
 * Shared helpers for the sync audit. Drives the REAL ImapSync engine against a
 * REAL disposable Dovecot (audit/harness/dovecot.sh). Never touches real mail.
 *
 * "Other client" actions (flags, moves, expunges, folder ops done by e.g. a
 * phone mail app) are simulated with a separate imapflow connection, which is
 * an independent IMAP client from the server's point of view.
 */
import { execFileSync } from "node:child_process";
import net from "node:net";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { ImapFlow } from "imapflow";
import { createTestDb } from "../../src/test-helpers/test-db.js";
import { ImapSync } from "../../src/sync/imap-sync.js";

export const IMAP_PORT = 14201;
export const IMAP_BASE = "/tmp/stork-audit-imap-sync-a";
const HARNESS = resolve(__dirname, "../harness/dovecot.sh");

export const ALICE = { user: "alice", pass: "alicepass" };

export function imapConfig(user = ALICE.user, pass = ALICE.pass) {
	return { host: "127.0.0.1", port: IMAP_PORT, secure: false, auth: { user, pass } };
}

/** Wipe and restart the disposable Dovecot. */
export function resetImap(): void {
	execFileSync("bash", [HARNESS, "reset", IMAP_BASE, String(IMAP_PORT)], { stdio: "ignore" });
}

export function stopImap(): void {
	execFileSync("bash", [HARNESS, "stop", IMAP_BASE, String(IMAP_PORT)], { stdio: "ignore" });
}

/** Run fn with an independent IMAP client ("another mail client"). */
export async function withImap<T>(fn: (c: ImapFlow) => Promise<T>, user = ALICE): Promise<T> {
	const c = new ImapFlow({ ...imapConfig(user.user, user.pass), logger: false });
	c.on("error", () => {});
	await c.connect();
	try {
		return await fn(c);
	} finally {
		await c.logout().catch(() => {});
	}
}

export interface RawOpts {
	subject: string;
	messageId?: string;
	from?: string;
	to?: string;
	body?: string;
	attachments?: { filename: string; content: string }[];
}

export function rawEmail(o: RawOpts): string {
	const mid = o.messageId ?? `<${o.subject.replace(/\W+/g, "-")}-${Math.random().toString(36).slice(2)}@audit.local>`;
	const head = [
		`From: ${o.from ?? "sender@audit.local"}`,
		`To: ${o.to ?? "alice@audit.local"}`,
		`Subject: ${o.subject}`,
		`Message-ID: ${mid}`,
		"Date: Mon, 05 Oct 2026 10:00:00 +0000",
		"MIME-Version: 1.0",
	];
	if (!o.attachments?.length) {
		return [...head, "Content-Type: text/plain; charset=utf-8", "", o.body ?? `Body of ${o.subject}`, ""].join("\r\n");
	}
	const b = "AUDITBOUNDARY";
	const parts = [
		...head,
		`Content-Type: multipart/mixed; boundary="${b}"`,
		"",
		`--${b}`,
		"Content-Type: text/plain; charset=utf-8",
		"",
		o.body ?? `Body of ${o.subject}`,
	];
	for (const a of o.attachments) {
		parts.push(
			`--${b}`,
			`Content-Type: application/octet-stream; name="${a.filename}"`,
			`Content-Disposition: attachment; filename="${a.filename}"`,
			"Content-Transfer-Encoding: base64",
			"",
			Buffer.from(a.content).toString("base64"),
		);
	}
	parts.push(`--${b}--`, "");
	return parts.join("\r\n");
}

/** Append messages to a server folder; returns assigned UIDs (UIDPLUS). */
export async function appendMsgs(
	folder: string,
	msgs: (RawOpts | string)[],
	flags: string[] = [],
	user = ALICE,
): Promise<number[]> {
	return withImap(async (c) => {
		const uids: number[] = [];
		for (const m of msgs) {
			const raw = typeof m === "string" ? m : rawEmail(m);
			const r = await c.append(folder, raw, flags);
			uids.push(r && typeof r === "object" && "uid" in r ? Number(r.uid) : -1);
		}
		return uids;
	}, user);
}

export interface ServerMsg {
	uid: number;
	flags: string[];
	subject: string | undefined;
	messageId: string | undefined;
}
export type ServerSnapshot = Record<string, { uidValidity: string; messages: ServerMsg[] }>;

/** Snapshot every folder on the server (uids, flags, subject, Message-ID). */
export async function serverSnapshot(user = ALICE): Promise<ServerSnapshot> {
	return withImap(async (c) => {
		const out: ServerSnapshot = {};
		const list = await c.list();
		for (const mb of list) {
			const lock = await c.getMailboxLock(mb.path, { readOnly: true });
			try {
				const msgs: ServerMsg[] = [];
				const st = c.mailbox;
				if (st && st.exists > 0) {
					for await (const m of c.fetch("1:*", { uid: true, flags: true, envelope: true })) {
						msgs.push({
							uid: m.uid,
							flags: [...(m.flags ?? [])].sort(),
							subject: m.envelope?.subject,
							messageId: m.envelope?.messageId,
						});
					}
				}
				out[mb.path] = { uidValidity: String(st ? st.uidValidity : ""), messages: msgs };
			} finally {
				lock.release();
			}
		}
		return out;
	}, user);
}

export async function serverSubjects(folder: string, user = ALICE): Promise<string[]> {
	const snap = await serverSnapshot(user);
	return (snap[folder]?.messages ?? []).map((m) => m.subject ?? "").sort();
}

export async function serverFlags(folder: string, uid: number, user = ALICE): Promise<string[]> {
	const snap = await serverSnapshot(user);
	return snap[folder]?.messages.find((m) => m.uid === uid)?.flags ?? [];
}

/** Fresh in-memory Stork DB with one IMAP inbound connector pointing at the Dovecot. */
export function makeDb(opts: { connectorMode?: boolean; user?: typeof ALICE } = {}): {
	db: Database.Database;
	connectorId: number;
} {
	const db = createTestDb();
	const u = opts.user ?? ALICE;
	db.prepare(
		`INSERT INTO inbound_connectors (name, type, imap_host, imap_port, imap_tls, imap_user, imap_pass, sync_delete_from_server)
		 VALUES ('Audit IMAP', 'imap', '127.0.0.1', ?, 0, ?, ?, ?)`,
	).run(IMAP_PORT, u.user, u.pass, opts.connectorMode ? 1 : 0);
	const connectorId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
	return { db, connectorId };
}

export function setConnectorMode(db: Database.Database, connectorId: number, on: boolean): void {
	db.prepare("UPDATE inbound_connectors SET sync_delete_from_server = ? WHERE id = ?").run(on ? 1 : 0, connectorId);
}

export async function newSync(db: Database.Database, connectorId: number, user = ALICE): Promise<ImapSync> {
	const s = new ImapSync(imapConfig(user.user, user.pass), db, connectorId);
	await s.connect();
	return s;
}

/** One full sync cycle with a fresh connection (what the scheduler does each interval). */
export async function syncOnce(db: Database.Database, connectorId: number, signal?: AbortSignal) {
	const s = await newSync(db, connectorId);
	try {
		return await s.syncAll(signal);
	} finally {
		await s.disconnect();
	}
}

export interface LocalRow {
	id: number;
	uid: number;
	folder: string;
	subject: string;
	message_id: string | null;
	flags: string;
	deleted_from_server: number;
	pending_archive: number;
}

export function localRows(db: Database.Database): LocalRow[] {
	return db
		.prepare(
			`SELECT m.id, m.uid, f.path AS folder, m.subject, m.message_id, m.flags,
			        m.deleted_from_server, m.pending_archive
			 FROM messages m JOIN folders f ON f.id = m.folder_id ORDER BY f.path, m.uid`,
		)
		.all() as LocalRow[];
}

export function localSubjects(db: Database.Database, folder?: string): string[] {
	return localRows(db)
		.filter((r) => folder === undefined || r.folder === folder)
		.map((r) => r.subject)
		.sort();
}

export function rowBySubject(db: Database.Database, subject: string): LocalRow | undefined {
	return localRows(db).find((r) => r.subject === subject);
}

export function folderId(db: Database.Database, path: string): number {
	return (db.prepare("SELECT id FROM folders WHERE path = ? AND inbound_connector_id IS NOT NULL").get(path) as { id: number }).id;
}

export function lastUid(db: Database.Database, path: string): number | undefined {
	const r = db
		.prepare("SELECT s.last_uid FROM sync_state s JOIN folders f ON f.id = s.folder_id WHERE f.path = ?")
		.get(path) as { last_uid: number } | undefined;
	return r?.last_uid;
}

export function labelsOf(db: Database.Database, messageRowId: number): string[] {
	return (
		db
			.prepare(
				"SELECT l.name FROM labels l JOIN message_labels ml ON ml.label_id = l.id WHERE ml.message_id = ? ORDER BY l.name",
			)
			.all(messageRowId) as { name: string }[]
	).map((r) => r.name);
}

export function addUserLabel(db: Database.Database, messageRowId: number, name: string): number {
	db.prepare("INSERT OR IGNORE INTO labels (name, source) VALUES (?, 'user')").run(name);
	const id = (db.prepare("SELECT id FROM labels WHERE name = ?").get(name) as { id: number }).id;
	db.prepare("INSERT OR IGNORE INTO message_labels (message_id, label_id, date) VALUES (?, ?, NULL)").run(
		messageRowId,
		id,
	);
	return id;
}

/** Maildir directory for a folder of a harness user. */
export function maildirDir(folder: string, user = ALICE.user): string {
	const root = join(IMAP_BASE, "mail", user, "Maildir");
	return folder === "INBOX" ? root : join(root, `.${folder.replace(/\//g, ".")}`);
}

/** Find the maildir file containing `needle` (e.g. a Subject) in a folder. */
export function findMaildirFile(folder: string, needle: string, user = ALICE.user): string | undefined {
	const dir = maildirDir(folder, user);
	for (const sub of ["cur", "new"]) {
		const d = join(dir, sub);
		if (!existsSync(d)) continue;
		for (const f of readdirSync(d)) {
			const p = join(d, f);
			if (readFileSync(p, "utf8").includes(needle)) return p;
		}
	}
	return undefined;
}

/** Number of successful IMAP logins for a user recorded in the Dovecot log. */
export function dovecotLoginCount(user = ALICE.user): number {
	const log = join(IMAP_BASE, "dovecot.log");
	if (!existsSync(log)) return 0;
	return readFileSync(log, "utf8")
		.split("\n")
		.filter((l) => l.includes("imap-login: Login:") && l.includes(`user=<${user}>`)).length;
}

/** JSON request helper for Hono route objects. */
export async function call(
	app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; json: unknown }> {
	const res = await app.request(path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let json: unknown = null;
	try {
		json = await res.json();
	} catch {
		json = null;
	}
	return { status: res.status, json };
}

/**
 * Fault-injecting IMAP proxy in front of the Dovecot. Listens on an ephemeral
 * port. When `partialFetch` is armed, the next client `UID FETCH` that asks for
 * message bodies (BODY.PEEK[]) is rewritten to request only the FIRST UID of
 * the set, and the server's tagged OK is turned into NO. This reproduces a
 * server that returns part of a batch and then fails the command (e.g. Gmail's
 * "NO Some messages could not be FETCHed"), while keeping the connection alive.
 */


export interface FaultProxy {
	port: number;
	/** Arm a one-shot partial-fetch fault. mode "no" = tagged NO, "ok" = silent omission. */
	armPartialFetch(mode: "no" | "ok"): void;
	faultsFired: number;
	/** Every client command line seen (tag stripped), e.g. "UID FETCH 1:3 (...)". */
	commands: string[];
	close(): Promise<void>;
}

/** Distinct IMAP command verbs (e.g. "UID FETCH", "SELECT") from a proxy log. */
export function commandVerbs(commands: string[]): string[] {
	const v = new Set<string>();
	for (const c of commands) {
		const parts = c.split(" ");
		const verb = parts[0].toUpperCase() === "UID" ? `UID ${parts[1]?.toUpperCase()}` : parts[0].toUpperCase();
		if (/^[A-Z]+( [A-Z]+)?$/.test(verb)) v.add(verb);
	}
	return [...v].sort();
}

export const IMAP_WRITE_VERBS = [
	"APPEND", "COPY", "CREATE", "DELETE", "EXPUNGE", "MOVE", "RENAME", "STORE",
	"SUBSCRIBE", "UNSUBSCRIBE", "UID COPY", "UID EXPUNGE", "UID MOVE", "UID STORE", "SETMETADATA", "SETACL",
];

export async function startFaultProxy(): Promise<FaultProxy> {
	let armed: "no" | "ok" | null = null;
	const sockets = new Set<net.Socket>();
	const state: FaultProxy = {
		port: 0,
		faultsFired: 0,
		commands: [],
		armPartialFetch(mode) {
			armed = mode;
		},
		close: () =>
			new Promise<void>((res) => {
				for (const s of sockets) s.destroy();
				server.close(() => res());
			}),
	};
	const server = net.createServer((client) => {
		sockets.add(client);
		const upstream = net.connect(IMAP_PORT, "127.0.0.1");
		sockets.add(upstream);
		let faultTag: string | null = null;
		let clientBuf = "";
		let serverTail = "";
		client.on("data", (chunk) => {
			clientBuf += chunk.toString("latin1");
			let idx: number;
			// biome-ignore lint: loop on line boundaries
			while ((idx = clientBuf.indexOf("\r\n")) >= 0) {
				let line = clientBuf.slice(0, idx + 2);
				clientBuf = clientBuf.slice(idx + 2);
				const cmd = /^\S+ ([A-Z]+(?: [A-Z]+)?)/i.exec(line);
				if (cmd) state.commands.push(line.replace(/^\S+ /, "").trim());
				const m = /^(\S+) UID FETCH (\S+) (.*(?:BODY|BINARY)\.PEEK\[\].*)$/is.exec(line);
				if (armed && m) {
					const first = m[2].split(/[,:]/)[0];
					line = `${m[1]} UID FETCH ${first} ${m[3]}`;
					if (armed === "no") faultTag = m[1];
					armed = null;
					state.faultsFired++;
				}
				upstream.write(Buffer.from(line, "latin1"));
			}
		});
		upstream.on("data", (chunk) => {
			if (!faultTag) {
				client.write(chunk);
				return;
			}
			let s = serverTail + chunk.toString("latin1");
			const needle = `\r\n${faultTag} OK `;
			if (s.includes(needle) || s.startsWith(`${faultTag} OK `)) {
				s = s.replace(needle, `\r\n${faultTag} NO [SERVERBUG] Some messages could not be FETCHed (simulated) `);
				if (s.startsWith(`${faultTag} OK `)) s = s.replace(`${faultTag} OK `, `${faultTag} NO [SERVERBUG] simulated `);
				faultTag = null;
				serverTail = "";
				client.write(Buffer.from(s, "latin1"));
				return;
			}
			// keep a small tail in case the needle straddles chunks
			const keep = 64;
			const out = s.slice(0, Math.max(0, s.length - keep));
			serverTail = s.slice(out.length);
			if (out) client.write(Buffer.from(out, "latin1"));
		});
		const end = () => {
			client.destroy();
			upstream.destroy();
		};
		client.on("error", end);
		upstream.on("error", end);
		client.on("close", end);
		upstream.on("close", end);
	});
	await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
	state.port = (server.address() as net.AddressInfo).port;
	return state;
}

/** Point the connector row (used by API routes / scheduler) at a different port. */
export function setConnectorPort(db: Database.Database, connectorId: number, port: number): void {
	db.prepare("UPDATE inbound_connectors SET imap_port = ? WHERE id = ?").run(port, connectorId);
}

export async function newSyncOnPort(db: Database.Database, connectorId: number, port: number): Promise<ImapSync> {
	const s = new ImapSync({ ...imapConfig(), port }, db, connectorId);
	await s.connect();
	return s;
}

/** Subjects of messages physically present in a maildir folder (read as root, bypasses IMAP). */
export function maildirSubjects(folder: string, user = ALICE.user): string[] {
	const dir = maildirDir(folder, user);
	const out: string[] = [];
	for (const sub of ["cur", "new"]) {
		const d = join(dir, sub);
		if (!existsSync(d)) continue;
		for (const f of readdirSync(d)) {
			const m = /^Subject: (.*)$/m.exec(readFileSync(join(d, f), "utf8"));
			out.push(m ? m[1].trim() : "");
		}
	}
	return out.sort();
}
