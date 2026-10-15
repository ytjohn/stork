# Stork — security findings (audit/security)

**Scope:**
- authentication and authorization
- transport security
- crypto and key management
- HTML rendering and XSS
- SSRF
- webhook
- security headers
- encryption at rest
- container
- dependencies

All PoCs ran against a local instance on 127.0.0.1 with mock servers. No real accounts or external hosts were contacted.

**Run:**
```bash
cd frontend && npx vite build && cd ..   # one-time, for the browser PoC
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
  npx vitest run --config audit/vitest.config.ts audit/security
```
Result when written: 18 tests in 9 files, all passing in ~92 s. Tests assert current (vulnerable) behaviour.

| ID | Finding | Severity | Status |
|---|---|---|---|
| C1 | No per-request auth after unlock; wildcard CORS; no lock/logout | Critical | EXPLOITABLE |
| C2 | Pre-setup takeover | High | EXPLOITABLE |
| H1 | Stored XSS via `attachments/by-cid` | High | EXPLOITABLE |
| H2 | SMTP/IMAP STARTTLS accepts any certificate | High | EXPLOITABLE (needs MITM) |
| M1 | Remote images fetched before stripping | — | REFUTED |
| M2 | Unlock blocks event loop; weak global rate limit | Medium/High | EXPLOITABLE (DoS) |
| M3 | SSRF via `test-smtp` and R2 `account_id` | Medium/High | EXPLOITABLE |
| M4 | `STORK_FAST_KDF` persists; password change → lockout | Medium/High | EXPLOITABLE (data loss) |
| W1 | Webhook secret returned by list API; non-constant-time compare | Medium | EXPLOITABLE |
| X1 | CSRF via text/plain; framable; missing headers | Medium | EXPLOITABLE / THEORETICAL |
| K1 | Container runs as root | Medium | THEORETICAL |
| D1 | Dependency advisories | Medium | Mixed reachability |

## C1 — No per-request auth after unlock; wildcard CORS; no lock/logout — Critical — EXPLOITABLE

**PoC:** `c1-auth-cors.test.ts`. **Precondition:** the instance is unlocked (its normal state); the attacker has no credentials.

**Cause:**
- Once `/api/unlock` succeeds, `context.state = "unlocked"` for the life of the process.
- The lock middleware (`src/api/server.ts:70-75`) then lets every `/api/*` route through with no token, cookie or session.
- There is no `/api/lock` or `/api/logout` (both 404).
- `cors()` (`server.ts:25`) answers `Access-Control-Allow-Origin: *`. The app uses no cookies, so the wildcard works without credentials.

**Observed:**
- `GET /api/messages/1` with `Origin: https://evil.example` → 200, ACAO `*`, body contains `SECRET: wire $50k`.
- An unauthenticated `POST /api/send` delivered mail as the victim to the attacker (captured by the mock SMTP server).

**Fix:**
- Mint a session token (or HttpOnly SameSite=Strict cookie) at unlock and require it on `/api/*`; compare with `crypto.timingSafeEqual`.
- Add `POST /api/lock`, which closes the DB and sets state to "locked", plus an idle timeout.
- Replace `cors()` with an explicit allowlist, or remove it (the SPA is same-origin).

## C2 — Pre-setup takeover — High — EXPLOITABLE

**PoC:** `c2-setup-takeover.test.ts`. **Precondition:** the instance is deployed but not yet set up, and the attacker reaches it first.

**Cause:**
- `GET /api/status` → `{state:"setup"}` tells anyone the instance is unclaimed.
- `POST /api/setup` (`encryption.ts:38-53`) checks only `state === "setup"`.
- So the first caller sets the password, receives the 24-word mnemonic, and the container unlocks. The operator then gets 409.

**Observed:** status reported setup; the first setup returned 201 with 24 words and the instance unlocked; the second setup got 409.

**Fix:**
- Require an out-of-band bootstrap secret (env var or mounted file), or a one-time token printed to the logs.
- Alternatively, allow setup only from loopback.

## H1 — Stored XSS via `attachments/by-cid` → mailbox read on the app origin — High — EXPLOITABLE

**PoC:** `h1-m1-browser.test.ts`, in real Chromium. **Precondition:** the attacker can send the victim an email with cid parts, and the victim opens one link.

**Cause:**
- `GET /api/attachments/by-cid/:messageId/:contentId` (`attachments.ts:46-70`) serves the sender-controlled Content-Type with no Content-Disposition and no nosniff.
- So a `text/html` cid part renders on the app origin.
- The SPA CSP does attach (`script-src 'self'`). But a sibling cid part referenced as `<script src="/api/attachments/by-cid/<id>/<jscid>">` is same-origin, so it is allowed.
- The attacker's JS then reads mail via `connect-src 'self'` and exfiltrates it by top-level navigation, which this CSP does not restrict.

**Observed in Chromium:**
- Headers: `text/html`, no content-disposition, no nosniff, `script-src 'self'`.
- `window.__xss_ran === true`.
- `#exfil` contained `SECRET-INBOX-CONTENT-7f3a9` from `/api/messages/<id>`.
- The tracker received `/steal?d=SECRET-INBOX-CONTENT-7f3a9`.

The in-app `SandboxedEmail` iframe is not the hole; navigating directly to the route is.

**Fix:**
- In both attachment handlers, send: `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.
- For by-cid, return inline content only for an allowlist of raster image types, and `application/octet-stream` otherwise.
- Ideally, serve attachments from a separate origin.

## H2 — STARTTLS accepts self-signed certs; credentials harvested by MITM — High — EXPLOITABLE (needs MITM)

**PoC:** `h2-smtp-tls.test.ts`.

**Cause:**
- `SmtpSendConnector` sets `tls: { rejectUnauthorized: config.secure }` (`smtp.ts:31`).
- STARTTLS on port 587 means `smtp_tls=0` → `secure=false` (`send.ts:110`), which turns certificate verification off.

**Observed:** against a local STARTTLS trap with a self-signed cert, `verify()` returned true, STARTTLS was used, and the trap captured `user=victim@corp.example pass=SuperSecretPassw0rd`.

IMAP (`imap.ts:31-36`) has the same gap, argued from code (no live IMAP trap was built). Neither connector sets `requireTLS`, so a STARTTLS-stripping attacker gets plaintext AUTH.

**Fix:** `tls: { rejectUnauthorized: true, servername: config.host }` plus `requireTLS: true` whenever implicit TLS is off.

## M1 — Remote images fetched before stripping — REFUTED

**PoC:** the M1 case in `h1-m1-browser.test.ts`.

**Prior claim:** a detached `div.innerHTML = rawHtml` (`email-sanitizer.ts:25,108`; `ThreadMessage.tsx:130`) prefetches remote `<img>` URLs.

**Observed in Chromium:**
- `innerHTML` on a detached node triggered 0 image loads; images load only once connected.
- The render path is a sandboxed iframe whose srcdoc CSP is `img-src data: <origin>/api/` while blocking is on.

Not exploitable. Using `DOMParser` would still be more robust.

## M2 — Unlock blocks the event loop; weak global rate limit — Medium/High — EXPLOITABLE (DoS)

**PoC:** `m2-unlock-dos.test.ts`.

**Cause:**
- `unlockWithPassword` runs @noble Argon2id synchronously on the main thread (`keys.ts:63-71`).
- At production parameters (64 MiB, t=3), one call blocked the event loop for **~4.8 s** (environment-dependent).
- The limiter (`encryption.ts:16-25,84-89`) is a single global counter, incremented only *after* the KDF. So N concurrent wrong attempts all run.
- The counter is process-global, so one attacker also delays the operator.
- It lives in memory, so a restart resets it.

**Observed:** 8 concurrent wrong unlocks were all processed (401).

**Fix:**
- Move the KDF to a worker thread or native addon.
- Gate the delay *before* the KDF, with a single-flight mutex plus a per-source counter.

## M3 — SSRF via `/api/send/test-smtp` and R2 `account_id` — Medium/High — EXPLOITABLE

**PoC:** `m3-ssrf.test.ts`.

**(a) test-smtp.** Unauthenticated `POST /api/send/test-smtp` (`send.ts:212-227`) dials any host:port. Observed: an inbound connection to an internal listener.

**(b) R2.**
- The R2 poller builds `https://${cf_r2_account_id}.r2.cloudflarestorage.com` (`r2-poller.ts:261`).
- An `account_id` of `127.0.0.1:<port>/` ends the authority early, so the host becomes `127.0.0.1:<port>`.
- Observed: the parsed host was 127.0.0.1:<port>, the request carried a signed `Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE` header (asserted from the signer's output, since the wire bytes are TLS), and the connection reached the listener.
- The `@` userinfo form is rejected by fetch; the path-split form is not.

**Fix:**
- Validate `account_id` against `^[a-f0-9]{32}$`.
- Deny loopback, RFC1918 and link-local addresses for user-supplied hosts (resolve, then pin the IP).
- Require auth (C1) on test-smtp.

## M4 — `STORK_FAST_KDF` persists; password change drifts KDF params → lockout — Medium/High — EXPLOITABLE (data loss)

**PoC:** `m4-kdf-lockout.test.ts`.

**Cause:**
- `initializeEncryption` writes the module's KDF params into `stork.keys` (`keys.ts:146-154`). A file created with FAST_KDF therefore records `memoryCost=1024, timeCost=1`.
- `changePassword` (`:235-241`) and `setPasswordFromVaultKey` (`:352-356`) derive the new key-encryption key at the current module params, but update only `kdf.salt`.
- So with a FAST-created file plus a production password change, the next unlock re-derives using the stale params. GCM unwrap fails, and the correct password is locked out.

**Observed across child processes:** the file stayed at 1024/1 after the production-mode password change, and unlocking with the correct new password threw `Decryption failed`.

**Fix:**
- Write the params actually used on every re-wrap.
- Refuse to boot in production below a param floor, or auto-upgrade the params on unlock.
- Honour `STORK_FAST_KDF` only when `NODE_ENV=test`.

## W1 — Webhook secret exposure; non-constant-time compare — Medium — EXPLOITABLE

**PoC:** `webhook-headers.test.ts`.

- `GET /api/connectors/inbound` returns `cf_email_webhook_secret` in cleartext (`connectors.ts:66`).
- With C1, any origin can read it and forge inbound mail via `POST /api/webhook/cloudflare-email/:id`. Observed: the secret appears in the JSON, and a forged email was stored (200).
- `timingSafeEqual` (`webhook.ts:107-114`) is hand-rolled and returns early on a length mismatch, leaking the length.

**Fix:**
- Never return secrets from list endpoints; return a boolean "configured" instead.
- Use `crypto.timingSafeEqual` on fixed-length digests.

## X1 — CSRF, clickjacking, missing headers — Medium — EXPLOITABLE / THEORETICAL

**PoC:** `webhook-headers.test.ts`.

- **CSRF:** the body is parsed as JSON regardless of Content-Type. A `text/plain` POST, which needs no preflight, to `/api/send/test-smtp` succeeded and dialed out.
- **Missing API headers:** API responses (e.g. `GET /api/health`) have no CSP, X-Frame-Options or X-Content-Type-Options.
- **Framing:** the SPA CSP (`server.ts:36-47`) sets `frame-src` but not `frame-ancestors`, and there is no XFO, so the app is framable (THEORETICAL; no UI-redress payload was built).

**Fix:**
- Add `frame-ancestors 'none'`, plus global `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.
- Reject non-JSON Content-Type on mutations.
- Put mutations behind the C1 token.

## Encryption at rest — Info — DONE WELL (verified)

**PoC:** `sqlcipher-at-rest.test.ts`.

- The main DB, the attached blobs DB and the WAL are all encrypted: the plaintext marker is absent and there is no `SQLite format 3` header.
- The blobs DB is attached under the same vault key (`db.ts:15`).
- `temp_store=MEMORY` (`db.ts:74`).
- `stork.keys` is mode 0600 (`keys.ts:127`).
- A wrong 32-byte key cannot open the DB.
- Key design:
  - A random master key, wrapped by an Argon2id-derived key and by a BIP39 recovery envelope.
  - GCM tags are checked.
  - Rotation is O(1).
- The default cipher is ChaCha20-Poly1305 (sqleet), not AES-256 as the docs say; see `audit/arch/MAINTAINABILITY.md`.

**Operational note (not a code bug):**
- There is no backup or export endpoint; backup means copying the data dir.
- A hot copy can catch an inconsistent WAL, so checkpoint first, then copy.
- Restore needs `stork.keys` plus the password or mnemonic.
- Losing `stork.keys` without the mnemonic is unrecoverable.

## Credential and key storage, logging — Info/Low

- IMAP, SMTP, SES and R2 secrets are plaintext columns inside the encrypted DB.
- `/api/connectors/inbound` omits `imap_pass` and the R2 secret, but leaks the webhook secret (W1).
- No credentials appear in `console.*` (grep is clean).
- **Low:** if unlock succeeds but opening the DB fails, the API returns `e.message` to the client (`encryption.ts:96`), which can disclose a path. Return a generic error.
- The recovery mnemonic is returned once and never persisted in plaintext; only the wrapped envelope is stored.
- The vault-key Buffer is zeroed after the DB opens (`lifecycle.ts:108`). But the key also exists as an immutable hex string inside the PRAGMA (`db.ts:35`), which can't be zeroed.

## Multi-account isolation and agent authz — Info (design gap)

- Stork is single-user: there are no users, sessions, tokens or api_keys tables.
- The webhook bearer secret is the only authorization check anywhere.
- Identities and connectors are global to the unlocked process.
- The planned agent API has no scoped-token or capability model to build on; design one alongside the C1 fix.

## K1 — Container / Kubernetes — Medium — THEORETICAL

**Finding:**
- The Dockerfile runs as root (no `USER`), with a writable root FS and no dropped capabilities.
- A healthcheck is present.
- The data dir `/app/data` is writable.

**Fix:**
- Add `USER node` and `chown /app/data`.
- k8s `securityContext`:
  - `runAsNonRoot`, `runAsUser: 1000`
  - `readOnlyRootFilesystem`
  - `allowPrivilegeEscalation: false`
  - `capabilities.drop: [ALL]`
- Use a PVC at `/app/data` as the only writable path.
- Don't expose `/api/setup` or `/api/unlock` beyond the proxy's auth.

## D1 — Dependency vulnerabilities — Medium — mixed reachability

`npm audit` (full tree, including dev): root 16 advisories (11 high), frontend 18 (11 high), 0 critical.

**Reachable at runtime:**
- **hono:** the high set includes "CORS reflects any Origin with credentials when origin defaults to wildcard", which is C1.
- **nodemailer:** address-parser ReDoS, recipient-domain bypass and CRLF header injection are reachable via `/api/send`.
- **mailparser → linkify-it:** quadratic-time DoS on inbound parsing.
- **ws, nanoid:** present.

**Not reachable:**
- The nodemailer "OAuth2 token-fetch cert validation" advisory: Stork uses only user/pass auth, never OAuth2. H2 is a separate bug in Stork's own `tls` option.

**Build-time only (pruned by `npm prune --omit=dev`):** vite, esbuild, postcss, tailwindcss, braces/micromatch/fast-glob, vitest.

**dompurify 3.4.0:** a moderate mXSS advisory. The iframe without `allow-scripts` is the backstop; upgrade anyway.

**Action:** update hono, nodemailer, imapflow, mailparser, ws, nanoid and dompurify, then re-audit.

## Done well

- Encryption at rest, verified (above).
- The `SandboxedEmail` iframe:
  - `sandbox` without `allow-scripts`, plus a tight srcdoc CSP.
  - `allow-same-origin` is safe only because scripts are blocked.
  - `allow-popups` popups inherit the sandbox.
  - DOMPurify strips script, form, meta, `on*` handlers and `javascript:` URLs.
  - mXSS, form phishing and CSS exfiltration are all gated by "no script + no remote fetch".
- The attachment download route (`/:attachmentId`) forces `Content-Disposition: attachment` and sanitises filenames against CRLF, quotes and paths, with RFC 5987 encoding (`attachments.ts:26-35`). by-cid is the H1 exception.
- All SQL is parameterised. Dynamic `SET` clauses use allowlisted column names.

## Could not run / limitations

- No live IMAP STARTTLS or plaintext-AUTH harness was built. The IMAP case is argued from code; the SMTP path proves the identical bug.
- The M2 timing (~4.8 s) is environment-dependent. The structural bug (synchronous main-thread KDF, global counter incremented after the attempt) is not.
- Clickjacking is shown only as "framable"; no UI-redress payload was built.
- R2 SSRF: the SigV4 header is asserted from the signer's output, because the wire bytes are inside TLS.
