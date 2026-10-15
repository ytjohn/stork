/**
 * Deterministic synthetic mail corpus generator.
 *
 * Same (n, seed) -> byte-identical output. No network, no real data.
 *
 * Properties (see README "Corpus"):
 *  - 30,000 pseudo-word vocabulary, Zipf(s=1.07) word frequencies
 *  - text body length lognormal, median ~5.5 KB  (RFC822 message median ~8 KB)
 *  - 20% multipart/alternative with an HTML part, 5% with 1 attachment 50KB-2MB (log-uniform)
 *  - 500 senders (Zipf), threads via In-Reply-To/References, 8 long threads of 60 msgs
 *  - dates spread evenly over 5 years (2021-10-15 .. 2026-10-15), UID order == date order
 *  - needle tokens with exact known document frequencies (see NEEDLES / expectedCounts())
 */

// ── PRNG ──────────────────────────────────────────────────────────────────
export function sfc32(a: number, b: number, c: number, d: number): () => number {
	return () => {
		a >>>= 0;
		b >>>= 0;
		c >>>= 0;
		d >>>= 0;
		let t = (a + b) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		d = (d + 1) | 0;
		t = (t + d) | 0;
		c = (c + t) | 0;
		return (t >>> 0) / 4294967296;
	};
}
export function rngFor(seed: number, stream: number): () => number {
	const r = sfc32(0x9e3779b9 ^ seed, 0x243f6a88 ^ stream, 0xb7e15162 ^ (seed * 31 + stream), 0xdeadbeef);
	for (let i = 0; i < 12; i++) r();
	return r;
}
/** Stateless 32-bit hash of (seed, idx, salt) -> [0,1) */
export function h01(seed: number, idx: number, salt: number): number {
	let x = (Math.imul(idx ^ 0x5bd1e995, 0x27d4eb2d) ^ Math.imul(seed + salt * 0x9e3779b1, 0x85ebca6b)) >>> 0;
	x ^= x >>> 15;
	x = Math.imul(x, 0x2c1b3c6d) >>> 0;
	x ^= x >>> 12;
	x = Math.imul(x, 0x297a2d39) >>> 0;
	x ^= x >>> 15;
	return (x >>> 0) / 4294967296;
}

// ── Vocabulary ────────────────────────────────────────────────────────────
const ONSET = ["b", "c", "d", "f", "g", "h", "j", "k", "l", "m", "n", "p", "r", "s", "t", "v", "w", "z", "br", "cl", "dr", "fl", "gr", "pl", "pr", "sh", "st", "th", "tr", "ch", "sp", "sl"];
const NUCLEUS = ["a", "e", "i", "o", "u", "ai", "ea", "ou", "io", "ee", "oa", "y"];
const CODA = ["", "", "", "n", "r", "s", "t", "l", "m", "nd", "st", "rk", "ng", "x", "ck"];
// Real English function words occupy the top Zipf ranks so FTS sees realistic "the/and" lists.
const TOP = "the of and to a in is that for it as with was on be by this you are at from or have an not but they which we will can all your has more one so if about our new please would there their what been also any time get just like".split(" ");

export const VOCAB_SIZE = 30000;
let vocabCache: string[] | null = null;
export function vocabulary(): string[] {
	if (vocabCache) return vocabCache;
	const r = rngFor(424242, 1);
	const seen = new Set<string>(TOP);
	const words = [...TOP];
	while (words.length < VOCAB_SIZE) {
		const syl = 1 + Math.floor(r() * 3.2);
		let w = "";
		for (let s = 0; s < syl; s++) {
			w += ONSET[Math.floor(r() * ONSET.length)] + NUCLEUS[Math.floor(r() * NUCLEUS.length)] + CODA[Math.floor(r() * CODA.length)];
		}
		if (w.length < 3 || seen.has(w) || w.startsWith("xylo") || w.startsWith("zq")) continue;
		seen.add(w);
		words.push(w);
	}
	vocabCache = words;
	return words;
}
let zipfCdf: Float64Array | null = null;
function zipf(): Float64Array {
	if (zipfCdf) return zipfCdf;
	const s = 1.07;
	const cdf = new Float64Array(VOCAB_SIZE);
	let acc = 0;
	for (let i = 0; i < VOCAB_SIZE; i++) {
		acc += 1 / (i + 1) ** s;
		cdf[i] = acc;
	}
	for (let i = 0; i < VOCAB_SIZE; i++) cdf[i] /= acc;
	zipfCdf = cdf;
	return cdf;
}
function sampleRank(u: number): number {
	const cdf = zipf();
	let lo = 0;
	let hi = VOCAB_SIZE - 1;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (cdf[mid] < u) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

// ── Needles (exact, known document frequencies) ───────────────────────────
export const NEEDLES = {
	rare: "xylorarium", // exactly 10 docs
	medium: "xylomedianta", // idx % 100 == 37   -> 1%
	common: "xylocommona", // h01 < 0.30          -> ~30% (exact count via expectedCounts)
	phrase: "quantum harvest", // idx % 200 == 11 -> 0.5%, words also appear separately elsewhere
	prefix: "zqprefix", // tokens zqprefix0..9 in idx % 50 == 3 -> 2%
	sender: "needle.sender@known-corp.example", // idx % 50 == 7 -> 2%
	subject: "Invoice", // idx % 33 == 5 -> ~3% have "Invoice #NNNN" in subject
	label: "Lists/dev", // custom folder/label (5%)
};
export function isRare(idx: number, n: number): boolean {
	const k = Math.floor((idx * 10) / n);
	return Math.floor(((k + 0.5) * n) / 10) === idx;
}
export const isMedium = (idx: number) => idx % 100 === 37;
export const isCommon = (seed: number, idx: number) => h01(seed, idx, 77) < 0.3;
export const isPhrase = (idx: number) => idx % 200 === 11;
export const isPhraseDecoy = (idx: number) => idx % 200 === 13; // has "harvest ... quantum" not adjacent
export const isPrefix = (idx: number) => idx % 50 === 3;
export const isNeedleSender = (idx: number) => idx % 50 === 7;
export const isInvoice = (idx: number) => idx % 33 === 5;

// ── Senders / people ──────────────────────────────────────────────────────
const FIRST = "alex sam jordan taylor morgan casey riley jamie avery quinn rowan drew emerson finley harper kai logan parker reese sage blake cameron dakota elliot hayden jesse kendall lane marley noel oakley peyton remy shay tatum".split(" ");
const LAST = "smith jones brown garcia miller davis wilson moore clark lewis walker hall young king wright scott green baker adams nelson hill campbell mitchell roberts carter phillips evans turner torres parker collins edwards stewart morris".split(" ");
const DOMAINS = ["example.com", "example.org", "example.net", "mail.example", "corp.example", "lists.example", "shop.example", "bank.example", "news.example", "dev.example"];
export interface Person {
	name: string;
	address: string;
}
let sendersCache: Person[] | null = null;
export function senders(): Person[] {
	if (sendersCache) return sendersCache;
	const r = rngFor(777, 2);
	const out: Person[] = [];
	const seen = new Set<string>();
	while (out.length < 500) {
		const f = FIRST[Math.floor(r() * FIRST.length)];
		const l = LAST[Math.floor(r() * LAST.length)];
		const d = DOMAINS[Math.floor(r() * DOMAINS.length)];
		const addr = `${f}.${l}${out.length % 7 === 0 ? out.length : ""}@${d}`;
		if (seen.has(addr)) continue;
		seen.add(addr);
		out.push({ name: `${f[0].toUpperCase()}${f.slice(1)} ${l[0].toUpperCase()}${l.slice(1)}`, address: addr });
	}
	sendersCache = out;
	return out;
}
export const ME: Person = { name: "Alice Perf", address: "alice@perf.example" };

// ── Message model ─────────────────────────────────────────────────────────
export const FOLDERS = ["INBOX", "Archive", "Sent", "Trash", "Lists/dev"] as const;
export type FolderName = (typeof FOLDERS)[number];
export interface Attachment {
	filename: string;
	contentType: string;
	data: Buffer;
}
export interface GenMessage {
	idx: number;
	folder: FolderName;
	messageId: string;
	inReplyTo: string | null;
	references: string[];
	subject: string;
	from: Person;
	to: Person[];
	cc: Person[];
	date: Date;
	text: string;
	html: string | null;
	attachments: Attachment[];
	flags: string[]; // IMAP flags e.g. \Seen
	longThread: number | null; // index of long thread (0..7) or null
}

const START = Date.UTC(2021, 9, 15);
const SPAN = Date.UTC(2026, 9, 15) - START;
export const LONG_THREADS = 8;
export const LONG_THREAD_LEN = 60;

export interface GenOptions {
	/** "unique": every attachment has distinct random bytes (IMAP corpus);
	 *  "pool": attachments drawn from 64 shared payloads (bulk DBs, bounds blobs DB size) */
	attachmentMode?: "unique" | "pool";
	/** Skip generating attachment bytes entirely (metadata only) */
	noAttachmentBytes?: boolean;
}

function folderFor(seed: number, idx: number): FolderName {
	if (isNeedleSender(idx)) return h01(seed, idx, 5) < 0.5 ? "INBOX" : "Archive";
	const u = h01(seed, idx, 3);
	if (u < 0.25) return "INBOX";
	if (u < 0.8) return "Archive";
	if (u < 0.92) return "Sent";
	if (u < 0.95) return "Trash";
	return "Lists/dev";
}

function words(r: () => number, count: number, out: string[]): void {
	const v = vocabulary();
	for (let i = 0; i < count; i++) out.push(v[sampleRank(r())]);
}

function paragraphs(tokens: string[], r: () => number): string {
	// Sentences of 6-20 words, paragraphs of 2-6 sentences, ~72 col wrap is not needed for FTS.
	const parts: string[] = [];
	let i = 0;
	let para: string[] = [];
	while (i < tokens.length) {
		const len = 6 + Math.floor(r() * 15);
		const s = tokens.slice(i, i + len);
		i += len;
		if (s.length === 0) break;
		s[0] = s[0][0].toUpperCase() + s[0].slice(1);
		para.push(`${s.join(" ")}.`);
		if (para.length >= 2 + Math.floor(r() * 5)) {
			parts.push(para.join(" "));
			para = [];
		}
	}
	if (para.length) parts.push(para.join(" "));
	return parts.join("\n\n");
}

function wrap(s: string, width = 76): string {
	return s
		.split("\n")
		.map((line) => {
			if (line.length <= width) return line;
			const out: string[] = [];
			let cur = "";
			for (const w of line.split(" ")) {
				if (cur.length + w.length + 1 > width && cur) {
					out.push(cur);
					cur = w;
				} else cur = cur ? `${cur} ${w}` : w;
			}
			if (cur) out.push(cur);
			return out.join("\n");
		})
		.join("\n");
}

/** Generator state for threading; must be iterated in idx order. */
export class CorpusGenerator {
	readonly n: number;
	readonly seed: number;
	private opts: GenOptions;
	private recentThreads: { root: string; refs: string[]; lastId: string; subject: string }[] = [];
	private longThreads: { refs: string[]; lastId: string | null; subject: string }[] = [];
	private longThreadAt = new Map<number, number>();
	private attPool: Buffer[] = [];

	constructor(n: number, seed = 1, opts: GenOptions = {}) {
		this.n = n;
		this.seed = seed;
		this.opts = opts;
		for (let t = 0; t < LONG_THREADS; t++) {
			this.longThreads.push({ refs: [], lastId: null, subject: `Project ${vocabulary()[3000 + t]} planning thread` });
		}
		const total = LONG_THREADS * LONG_THREAD_LEN;
		if (n >= total * 2) {
			for (let k = 0; k < total; k++) {
				// interleave the threads evenly through the corpus (k -> thread k%8, position k/8)
				const idx = Math.floor(((k + 0.5) * n) / total);
				this.longThreadAt.set(idx, k % LONG_THREADS);
			}
		}
		if (opts.attachmentMode === "pool") {
			const r = rngFor(seed, 99);
			for (let i = 0; i < 64; i++) this.attPool.push(randomBytes(r, attSize(r)));
		}
	}

	message(idx: number): GenMessage {
		const { seed, n } = this;
		const r = rngFor(seed, idx + 1000);
		const people = senders();
		const folder = this.longThreadAt.has(idx) ? "INBOX" : folderFor(seed, idx);
		const sent = folder === "Sent";
		let from: Person = isNeedleSender(idx) ? { name: "Needle Sender", address: NEEDLES.sender } : people[Math.min(499, Math.floor(sampleRankSmall(r(), 500)))];
		let to: Person[] = [ME];
		if (sent) {
			to = [from];
			from = ME;
		}
		const cc: Person[] = [];
		if (r() < 0.15) for (let i = 0, k = 1 + Math.floor(r() * 3); i < k; i++) cc.push(people[Math.floor(r() * 500)]);

		const date = new Date(START + Math.floor(((idx + r() * 0.9) / n) * SPAN));
		const messageId = `<perf.${seed}.${idx}@gen.stork-audit.example>`;

		// Threading
		let inReplyTo: string | null = null;
		let references: string[] = [];
		const vocab = vocabulary();
		let subject: string;
		const lt = this.longThreadAt.get(idx);
		if (lt !== undefined) {
			const t = this.longThreads[lt];
			if (t.lastId) {
				inReplyTo = t.lastId;
				references = [...t.refs, t.lastId];
				subject = `Re: ${t.subject}`;
			} else subject = t.subject;
			t.refs = references;
			t.lastId = messageId;
		} else if (this.recentThreads.length > 0 && r() < 0.4) {
			const ti = Math.floor(r() * this.recentThreads.length);
			const t = this.recentThreads[ti];
			inReplyTo = t.lastId;
			references = [...t.refs, t.lastId].slice(-20);
			subject = `Re: ${t.subject}`;
			t.refs = references;
			t.lastId = messageId;
		} else {
			const sw: string[] = [];
			words(r, 3 + Math.floor(r() * 6), sw);
			subject = sw.join(" ");
			subject = subject[0].toUpperCase() + subject.slice(1);
			if (isInvoice(idx)) subject = `Invoice #${10000 + idx} ${subject}`;
			this.recentThreads.push({ root: messageId, refs: [], lastId: messageId, subject });
			if (this.recentThreads.length > 300) this.recentThreads.shift();
		}

		// Body
		const median = 5500; // bytes of text body
		const sigma = 0.75;
		const z = gaussian(r);
		const target = Math.min(96 * 1024, Math.max(200, Math.floor(median * Math.exp(sigma * z))));
		const tokens: string[] = [];
		words(r, Math.floor(target / 6.6), tokens);
		const insert = (tok: string) => tokens.splice(Math.floor(r() * (tokens.length + 1)), 0, tok);
		if (isRare(idx, n)) insert(NEEDLES.rare);
		if (isMedium(idx)) insert(NEEDLES.medium);
		if (isCommon(seed, idx)) insert(NEEDLES.common);
		if (isPhrase(idx)) insert(NEEDLES.phrase);
		if (isPhraseDecoy(idx)) {
			insert("harvest");
			insert("quantum");
		}
		if (isPrefix(idx)) insert(`${NEEDLES.prefix}${idx % 10}`);
		let text = paragraphs(tokens, r);
		text = `Hi ${to[0].name.split(" ")[0]},\n\n${text}\n\nBest,\n${from.name}\n`;
		if (inReplyTo) text += `\nOn ${date.toUTCString()} someone wrote:\n> ${tokens.slice(0, 30).join(" ")}\n`;

		let html: string | null = null;
		if (h01(seed, idx, 11) < 0.2) {
			const ps = text
				.split("\n\n")
				.map((p) => `<p style="margin:0 0 12px 0;font-family:Arial,sans-serif">${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`)
				.join("\n");
			html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{color:#222}</style></head><body><table width="100%"><tr><td>\n${ps}\n</td></tr></table><div style="font-size:11px;color:#888">You are receiving this because you subscribed. <a href="https://news.example/unsub?id=${idx}">Unsubscribe</a></div></body></html>`;
		}

		const attachments: Attachment[] = [];
		if (h01(seed, idx, 13) < 0.05 && !this.opts.noAttachmentBytes) {
			const ar = rngFor(seed, idx + 7_000_000);
			const data =
				this.opts.attachmentMode === "pool" ? this.attPool[Math.floor(ar() * this.attPool.length)] : randomBytes(ar, attSize(ar));
			const kind = ar() < 0.6 ? ["pdf", "application/pdf"] : ar() < 0.5 ? ["jpg", "image/jpeg"] : ["zip", "application/zip"];
			attachments.push({ filename: `${vocab[100 + (idx % 500)]}-${idx}.${kind[0]}`, contentType: kind[1], data });
		}

		const flags: string[] = [];
		const recent = idx > n * 0.97;
		if (h01(seed, idx, 17) < (sent ? 1 : recent ? 0.3 : 0.88)) flags.push("\\Seen");
		if (h01(seed, idx, 19) < 0.03) flags.push("\\Flagged");

		return { idx, folder, messageId, inReplyTo, references, subject, from, to, cc, date, text, html, attachments, flags, longThread: lt ?? null };
	}

	*all(): Generator<GenMessage> {
		for (let i = 0; i < this.n; i++) yield this.message(i);
	}
}

function sampleRankSmall(u: number, k: number): number {
	// Zipf(s=1) over k items via inverse of harmonic approx
	const Hk = Math.log(k) + 0.5772;
	return Math.max(0, Math.floor(Math.exp(u * Hk - 0.5772)) - 1) % k;
}
function gaussian(r: () => number): number {
	const u = Math.max(1e-12, r());
	const v = r();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function attSize(r: () => number): number {
	return Math.floor(Math.exp(Math.log(50 * 1024) + r() * (Math.log(2 * 1024 * 1024) - Math.log(50 * 1024))));
}
function randomBytes(r: () => number, size: number): Buffer {
	const b = Buffer.allocUnsafe(size);
	for (let i = 0; i + 4 <= size; i += 4) b.writeUInt32LE((r() * 4294967296) >>> 0, i);
	for (let i = size - (size % 4); i < size; i++) b[i] = (r() * 256) | 0;
	return b;
}

// ── RFC822 serialisation ──────────────────────────────────────────────────
function addr(p: Person): string {
	return `"${p.name}" <${p.address}>`;
}
function b64lines(buf: Buffer): string {
	const s = buf.toString("base64");
	const out: string[] = [];
	for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
	return out.join("\r\n");
}
function qpish(text: string): string {
	// Bodies are pure ASCII words; 7bit with CRLF and <998 col lines is valid.
	return wrap(text).replace(/\r?\n/g, "\r\n");
}

export function headerBlock(m: GenMessage): string[] {
	const h = [
		"Return-Path: <" + m.from.address + ">",
		`Received: from mx${m.idx % 7}.gen.stork-audit.example (mx${m.idx % 7}.gen.stork-audit.example [192.0.2.${m.idx % 250}]) by mail.perf.example with ESMTPS id ${m.idx.toString(36)}; ${m.date.toUTCString()}`,
		`Date: ${m.date.toUTCString().replace("GMT", "+0000")}`,
		`From: ${addr(m.from)}`,
		`To: ${m.to.map(addr).join(", ")}`,
	];
	if (m.cc.length) h.push(`Cc: ${m.cc.map(addr).join(", ")}`);
	h.push(`Subject: ${m.subject}`, `Message-ID: ${m.messageId}`);
	if (m.inReplyTo) h.push(`In-Reply-To: ${m.inReplyTo}`);
	if (m.references.length) h.push(`References: ${m.references.join("\r\n ")}`);
	h.push("MIME-Version: 1.0", "X-Mailer: stork-audit-gen/1");
	return h;
}

export function toRfc822(m: GenMessage): Buffer {
	const h = headerBlock(m);
	const textPart = qpish(m.text);
	const B1 = `=_alt_${m.idx}`;
	const B2 = `=_mix_${m.idx}`;
	let body: string;
	let ctype: string;
	const alt = m.html
		? [`--${B1}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 7bit", "", textPart, `--${B1}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: 7bit", "", qpish(m.html), `--${B1}--`, ""].join("\r\n")
		: null;
	if (m.attachments.length) {
		ctype = `multipart/mixed; boundary="${B2}"`;
		const parts = [`--${B2}`];
		if (alt) parts.push(`Content-Type: multipart/alternative; boundary="${B1}"`, "", alt);
		else parts.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 7bit", "", textPart);
		for (const a of m.attachments) {
			parts.push(`--${B2}`, `Content-Type: ${a.contentType}; name="${a.filename}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${a.filename}"`, "", b64lines(a.data));
		}
		parts.push(`--${B2}--`, "");
		body = parts.join("\r\n");
	} else if (alt) {
		ctype = `multipart/alternative; boundary="${B1}"`;
		body = alt;
	} else {
		ctype = "text/plain; charset=utf-8";
		body = textPart;
	}
	h.push(`Content-Type: ${ctype}`);
	if (!m.attachments.length && !alt) h.push("Content-Transfer-Encoding: 7bit");
	return Buffer.from(`${h.join("\r\n")}\r\n\r\n${body}\r\n`, "utf8");
}

/** Exact expected document counts for needle queries over a corpus of n messages. */
export function expectedCounts(n: number, seed = 1) {
	let rare = 0, medium = 0, common = 0, phrase = 0, prefix = 0, sender = 0, invoice = 0;
	for (let i = 0; i < n; i++) {
		if (isRare(i, n)) rare++;
		if (isMedium(i)) medium++;
		if (isCommon(seed, i)) common++;
		if (isPhrase(i)) phrase++;
		if (isPrefix(i)) prefix++;
		if (isNeedleSender(i)) sender++;
		if (isInvoice(i)) invoice++;
	}
	return { rare, medium, common, phrase, prefix, sender, invoice };
}
