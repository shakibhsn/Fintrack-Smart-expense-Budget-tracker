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

Create the database (if it doesn't exist yet), then apply the committed
migrations in `prisma/migrations/` — this creates all 5 tables (User,
Transaction, Budget, SavingsGoal, Notification):

```bash
npx prisma migrate deploy
```

(If you're actively changing `schema.prisma` yourself later, use
`npx prisma migrate dev --name <description>` instead - that's the
interactive command that also generates a new migration file.)

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

# 3. Add income + expenses (dates default to whatever you pass; notes are optional)
curl -s -X POST $BASE/transactions -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"type":"INCOME","amount":50000,"category":"Salary","description":"Monthly pay","date":"2026-09-01"}'
curl -s -X POST $BASE/transactions -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"type":"EXPENSE","amount":5000,"category":"Food","description":"Groceries","notes":"Weekly shop","date":"2026-09-05"}'
curl -s -X POST $BASE/transactions -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"type":"EXPENSE","amount":2000,"category":"Transport","description":"Cab","date":"2026-09-06"}'

# 4. Search (matches description, category AND notes) / filter / date range / amount range / sort
curl -s "$BASE/transactions?type=EXPENSE&sort=amount-desc" -H "$AUTH"
curl -s "$BASE/transactions?search=weekly" -H "$AUTH"
curl -s "$BASE/transactions?dateFrom=2026-09-01&dateTo=2026-09-30" -H "$AUTH"
curl -s "$BASE/transactions?minAmount=1000&maxAmount=6000" -H "$AUTH"

# 5. Dashboard - totals are computed from the transactions above, not hard-coded
curl -s $BASE/dashboard -H "$AUTH"
curl -s "$BASE/dashboard?period=year" -H "$AUTH"

# 6. Budget: give it its own date range (not locked to a calendar month).
#    spent/remaining/percentage are computed live from real transactions in that range.
curl -s -X POST $BASE/budgets -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"category":"Food","limit":10000,"startDate":"2026-09-01","endDate":"2026-09-30"}'
curl -s $BASE/budgets -H "$AUTH"           # every budget (past/active/upcoming), each with a computed "status"
curl -s $BASE/budgets/summary -H "$AUTH"   # totals across only the budgets active right now

# 6b. A second Food budget overlapping that same date range is rejected (409)
curl -s -X POST $BASE/budgets -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"category":"Food","limit":5000,"startDate":"2026-09-15","endDate":"2026-10-15"}'

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

- **Budgets** have their own `startDate`/`endDate` (not a calendar month) and
  never store `spent`. `GET /api/budgets` sums the real `EXPENSE` transactions
  in that exact range on every request, so the number is always correct even
  if you edit or delete a transaction afterwards. `GET /api/budgets/summary`
  totals only the budgets whose range includes today (`status: "active"`);
  `GET /api/budgets` returns every budget, each tagged `upcoming`/`active`/`ended`.
  Two budgets for the same category with overlapping date ranges are rejected
  with 409 - you'd otherwise have no single answer for "what's my Food limit
  today". Deleting a budget never deletes the transactions in that category.
- **Notifications** are generated, not scheduled: creating/editing an expense
  re-checks any budget for that category covering that date; creating or
  editing a budget re-checks it immediately too (so a budget created after
  the spending already happened still gets a warning); depositing to a goal
  re-checks its 50%/100% milestones. Each check is deduplicated (budgets:
  once per budget, using the budget's own creation time as the window; goals:
  once ever) so the same event won't create duplicate notifications.
- **Dashboard forecast** (`/api/analytics/forecast`) projects the rest of the
  month from this month's real average daily spend — it's not a fixed number.
