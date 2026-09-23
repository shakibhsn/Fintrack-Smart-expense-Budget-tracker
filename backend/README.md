# FinTrack Backend

Node.js + Express + Prisma + PostgreSQL API for FinTrack. See the project
root `README.md` for the full API route table and architecture overview —
this file is the setup guide plus a `curl` walkthrough of the whole flow.

## Prerequisites
- Node.js 18+
- PostgreSQL running locally (or a hosted Postgres connection string)

## Setup

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env`:
- `DATABASE_URL` — your Postgres connection string
- `JWT_SECRET` — any long random string (e.g. `openssl rand -hex 32`)
- `CLIENT_URL` — the origin the frontend is served from (e.g. `http://localhost:5500`)

Create the database (if it doesn't exist yet), then run the migration —
this creates all 5 tables (User, Transaction, Budget, SavingsGoal, Notification):

```bash
npx prisma migrate dev --name init
```

Start the server:

```bash
npm run dev
```

You should see: `FinTrack API server running on http://localhost:5000`

`npx prisma studio` opens a browser GUI for the database if you want to
inspect rows directly.

## Walk through the whole app with curl

No seed data ships with the project — this is the fastest way to get a
working account and confirm every piece works, end to end.

```bash
BASE=http://localhost:5000/api

curl -s $BASE/health

# 1. Register, keep the token
curl -s -X POST $BASE/auth/register -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"test@example.com","password":"Test123456"}'
TOKEN="paste the token from the response here"
AUTH="Authorization: Bearer $TOKEN"

# 2. Login also works
curl -s -X POST $BASE/auth/login -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test123456"}'

curl -s $BASE/auth/me -H "$AUTH"

# 3. Add income + expenses (dates default to whatever you pass)
curl -s -X POST $BASE/transactions -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"type":"INCOME","amount":50000,"category":"Salary","description":"Monthly pay","date":"2026-09-01"}'
curl -s -X POST $BASE/transactions -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"type":"EXPENSE","amount":5000,"category":"Food","description":"Groceries","date":"2026-09-05"}'
curl -s -X POST $BASE/transactions -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"type":"EXPENSE","amount":2000,"category":"Transport","description":"Cab","date":"2026-09-06"}'

# 4. Search / filter / sort
curl -s "$BASE/transactions?type=EXPENSE&sort=amount-desc" -H "$AUTH"
curl -s "$BASE/transactions?search=grocer" -H "$AUTH"

# 5. Dashboard - totals are computed from the transactions above, not hard-coded
curl -s $BASE/dashboard -H "$AUTH"
curl -s "$BASE/dashboard?period=year" -H "$AUTH"

# 6. Budget: spent/remaining/percentage computed live from real transactions
curl -s -X POST $BASE/budgets -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"category":"Food","limit":10000}'
curl -s $BASE/budgets/summary -H "$AUTH"

# 7. Analytics
curl -s $BASE/analytics/monthly -H "$AUTH"
curl -s $BASE/analytics/categories -H "$AUTH"
curl -s $BASE/analytics/forecast -H "$AUTH"

# 8. Savings goal + deposit
curl -s -X POST $BASE/goals -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"title":"MacBook Pro","targetAmount":120000,"icon":"fa-laptop"}'
GOAL_ID="paste the goal id from the response"
curl -s -X POST $BASE/goals/$GOAL_ID/deposit -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"amount":10000}'

# 9. Notifications - the budget/goal calls above should have generated some
curl -s $BASE/notifications -H "$AUTH"
curl -s -X PATCH $BASE/notifications/read-all -H "$AUTH"

# 10. Second user cannot see the first user's data
curl -s -X POST $BASE/auth/register -H "Content-Type: application/json" \
  -d '{"name":"Second User","email":"second@example.com","password":"Test123456"}'
TOKEN2="paste the second token"
curl -s $BASE/transactions -H "Authorization: Bearer $TOKEN2"   # -> empty list
curl -s $BASE/goals/$GOAL_ID -H "Authorization: Bearer $TOKEN2" # -> 404
```

## Notes on how a few things are computed

- **Budgets** never store `spent`. `GET /api/budgets` and `/summary` sum the
  real `EXPENSE` transactions for that category/month on every request, so
  the number is always correct even if you edit or delete a transaction
  afterwards.
- **Notifications** are generated, not scheduled: creating/editing an expense
  re-checks that category's budget; creating or editing a budget re-checks it
  immediately too (so a budget created after the spending already happened
  still gets a warning); depositing to a goal re-checks its 50%/100%
  milestones. Each check is deduplicated (budgets: once per calendar month;
  goals: once ever) so the same event won't create duplicate notifications.
- **Dashboard forecast** (`/api/analytics/forecast`) projects the rest of the
  month from this month's real average daily spend — it's not a fixed number.
