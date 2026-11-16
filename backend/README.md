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

## Operational settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 5000 | API port |
| `CLIENT_URL` | `*` | Allowed browser origin (CORS), e.g. `http://localhost:5500` |
| `RATE_LIMIT_MAX` | 300 | Requests per 15 minutes per IP for `/api` (raise only for load/e2e testing) |
| `RECURRING_SCHEDULER` / `RECURRING_TICK_MS` | on / 15 min | Recurring-transaction scheduler (see Phase 12) |
| `ANOMALY_THRESHOLDS` | defaults | JSON overrides for unusual-spending thresholds (see Phase 10) |

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
(`pg_dump fintrack > backup.sql`). Phases 5, 7, 8 and 9 need no schema changes.

Phases 10-12 add three more migrations, all **additive** (new enums/tables and nullable columns; no existing row is changed or dropped):

| Migration | Adds |
|---|---|
| `3_unusual_spending_detections` | `UnusualDetection` table (+ `DetectionType`, `DetectionStatus` enums) with a unique `(userId, fingerprint)` index |
| `4_saved_simulations` | `SavedSimulation` table (inputs, baseline snapshot, results as JSON) |
| `5_recurring_transactions` | `RecurringTransaction` and `RecurringOccurrence` tables, `RecurrenceFrequency`/`OccurrenceStatus` enums, the `RECURRING` notification type, and two **nullable** columns on `Transaction` (`recurringId`, `occurrenceDate`) plus the unique index that makes generation idempotent. Existing transactions keep NULL in both. |

**Safe upgrade plan:** (1) back up (`pg_dump`); (2) stop the server (Windows locks the Prisma engine file); (3) `npx prisma migrate deploy`
applies 3, 4 and 5 in order; (4) `npx prisma generate`; (5) start the server. Rollback = restore the backup (the new columns are nullable, so
older code keeps working against the migrated database, but it would not know about recurring schedules).

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

## Phase 9 - Spending forecast

`GET /api/forecast?period=next_7_days|next_30_days|next_3_months|next_6_months` (`services/forecastService.js`; every
constant lives in its `MODEL` / `PERIODS`). An **estimate, never a guarantee**; no machine learning.

**Method - weighted moving average (WMA).** Take the user's last up to **6 complete calendar months** (never reaching
before their first transaction; months with nothing recorded after that count as real zeros; the current, unfinished
month is not part of the model). With *n* months (oldest → newest) month *i* gets weight *i*:

    predicted = Σ(weight_i × value_i) / Σ(weight_i)          e.g. [1000, 2000, 3000, 4000] → (1000+4000+9000+16000)/10 = 3000

The same average is applied to total expenses, total income and every expense category.
`predicted savings = predicted income − predicted expenses`; a negative result is shown as an explicit **deficit**.
Income is *not* assumed constant: it is its own WMA, so a changing salary changes the prediction.
Future months are projected flat at the predicted value (no trend extrapolation, no invented seasonality).

| Period | Total = monthly prediction × | Needs |
|---|---|---|
| Next 7 / 30 days | days ÷ 30.4375 (average month) | ≥ 2 complete months |
| Next 3 months | 3 | ≥ 3 complete months |
| Next 6 months | 6 | ≥ 6 complete months |

Periods the data cannot support come back with `available: false` and a reason, and the UI disables them.
**Minimum data (documented requirement):** ≥ 2 complete months **and** ≥ 8 expense transactions in the window; otherwise the
response is `available: false` with *"Not enough financial history to generate a reliable forecast."* and **no numbers**.
**Reliability label:** 2 months = *Limited Data*, 3-5 = *Moderate Data*, ≥ 6 = *Sufficient Data*.
**Category forecast:** a category is predicted only if it had spending in ≥ 2 history months and ≥ 3 transactions, otherwise it is
listed with *"Insufficient data for this category"*. The typical range shown is ± one standard deviation of the monthly values
(scaled by √months for multi-month periods). Trend = mean of the newest half of the months vs the oldest half (±5% = stable).
Cached per user (`derivedCache`) and recalculated whenever the user writes a transaction, budget or goal.

## Phase 10 - Unusual spending detection

`GET /api/unusual-spending?status=active|reviewed|dismissed|all`, `PATCH /api/unusual-spending/:id {status: NEW|REVIEWED|DISMISSED}`,
`GET /api/unusual-spending/:id/transactions` (`services/anomalyService.js`). Findings are **statistical comparisons with the user's
own history, never accusations**: the wording never says fraud/suspicious, and nothing is blocked, edited or deleted
(dismissing/reviewing only changes the finding's own status).

**Minimum data:** ≥ 15 expense transactions spanning ≥ 45 days, else *"Not enough transaction history to identify unusual spending patterns."*

| Type | Rule (defaults) |
|---|---|
| `LARGE_TRANSACTION` | an expense from the last 30 days is flagged when, **within its own category**, amount > Q3 + 1.5 × IQR of the user's other transactions in that category (last 180 days) **and** amount ≥ 2 × that category's median. Needs ≥ 8 other transactions in the category (no baseline, no alert). At most 5 per run, largest ratio first. So ৳5,000 can be unusual for one user and normal for another. |
| `CATEGORY_INCREASE` | spending in a category over the last 30 days vs the average of up to 3 previous 30-day windows (only windows inside the user's history). Flagged at ≥ +30%, if the category was active in ≥ 2 baseline windows and the rise is ≥ 5% of the user's average monthly expenses (so tiny categories do not alert). |
| `UNUSUAL_MONTH` | total expenses of the last complete month, and of the current month so far, vs the mean of up to 5 earlier complete months (≥ 3 needed). Flagged when ≥ 1.5 standard deviations **and** ≥ 25% above the mean. |
| `REPEATED_INCREASE` | a category whose 30-day spending rose by ≥ 15% in each of 4 consecutive 30-day windows (a sustained change, not a one-off). Replaces `CATEGORY_INCREASE` for that category so the user is not alerted twice. |

**Every finding stores** type, category/transaction, actual amount, historical baseline, difference, % change, detection date,
the compared window and a plain-language explanation built from those same numbers (plus the rule and inputs under *details*).
**Duplicates:** each finding has a deterministic fingerprint (`type:transaction` or `type:category:month`) with a unique
`(userId, fingerprint)` index, so re-running detection (every page load, every data change) updates the same row. Reviewed/dismissed
findings are never touched again; unreviewed ones are refreshed, and removed within 30 days if they no longer hold (e.g. the transaction was deleted).
Detection is cached per user and re-run when transactions change.
**Configurable:** every threshold is in `DEFAULTS`; override any of them with the `ANOMALY_THRESHOLDS` environment variable (a JSON
object merged over the defaults, e.g. `ANOMALY_THRESHOLDS={"large":{"minMedianRatio":3}}`).

## Phase 11 - What-If simulator

`utils/simulation.js` holds the maths (pure; the browser has an identical copy for instant feedback, and the server re-runs **this**
version whenever a scenario is calculated or saved, so a saved result is always the server's). Nothing here ever writes to
transactions, budgets or goals: only `SavedSimulation` rows are created/deleted.

Starting point (`GET /api/simulations/baseline?months=1..12`, default 3): **monthly averages over the last N complete months**
(never before the first transaction) of income and per-category expenses. Unavailable until there is one complete month.

    simulated category     = current × (1 − reduction% / 100)
    simulated expenses     = Σ simulated categories
    simulated income       = current income + income increase
    simulated savings      = simulated income − simulated expenses       (savings improvement = simulated − current)
    savings rate           = savings ÷ income × 100                       (null when income is 0)
    expense limit for a target of t%  = simulated income × (1 − t/100)   (gap = simulated expenses − limit)
    hypothetical budget    = limit vs simulated spend of that category (over/under)

`POST /api/simulations/calculate {inputs, months?}` (stateless), `POST /api/simulations {name, inputs, months?}` (validated + recomputed
server-side; the client cannot supply results), `GET /api/simulations`, `GET /api/simulations/:id` (returns the **original saved result**
and the same inputs **recalculated against today's data**, plus `dataChangedSinceSaved`), `DELETE /api/simulations/:id`. Max 50 saved per user.
A saved simulation stores the inputs, a snapshot of the baseline it used (reference period + averages) and the results.

## Phase 12 - Recurring transactions

Endpoints: `GET/POST /api/recurring`, `GET/PUT/DELETE /api/recurring/:id`, `POST /api/recurring/:id/pause`,
`POST /api/recurring/:id/resume {catchUp?}`, `GET /api/recurring/:id/occurrences`, `POST /api/recurring/process`
(runs **the caller's own** due schedules; there is no global or unauthenticated trigger). All dates are **UTC calendar days**.

**Recurrence rules** (`utils/recurrence.js`, pure). The *n*-th occurrence is always computed from the original start date, never
from the previous occurrence, so a short month cannot make later dates drift:

| Frequency | Rule |
|---|---|
| Daily | start + n days |
| Weekly | start + 7n days (the start date's weekday is kept) |
| Monthly | same day-of-month as the start date. If a month is shorter (start on the 29th/30th/31st) the **last day of that month** is used, and the original day is used again in months that have it: Jan 31 → Feb 28 (Feb 29 in leap years) → Mar 31 → Apr 30 |
| Yearly | same month/day; a Feb 29 start runs on Feb 29 in leap years and **Feb 28** otherwise |
| End date | optional and **inclusive**; no occurrence after it is ever created; the schedule then shows as *completed* |

**Generation.** A schedule stores `nextOccurrence`. When it is due (≤ today, active) the server, in **one database transaction**,
creates the `Transaction` (user, type, amount, category, title as description, notes, `date` = the occurrence date, `recurringId`),
creates the `RecurringOccurrence` row and moves `nextOccurrence` forward. Generated transactions appear in the normal list, flow into
the dashboard/analytics/budgets, raise the usual budget alerts, and never create schedules themselves.

**Idempotency / no duplicates.** The database enforces it: `Transaction` has `UNIQUE(recurringId, occurrenceDate)` and
`RecurringOccurrence` has `UNIQUE(recurringId, scheduledDate)`. Moving `nextOccurrence` is a compare-and-set
(`UPDATE … WHERE nextOccurrence = <expected> AND isActive`). Running the job twice, concurrently, or from several instances can
therefore never create a second transaction for a date: the loser hits the constraint, rolls back and carries on.

**Scheduling.** Schedules live in PostgreSQL, so restarts lose nothing. An in-process timer (`services/recurringScheduler.js`) only
*wakes the job up*: once shortly after start (catching up anything that fell due while the server was down/asleep) and then every
`RECURRING_TICK_MS` (default 15 min). The job asks the database what is due. Because hosts may sleep, due schedules are also processed
lazily for the signed-in user when they open the dashboard, the transaction list or the recurring page. Set `RECURRING_SCHEDULER=off`
to disable the timer (e.g. when an external cron calls it). Failures of one schedule never stop the others.

**Policies (all documented, none surprising):**
- *Start date in the past:* past dates are **not** created unless the user ticks back-fill (`backfill: true`, max 60 past occurrences).
- *Long outage:* a date missed by more than **31 days** is recorded as `SKIPPED` instead of flooding the ledger; dates missed by ≤ 31 days are generated.
- *Pause:* nothing is generated, existing transactions and the configuration are kept.
- *Resume:* by default dates missed while paused are recorded as `SKIPPED` (last 60) and the schedule continues from the next date; with `catchUp: true` they are generated on purpose (max 60).
- *Edit:* only `applyTo: "future"` is supported. Future dates are generated on the day they fall due, so the new values automatically apply to every not-yet-generated occurrence, and **transactions already generated are never modified** (regenerating past ones is deliberately not supported). Changing frequency/start/end recomputes the next date from today or the day after the last handled date, so handled dates are never re-created.
- *Delete:* removes the schedule and its log; the transactions it created **stay** (they simply no longer link to a schedule). Deleting a generated transaction does not regenerate it; the history marks it deleted.
- *Failures:* recorded as `FAILED` with the error and attempt count, the pointer is **not** advanced (so the same date is retried by the next run) and the date is never shown as generated. One notification per failed date.
- *Notifications* (`RECURRING`): one when a transaction is created (a single digest if > 3 at once), one the day before a schedule runs, one per failed date; all de-duplicated by title.
- Limits: 100 schedules per user.

## Phase 13 - Subscription tracker

Endpoints: `GET/POST /api/subscriptions`, `GET/PUT/DELETE /api/subscriptions/:id`, `POST /api/subscriptions/:id/pause|resume|cancel`,
`POST /api/subscriptions/:id/payments {paidDate?, recordTransaction?}`, `GET /api/subscriptions/summary`, `POST /api/subscriptions/process`.
Subscriptions are **separate from recurring transactions**: a subscription is a *plan you pay for* (with a provider, status and renewal date); a
recurring transaction is a *schedule that generates ledger entries*. Nothing is shared except the optional link described below.

**Estimates vs actual payments (never mixed).** `amount × payments-per-year` gives the yearly estimate; monthly = yearly / 12.
Payments per year: weekly `365.25/7`, monthly 12, quarterly 4, yearly 1, custom every N days `365.25/N`. These are **ESTIMATES** of what active
plans cost and are labelled as such everywhere. An **ACTUAL** payment exists only when a renewal is confirmed (`POST …/payments`) or auto-recorded.
A renewal date arriving never means "paid". Estimates are never added to expenses; a payment recorded as an expense is counted once, in expenses.

**Status:** `active`, `paused`, `cancelled` are stored; `expired` is derived (end date passed or no further renewal). Priority: cancelled > expired >
paused > active. Paused and cancelled subscriptions generate no reminders, no payments and no transactions, and are excluded from cost totals.

**Optional transaction link / no duplicates.** With `autoRecord` on (and a subscription in the account currency) a due renewal creates an expense
(`Transaction.subscriptionId` + `occurrenceDate`). The database guarantees one row per occurrence: `UNIQUE(subscriptionId, occurrenceDate)` on
transactions and `UNIQUE(subscriptionId, dueDate)` on `SubscriptionPayment`; the renewal pointer moves with a compare-and-set, so repeated, concurrent
or multi-instance runs cannot double-record. Renewals missed by more than 62 days are skipped rather than flooding the ledger.

## Phase 14 - Notifications and alerts

Endpoints: `GET /api/notifications ?status=all|unread|read&category=&page=&limit=`, `GET /api/notifications/unread-count`,
`PATCH /api/notifications/:id/read|unread`, `PATCH /api/notifications/read-all ?category=`, `DELETE /api/notifications/:id`,
`GET/PUT /api/notifications/preferences`.

**One creation path.** Every notification is created by `notificationService.notify()`. It (1) checks the user's per-category preference first, so an
opted-out category stores **nothing**; (2) requires a deterministic `dedupeKey` and relies on `UNIQUE(userId, dedupeKey)`, so the same event can never
notify twice, whatever the number of requests, retries, scheduler runs or concurrent instances; (3) never throws, so a failing notification cannot
break the transaction, budget or goal request that triggered it. Categories: budget, goals, subscriptions, recurring, unusual spending, insights, system.

| Event | Rule |
|---|---|
| Budget | Transition only: 70 %, 90 %, 100 % (limit reached) and over budget. Each level once per budget **and limit** (raising the limit re-arms it). Adding more spend inside the same level notifies nothing |
| Goals | Created; contribution (replaced by the milestone message when one is crossed); 25 / 50 / 75 % once each; completed once; overdue once (job) |
| Subscriptions | Paused / resumed / cancelled / auto-recorded; renewal reminder N days ahead (user preference, or per-subscription override; 0 = only on the day); "date reached" notice for manual subscriptions that **says nothing was recorded**; plan ending soon. Paused/cancelled get no reminders |
| Recurring | Upcoming (day before), generated (digest above 3), failed, paused |
| Unusual spending | One per **newly created** finding; a re-sync never repeats it |
| Insights | High-priority alerts, max 3 per run, once per insight and period |

Time-based events (reminders, overdue goals) run in the existing scheduler tick for everyone, and also for the signed-in user when they open their
notifications (throttled to once a minute), so hosts that sleep still catch up. **Delivery is in-app first** (stored in PostgreSQL). Deleting a notification removes only that row (its key goes with it). SMS is not implemented.

**Optional e-mail copy** (`services/emailService.js`, nodemailer). It exists only when the **server** is configured with SMTP environment variables; otherwise nothing is ever sent,
`GET /notifications/preferences` reports `email.available: false`, switching it on is refused with HTTP 409 and the UI says e-mail is not set up. When configured it is **opt-in per user**
(`emailEnabled`, default off), sent to the account's own address, for every category the user left on, **once per notification** (a compare-and-set on `emailStatus` means two
instances or a retry can never send twice; there is no automatic retry), and capped at `EMAIL_HOURLY_CAP` (30) per user per hour. `emailStatus` is `SENT` (accepted by the mail server: this is not
a guarantee of inbox delivery, and the UI words it that way), `FAILED`, or `SKIPPED` (hourly cap); a failing mail server never breaks the request that created the notification.
Credentials come **only** from environment variables and are never stored, returned by the API or logged (log lines carry the error code only). Mail bodies HTML-escape user text and
header injection through titles is neutralised. `POST /notifications/email/test` (5/min) sends one test message so users can verify the setup.

## Phase 15 - Financial reports

Endpoints: `GET /api/reports ?period=this_month|last_month|last_3_months|last_6_months|this_year|custom&startDate=&endDate=`,
`GET /api/reports/export/csv|pdf` (same query), `GET/POST /api/reports/snapshots`, `GET/DELETE /api/reports/snapshots/:id`,
`GET /api/reports/snapshots/:id/csv|pdf`.

The report reuses the **same building blocks as Analytics and the Dashboard** (`sumByType`, `categoryTotals`, `timeSeries`,
`resolveAnalyticsPeriod`, `metricComparison`, `getBudgetsWithSpending`, `subscriptionService.summary`), so its totals equal those pages for the same range
(verified by tests). Income, expense and savings come only from transactions; savings = income − expense and may be negative. `savingsRate` is `null`
(not 0) when there is no income; changes against a zero previous period have no percentage; when the previous period has no transactions the report
says so instead of inventing a comparison. Goal contributions are allocations of income already counted and never change savings.

**Budget overlap rule.** Budgets have their own date ranges. Every budget overlapping the period is listed and judged over **its own full range** (as on
the Budgets page); `spentInPeriod` shows the part inside the report period. Only budgets that **start inside** the period are added into the summary
totals; budgets that began earlier are listed (marked) but excluded from totals so a limit is never compared with spending from another window. Same-category
budgets cannot overlap, so nothing is counted twice.

**Subscriptions in a report:** ESTIMATE (current plans, monthly/yearly) and ACTUAL (confirmed payments inside the period) are shown separately and labelled.

**Live vs snapshot.** A report is always **dynamic** (recalculated on every request, labelled "Live report"). `POST /snapshots` saves a frozen copy labelled
"Saved snapshot"; a `fingerprint` (hash of the period and figures) with `UNIQUE(userId, fingerprint)` means saving an unchanged report again (even
concurrently) returns the existing snapshot instead of a duplicate. 50 snapshots per user. **PDF:** generated server-side with `pdfkit` (brand header, title,
period, summary, trend and category charts drawn as vectors, tables, budgets, goals, subscriptions, generation date, page footer). The PDF embeds **Noto Sans and Noto Sans Bengali** (npm packages `@fontsource/*`, so nothing is downloaded at runtime): the taka sign (`৳1,234.00`) and Bengali descriptions/categories/names print correctly
(mixed Latin+Bengali strings are drawn run by run). Characters in no bundled font (emoji, CJK, ...) print as `?` rather than an empty box; the CSV and the screen always keep the original text. **CSV:** stacked, labelled sections with a UTF-8 BOM and formula-injection protection.

## Phase 16 - Import, export and backup

### CSV import (`/api/import`)
Flow: **upload → parse → validate columns → preview → review errors/duplicates → explicit confirmation → save valid rows → summary.** The browser reads the
file and sends its text; the server stores nothing from a preview. Confirmation re-analyses the file on the server (the client is never trusted).

| Endpoint | Purpose |
|---|---|
| `GET /import/template` | CSV template (header + two clearly-marked example rows) |
| `POST /import/transactions/preview {csv, fileName}` | Validation + duplicate analysis. **Writes nothing** |
| `POST /import/transactions/confirm {csv, fileName, duplicateAction?, includeRows?, confirm:true}` | Saves in **one database transaction** with an import-history row |
| `POST /import/transactions/error-report {csv}` | CSV of every invalid/duplicate row with the reason and the original cells |
| `GET /import/history`, `POST /import/history/:id/undo` | History; undo removes only the transactions that import created |

Format (header required, comma separated, UTF-8): `date,type,amount,category,description[,notes]`. `date` is `YYYY-MM-DD` and a real calendar day (years
1970–2100; `01/02/2024` is rejected, never guessed). `type` is INCOME/EXPENSE (any case). `amount` is a plain positive number with at most 2 decimals and at most
`999999999.99` (no thousands separators or currency signs). `category` ≤ 50, `description` ≤ 200, `notes` ≤ 500 characters. A row with the wrong number of
columns is invalid. **Limits:** 1,000,000 characters (~1 MB), 1,000 data rows, 30 columns, 5,000 characters per cell, enforced while parsing. A header-only,
empty or binary file is rejected with an explanation.

**Excel (.xlsx) import.** `POST /import/transactions/{preview,confirm,error-report}` accept either `{ csv }` or `{ xlsx: <base64>, fileName }`. A workbook is converted (`services/xlsxImport.js`, `exceljs`) into the same CSV text and then goes through the
identical pipeline (validation, duplicates, preview, confirmation, one-transaction save, history/undo). Only the first visible sheet is read, the header must be in its first row, Excel date cells become `YYYY-MM-DD`, number noise (0.1+0.2) is
rounded, and **formulas are never evaluated** (only the stored result is read, as text; hostile text stays text). Limits: 2,000,000 bytes, 1,000 data rows, 30 columns, 5,000 characters per cell. `.xls` (legacy binary) and `.xlsm` (macros) are refused, as is anything that is
not a real zip-based workbook or that cannot be read (damaged / password-protected). Request body limit for `/api/import`: 3.5 MB. Note: a zip can expand when read; the 2 MB cap and the row/column limits bound the work, but a very hostile archive can still
cost CPU/memory, so keep the import endpoints behind the rate limit (they are).

**Duplicate strategy.** A row is a *possible duplicate* when the user already has a transaction with the same type, calendar date, amount and category and the same
description (ignoring case and repeated spaces), **or** an identical row appears earlier in the same file. Duplicates are never dropped silently: the user chooses
(default skip; tick rows individually, or all). The preview also warns when the exact same file (SHA-256) was already imported. Invalid rows are never imported.

**Safety.** Text is trimmed and control characters removed; nothing is ever evaluated. A leading apostrophe that FinTrack's own export adds before `= + - @` is
removed again, so an exported file imports back unchanged. Ownership is enforced in every query. Failures roll back completely; a `FAILED` history row stores only a
generic message (no row data, no stack, no SQL). Budget alerts for imported expenses use the same de-duplicated path as manual entry.

### Exports (`/api/export`)
`GET /export/transactions` (all, or filtered with the Transactions page filter names: `type, category, search, dateFrom, dateTo, minAmount, maxAmount`; same columns
as the import template, so it round-trips), `/export/budgets`, `/export/goals`, `/export/subscriptions` (estimates labelled), `/export/recurring`, and
`/export/backup` (full JSON). **CSV formula injection:** every text cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'` (numbers are written as numbers);
cells with commas, quotes or line breaks are RFC 4180-quoted; files carry a UTF-8 BOM and CRLF line endings. Report CSV/PDF are under `/api/reports`.

### Full backup and restore (`/api/export/backup`, `/api/backup`)
The backup contains the user's own transactions, budgets, goals (with contributions), subscriptions and recurring schedules, the name/currency, a format version and a
SHA-256 **checksum** (detects damage or hand edits; it is not a signature). **Excluded and documented:** password hash, e-mail address, tokens/secrets (none are stored),
notifications and preferences (including the e-mail opt-in), unusual-spending findings, saved simulations, report snapshots, import history and recurring occurrence logs. **Subscription payment history IS included** (restored with new ids, linked to the
restored subscription and to the restored expense it created; a payment already recorded for the same subscription and due date is skipped, so restoring twice adds nothing).

`POST /backup/preview {backup, mode}` validates (app/kind/format version, checksum, item caps, **every item** against a strict schema), then reports what would be added,
skipped (conflicts) and, for replace, deleted. **Writes nothing.** `POST /backup/restore {backup, mode, confirm:true, confirmText?}`:
- **merge is the default and never destructive:** existing data is untouched; items that already exist (transactions by the duplicate rule with multiset matching so genuine repeats
  survive; budgets by category+dates or overlap; goals; subscriptions; recurring) are skipped, so restoring the same backup twice adds nothing;
- **replace** deletes the user's current data first and needs the exact phrase `REPLACE MY DATA`;
- everything runs in **one transaction**: any error leaves the account exactly as it was; a generic `FAILED` history row is written;
- rows get **new ids** for the signed-in user (ids in the file are only labels to re-link transactions to their subscription/schedule); recurring schedules return **paused**;
  a goal's saved amount is recomputed as the sum of its contributions; the account's name, currency and e-mail are never changed; amounts are copied without currency conversion.

**Rate limits** (per user, per minute): exports `EXPORT_RATE_LIMIT_MAX` (default 30), import/restore `IMPORT_RATE_LIMIT_MAX` (default 20), on top of the general limiter.
Request bodies: `/api/import` 1.5 MB, `/api/backup` 6 MB (others keep the 100 kB default); larger bodies get HTTP 413.

## Migrations 6-9 (Phases 13-16)

All **additive** (new enums/tables and nullable columns; no existing row is changed or dropped):

| Migration | Adds |
|---|---|
| `6_subscriptions` | `Subscription`, `SubscriptionPayment`, their enums, `Transaction.subscriptionId` + unique `(subscriptionId, occurrenceDate)` |
| `7_notification_center` | `NotificationCategory`, `Notification.category/dedupeKey/relatedType/relatedId/link/readAt` with `UNIQUE(userId, dedupeKey)` (existing rows are back-filled with a category and a unique legacy key), `NotificationPreference` |
| `8_report_snapshots` | `ReportSnapshot` with `UNIQUE(userId, fingerprint)` |
| `9_import_export` | `ImportBatch` (+ `ImportKind`, `ImportStatus`), nullable `Transaction.importBatchId` |
| `10_email_notifications` | `NotificationPreference.emailEnabled` (default false), `Notification.emailStatus` / `emailedAt` (both nullable) |

**Safe upgrade plan:** (1) `pg_dump` backup; (2) stop the server (Windows locks the Prisma engine file); (3) `npx prisma migrate deploy` (applies 6–10 in order);
(4) `npx prisma generate`; (5) `npm install` (adds `pdfkit`, `exceljs`, `nodemailer` and the Noto font packages); (6) start the server. Rollback = restore the backup (all new columns are nullable).

| Variable | Default | Purpose |
|---|---|---|
| `EXPORT_RATE_LIMIT_MAX` | 30 | Exports per user per minute |
| `IMPORT_RATE_LIMIT_MAX` | 20 | Import/restore requests per user per minute |
| `SMTP_HOST`, `EMAIL_FROM` | unset | **Both required** to enable the optional e-mail copy of notifications; unset = e-mail is off and says so |
| `SMTP_PORT` / `SMTP_SECURE` | 587 / false | Port; `SMTP_SECURE=true` for TLS from the start (usually port 465) |
| `SMTP_USER`, `SMTP_PASS` | unset | Optional login pair (environment only; never stored or logged) |
| `SMTP_IGNORE_TLS` | false | `true` only for local test servers |
| `APP_URL` | `CLIENT_URL` | Base address used for the "Open FinTrack" link in e-mails |
| `EMAIL_HOURLY_CAP` / `EMAIL_TEST_RATE_LIMIT_MAX` | 30 / 5 | E-mails per user per hour / test e-mails per minute |

## Phase 17 - AI financial assistant

Endpoints (all authenticated, all scoped to the signed-in user): `GET /api/ai/status`, `PUT /api/ai/settings {enabled?, externalAi?}`, `POST /api/ai/ask {question, range?}`,
`GET /api/ai/recommendations`, `POST /api/ai/recommendations/dismiss {key}`. Page: `#/ai-assistant`.

**Architecture: the numbers never come from a model.**
```
question -> rule-based intent (services/ai/intent.js) -> whitelisted TOOL + zod-validated parameters (services/ai/tools.js)
         -> existing services / parameterised Prisma queries on the caller's own data -> deterministic answer text (answer.js)
         -> OPTIONAL: an external model rephrases that answer (provider.js), accepted only if every number in it was computed by FinTrack
```
- **Tools (a closed set):** `summary`, `categories`, `compare`, `budgets`, `savings_outlook` (an ESTIMATE from the Forecast model), `habits`, `health` (the Health Score), `transactions`, plus the recommendation rules for "reduce my expenses".
  Parameters come from a closed vocabulary (this/last month, this/last year, last N days/months, a custom range of at most 5 years, an optional category). The user id comes from the **server-side session**, never from the question,
  the request body or the model; unknown fields are stripped, unknown tools are refused. **No SQL text and no generated code is ever built or executed**; tools are read-only.
- **Honesty:** each answer carries the figures table, a plain-language "how this was calculated" note, the period used and any assumption made (for example "no period given, so this month so far"). With no or too little data
  the answer says so (`insufficient: true`) instead of inventing figures. Estimates are labelled `ESTIMATE`. Unsupported questions get a polite refusal plus examples.
- **Recommendations** (`recommendationService.js`): fixed, documented rules (thresholds in `RULES`) over real data: a category up >= 25 % and >= 500 on the same days of last month; budgets >= 80 % used or over; subscriptions >= 15 % of last month's spending;
  last month's savings rate < 10 % or negative; one category >= 40 % of this month's spending. Each has `why` (the evidence), a `kind` (`observation` = fact, `estimate` = labelled possibility, never a guarantee), a data range and a stable key that includes the month, so the same
  recommendation is never listed twice and a dismissed one does not return that month. Fewer than 10 expenses in 90 days => no recommendations and the reason. A change is never claimed without a baseline from the previous period.
- **External AI is optional and OFF by default.** Configure `ANTHROPIC_API_KEY` (server environment only; also `AI_MODEL` default `claude-haiku-5-5`, `AI_API_URL`, `AI_TIMEOUT_MS` 15000). A user must opt in (`externalAi`). What is sent: the question text and aggregate facts (totals, category names,
  percentages); never transaction descriptions, e-mail, name, ids or tokens. The provider's own data-handling terms apply; FinTrack makes no confidentiality promise on their behalf (the settings panel says so). If the provider is down, slow (timeout), rate-limited or returns garbage, the request still succeeds with FinTrack's own answer and
  a clear note. A model answer containing a number FinTrack did not compute is discarded. For a question the rules cannot match, the model may only choose one tool from the whitelist (validated like any input). The UI marks every answer: "Calculated by FinTrack" or "AI-worded by an external model".
  **This integration was tested against a local stub of the provider's API, not against the live service** (no key was available); verify with your own key before relying on it.
- **Usage controls:** `AiSetting.enabled` (per user) and `AI_ENABLED=false` (whole server); per-user rate limit `AI_RATE_LIMIT_MAX` (20/min); daily external-call cap `AI_DAILY_PROVIDER_LIMIT` (50, then answers continue without the model); `AiUsageLog` stores tool, source, status and latency
  **only** (no question text, no figures). No conversation is stored server-side: the history lives in the page's memory and disappears when you leave. The page shows the disclaimer: educational, not professional financial advice.

Migration `11_ai_assistant` (additive): `AiSetting`, `AiUsageLog`, `AiDismissal`.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Enables the optional external model (users still opt in individually) |
| `AI_MODEL` / `AI_API_URL` / `AI_TIMEOUT_MS` | `claude-haiku-5-5` / Anthropic Messages API / 15000 | Provider settings |
| `AI_ENABLED` | true | `false` switches the assistant off for everyone |
| `AI_RATE_LIMIT_MAX` / `AI_DAILY_PROVIDER_LIMIT` | 20 / 50 | Requests per user per minute / external calls per user per day |

## Migration 10-11

| Migration | Adds |
|---|---|
| `10_email_notifications` | `NotificationPreference.emailEnabled` (default false), `Notification.emailStatus` / `emailedAt` |
| `11_ai_assistant` | `AiSetting`, `AiUsageLog` (tool/source/status/latency only), `AiDismissal` |

## Phase 19 - security hardening and data integrity

Full review, findings and residual risks: [`docs/SECURITY.md`](../docs/SECURITY.md). What changed in the backend:
- **Startup configuration check** (`config/env.js`): in production (`NODE_ENV=production`) the server **refuses to start** with a missing/short/placeholder `JWT_SECRET`, a missing `DATABASE_URL`, or a `CLIENT_URL` that is missing, `*`, or not `https://`.
  In development the same problems are warnings. `CLIENT_URL` accepts several origins, comma separated (exact allow-list).
- **Auth:** bcrypt cost 12 (`BCRYPT_ROUNDS`), password 8-72 bytes, name/e-mail length limits, constant-time-ish login for unknown accounts, JWT pinned to HS256, `AUTH_RATE_LIMIT_MAX` (default 20 per 15 min per IP), `TRUST_PROXY` for deployments behind a proxy.
- **Strict input:** money fields accept only numbers/numeric strings with at most 2 decimals; dates must be real calendar days (`validators/scalar.js`); `null`, arrays and impossible dates are rejected instead of being coerced.
- **Integrity under concurrency:** budget create/update run under a per-user+category advisory lock so overlapping budgets cannot be created by simultaneous requests; transaction lists use a deterministic total order (unique id tiebreaker) so pagination never repeats or skips rows.
- **Tools:** `npm run scan:secrets` (credential scan of every committable file), `npm audit` in CI.
- **Tests:** `tests/api/security.test.js` (43), `tests/api/integrity.test.js` (24), `tests/api/ai.test.js` (58); the shared test helper refuses to run against any database whose name does not contain `test`.

## Phase 20 - production readiness (no deployment performed)

Deployment design, costs and checklists: [`docs/deployment/`](../docs/deployment/). Backend pieces:
- **Health:** `GET /api/health` (liveness) and `GET /api/health/ready` (readiness: database, all migrations applied, background scheduler heartbeat, `version` = `GIT_SHA`; HTTP 503 when not ready). Both are exempt from the rate limiter.
- **Logging:** one JSON line per request (`reqId`, method, path **without query**, status, duration, user id) and structured error logs; never bodies, headers, tokens, passwords or e-mails (`utils/logger.js`). `X-Request-Id` on every response.
- **Graceful shutdown:** `SIGTERM`/`SIGINT` stop accepting connections, let in-flight requests finish (10 s), stop the scheduler and close the database pool.
- **Scheduler monitoring:** `recurringScheduler.status()` feeds readiness; the jobs are idempotent and run server-side (no browser needed).
- **Container:** `Dockerfile` (multi-stage, non-root, `HEALTHCHECK`, optional `RUN_MIGRATIONS=true` entrypoint), `docker-compose.yml` at the repository root for a production-like local stack.
- **Backups:** `scripts/db-backup.js` (read-only, verified dump + checksum) and `scripts/db-verify-restore.js` (restores into a scratch database, compares row counts, drops it). Guide: `docs/deployment/OPERATIONS.md`.
- **CI/CD:** `.github/workflows/ci.yml` (all suites against a throw-away PostgreSQL) and `deploy.yml` (manual, off by default, AWS OIDC, readiness gate). **Not yet run on GitHub or AWS.**
- **Tests:** `tests/api/ops.test.js` (health, readiness, scheduler heartbeat, request ids, log privacy, rate-limit exemption, DB outage; the SIGTERM case runs on Linux/CI only).

| Variable | Default | Purpose |
|---|---|---|
| `TRUST_PROXY` | unset | Proxy hops in front of the API (`1` behind one load balancer) |
| `AUTH_RATE_LIMIT_MAX` | 20 | Login/register attempts per IP per 15 minutes |
| `BCRYPT_ROUNDS` | 12 | Password hashing cost (10-14) |
| `LOG_LEVEL` | info | `debug`/`info`/`warn`/`error` |
| `GIT_SHA` | unknown | Release id shown by `/api/health/ready` (set by the build) |
| `RUN_MIGRATIONS` | unset | `true` = the container applies pending migrations at start |
