/**
 * Fault-injecting TCP proxy between Stork (imapflow) and Dovecot.
 *
 * Client→server traffic is split into lines so commands can be matched by
 * regex. A matching rule can:
 *   - reply itself with a tagged/untagged response (NO [THROTTLED], BAD, BYE)
 *   - forward the command and then sabotage the server's reply stream:
 *       drop  — destroy both sockets after N reply bytes
 *       stall — stop relaying reply bytes after N bytes (socket stays open)
 *       drip  — relay reply bytes one at a time every `dripMs`
 */
import { createServer, type Server, type Socket, connect } from "node:net";

export type FaultAction =
	| { kind: "reply"; response: (tag: string) => string; close?: boolean }
	| { kind: "drop"; afterBytes: number }
	| { kind: "stall"; afterBytes: number }
	| { kind: "drip"; afterBytes: number; dripMs: number };

export interface FaultRule {
	match: RegExp;
	action: FaultAction;
	/** Only apply on these connection indexes (0-based). Default: all */
	connections?: number[];
	/** Max times this rule fires (default unlimited) */
	times?: number;
	fired?: number;
}

export class FaultProxy {
	private server: Server;
	port = 0;
	rules: FaultRule[] = [];
	connections = 0;
	/** every client command line seen (tag stripped of literal payloads) */
	commands: { conn: number; at: number; line: string }[] = [];
	private sockets = new Set<Socket>();

	constructor(private targetPort: number) {
		this.server = createServer((client) => this.handle(client));
	}

	async start(): Promise<number> {
		await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
		const a = this.server.address();
		this.port = typeof a === "object" && a ? a.port : 0;
		return this.port;
	}

	async stop(): Promise<void> {
		for (const s of this.sockets) s.destroy();
		await new Promise<void>((r) => this.server.close(() => r()));
	}

	count(re: RegExp): number {
		return this.commands.filter((c) => re.test(c.line)).length;
	}

	private handle(client: Socket): void {
		const connIdx = this.connections++;
		const upstream = connect(this.targetPort, "127.0.0.1");
		this.sockets.add(client);
		this.sockets.add(upstream);
		const kill = () => {
			client.destroy();
			upstream.destroy();
		};
		client.on("error", kill);
		upstream.on("error", kill);
		client.on("close", kill);
		upstream.on("close", kill);

		// server → client sabotage state
		let mode: FaultAction | null = null;
		let budget = 0;
		const dripQueue: Buffer[] = [];
		let dripTimer: NodeJS.Timeout | null = null;

		upstream.on("data", (chunk: Buffer) => {
			if (!mode || mode.kind === "reply") {
				client.write(chunk);
				return;
			}
			if (budget > 0) {
				const pass = chunk.subarray(0, budget);
				client.write(pass);
				budget -= pass.length;
				chunk = chunk.subarray(pass.length);
				if (chunk.length === 0) return;
			}
			if (mode.kind === "drop") {
				kill();
				return;
			}
			if (mode.kind === "stall") return; // swallow forever
			if (mode.kind === "drip") {
				dripQueue.push(chunk);
				if (!dripTimer) {
					const ms = mode.dripMs;
					dripTimer = setInterval(() => {
						const head = dripQueue[0];
						if (!head) return;
						client.write(head.subarray(0, 1));
						if (head.length > 1) dripQueue[0] = head.subarray(1);
						else dripQueue.shift();
					}, ms);
					client.once("close", () => dripTimer && clearInterval(dripTimer));
				}
			}
		});

		let pending = "";
		client.on("data", (chunk: Buffer) => {
			pending += chunk.toString("binary");
			let idx: number;
			while ((idx = pending.indexOf("\r\n")) !== -1) {
				const line = pending.slice(0, idx);
				pending = pending.slice(idx + 2);
				this.commands.push({ conn: connIdx, at: Date.now(), line });
				const rule = this.rules.find(
					(r) =>
						r.match.test(line) &&
						(!r.connections || r.connections.includes(connIdx)) &&
						(r.times === undefined || (r.fired ?? 0) < r.times),
				);
				if (rule) {
					rule.fired = (rule.fired ?? 0) + 1;
					const tag = line.split(" ")[0];
					if (rule.action.kind === "reply") {
						client.write(rule.action.response(tag));
						if (rule.action.close) setTimeout(kill, 20);
						continue; // do not forward
					}
					mode = rule.action;
					budget = rule.action.afterBytes;
				}
				upstream.write(`${line}\r\n`, "binary");
			}
		});
	}
}
