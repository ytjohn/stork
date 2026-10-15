/**
 * THROWAWAY PROTOTYPE (audit only — never imported by app code).
 * Generates an mbsync-style Maildir tree from the audit perf corpus.
 *
 *   npx tsx audit/alternatives/prototype/gen-maildir.ts --n 1000 --dir /tmp/stork-audit-maildir
 *
 * Layout written (mirrors what mbsync produces for the user's two accounts):
 *   <dir>/gmail/INBOX, <dir>/gmail/[Gmail]/All Mail, [Gmail]/Sent Mail, [Gmail]/Trash, Lists/dev
 *        (SubFolders Verbatim; every non-trash message ALSO has a byte-identical copy in All Mail,
 *         which is how Gmail labels look through IMAP → mbsync)
 *   <dir>/namecheap/{cur,new,tmp} (= INBOX), .Sent, .Archive    (SubFolders Maildir++)
 * Filenames: <secs>.<pid>_<n>.<host>,U=<uid>:2,<flags>   (mbsync's native naming); ~5% left in new/.
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CorpusGenerator, toRfc822 } from "../../perf/lib/corpus.js";
import { arg } from "../../perf/lib/env.js";

const n = Number(arg("n", "1000"));
const root = arg("dir", "/tmp/stork-audit-maildir") as string;
rmSync(root, { recursive: true, force: true });

const uids = new Map<string, number>();
let seq = 0;
function put(dir: string, raw: Buffer, flags: string[], date: Date, isNew: boolean) {
	for (const s of ["cur", "new", "tmp"]) mkdirSync(join(dir, s), { recursive: true });
	const uid = (uids.get(dir) ?? 0) + 1;
	uids.set(dir, uid);
	const fl = flags.map((f) => ({ "\\Seen": "S", "\\Flagged": "F", "\\Answered": "R" })[f] ?? "").sort().join("");
	const base = `${Math.floor(date.getTime() / 1000)}.${process.pid}_${++seq}.audithost,U=${uid}`;
	const p = isNew ? join(dir, "new", base) : join(dir, "cur", `${base}:2,${fl}`);
	writeFileSync(p, raw);
	utimesSync(p, date, date);
}

const gmailFolder: Record<string, string> = {
	INBOX: "INBOX", Archive: "", Sent: "[Gmail]/Sent Mail", Trash: "[Gmail]/Trash", "Lists/dev": "Lists/dev",
};
const ncFolder: Record<string, string> = { INBOX: "", Archive: ".Archive", Sent: ".Sent", Trash: ".Archive", "Lists/dev": "" };

const gen = new CorpusGenerator(n, 1, { attachmentMode: "pool" });
let bytes = 0;
for (const m of gen.all()) {
	const raw = toRfc822(m);
	bytes += raw.length;
	const isNew = m.folder === "INBOX" && !m.flags.includes("\\Seen") && m.idx % 4 === 0;
	if (m.idx % 2 === 0) {
		const g = join(root, "gmail");
		const f = gmailFolder[m.folder];
		if (f) put(join(g, f), raw, m.flags, m.date, isNew);
		if (m.folder !== "Trash") put(join(g, "[Gmail]/All Mail"), raw, m.flags, m.date, false);
	} else {
		put(join(root, "namecheap", ncFolder[m.folder]), raw, m.flags, m.date, isNew);
	}
}
console.log(JSON.stringify({ root, n, bytes, folders: Object.fromEntries(uids) }, null, 1));
