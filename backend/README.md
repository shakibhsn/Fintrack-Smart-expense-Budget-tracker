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
curl -s -X POST $BASE/goals/$GOAL_ID/contributions -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"amount":10000,"note":"Bonus"}'
curl -s $BASE/goals/$GOAL_ID/contributions -H "$AUTH"      # contribution history
curl -s $BASE/goals/summary -H "$AUTH"

# 8b. Analytics for a period, insights, health score
curl -s "$BASE/analytics/overview?period=last_3_months" -H "$AUTH"
curl -s $BASE/insights -H "$AUTH"
curl -s $BASE/health-score -H "$AUTH"

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

## Database migrations

`prisma/migrations/2_savings_goal_contributions` (Phase 6) is **additive and safe**:
it adds three nullable columns to `SavingsGoal` (`targetDate`, `category`, `description`),
creates the `GoalContribution` table, and backfills **one** contribution row
("Balance before contribution tracking") for every existing goal that already
had a `savedAmount`, so `sum(contributions) == savedAmount` holds from day one.
Nothing is dropped or rewritten. Apply it with:

```bash
cd backend
npx prisma migrate deploy      # applies pending migrations
npx prisma generate            # refresh the client (stop the server first on Windows)
```

Back up the database first if it holds data you care about
(`pg_dump fintrack > backup.sql`). Phases 5, 7 and 8 need no schema changes.

## Phase 5 - Analytics rules

`GET /api/analytics/overview?period=...` (all queries filter by the signed-in user's id;
totals, categories and the time series are aggregated by PostgreSQL, not in the browser).

| period | range reported | compared with ("previous equivalent period") |
|---|---|---|
| `this_month` | 1st of this month → today | the same number of days at the start of last month |
| `last_month` | last calendar month | the month before it |
| `last_3_months` | this month + the 2 before it, to today | the 3 months before that range |
| `last_6_months` | this month + the 5 before it, to today | the 6 months before that range |
| `this_year` | 1 Jan → today | the same span of last year |
| `custom` | `startDate`..`endDate`, both inclusive (max 5 years) | the equal-length window immediately before it |

"To-date" ranges stop at today so a half-finished month is never compared with a whole one
(future-dated transactions are excluded until their date).
Savings = income − expenses. Savings rate = (income − expenses) ÷ income × 100, and is `null`
(shown as "N/A"), not 0, when there is no income. A percentage change is `null` when the
previous value is 0, and **no comparison at all** is made unless the previous period has at least one
transaction - the response then carries a plain-language message instead of a misleading percentage.
The series is daily for ranges of up to 31 days and monthly beyond that (the spending-trend chart
is therefore "daily" for This Month and "monthly" for the longer periods); empty buckets are
zero-filled so the axis is continuous. Shared helpers: `utils/finance.js`, `utils/dateRange.js`.

## Phase 6 - Savings goal accounting

- **A contribution is not a Transaction.** It allocates money the user already recorded as income,
  so it never changes income, expenses, budgets, analytics or the savings rate - nothing is counted twice.
  (Recording a contribution does *not* reduce your balance on the dashboard; the dashboard balance is
  income − expenses of recorded transactions only.)
- `savedAmount` always equals the sum of the goal's contributions. It only changes together with a
  contribution, inside one database transaction, using a database-side increment (so concurrent
  contributions can't overwrite each other). `PUT /api/goals/:id` rejects `savedAmount`.
- An "initial saved amount" at creation (must be ≤ the target) is stored as the goal's first contribution.
- Formulas (`utils/goalMetrics.js`, used everywhere): progress = saved ÷ target × 100 (the bar shows
  `min(progress, 100)`; `actualProgress` and `excess` expose the real values), remaining = max(target − saved, 0).
- Status: **Completed** if saved ≥ target; else **Overdue** if the target date is before today (an overdue
  goal is never auto-completed - it completes only by reaching the target); else **Not Started** if nothing saved;
  else **In Progress**.
- Validation: contribution amount > 0, date not in the future, new goals can't have a past target date.
- Ownership: every goal/contribution query includes `userId`; another user's id returns 404.

## Phase 7 - Insight rules

`GET /api/insights` runs fixed rules (`services/insightService.js`); it is **not AI or machine learning**.
Every insight has a stable id, a category (spending / budget / savings / habits / recommendations),
a message and a `reason` stating the rule and numbers. Windows: this month to date vs the same days of last
month (the same windows as Analytics "This Month"). Minimum data: 5 transactions in the last 90 days, otherwise
`sufficient:false` and "Not enough financial data to generate insights yet."

- **Spending** - highest category (≥2 categories), lowest (≥3), overall change and per-category changes
  (only when the previous window has data and the change is ≥10%; at most 3 categories).
- **Budget** - per active budget: 70-89% warning, 90-100% "almost exhausted", >100% exceeded by ৳X; a single
  "within budget" insight only if every active budget is under 70%.
- **Savings** - spending above income; savings-rate change (≥1 point) and savings-amount change vs the previous
  window; goal progress / overdue / completed; goal **pace estimate** only with ≥3 real contributions spanning ≥30
  days in the last 90 days (starting balances excluded), phrased as "may".
- **Habits** - 3 months of steadily rising/falling spending; a category already ≥150% of its own average of the
  previous (≥2) months (worded neutrally - never "suspicious"); the same title+category ≥3 times in 90 days with
  similar amounts (within 20%).
- **Recommendations** - only generated from a rule above (review a rising category, revisit a strained budget,
  try a budget when none exist, set a savings target when the rate is under 10%, create a goal when none exist).
  Always phrased as suggestions.
- Duplicates are impossible by construction (deterministic ids, de-duplicated). Results are cached per user for up to
  5 minutes and cleared as soon as that user writes a transaction, budget, goal or contribution
  (`services/derivedCache.js`); the cache is in-process, so with several server instances each keeps its own copy.

## Financial Health Score (Phase 8)

An **educational indicator, not financial advice.** One service computes it (`services/healthScoreService.js`);
every weight and threshold lives in its `MODEL` constant. `GET /api/health-score`.

score = round( earned points ÷ evaluable points × 100 )

A component is *evaluable* only when the user has the data it needs. An unevaluable component is left out of
**both** sides of the fraction - it is never scored as 0 - and the UI says "Based on N of 5 components".
The score is **unavailable** (no number is shown) unless there are **≥ 10 transactions in the last 90 days** and the
evaluable components add up to **≥ 35 of the 100 nominal points**. Levels: 80-100 Excellent, 60-79 Good,
40-59 Fair, 0-39 Needs Improvement.

| Component | Points | Evaluable when | Formula |
|---|---:|---|---|
| Budget Management | 30 | ≥1 budget overlaps this month + the 2 before it | per budget, usage = spent ÷ limit × 100: ≤70% → 1.0; 70-100% falls linearly to 0.6; 100-150% falls linearly to 0; ≥150% → 0. Component = average × 30 |
| Savings Rate | 25 | income > 0 in this month + the 2 before it | rate = (income − expenses) ÷ income × 100; ≤0% → 0, ≥20% → full, linear between (negative savings earn 0, never negative) |
| Expense Stability | 20 | ≥3 completed months (of the last 6) with expenses | coefficient of variation (std-dev ÷ mean) of monthly **expenses ÷ income** when every one of those months has income, otherwise of monthly expenses; CV ≤0.15 → full, ≥0.60 → 0, linear between. High spending alone is never penalised, only month-to-month swings |
| Savings Goal Progress | 15 | ≥1 goal with a target date, or completed in the last 90 days | per goal: completed → 1; else expected = share of the creation→target-date time elapsed; expected <10% → 1 (grace); else min(1, actual progress ÷ expected). Goals without a target date (and not completed) are skipped. Average × 15 |
| Tracking Consistency | 10 | ≥4 weeks since the first transaction | split the last 12 weeks (or the weeks since the first transaction) into 7-day buckets; score = weeks with ≥1 transaction ÷ weeks evaluated. Number of transactions is irrelevant |

**Score history** - the same formulas are re-run "as of" the end of each of the previous 6 months using only data
dated on or before that day (budgets/goals created later are excluded; in the past only budgets that had already
ended count, because their result was final). A month appears only if a score was possible then; history is shown only
when there are ≥2 points. Nothing is estimated or back-filled. Results are cached/invalidated like insights.

To change the model, edit `MODEL` (weights, thresholds) in `healthScoreService.js` and this section.
