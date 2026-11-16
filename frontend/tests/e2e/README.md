# Frontend end-to-end tests

Browser tests (puppeteer, a real headless browser) for the modular frontend: routing, auth guard, lazy loading, error isolation,
every feature's flows, responsive behaviour at 1440 / 1280 / 768 / 390 px, WCAG contrast of the design tokens, leak checks
across repeated navigation, and basic performance measurements.

They create their own users and data through the API, so run them against a **test database, never your real one**.

## Setup

```bash
cd frontend/tests/e2e
npm install                      # puppeteer-core (uses your installed Edge/Chrome)

# 1. a test backend on :5055 using a separate database, allowing the harness origin and a higher request limit
#    (create the DB and run `npx prisma migrate deploy` against it first)
cd ../../../backend
DATABASE_URL="postgresql://…/fintrack_test?schema=public" PORT=5055 CLIENT_URL=http://localhost:5600 RATE_LIMIT_MAX=20000 \n  SMTP_HOST=127.0.0.1 SMTP_PORT=2525 SMTP_IGNORE_TLS=true EMAIL_FROM="FinTrack <noreply@fintrack.test>" node src/server.js   # SMTP vars: only the notifications suite uses them (it starts a local sink on :2525)

# 2. a Chromium-based browser with remote debugging on :9333, e.g.
msedge --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/fintrack-e2e about:blank
#    (chrome works the same way)
```

## Run

```bash
node core.test.js           # routing, guard, lazy loading, error isolation, sidebar/drawer, theme, menus, keyboard, a11y on every page (the sidebar link count is read from src/core/routes.js)
node transactions.test.js   # filters, pagination, add/edit/delete, modal accessibility, XSS safety, error + slow network
node features-a.test.js     # budgets, savings goals, analytics
node features-b.test.js     # insights, health score, forecast, unusual spending, simulator, recurring
node login.test.js          # sign in / register / expired session
node quality.test.js        # responsive widths, contrast, leaks, performance
node subscriptions.test.js  # subscription tracker (Phase 13)
node notifications.test.js  # notification center, preferences, badge, bell, e-mail opt-in against a local SMTP sink (Phase 14)
node reports.test.js        # reports page, periods, snapshots, PDF/CSV downloads (Phase 15)
node ui.test.js            # design system, dark mode, theme persistence, contrast/overflow/labels on every page, focus, phone drawer (Phase 18)
node ai.test.js            # AI assistant page: questions, period filter, errors/retry, recommendations, settings (Phase 17)
node import-export.test.js  # CSV import flow, history/undo, exports, backup and restore (Phase 16)
```

Each prints `PASS`/`FAIL` lines and a summary; the exit code is non-zero if anything failed.
The harness (`harness.js`) serves the frontend on :5600 with correct module MIME types and rewrites API calls from `:5000` to the test backend on `:5055`.
The Phase 13-16 suites need the test database migrated through migration 9 (`npx prisma migrate deploy`), and the test backend's default export/import rate limits are fine for them.
Several suites assume the current date is between the 5th and 26th of a month for month-to-date comparisons.
