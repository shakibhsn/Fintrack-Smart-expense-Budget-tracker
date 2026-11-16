# Production deployment checklist

Tick every line on **staging first**, then production. Use a **dedicated test account** created for the check (never real users' data, never fabricated records inside a real person's account). Delete the test account afterwards.

## Before
- [ ] Budget alarm created; monthly cost estimate accepted (`ARCHITECTURE.md`).
- [ ] `ci.yml` is green on the commit being released (API suites, browser suites, audit, secret scan).
- [ ] Pending migrations reviewed (additive only?). Database **backup taken and verified** (`db-backup.js` then `db-verify-restore.js` passes).
- [ ] Environment variables set from SSM (nothing in the repository): `NODE_ENV=production`, `DATABASE_URL` (`sslmode=require`), `JWT_SECRET` (>= 32 random chars, different from staging), `CLIENT_URL` (https origin), `TRUST_PROXY=1`.
- [ ] Database is **not** publicly accessible; only the API's security group can reach it.
- [ ] `RUN_MIGRATIONS=true` or the migration step is part of the release.

## After deploy
- [ ] `GET /api/health` 200 and `GET /api/health/ready` 200 with `version` = the released commit, `migrations.ok`, `scheduler.ok`.
- [ ] HTTPS everywhere; HTTP redirects to HTTPS; response headers present (CSP, HSTS, nosniff).
- [ ] CORS: the site works; calling the API from another origin in a browser is blocked.
- [ ] Register + log in + log out; wrong password gives the generic error; the brute-force limiter triggers after 20 attempts from one address and does **not** block other users.
- [ ] Dashboard shows the new account's (empty) state without errors. Create, edit and delete a transaction; totals update.
- [ ] Create a budget and exceed 90% -> one notification, once. Savings goal + contribution (dashboard income/expense unchanged).
- [ ] Subscription: create, pause, resume; no payment is assumed. Recurring schedule: create one that starts today and confirm the transaction appears **without opening the app again after the scheduler tick** (wait one tick or check the log line `[recurring]`).
- [ ] Reports: PDF and CSV download (open the PDF; Bangla text and the taka sign display).
- [ ] Import a small CSV and an XLSX (preview -> confirm -> undo). Export CSV + full backup; restore the backup into a second test account (merge).
- [ ] Notifications page and the unread badge; if e-mail is configured: the test e-mail arrives.
- [ ] AI assistant: asks "How much did I spend this month?" (answer matches the dashboard). If the provider key is set: opt in and confirm the AI-worded label; otherwise confirm it says calculated by FinTrack.
- [ ] Mobile: phone-width navigation drawer, tables, dialogs, file pickers (real device). Dark mode toggle persists after reload.
- [ ] **Isolation:** second test account cannot see the first one's data (try a known id in the URL: 404).
- [ ] Logs: request lines visible in CloudWatch with request ids; no tokens/passwords/e-mails in them. An alarm test fires (e.g. temporarily lower a threshold).
- [ ] Backups: RDS automated backup exists and a restore drill into staging succeeded within the time you wrote down.
- [ ] Rollback rehearsed on staging (redeploy the previous image tag).
- [ ] Test account deleted. Live URL recorded in the README **only now**.
