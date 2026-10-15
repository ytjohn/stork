# Stork dependency inventory

Collected 2026-10-15 from:
- `node_modules/*/package.json` (installed versions and licenses)
- `npm outdated --json`, `npm view` (latest version, license, `time.modified`, maintainers) and `npm audit --json`, run against the public registry through the sandbox proxy
- `npx license-checker --summary`

"Installed" means the version the April 2026 lockfile resolves to.

## 1. Direct dependencies: backend (`/package.json`)

### Production

| Package | Range | Installed | Wanted (in range) | Latest | License (installed → latest) | Registry last modified | Maintainers | Prod advisories (installed) | Risk notes |
|---|---|---|---|---|---|---|---:|---|---|
| `hono` | ^4.12.10 | 4.12.14 | 4.13.13 | 4.13.13 | MIT → MIT | 2026-10-10 | 1 (yusukebe) | **HIGH**: 25 advisories < 4.13.7. The high one is **GHSA-88fw-hqm2-52qc, "CORS middleware reflects any Origin with credentials when origin defaults to wildcard"**, which applies directly: `server.ts` calls `cors()` with defaults. The rest are moderate (JSX/SSR, bodyLimit, serve-static on Windows), mostly unused here. | Very active, single maintainer, large community. `npm update` fixes it within range. |
| `@hono/node-server` | ^1.19.12 | 1.19.14 | 1.19.17 | **2.1.5** | MIT | 2026-10-13 | 1 | Moderate: GHSA-frvp-7c67-39w9 (serve-static path traversal **on Windows only**) | 2.x requires Node ≥ 20 and accepts hono ^4. The bump is mechanical; check `serveStatic` import paths. |
| `imapflow` | ^1.0.171 | 1.3.2 | 1.7.8 | **2.4.3** | MIT → MIT (see §4) | 2026-10-15 | **1 (andris, Postal Systems)** | HIGH, transitive through its `nodemailer` dependency (deduped to the vulnerable 8.0.5; imapflow ≥ 1.4.2 raises the floor), plus `socks`→`ip-address` (SSRF-class advisories, low relevance) | The core of the product. Very active: about 150 releases, 2.x since 2026-09-07. 2.0 breaking changes: Node ≥ 20, a TypeScript rewrite with ESM+CJS builds, `lib/` no longer published (use the export map), and **internal members stripped from the type declarations**. Stork reaches into the private `client.socket` (`imap-sync.ts:1477`, `:1490`) through `as unknown` casts. That still compiles but may break at runtime; test it. 2.0 also fixes "re-arm auto-IDLE", which matters if IDLE is adopted. |
| `mailparser` | ^3.9.4 | 3.9.8 | 3.9.39 | 3.9.39 | MIT | 2026-10-14 | 1 (andris) | HIGH, transitive: `linkify-it` quadratic DoS (GHSA-22p9-wv53-3rq4, GHSA-v245-v573-v5vm), triggered by **attacker-controlled mail bodies**, plus its `nodemailer` dependency (same deduped 8.0.5) | Fixed within range by `npm update`. Same single maintainer as imapflow and nodemailer. |
| `nodemailer` | ^8.0.4 | 8.0.5 | 8.0.11 | **10.1.1** | MIT-0 (since 7.0; was MIT ≤ 6.x) | 2026-10-14 | 1 (andris) | **HIGH**: 12 advisories. Relevant to Stork: addressparser quadratic DoS (GHSA-2x7j-588g-ccc2 < 9.1.0, GHSA-v53p-9fqp-m79j ≤ 10.0.5; the recipients come from API input), recipient-domain validation bypass, CRLF injection in List-* headers (≤ 8.0.8), and the process-global DNS cache reusing TLS servername across transports (< 10.0.2) | 8.0.11 fixes only part of the list. **Full remediation needs 10.x, two majors.** 9.0: HTTPS fetches validate TLS by default. 10.0: Node ≥ 20, TypeScript rewrite, internal type members dropped. 8.x: error code `NoAuth` renamed to `ENOAUTH`. `@types/nodemailer` becomes redundant once 10.x ships its own types; check. |
| `better-sqlite3-multiple-ciphers` | ^12.8.0 | 12.9.0 | 12.11.1 | **13.0.3** | MIT | 2026-09-21 | **1 (m4heshd)** | none | **A single-maintainer fork of `better-sqlite3` (WiseLibs, also one npm maintainer) that bundles SQLite3MultipleCiphers (utelle).** It tracks upstream closely: 12.9.0 came 2 days after upstream, and 13.0.3 2 days after. Native addon, with prebuilds downloaded from GitHub releases by `prebuild-install` and a fallback to `node-gyp`. 13.x requires **Node ≥ 22**. **Default cipher is ChaCha20-Poly1305, not SQLCipher** (see MAINTAINABILITY §4). Bus-factor risk: if it stalls, the fallback is `better-sqlite3` with a custom SQLite3MC or SQLCipher build, or `@journeyapps/sqlcipher`. Either way a data migration is needed, because the cipher format changes. Pin exact versions and test every upgrade against a real encrypted DB copy. |
| `@noble/hashes` | ^2.0.1 | 2.2.0 | 2.4.0 | 2.4.0 | MIT | 2026-08-27 | 1 (paulmillr) | none | Audited pure-JS crypto, actively maintained. Its Argon2id is **pure JS and synchronous: about 3.9 s at m=64 MiB, t=3, p=1 on this host**, blocking the event loop during setup (2 derivations), unlock and change-password. Alternatives: `hash-wasm` (WASM, roughly 3–5× faster, async-capable), `argon2` (native, worker pool), or a worker thread. Node 22 has no `crypto.argon2` (that arrived in Node 24.7). If the fork moves to Node 24+, `crypto.argon2()` is native and async, and the KDF parameters stay compatible. |
| `bip39` | ^3.1.0 | 3.1.0 | 3.1.2 | 3.1.2 | ISC | 2026-10-13 | 3 | none | Low risk. It pulls in `@noble/hashes` v1 as well (two copies). |

### Development

| Package | Installed | Latest | License | Last modified | Maint. | Notes |
|---|---|---|---|---|---:|---|
| `@biomejs/biome` | 2.4.12 | 2.5.15 | MIT OR Apache-2.0 | 2026-09-30 | 5 | Lint and format. Fine. |
| `@playwright/test` | 1.59.1 | 1.64.1 | Apache-2.0 | 2026-10-15 | 5 | Browser revision is pinned per version. This sandbox's `/opt/pw-browsers` has 1194; 1.59 wants 1217. |
| `@types/mailparser` | 3.4.6 | 3.9.0 | MIT | 2026-10-04 | 1 | |
| `@types/node` | 22.19.17 | 26.6.5 | MIT | 2026-10-09 | 1 | Keep at 22 while targeting Node 22. |
| `@types/nodemailer` | 7.0.11 | 8.0.2 | MIT | 2026-10-04 | 1 | Drop once nodemailer 10 ships types. |
| `@vitest/coverage-v8` | 4.1.4 | 5.0.4 | MIT | 2026-10-12 | 5 | Moderate advisory through `@vitest/mocker` (dev only). |
| `esbuild` | 0.28.0 | 0.28.2 | MIT | 2026-08-08 | 1 | Low (dev-server on Windows). |
| `happy-dom` | 20.9.0 | 21.0.1 | MIT | 2026-10-12 | 1 | |
| `tsx` | 4.21.0 | 4.23.15 | MIT | 2026-09-20 | 1 | |
| `vitest` | 4.1.4 | 5.0.4 | MIT | 2026-10-12 | 5 | Moderate (dev only). |
| *(missing)* `typescript` | – | 7.0.2 | Apache-2.0 | – | – | **The root has no TypeScript dependency.** `tsc` here was a global 6.0.2. Add it. TS 7 is the native Go port, so test it before adopting. |

## 2. Direct dependencies: frontend (`/frontend/package.json`)

| Package | Kind | Installed | Latest | License | Last modified | Maint. | Advisories / notes |
|---|---|---|---|---|---|---:|---|
| `react`, `react-dom` | prod | 19.2.4 | 19.3.1 | MIT | 2026-10-14 | 2 | none |
| `dompurify` | prod | 3.4.0 | 3.4.17 | MPL-2.0 OR Apache-2.0 | 2026-10-12 | 1 (cure53) | **Moderate**: 11 advisories ≤ 3.4.15, mostly `IN_PLACE`/`setConfig` modes. Check whether `email-sanitizer.ts` uses them, but upgrade anyway; it is in range. This is the XSS front line, together with the iframe sandbox. |
| `@testing-library/jest-dom` | dev | 6.9.1 | 7.0.1 | MIT | 2026-08-09 | 18 | |
| `@testing-library/react` | dev | 16.3.2 | 16.3.3 | MIT | 2026-08-27 | 18 | |
| `@testing-library/user-event` | dev | 14.6.1 | 14.6.8 | MIT | 2026-10-13 | 18 | |
| `@types/dompurify` | dev | 3.2.0 | 3.2.0 (deprecated stub) | MIT | 2024-11-19 | 1 | **Deprecated.** DOMPurify ships its own types. Remove it. |
| `@types/react`, `@types/react-dom` | dev | 19.2.x | 19.3.0 | MIT | 2026-10-04 | 1 | |
| `@vitejs/plugin-react` | dev | 4.7.0 | 6.1.2 | MIT | 2026-10-05 | 2 | Two majors behind. Follows the vite major. |
| `@vitest/coverage-v8`, `vitest` | dev | 4.1.4 | 5.0.4 | MIT | 2026-10-12 | 5 | Moderate (dev). |
| `autoprefixer` | dev | 10.4.27 | 10.6.1 | MIT | 2026-09-15 | 1 | |
| `happy-dom` | dev | 20.8.9 | 21.0.1 | MIT | 2026-10-12 | 1 | |
| `postcss` | dev | 8.5.10 | 8.5.30 | MIT | 2026-10-12 | 1 | High (sourceMappingURL file read, build-time only). In range. |
| `tailwindcss` | dev | 3.4.19 | **4.3.3** | MIT | 2026-10-15 | 3 | High transitive (`braces`/`micromatch`/`chokidar`, build-time only). The fix needs **Tailwind 4**, a config-format rewrite (CSS-first `@theme`, new engine) with some class renames. That is a medium effort over about 9k LOC of TSX. |
| `typescript` | dev | 5.9.3 | 7.0.2 | Apache-2.0 | 2026-10-15 | 7 | |
| `vite` | dev | 6.4.2 | **8.3.4** | MIT | 2026-10-08 | 2 | High (dev-server `fs.deny` bypass and launch-editor, both Windows-only). Two majors behind. |

## 3. `npm audit` totals

| Scope | Total | Critical | High | Moderate | Low |
|---|---:|---:|---:|---:|---:|
| Backend, prod only (`--omit=dev`) | **7** | 0 | **6** | 1 | 0 |
| Backend, all | 16 | 0 | 11 | 4 | 1 |
| Frontend, prod only | **1** (dompurify) | 0 | 0 | 1 | 0 |
| Frontend, all | 18 | 0 | 11 | 6 | 1 |

The backend production chain resolves as follows:
- **Fixed by `npm update` within the existing ranges:** hono, `@hono/node-server` (Windows only), mailparser/linkify-it, imapflow (through its nodemailer), `ip-address` (through imapflow/socks), and dompurify.
- **Needs a major bump:** only `nodemailer` (8 → 10) to clear all of its addressparser DoS and TLS-servername advisories.

`.github/dependabot.yml` exists (weekly npm and Actions updates), but nobody has merged anything since April, which is how this backlog formed.

## 4. License analysis

### imapflow's license history (checked per version on the registry)

| imapflow versions | License |
|---|---|
| 1.0.0 (2019-12) | `UNLICENSED` |
| ~1.0.x through **1.0.63** (2020–mid-2021) | **`AGPL-3.0-or-later`** |
| **1.0.65 (2021-07-25)** onward, including 1.0.171, the installed **1.3.2**, 1.7.8 and **2.4.3** | **MIT** |

Stork's range `^1.0.171` resolves only to MIT releases, and the installed `node_modules/imapflow/LICENSE` is MIT ("Copyright (c) 2020-2024 Postal Systems OÜ"). Even the older AGPL-3.0-or-later releases would have been compatible with Stork's AGPL-3.0-only. Postal Systems also sells EmailEngine commercially, so another relicensing of future releases is possible. **Pin imapflow and recheck the `license` field on every upgrade**, for example with a CI check through `license-checker --failOn`.

### nodemailer

It moved from MIT to **MIT-0** in 7.0.0. MIT-0 has no attribution requirement and is compatible.

### Transitive summary (`license-checker`)

| Set | Licenses |
|---|---|
| Backend production (91 packages) | MIT 70, ISC 8, BSD-2-Clause 4, **(MIT OR EUPL-1.1+)** 2 (`@zone-eu/mailsplit`, a mailparser dependency; take MIT), Apache-2.0 2 (`detect-libc`, `tunnel-agent`), BSD-3-Clause 1, MIT-0 1, (MIT OR WTFPL) 1, (BSD-2-Clause OR MIT OR Apache-2.0) 1, AGPL-3.0-only 1 (Stork itself) |
| Backend with dev | Adds MPL-2.0 ×3 (`lightningcss*`, dev/build only) |
| Frontend production | MIT 4, (MPL-2.0 OR Apache-2.0) 1 (DOMPurify), UNLICENSED 1 (`stork-frontend` itself: `private` with no `license` field; add `"license": "AGPL-3.0-only"`) |
| Frontend with dev | Adds CC-BY-4.0 ×1 (`caniuse-lite` data, build only), Apache-2.0, BSD |

**Compatibility with AGPL-3.0-only:** everything is permissive or weak-copyleft. MPL-2.0 is file-level copyleft, explicitly compatible with GPL/AGPL, and in this tree it is either dev-only or offered as MPL-OR-Apache. The shipped bundle includes DOMPurify, so keep its license notice, for example with a `license.txt` emitted by Vite or a NOTICE file. **No dependency is incompatible.**

### Implications for the user's fork

- The upstream is **AGPL-3.0-only**. `LICENSING.md` reserves dual-licensing rights for Paperkite Technologies LLC, but only over **their** copyright. The fork's own modifications belong to the user, who must license them under AGPL-3.0 when distributing them together with the upstream code.
- **A private, personal deployment** (your own cluster, used only by you) triggers **no obligations**. AGPL §13 is about offering the modified program's functionality to **other users** over a network. Using it yourself is not conveying it.
- **The obligations begin** once anyone else uses the instance over the network (family members, a shared household server, or a public demo like upstream's fly.io app). At that point you must offer those users the Corresponding Source of the **running, modified** version, for example with a source link in the UI. The existing "Get Stork" link in `DemoBanner.tsx` points at upstream; point it at your fork. The same applies to distributing images (a public registry) or binaries.
- **AI agents using the API** do not change this. An agent acting for you is not a separate user. A third-party SaaS agent that you let call the API is arguably still you using the software, but if the agent's operator's users interact with Stork's functionality, apply the "other users" test.
- Keep `LICENSE`, keep copyright headers, add your copyright line for your changes, and mark modified files with a "Modified by … on <date>" notice (AGPL §5a), for example in the CHANGELOG.

## 5. Single-maintainer concentration

| Maintainer | Packages critical to Stork |
|---|---|
| Andris Reinman (Postal Systems / nodemailer org) | **imapflow, mailparser, nodemailer**, plus transitives `libmime`, `libqp`, `@zone-eu/mailsplit` |
| m4heshd | **better-sqlite3-multiple-ciphers** (encryption at rest) |
| yusukebe | hono, @hono/node-server |
| paulmillr | @noble/hashes |
| cure53 | dompurify |

All of them are currently very active, with releases this month. The **highest structural risk is `better-sqlite3-multiple-ciphers`**. It is a fork of a fork, built natively, holds the encryption format, and has one maintainer. Keep a documented export path, for example a `stork export --mbox` command run while unlocked, so the data is never trapped in the SQLite3MC format.
