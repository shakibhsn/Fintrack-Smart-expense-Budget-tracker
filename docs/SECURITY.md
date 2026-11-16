# FinTrack security review (Phase 19)

Scope: the Express API, the PostgreSQL schema access (Prisma), the browser app, the repository and its dependencies. Method: read the code, wrote attack-style tests (`backend/tests/api/security.test.js`,
43 checks), fixed what they found, re-ran everything. This is a **self-review by the development team, not an independent penetration test.** No claim is made that the application is free of vulnerabilities.

## Findings and what was done

| # | Finding (severity) | Evidence | Fix |
|---|---|---|---|
| 1 | Login timing revealed whether an account exists (medium) | unknown e-mail returned in ~1 ms, wrong password in ~60 ms | a dummy bcrypt comparison is performed for unknown e-mails; test asserts comparable timing |
| 2 | Weak password policy: min 6, no maximum (bcrypt silently ignores bytes past 72) (medium) | code review | min 8, max 72 **bytes**; name <= 100, e-mail <= 254; existing short passwords can still log in |
| 3 | bcrypt cost 10 (low) | code review | cost 12 (`BCRYPT_ROUNDS`, 10-14) |
| 4 | JWT algorithm not pinned (medium, defence in depth) | code review | sign and verify with `HS256` only; tests: `alg:none`, HS512, tampered, expired, wrong secret, deleted user, query-string token all rejected |
| 5 | Server would start in production with a missing/weak `JWT_SECRET` or `CLIENT_URL` unset/`*` (high) | code review | `config/env.js`: production **refuses to start** (exit 1) with a clear message that never prints the secret |
| 6 | CORS: single origin only, `*` fallback (medium) | code review | exact allow-list from comma-separated `CLIENT_URL`; other origins receive no CORS headers (tested) |
| 7 | No `trust proxy` setting: behind a load balancer all users share one IP, so the login limiter locks everyone out, and a spoofable header could be trusted (high for deployment) | design review | `TRUST_PROXY` env; tested both ways (spoofed `X-Forwarded-For` cannot evade the limiter without it; real client counted with it) |
| 8 | Login/register limiter hard-coded and shared (low) | review | `AUTH_RATE_LIMIT_MAX` (default stays 20 per 15 min) |
| 9 | Dates and numbers over-coerced: `null` became 1970-01-01, `2023-02-31` became 3 March, an array became a number (medium, data integrity) | attack tests | strict input guards (`validators/scalar.js`): only real calendar days; only numbers/numeric strings |
| 10 | Money with more than 2 decimals was silently rounded (medium, integrity) | `10.999` stored as `11.00` | rejected with a clear message |
| 11 | Overlapping budgets could be created by simultaneous requests (race condition) (medium, integrity) | 8 parallel requests created 8 budgets | check + insert now run in one transaction under a per-user/category advisory lock |
| 12 | Transaction pages could repeat or skip rows when many rows share a date (medium, integrity) | walking all pages returned 1,056 of 1,305 rows | all sorts end with the unique id as tiebreaker |
| 13 | Dashboard showed a 0% savings rate when there was no income (low, misleading) | integrity test | `null` ("N/A"), consistent with Analytics and Reports |
| 14 | Font Awesome loaded from a CDN without Subresource Integrity (low) | review | SRI hash added (matches the cdnjs-published value) |
| 15 | Stack traces exposed when `NODE_ENV=development` (info) | by design | still only for `development`; production/test never return them; tested. **Never deploy with `NODE_ENV=development`** (the production config check does not stop that; the checklist does). |
| 16 | No secret scanning / `.env.*` not ignored (low) | review | `npm run scan:secrets` (also in CI), `.env.*` ignored, `.env.example` only |

## Verified as already sound (tests added so it stays that way)

- **Authorization:** every data route requires a token (21 routes tested). User B receives 404 for **all 27 tested read/update/delete requests** against user A's transactions, budgets, goals, contributions, subscriptions, recurring schedules, notifications, report snapshots and import batches; A's data is unchanged afterwards; lists, exports, reports and backups of B contain none of A's data. A client-supplied `userId` in a request body is rejected or ignored, never honoured; a restore file carrying foreign ids writes only to the caller.
- **Injection:** SQL, template and traversal payloads in query strings, paths, bodies and the login form never produce a 500 or change data (Prisma parameterises; the two raw queries use bound parameters and validated dates); a `pg_sleep` payload does not run. The AI assistant can only call a whitelist of read-only tools with validated parameters: no SQL or code is generated or executed.
- **XSS:** user text is stored verbatim and served as JSON with `nosniff`; the frontend escapes everything through the `html` template tag (browser tests render `<script>`/`<img onerror>` payloads in transactions and the new pages).
- **Passwords:** bcrypt, salted, never returned (register/login/me/exports/backups checked).
- **Headers:** Helmet defaults (HSTS, nosniff, frame protections, referrer policy), no `X-Powered-By`. Body size limits (100 kB default, 1.5-6 MB on import routes) return 413; malformed JSON returns 400 without parser internals; error bodies never contain stacks, paths, SQL or Prisma text.
- **Uploads / CSV:** type, size, row, column and cell limits; binary and `.xls/.xlsm` refused; formulas never evaluated; CSV/Excel formula-injection neutralised on export; XLSX read through a library with no macro execution.
- **Prototype pollution** keys in JSON bodies are harmless.
- **Dependencies:** `npm audit` reports 0 vulnerabilities for the backend (all dependencies) and the frontend, at the time of review.

## Known limitations and residual risk (honest list)

1. **JWTs are stateless and live in `localStorage`.** Logging out only deletes the browser copy; a stolen token works until it expires (default 7 days). XSS would expose it. Mitigations: strict output escaping, SRI, a CSP (recommended policy in `docs/deployment/OPERATIONS.md`, **not enforced by the app itself**; it must be set by the host) and short lifetimes. A stronger design (httpOnly cookies + refresh/rotation, server-side revocation) was not built.
2. **No password reset, e-mail verification or MFA.** Registration reveals whether an e-mail exists (409); it is rate limited, and avoiding it needs e-mail verification.
3. **No account lockout** beyond the per-IP rate limit; credential stuffing from many addresses is possible.
4. **In-memory rate limiters** are per instance; run a single API instance or move limits to the edge (WAF/CloudFront).
5. `npm audit` only knows published advisories; transitive risk (for example the XLSX parser reading a hostile zip) is bounded by size/row limits but not eliminated.
6. The external AI provider (if enabled by a user) receives the question and aggregate figures; its terms apply.
7. No third-party penetration test, no dependency pinning by hash, no WAF.
