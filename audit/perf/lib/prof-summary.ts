/**
 * Summarise a V8 .cpuprofile: self time by function and by package/file.
 *   npx tsx audit/perf/lib/prof-summary.ts <file.cpuprofile> [top=25]
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
const top = Number(process.argv[3] ?? 25);
const p = JSON.parse(readFileSync(file, "utf8")) as {
	nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number; children?: number[] }[];
	samples: number[];
	timeDeltas: number[];
};
const self = new Map<number, number>();
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0));
const byFn = new Map<string, number>();
const byPkg = new Map<string, number>();
let total = 0;
for (const n of p.nodes) {
	const t = self.get(n.id) ?? 0;
	total += t;
	const url = n.callFrame.url;
	const short = url.replace(/^.*node_modules\//, "nm:").replace(/^file:\/\/.*\/stork\//, "");
	const key = `${n.callFrame.functionName || "(anon)"} ${short}:${n.callFrame.lineNumber}`;
	byFn.set(key, (byFn.get(key) ?? 0) + t);
	const pkg = url.includes("node_modules/") ? `nm:${url.split("node_modules/").pop()?.split("/")[0]}` : url.startsWith("node:") ? url : url ? short.split("/").slice(0, 3).join("/") : n.callFrame.functionName;
	byPkg.set(pkg, (byPkg.get(pkg) ?? 0) + t);
}
const fmt = (m: Map<string, number>) =>
	[...m.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, top)
		.map(([k, v]) => `${((v / total) * 100).toFixed(1).padStart(5)}%  ${(v / 1000).toFixed(0).padStart(7)}ms  ${k}`)
		.join("\n");
console.log(`total sampled ${(total / 1e6).toFixed(1)}s\n--- by package/file ---\n${fmt(byPkg)}\n--- by function ---\n${fmt(byFn)}`);
