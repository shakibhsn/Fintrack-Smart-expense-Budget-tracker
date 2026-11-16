# FinTrack operations guide

Covers: setup, environment variables, CI/CD, database backup and restore, monitoring, rollback and troubleshooting. Read `ARCHITECTURE.md` first. **Nothing in this guide has been executed
against AWS** (no account access, no approval to provision); the commands are standard and the local parts (Docker files, backup scripts, health endpoints, CI workflow logic) are what was tested.

## 1. Environments

| | Development | Staging | Production |
|---|---|---|---|
| Where | your machine | AWS (separate resources) | AWS (separate resources) |
| Database | `fintrack` on local PostgreSQL | its own database, its own user | its own database/instance, its own user |
| `NODE_ENV` | `development` | `production` | `production` |
| Automated tests | **never against a real database** - only `fintrack_test` | never | never |
| CORS (`CLIENT_URL`) | `http://localhost:5500` | the staging site origin (https) | the production site origin (https) |
| Secrets | `.env` (git-ignored) | SSM Parameter Store | SSM Parameter Store |

Rules: staging and production never share a database or a `JWT_SECRET` (a token from one must not work in the other). The CI job uses a throw-away PostgreSQL container that exists only for that job.

## 2. Environment variable reference (no secrets here)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | - | PostgreSQL URL. Production: `?sslmode=require` and a least-privilege user. |
| `JWT_SECRET` | yes | - | >= 32 random characters. **Production refuses to start** if missing/short/placeholder. |
| `JWT_EXPIRES_IN` | no | `7d` | Token lifetime (tokens cannot be revoked early; prefer 1-7 days). |
| `NODE_ENV` | yes in prod | - | Must be `production` when deployed (hides stack traces, enforces config checks). |
| `CLIENT_URL` | yes | - | Exact frontend origin(s), comma separated, `https://` in production. `*` is refused in production. |
| `PORT` | no | 5000 | Listen port. |
| `TRUST_PROXY` | behind a proxy | unset | Number of proxy hops (`1`). Without it, the limiter sees the proxy's IP for everyone. |
| `RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX` | no | 300 / 20 | Requests per 15 min per IP (general / login+register). |
| `EXPORT_RATE_LIMIT_MAX` / `IMPORT_RATE_LIMIT_MAX` / `AI_RATE_LIMIT_MAX` | no | 30 / 20 / 20 | Per user per minute. |
| `BCRYPT_ROUNDS` | no | 12 | Password hashing cost (10-14). |
| `RUN_MIGRATIONS` | no | unset | `true` = the container applies pending migrations at start (see section 5). |
| `RECURRING_SCHEDULER` / `RECURRING_TICK_MS` | no | on / 900000 | Background jobs. Keep **on** in production. |
| `LOG_LEVEL` | no | `info` | `debug` `info` `warn` `error`. |
| `GIT_SHA` | set by the build | `unknown` | Shown by `/api/health/ready` so a deploy can verify the new version is live. |
| `SMTP_HOST`, `EMAIL_FROM`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `APP_URL`, `EMAIL_HOURLY_CAP` | optional | - | E-mail notifications (off unless host + from are set). With Amazon SES use its SMTP endpoint and SMTP credentials. |
| `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_API_URL`, `AI_TIMEOUT_MS`, `AI_ENABLED`, `AI_DAILY_PROVIDER_LIMIT` | optional | - | External AI model for the assistant (off unless a key is set). |
| `PG_BIN` | scripts only | PATH | Folder with `pg_dump`/`pg_restore`/`psql` for the backup scripts. |

Frontend: `runtime-config.js` sets `window.FINTRACK_CONFIG = { apiBaseUrl: 'https://<api>/api' }` and is written per environment by the deploy workflow. It is public: never put a secret in it.

## 3. First-time setup (when you decide to deploy)

1. **Decide the hosting option** (ARCHITECTURE.md section 2/3) and set a **budget alarm** in AWS Budgets before creating anything.
2. Create the AWS account structure: a deploy role for GitHub **OIDC** (trust only `repo:<you>/<repo>:environment:<env>`; permissions limited to: push to one ECR repository, update one App Runner service, sync one S3 bucket, invalidate one CloudFront distribution). No access keys.
3. Create: ECR repository, RDS PostgreSQL (private, automated backups >= 7 days, deletion protection ON), security group allowing only the App Runner VPC connector, SSM SecureString parameters (`JWT_SECRET`, `DATABASE_URL`, optional SMTP/AI), App Runner service (port 5000, health check path `/api/health/ready`, 1 min / 1 max instance, env + secrets from SSM), S3 bucket (private, CloudFront origin access control), CloudFront distribution (default root `login.html`; response-headers policy below).
4. In GitHub: create Environments `staging` and `production` (production: required reviewers), set the variables listed in `deploy.yml` and the repository variable `DEPLOY_ENABLED=true`.
5. Set `CLIENT_URL` on the API to the CloudFront origin, `TRUST_PROXY=1`, `NODE_ENV=production`.
6. Take a backup, then release (section 5). Create a **dedicated test account** and run the production verification list (`CHECKLIST.md`).

Recommended CloudFront response-headers policy (the HTML pages contain one small inline script, so use its hash instead of `unsafe-inline`; compute it with `openssl dgst -sha256 -binary | base64` after any edit):
`Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-<hash of the inline theme script>' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:; img-src 'self' data:; connect-src 'self' https://<api-domain>; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` plus `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`. (Inline `style=""` attributes are used throughout the UI, hence `style-src 'unsafe-inline'`.) **Test the policy on staging first**; a wrong CSP breaks the app.

## 4. CI/CD

`.github/workflows/ci.yml` (every push/PR, and reused by deploy): backend job = install, Prisma generate, **apply all migrations to an empty PostgreSQL service**, `npm audit --omit=dev` (high/critical fail), secret scan, then **all API suites** (`tests/api/run-all.sh`: phases 1-17, AI, security, integrity); frontend job = install, `npm audit`, build, start the API, headless Chrome, **all browser suites**.
`.github/workflows/deploy.yml` (manual, off until `DEPLOY_ENABLED=true`): CI must pass -> build the image tagged with the commit SHA -> push to ECR -> roll App Runner -> **wait until `/api/health/ready` reports the new SHA** (fails the deploy otherwise) -> build + upload the frontend with the environment's `runtime-config.js` -> invalidate CloudFront -> smoke test. Production requires a human approval on its GitHub Environment.
**The workflows have not been run on GitHub** (they need the repository and AWS side); they were reviewed against the local commands they wrap, which were run.

## 5. Releases and database migrations

1. **Backup first** (section 6) whenever the release contains a migration.
2. Migrations are applied with the project's workflow, `prisma migrate deploy` (only applies committed, reviewed migrations; never resets or generates). Two supported ways: (a) set `RUN_MIGRATIONS=true` on the service so the container applies them before listening (an advisory lock makes concurrent starts safe; if it fails the new container exits and App Runner keeps the old one); (b) run it from a one-off task/`docker compose run --rm migrate`.
3. Migrations in this project are additive (new tables/nullable columns) so the previous app version keeps working against the migrated database: that makes a code rollback safe without a database rollback.
4. Destructive changes (dropping/renaming columns) need a two-step release (stop using it, then remove it) and **your explicit approval**.

## 6. Database backup and restore

Scripts (read-only against the source): `backend/scripts/db-backup.js` and `db-verify-restore.js` (need the PostgreSQL client tools; set `PG_BIN` on Windows).
```
DATABASE_URL=postgresql://... node scripts/db-backup.js --out ../backups          # writes <db>-<time>.dump + .sha256, verifies it can be read back
DATABASE_URL=postgresql://<admin>@<same server> node scripts/db-verify-restore.js ../backups/<file>.dump --compare-to postgresql://<source>
```
`db-verify-restore.js` restores into a scratch database (`fintrack_verify_<time>`, dropped afterwards), compares row counts per table with the source, and exits non-zero if anything differs. **A backup counts only after this passes.** Both scripts were tested on the test database (64,257 rows restored and matched).
- **Schedule:** RDS automated backups (7-35 days, point-in-time recovery) as the first line; plus a weekly `db-backup.js` dump copied to a private, versioned S3 bucket (encrypt, lifecycle 90 days) as an independent copy.
- **Restore into production** (disaster): stop the API (set App Runner to 0 / pause), restore with `pg_restore --clean --if-exists --no-owner -d <db> <file>` or an RDS point-in-time restore into a NEW instance and repoint `DATABASE_URL`, run `prisma migrate deploy`, start the API, run the verification list. Practise this on staging before you need it; record how long it takes.
- **User-level backups** (Export & Backup page, JSON) protect one account, not the system.

## 7. Monitoring and alerts

- **Liveness** `GET /api/health` (process answers) and **readiness** `GET /api/health/ready`: database reachable, **all migrations applied**, background scheduler healthy (last pass finished within 3 ticks, no error), plus `version` (commit SHA). HTTP 503 when not ready. Use readiness for App Runner/ALB health checks and the deploy gate.
- **Logs:** one JSON line per request (`reqId`, method, path without query, status, ms, user id) and structured errors; never bodies, tokens, passwords or e-mail addresses. Send stdout to CloudWatch Logs (App Runner does this). Every response carries `X-Request-Id`; ask users for it when they report an error.
- **Alarms (CloudWatch)**: App Runner `5xxStatusResponses` > 5 in 5 min; no healthy instances; RDS CPU > 80% for 15 min, free storage < 2 GB, connections near max; a **metric filter** on logs containing `"level":"error"`; a billing alarm. Send alarms to an SNS e-mail topic.
- **Background jobs:** the scheduler status is inside `/api/health/ready` (`checks.scheduler`). Alarm on readiness failures. Recurring/subscription work is idempotent, so a missed tick is caught up on the next one and when users open the app.
- **Error monitoring:** structured error logs + CloudWatch alarm are in place. A third-party error tracker (Sentry etc.) is **not** integrated; add it if you want grouped stack traces.
- **Graceful shutdown:** on `SIGTERM` the API stops accepting connections, finishes in-flight requests (10 s), stops the scheduler and closes the database pool, so deploys do not cut requests.

## 8. Rollback

| Situation | Action |
|---|---|
| Bad code release, database unchanged or only additive migrations | Redeploy the previous image tag (the commit SHA is the tag): `aws apprunner update-service ... ImageIdentifier=<repo>:<previous sha>`, or rerun the deploy workflow on the previous commit. App Runner also keeps the old version running if the new one fails its health check. |
| Bad frontend release | Re-run the deploy on the previous commit (re-uploads the previous files and invalidates CloudFront). Enable S3 bucket **versioning** to restore single files. |
| Bad migration | Do **not** hand-edit. Restore the pre-release backup into a new database (section 6), repoint the API, fix the migration in git, release again. This is why the backup comes first. |
| Secret leaked | Rotate in SSM, redeploy. Rotating `JWT_SECRET` signs every user out (acceptable). Rotate DB credentials and SMTP/AI keys the same way. |

## 9. Troubleshooting

| Symptom | Likely cause | Check / fix |
|---|---|---|
| API exits immediately, log says `[config] ERROR` | unsafe production configuration | read the message: weak `JWT_SECRET`, missing/`*`/non-https `CLIENT_URL`, no `DATABASE_URL`. |
| Browser: CORS error | `CLIENT_URL` does not exactly equal the page origin (scheme + host + port, no trailing slash) | fix the variable; multiple origins comma separated. |
| Everyone gets "Too many attempts" | `TRUST_PROXY` not set behind a proxy | set `TRUST_PROXY=1`. |
| `/api/health/ready` 503 `migrations` | pending migrations | take a backup, run `prisma migrate deploy` (or `RUN_MIGRATIONS=true`). |
| `/api/health/ready` 503 `database` | network / credentials / SSL | security groups, `sslmode=require`, credentials in SSM. |
| `checks.scheduler.ok=false` | the job keeps failing or the process was starved | read the `[recurring]` log lines, check DB load; restart the service. |
| Login works locally, 401 in production | `JWT_SECRET` differs between instances/environments | one secret per environment, same on every instance. |
| PDF text shows `?` | characters outside Latin/Bengali | by design (CSV keeps the original text). |
| E-mail "failed" badge | SMTP rejected the mail | `[email] send failed: <code>` in the log (code only). Verify SES sandbox/sender verification. |
| AI answers always "calculated by FinTrack" | no key, or the user did not opt in, or the daily cap was reached | `GET /api/ai/status`. |
| Uploads rejected with 413 | file over the documented limits (CSV 1 MB, XLSX 2 MB, backup 5 MB) | split the file. |
