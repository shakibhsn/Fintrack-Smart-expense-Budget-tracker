# Backend API tests

Plain Node scripts (no framework) that call a **running test backend** over HTTP and, for service-level checks, use Prisma in-process against the
**same test database**. They create their own users and data, so run them against a throw-away database, **never your real one**.

```bash
# 1. a test database with every migration applied
createdb fintrack_test
DATABASE_URL="postgresql://USER:PASS@localhost:5432/fintrack_test?schema=public" npx prisma migrate deploy

# 2. the test backend on :5055 (restart it between suites: it resets the in-memory rate limiters)
DATABASE_URL="postgresql://USER:PASS@localhost:5432/fintrack_test?schema=public" PORT=5055 CLIENT_URL=http://localhost:5600 \
  RECURRING_SCHEDULER=off RATE_LIMIT_MAX=100000 EXPORT_RATE_LIMIT_MAX=1000 IMPORT_RATE_LIMIT_MAX=1000 EMAIL_TEST_RATE_LIMIT_MAX=1000 \
  SMTP_HOST=127.0.0.1 SMTP_PORT=2525 SMTP_IGNORE_TLS=true SMTP_USER=mailuser SMTP_PASS=s3cret-pass-xyz EMAIL_FROM="FinTrack <noreply@fintrack.test>" node src/server.js

# 3. a suite (in another terminal); the in-process helper derives the test URL from .env (…/fintrack -> …/fintrack_test) or use TEST_DATABASE_URL
cd backend/tests/api
node phase16.test.js
```

| Suite | Covers |
|---|---|
| `regression.test.js` | auth, transactions, budgets, goals, dashboard, user isolation (phases 1-4) |
| `phase5` … `phase12*` | analytics, goal accounting, insights, health score, forecast, unusual spending, simulator, recurring (incl. reliability / pure maths) |
| `phase13.test.js` | subscription maths, statuses, boundaries, no-duplicate payments, auto-record policies, isolation |
| `phase14.test.js` | notification preferences, budget transitions, goal milestones, subscription reminder windows, de-duplication under concurrency, read/unread/delete, isolation |
| `phase15.test.js` | reports: periods, consistency with Analytics/Dashboard, zero income, negative savings, budget overlap, subscriptions estimate vs actual, CSV, PDF (magic bytes + extracted text), snapshots, limits, isolation |
| `phase17.test.js` | optional e-mail notifications against a local SMTP sink (`smtpSink.js`): opt-in, one mail per event, concurrency, escaping/header injection, isolation, failing SMTP, no credential leaks, a server without SMTP |
| `ai.test.js` | AI assistant: every supported question against known data, intent parsing, insufficient data, isolation, SQL/prompt injection, recommendations (rules, evidence, estimates, dismiss, no baseline), settings, a STUB provider (opt-in, payload contents, invented-number rejection, 500/garbage/timeout fallback, classification whitelist), daily cap and rate limit, usage log contents |
| `phase16.test.js` | CSV parser, import validation/duplicates/limits/rollback/undo/history, exports + formula injection, backup contents (no secrets), restore preview/merge/replace/rollback, isolation, rate limiter |

Each prints `PASS`/`FAIL` lines and a summary; the exit code is non-zero if anything failed. Several suites assume the current date is between the 5th and 26th of a month
for month-to-date comparisons.
