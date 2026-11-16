# FinTrack — Full-Stack Personal Finance Tracker

FinTrack is a personal finance tracker: transactions, budgets, savings goals, subscriptions and recurring payments, analytics, forecasts, reports (PDF/CSV),
import/export/backup, notifications and an AI assistant. Every number the frontend shows is calculated from PostgreSQL through the Express API (no mock or
hard-coded financial data), and every record is private to the signed-in user.

> **Project status (honest summary).** Phases 1-20 of the plan are implemented and tested on a developer machine. **It is not deployed**: no cloud account was provisioned,
> there is **no live URL**, the CI/CD workflows have not been run on GitHub, and nothing was tested on physical phones. See [Known gaps before real users](#known-gaps-before-real-users).

```
Browser (static modules) → REST API (Express) → Prisma ORM → PostgreSQL
                              ├─ background scheduler (recurring, subscriptions, reminders)
                              ├─ optional SMTP e-mail      └─ optional AI provider (opt-in)
```

## Technology stack

| Layer | Technology |
|---|---|
| Frontend | Native ES modules, hash routing, a small shared component library, Tailwind CSS (local build), Chart.js (local bundle); no framework |
| Backend | Node 20, Express 4, Zod validation, JWT (HS256) + bcrypt, Helmet, express-rate-limit |
| Data | PostgreSQL, Prisma 5 (11 additive migrations) |
| Documents | pdfkit (PDF, Noto Sans + Bengali fonts), exceljs (XLSX import), nodemailer (optional e-mail) |
| Testing | Plain Node API suites (~900 checks) and puppeteer browser suites (~700 checks), run against a separate `fintrack_test` database |
| Delivery | Dockerfile, docker-compose, GitHub Actions CI + manual deploy workflow (AWS OIDC), backup/restore scripts |

## Screenshots

| Dashboard (dark, desktop) | Dashboard (light, phone) | AI assistant (dark, phone) |
|---|---|---|
| ![Dashboard dark](docs/screenshots/dashboard-dark-desktop.png) | ![Dashboard light phone](docs/screenshots/dashboard-light-mobile.png) | ![AI assistant](docs/screenshots/ai-dark-mobile.png) |

Screenshots show data from a throw-away test account.

## What's built

- **Auth** — register/login with bcrypt password hashing, JWT sessions, a
  protected `/api/auth/me`, logout.
- **Transactions** — full CRUD, with server-side search (description, category
  *and* notes), type/category filtering, a date-range filter (Today/This
  Week/This Month/Custom), a min/max amount filter, sorting, and pagination
  exposed in the UI (Prev/Next, 20 per page).
- **Budgets** — CRUD with an arbitrary `startDate`/`endDate` per budget (not
  locked to a calendar month). Overlapping budgets for the same category are
  rejected (409). `spent`, `remaining` and `percentage` are always computed
  live from real transactions in that date range, never stored. Each budget
  carries a computed `status`: `upcoming` / `active` / `ended`.
- **Savings Goals** — CRUD with optional target date, category and description,
  an optional starting balance, and a stored contribution history. Progress,
  remaining amount and status (Not Started / In Progress / Completed /
  Overdue) are calculated by the API; the bar never exceeds 100% (any extra is
  shown as "above target"). Contributions are **not** transactions — see
  "Savings goal accounting" in `backend/README.md`. A Savings Goals card on
  the dashboard summarises them.
- **Dashboard** (`GET /api/dashboard`) — real income/expense/balance/savings
  rate for This Month / Last Month / This Year, recent transactions, a
  category breakdown, and a trailing 6-month income-vs-expense trend.
- **Analytics** — a period-filtered page (This Month / Last Month / Last 3 / Last 6
  Months / This Year / Custom range) with income vs expenses, spending and
  savings trends, expense breakdown, income distribution, top categories and
  an honest comparison with the previous equivalent period. All numbers are
  aggregated by the database for the signed-in user. The older monthly /
  category / forecast endpoints remain.
- **Smart Insights** — a rule-based engine (no AI/ML) that turns your own
  transactions, budgets and goals into spending, budget, savings, habit and
  recommendation insights, each with a "Why?" explaining the rule and numbers.
  Shows "Not enough financial data to generate insights yet." until there is
  enough data.
- **Financial Health Score** — a transparent 0–100 educational score from five
  documented components, normalised over the components your data supports,
  with a per-component breakdown, strengths, suggestions and a score history
  recomputed from real past data. Unavailable (never a placeholder number)
  until the minimum data exists. Formulas: `backend/README.md`.
- **Notifications** — generated from real activity, not scheduled fake data:
  a budget crossing 80% or 100% raises a warning/exceeded alert (checked both
  when an expense is added *and* when the budget itself is created/edited),
  a savings goal crossing 50%/100% raises a milestone alert. Each is
  deduplicated so the same event doesn't spam the bell twice.
- Every route above requires a valid JWT and is scoped to `req.user.id` —
  one user can never read or modify another user's data (verified with an
  automated two-user test, see below).
- **Loading & error states** — every page's initial data load shows a
  pulsing skeleton (not a blank screen or a stale zero) while it fetches, and
  a "Try Again" retry block if the request fails outright.

The frontend is a modular single-page app (native ES modules, with a small build for local Tailwind CSS and Chart.js assets): each of the 12
features is its own lazily-loaded page with its own service, styles and loading/empty/error
states, behind a shared shell, router, component library and design system. A failure in one
page, widget or chart is contained and never takes down the rest of the app. See
[`frontend/README.md`](frontend/README.md) for the architecture, routes, design tokens,
error-isolation strategy and accessibility notes.

- **Spending Forecast** — estimates of next 7 days / 30 days / 3 months / 6 months
  (expenses, income, savings, per-category) from a documented weighted moving
  average of your real complete months, with a data-reliability label, a
  solid-vs-dashed actual/estimate chart and an honest "not enough history"
  state. Only periods your data supports are offered.
- **Unusual Spending** — explainable statistical rules (per-category IQR, rolling
  30-day baselines, monthly z-score, repeated increases) that flag changes in
  *your own* pattern, with the numbers and reason for each. Review, dismiss or
  view the related transactions; findings never repeat, never block anything
  and never claim fraud. Thresholds are configurable.
- **What-If Simulator** — start from your real monthly averages, then reduce
  categories, raise income, set a savings target, try hypothetical budgets or
  combine them, with instant results, a current-vs-simulated comparison and
  saved scenarios (original saved result vs recalculated now). It never
  touches real transactions, budgets or goals.
- **Recurring Transactions** — daily/weekly/monthly/yearly schedules stored in
  the database and processed by the server (a restart-proof scheduler with
  startup catch-up and on-demand processing), idempotent by database
  constraint, with month-end/leap-year rules, pause/resume with a catch-up
  policy, an occurrence history (generated/skipped/failed) and notifications.
- **Subscription Tracker** — plans you pay for (weekly / monthly / quarterly / yearly /
  custom cycles) with pause, resume, cancel and details. Monthly/yearly costs are
  clearly **estimates**; payments are **actual** only once you confirm them (a renewal
  date arriving never means "paid"). Optional auto-recording of expenses that can never
  duplicate, no activity for paused/cancelled plans, and a dashboard with upcoming
  renewals, recently cancelled and a category breakdown.
- **Notification Center** — All / Unread / Read, category filters, related links, mark
  read/unread, delete, mark all read, an unread badge in the navigation and per-category
  preferences (including renewal-reminder timing). Budget thresholds (70 / 90 / 100 % /
  over) notify on the transition only; goals, subscriptions, recurring and unusual
  spending notify once per event, enforced by a database unique key. In-app first; an
  optional e-mail copy (opt-in, one mail per notification) works only when the server has
  SMTP configured, and the app says so when it does not. No SMS.
- **Reports** — current / previous month, last 3 / 6 months, current year or a custom
  range: income, expenses, savings, category breakdown, top transactions, trends, budget
  performance, goals and subscriptions (estimate vs actual), month-over-month comparison
  with honest "no previous data" handling, charts, **PDF and CSV export**, and saved
  snapshots (frozen copies, clearly labelled, no duplicates).
- **Import & Export** — CSV or Excel (.xlsx) import with template, preview, validation, row-level errors,
  duplicate detection you decide on, explicit confirmation, one-transaction save,
  history and undo; CSV exports (all or filtered transactions, budgets, goals,
  subscriptions, recurring) with spreadsheet-formula protection; a full JSON backup
  without passwords or secrets; and a safe restore (preview, merge by default,
  typed confirmation to replace, full rollback on failure, subscription payment history
  included). Both CSV and Excel (`.xlsx`) files can be imported.

- **AI Financial Assistant** — ask about your own spending, budgets and savings in plain language. Questions are
  translated into a closed set of validated, read-only operations on your data (no SQL, no generated code); every answer shows
  its figures, how they were calculated and any assumption, and says so when data is insufficient. Rule-based
  recommendations explain why they appear and label estimates. An optional external AI model (opt-in, server key) may only
  re-word answers; numbers it did not get from FinTrack are rejected. Educational, not financial advice.

## Testing

```bash
# API suites (phases 1-17, AI, security, integrity, ops): needs a TEST database with all migrations applied
DATABASE_URL="postgresql://USER:PASS@localhost:5432/fintrack_test?schema=public" bash backend/tests/api/run-all.sh
# Browser suites: see frontend/tests/e2e/README.md
```
The test helpers **refuse to run against any database whose name does not contain "test"**. Details: [`backend/tests/api/README.md`](backend/tests/api/README.md), [`frontend/tests/e2e/README.md`](frontend/tests/e2e/README.md).
Security review: [`docs/SECURITY.md`](docs/SECURITY.md).

## Deployment

Architecture, options, costs, runbook (environments, environment variables, CI/CD, backups, monitoring, rollback, troubleshooting) and the production checklist are in
[`docs/deployment/`](docs/deployment/ARCHITECTURE.md). Recommended for a portfolio: S3 + CloudFront (frontend), AWS App Runner (API container), RDS PostgreSQL,
about $20-30/month **estimated** (not an invoice) for one environment. **Live URL: none yet; the app has not been deployed.**
Local production-like stack: `docker compose --env-file .env.docker up --build` (see `.env.docker.example`).

## Known gaps before real users

- Not deployed; CI/CD and the AWS design are untested on GitHub/AWS; production database backup/restore drill not yet performed in a real environment.
- No password reset, e-mail verification or MFA; JWTs are stateless (logout cannot revoke them) and kept in `localStorage`; the CSP must be set by the host.
- Mobile layouts are tested in headless browsers at phone widths only; real-device testing is a checklist in `frontend/README.md`.
- The external AI integration was tested against a stub, not the live provider; e-mail was tested against a local SMTP sink, not a real provider.
- No SMS; no third-party penetration test.

## Requirements

- Node.js 18+
- PostgreSQL 13+ (local install or a hosted connection string)

## Setup

```bash
cd backend
npm install
cp .env.example .env
```

Edit `backend/.env`:

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string, e.g. `postgresql://user:pass@localhost:5432/fintrack?schema=public` |
| `JWT_SECRET` | Any long random string (`openssl rand -hex 32`) |
| `JWT_EXPIRES_IN` | Token lifetime, e.g. `7d` |
| `PORT` | Backend port, default `5000` |
| `CLIENT_URL` | Origin the frontend is served from, e.g. `http://localhost:5500` (CORS) |
| `NODE_ENV` | `development` or `production` |

Create the database (if it doesn't already exist), then apply the committed
migrations — this creates all 5 tables (User, Transaction, Budget,
SavingsGoal, Notification):

```bash
npx prisma migrate deploy
```

Start the backend:

```bash
npm run dev
```

You should see `FinTrack API server running on http://localhost:5000`.

## Running the frontend

The frontend is static files (HTML + ES modules), but it must be served over HTTP (not opened
as a `file://` path) so ES modules load and the browser's CORS check matches `CLIENT_URL`:

```bash
cd frontend
npm install
npm run build
npx serve -l 5500
```

Open `http://localhost:5500/`, create an account, and you're in. Pages are addressed with hash
routes (`#/dashboard`, `#/transactions`, `#/forecast`, …) so refresh and the Back button work on any static server.
There's no seed data — register through the UI (or `curl`, see below) and
add your own transactions/budgets/goals. Everything you enter persists in
Postgres and survives a browser refresh.

## API overview

All routes below except `/api/health` and `/api/auth/*` require
`Authorization: Bearer <token>`.

```
GET    /api/health

POST   /api/auth/register        { name, email, password }
POST   /api/auth/login           { email, password }
GET    /api/auth/me
POST   /api/auth/logout

GET    /api/transactions         ?type=&category=&search=&dateFrom=&dateTo=&minAmount=&maxAmount=&sort=&page=&limit=
POST   /api/transactions         { type, amount, category, description, notes?, date }
GET    /api/transactions/:id
PUT    /api/transactions/:id
DELETE /api/transactions/:id

GET    /api/budgets              - every budget the user has (past, active, upcoming)
GET    /api/budgets/summary       - totals across budgets active right now
POST   /api/budgets              { category, limit, startDate, endDate }
PUT    /api/budgets/:id
DELETE /api/budgets/:id          - never deletes the underlying transactions

GET    /api/goals
GET    /api/goals/summary         - dashboard overview (counts, totals, upcoming target dates)
POST   /api/goals                { title, targetAmount, savedAmount?, targetDate?, category?, description?, icon? }
GET    /api/goals/:id
PUT    /api/goals/:id            - never changes savedAmount (use contributions)
DELETE /api/goals/:id            - also deletes its contribution history
GET    /api/goals/:id/contributions
POST   /api/goals/:id/contributions  { amount, date?, note? }   (/deposit is a legacy alias)

GET    /api/dashboard             ?period=month|last_month|year

GET    /api/analytics/overview    ?period=this_month|last_month|last_3_months|last_6_months|this_year|custom&startDate=&endDate=
GET    /api/insights              - rule-based insights (cached until your data changes)
GET    /api/health-score          - financial health score + breakdown + history
GET    /api/forecast              ?period=next_7_days|next_30_days|next_3_months|next_6_months
GET    /api/unusual-spending      ?status=active|reviewed|dismissed|all
PATCH  /api/unusual-spending/:id  { status: NEW|REVIEWED|DISMISSED }   - never touches transactions
GET    /api/unusual-spending/:id/transactions
GET    /api/simulations/baseline  ?months=3    - your real monthly averages
POST   /api/simulations/calculate { inputs }   - stateless what-if
GET    /api/simulations           POST /api/simulations { name, inputs }
GET    /api/simulations/:id       - saved result + recalculated against today's data
DELETE /api/simulations/:id
GET    /api/recurring             POST /api/recurring { title, type, amount, category, frequency, startDate, endDate?, notes?, backfill? }
GET    /api/recurring/:id         PUT /api/recurring/:id   DELETE /api/recurring/:id (keeps generated transactions)
POST   /api/recurring/:id/pause   POST /api/recurring/:id/resume { catchUp? }
GET    /api/recurring/:id/occurrences   - upcoming + generated/skipped/failed history
POST   /api/recurring/process     - process the caller's own due schedules (idempotent)
GET    /api/analytics/monthly     ?months=6
GET    /api/analytics/categories  ?month=&year=
GET    /api/analytics/income-expense ?months=6
GET    /api/analytics/forecast

GET    /api/subscriptions         ?status=all|upcoming|active|paused|cancelled|expired     POST /api/subscriptions {...}
GET    /api/subscriptions/summary PUT/DELETE /api/subscriptions/:id
POST   /api/subscriptions/:id/pause|resume|cancel      POST /api/subscriptions/:id/payments { paidDate?, recordTransaction? }

GET    /api/notifications         ?status=all|unread|read&category=&page=&limit=
GET    /api/notifications/unread-count
PATCH  /api/notifications/:id/read|unread    DELETE /api/notifications/:id
PATCH  /api/notifications/read-all           ?category=
GET    /api/notifications/preferences        PUT /api/notifications/preferences { budget?, goals?, ..., renewalReminderDays? }

GET    /api/reports               ?period=this_month|last_month|last_3_months|last_6_months|this_year|custom&startDate=&endDate=
GET    /api/reports/export/csv|pdf           (same query)
GET    /api/reports/snapshots     POST /api/reports/snapshots { period, startDate?, endDate?, title? }
GET    /api/reports/snapshots/:id  (/csv, /pdf)   DELETE /api/reports/snapshots/:id

GET    /api/import/template
POST   /api/import/transactions/preview   { csv, fileName }        - validates, saves NOTHING
POST   /api/import/transactions/confirm   { csv, fileName, duplicateAction?, includeRows?, confirm: true }
POST   /api/import/transactions/error-report { csv }
GET    /api/import/history        POST /api/import/history/:id/undo
GET    /api/export/transactions   ?type=&category=&search=&dateFrom=&dateTo=&minAmount=&maxAmount=
GET    /api/export/budgets|goals|subscriptions|recurring      GET /api/export/backup (JSON)
POST   /api/backup/preview        { backup, mode: merge|replace }  - writes nothing
POST   /api/backup/restore        { backup, mode, confirm: true, confirmText? }   (replace needs "REPLACE MY DATA")
```

See `backend/README.md` for `curl` examples of the full end-to-end flow
(register → add transactions → budgets → goals).

## Project layout

```
fintrack/
├── frontend/
│   ├── index.html, login.html, fintrack_application.html   entry points (the app is a thin shell)
│   ├── README.md                                           architecture, routes, design system
│   └── src/
│       ├── core/        router, session, dom helpers, events, theme, logger
│       ├── services/    apiClient (timeouts, de-duplication, 401 handling), auth, notifications
│       ├── components/  button/input/modal/toast/skeleton/empty+error states/pagination/charts…
│       ├── layout/      shell: sidebar, top bar, notifications, profile menu
│       ├── styles/      tokens.css (design tokens) + base/components/layout
│       └── features/    dashboard · transactions · budgets · analytics · savings-goals · insights ·
│                        health-score · forecast · anomaly-detection · simulator · recurring ·
│                        subscriptions · reports · notifications · import-export · settings
└── backend/
    ├── src/
    │   ├── config/          Prisma client
    │   ├── controllers/     one file per resource
    │   ├── routes/
    │   ├── middleware/       auth, validation, centralized error handler
    │   ├── validators/       Zod schemas
    │   ├── services/         budget/analytics/goal/insight/health-score calculations
    │   ├── utils/            shared finance + date-range + goal-metric helpers
    │   └── server.js
    ├── prisma/schema.prisma
    ├── .env.example
    └── README.md
```
