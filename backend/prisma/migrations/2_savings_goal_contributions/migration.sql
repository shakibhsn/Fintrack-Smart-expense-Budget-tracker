-- Phase 6: savings goal contributions + optional goal metadata.
-- Additive and safe: only new nullable columns and a new table; no existing data is changed or dropped.

ALTER TABLE "SavingsGoal"
  ADD COLUMN "targetDate"  TIMESTAMP(3),
  ADD COLUMN "category"    TEXT,
  ADD COLUMN "description" TEXT;

CREATE TABLE "GoalContribution" (
  "id"        TEXT NOT NULL,
  "goalId"    TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "amount"    DECIMAL(12,2) NOT NULL,
  "date"      TIMESTAMP(3) NOT NULL,
  "note"      TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoalContribution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GoalContribution_goalId_idx" ON "GoalContribution"("goalId");
CREATE INDEX "GoalContribution_userId_date_idx" ON "GoalContribution"("userId", "date");

ALTER TABLE "GoalContribution" ADD CONSTRAINT "GoalContribution_goalId_fkey"
  FOREIGN KEY ("goalId") REFERENCES "SavingsGoal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoalContribution" ADD CONSTRAINT "GoalContribution_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: goals created before this migration already hold a savedAmount but no history.
-- Give each one a single "Balance before contribution tracking" row so that
-- sum(contributions) == savedAmount holds for every goal from day one.
INSERT INTO "GoalContribution" ("id", "goalId", "userId", "amount", "date", "note")
SELECT gen_random_uuid()::text, "id", "userId", "savedAmount", "createdAt", 'Balance before contribution tracking'
FROM "SavingsGoal" WHERE "savedAmount" > 0;
