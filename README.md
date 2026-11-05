# FinTrack — Full-Stack Personal Finance Tracker

**Status: Day 1, 2 and 3 complete.** FinTrack is a real full-stack app now:
every number the frontend shows is calculated from PostgreSQL through the
Express API — there is no mock/hard-coded financial data left anywhere.

```
Frontend (static HTML/JS) → REST API (Express) → Prisma ORM → PostgreSQL
```

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

The frontend (`fintrack_application.html`, `login.html`) is your original
design, unmodified except for replacing every hard-coded array/number with
API calls, loading/empty/error states, and the small pieces of UI the mock
version was missing (Create/Edit Budget and Create/Edit Goal modals, a Notes
field, date-range/amount filters, pagination controls).

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

The frontend is static HTML, but it must be served over HTTP (not opened as
a `file://` path) so the browser's CORS check matches `CLIENT_URL`:

```bash
cd frontend
npx serve -l 5500
```

Open `http://localhost:5500/login.html`, create an account, and you're in.
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
GET    /api/analytics/monthly     ?months=6
GET    /api/analytics/categories  ?month=&year=
GET    /api/analytics/income-expense ?months=6
GET    /api/analytics/forecast

GET    /api/notifications
PATCH  /api/notifications/:id/read
PATCH  /api/notifications/read-all
```

See `backend/README.md` for `curl` examples of the full end-to-end flow
(register → add transactions → budgets → goals).

## Project layout

```
fintrack/
├── frontend/
│   ├── login.html
│   └── fintrack_application.html
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
