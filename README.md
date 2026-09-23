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
- **Transactions** — full CRUD, with server-side search, type/category
  filtering, sorting and pagination.
- **Budgets** — CRUD per category/month. `spent`, `remaining` and
  `percentage` are always computed live from real transactions, never stored.
- **Savings Goals** — CRUD plus deposits (server-side atomic increment;
  negative/invalid amounts rejected).
- **Dashboard** (`GET /api/dashboard`) — real income/expense/balance/savings
  rate for This Month / Last Month / This Year, recent transactions, a
  category breakdown, and a trailing 6-month income-vs-expense trend.
- **Analytics** — monthly income/expense trend, category breakdown with
  month-over-month change, and a spending forecast (daily average projected
  across the month).
- **Notifications** — generated from real activity, not scheduled fake data:
  a budget crossing 80% or 100% raises a warning/exceeded alert, a savings
  goal crossing 50%/100% raises a milestone alert. Each is deduplicated so
  the same event doesn't spam the bell twice.
- Every route above requires a valid JWT and is scoped to `req.user.id` —
  one user can never read or modify another user's data (verified with an
  automated two-user test, see below).

The frontend (`fintrack_application.html`, `login.html`) is your original
design, unmodified except for replacing every hard-coded array/number with
API calls, loading/empty states, and the small pieces of UI the mock version
was missing (a Create/Edit Budget modal, a Create/Edit Goal modal).

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

Create the database (if it doesn't already exist) and run the migration —
this creates all 5 tables (User, Transaction, Budget, SavingsGoal, Notification):

```bash
npx prisma migrate dev --name init
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

GET    /api/transactions         ?type=&category=&search=&sort=&page=&limit=
POST   /api/transactions         { type, amount, category, description, date }
GET    /api/transactions/:id
PUT    /api/transactions/:id
DELETE /api/transactions/:id

GET    /api/budgets              ?month=&year=
GET    /api/budgets/summary       ?month=&year=
POST   /api/budgets              { category, limit, month?, year? }
PUT    /api/budgets/:id
DELETE /api/budgets/:id

GET    /api/goals
POST   /api/goals                { title, targetAmount, icon? }
GET    /api/goals/:id
PUT    /api/goals/:id
DELETE /api/goals/:id
POST   /api/goals/:id/deposit    { amount }

GET    /api/dashboard             ?period=month|last_month|year

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
    │   ├── services/         budget/analytics/notification calculations
    │   └── server.js
    ├── prisma/schema.prisma
    ├── .env.example
    └── README.md
```
