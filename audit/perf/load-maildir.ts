/**
 * Bulk-load the synthetic corpus straight into the disposable Dovecot's Maildir
 * (much faster than IMAP APPEND), then pre-build Dovecot's index so the sync
 * benchmark measures stork, not Dovecot's first-scan.
 *
 *   npx tsx audit/perf/load-maildir.ts --size 10k [--seed 1] [--reset] [--user alice|bob] [--wipe-user]
 *
 * --reset wipes and restarts the Dovecot instance (port 14203, base /tmp/stork-audit-imap-perf).
 * Without --reset messages are ADDED (use a different --seed to simulate new mail).
 */
import { execSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CorpusGenerator, type FolderName, toRfc822 } from "./lib/corpus.js";
import { IMAP_BASE, IMAP_PORT, REPO, arg, flag, parseSize, writeResult } from "./lib/env.js";

const n = parseSize(arg("size", "10k") as string);
const seed = Number(arg("seed", "1"));
const user = arg("user", "alice") as string; // harness users: alice, bob
const harness = join(REPO, "audit/harness/dovecot.sh");
const conf = join(IMAP_BASE, "dovecot.conf");

if (flag("reset")) execSync(`bash ${harness} reset ${IMAP_BASE} ${IMAP_PORT}`, { stdio: "inherit" });
else execSync(`bash ${harness} start ${IMAP_BASE} ${IMAP_PORT} || true`, { stdio: "inherit", shell: "/bin/bash" });

const md = join(IMAP_BASE, `mail/${user}/Maildir`);
if (flag("wipe-user")) execSync(`rm -rf ${join(IMAP_BASE, "mail", user)}`);
const dirFor = (f: FolderName) => (f === "INBOX" ? md : join(md, `.${f.replace(/\//g, ".")}`));
for (const f of ["INBOX", "Archive", "Sent", "Trash", "Lists/dev"] as FolderName[]) {
	for (const sub of ["cur", "new", "tmp"]) mkdirSync(join(dirFor(f), sub), { recursive: true });
}

const t0 = performance.now();
const gen = new CorpusGenerator(n, seed, { attachmentMode: "unique" });
let bytes = 0;
for (const m of gen.all()) {
	const raw = toRfc822(m);
	bytes += raw.length;
	const secs = Math.floor(m.date.getTime() / 1000);
	const fl = m.flags.map((f) => (f === "\\Seen" ? "S" : f === "\\Flagged" ? "F" : "")).sort().join("");
	const name = `${secs}.M${m.idx}P${seed}Q${m.idx}.perfgen,S=${raw.length}:2,${fl}`;
	const p = join(dirFor(m.folder), "cur", name);
	writeFileSync(p, raw);
	utimesSync(p, m.date, m.date); // Dovecot uses mtime as INTERNALDATE
	if (m.idx % 10000 === 0 && m.idx) console.log(`  wrote ${m.idx}/${n}`);
}
const genMs = performance.now() - t0;
execSync(`chown -R storkaudit:storkaudit ${join(IMAP_BASE, "mail")}`);
const t1 = performance.now();
// Pre-index so stork's sync timing excludes Dovecot's initial maildir scan.
execSync(`doveadm -c ${conf} index -u ${user} '*'`, { stdio: "inherit" });
const idxMs = performance.now() - t1;
const status = execSync(`doveadm -c ${conf} mailbox status -u ${user} 'messages vsize' '*'`, { encoding: "utf8" });
console.log(status);
writeResult(`maildir-load-${user}-seed${seed}-${n}`, { n, seed, user, bytes, genMs, doveadmIndexMs: idxMs, status });
