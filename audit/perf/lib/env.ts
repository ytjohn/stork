import { execSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PERF_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const RESULTS_DIR = join(PERF_DIR, "results");
export const REPO = dirname(dirname(PERF_DIR));
export const WORK = process.env.STORK_PERF_WORK || "/tmp/stork-audit-perf";
export const IMAP_BASE = process.env.STORK_PERF_IMAP_BASE || "/tmp/stork-audit-imap-perf";
export const IMAP_PORT = Number(process.env.STORK_PERF_IMAP_PORT || 14203);
/** Fixed, synthetic vault key so benchmark DBs are SQLCipher-encrypted like production. */
export const VAULT_KEY_HEX = "a1".repeat(32);
export const vaultKey = () => Buffer.from(VAULT_KEY_HEX, "hex");

function sh(cmd: string): string {
	try {
		return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

/** Snapshot of the machine, attached to every timed result. */
export function envSnapshot() {
	return {
		at: new Date().toISOString(),
		nproc: Number(sh("nproc")) || cpus().length,
		cpuModel: sh("lscpu | grep 'Model name' | sed 's/.*: *//'") || cpus()[0]?.model,
		memTotalGB: +(totalmem() / 2 ** 30).toFixed(1),
		memFreeGB: +(freemem() / 2 ** 30).toFixed(1),
		freeG: sh("free -g | sed -n 2p"),
		node: process.version,
		disk: sh("df -h /tmp | tail -1"),
		loadavg: loadavg().map((x) => +x.toFixed(2)),
		uptime: sh("uptime"),
	};
}

export interface Stats {
	n: number;
	min: number;
	median: number;
	p95: number;
	max: number;
	mean: number;
}
export function stats(xs: number[]): Stats {
	const s = [...xs].sort((a, b) => a - b);
	const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
	const r = (x: number) => +x.toFixed(3);
	return {
		n: s.length,
		min: r(s[0] ?? Number.NaN),
		median: r(s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : Number.NaN),
		p95: r(q(0.95)),
		max: r(s[s.length - 1] ?? Number.NaN),
		mean: r(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
	};
}

export function fileSize(p: string): number {
	try {
		return statSync(p).size;
	} catch {
		return 0;
	}
}
export function dbFiles(dir: string, name = "stork") {
	const f = (s: string) => fileSize(join(dir, s));
	return {
		main: f(`${name}.db`),
		mainWal: f(`${name}.db-wal`),
		blobs: f(`${name}-blobs.db`),
		blobsWal: f(`${name}-blobs.db-wal`),
	};
}
export const MB = (b: number) => +(b / 2 ** 20).toFixed(2);

export function writeResult(name: string, data: unknown): string {
	mkdirSync(RESULTS_DIR, { recursive: true });
	const p = join(RESULTS_DIR, `${name}.json`);
	writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
	console.log(`[result] ${p}`);
	return p;
}

export function arg(name: string, def?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
	return def;
}
export function flag(name: string): boolean {
	return process.argv.includes(`--${name}`);
}
export function parseSize(s: string): number {
	const m = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(s.trim());
	if (!m) throw new Error(`bad size ${s}`);
	return Math.round(Number(m[1]) * (m[2].toLowerCase() === "k" ? 1e3 : m[2].toLowerCase() === "m" ? 1e6 : 1));
}
export function sizeLabel(n: number): string {
	return n >= 1e6 && n % 1e6 === 0 ? `${n / 1e6}m` : n >= 1000 && n % 1000 === 0 ? `${n / 1000}k` : String(n);
}
export function ensureDir(p: string) {
	if (!existsSync(p)) mkdirSync(p, { recursive: true });
	return p;
}

/** Simple RSS sampler (main process). */
export class RssSampler {
	peak = 0;
	samples: number[] = [];
	private t: NodeJS.Timeout | null = null;
	start(ms = 100) {
		this.t = setInterval(() => {
			const r = process.memoryUsage().rss;
			this.samples.push(r);
			if (r > this.peak) this.peak = r;
		}, ms);
		this.t.unref();
		return this;
	}
	stop() {
		if (this.t) clearInterval(this.t);
		const r = process.memoryUsage().rss;
		if (r > this.peak) this.peak = r;
		return { peakRssMB: MB(this.peak), endRssMB: MB(r) };
	}
}
