-- Phase 12: recurring transactions.
-- Additive and safe: new enums/tables, two NULLABLE columns on "Transaction", one new notification type.
-- Existing transactions are untouched (both new columns are NULL for them).

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RECURRING';

CREATE TYPE "RecurrenceFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY');
CREATE TYPE "OccurrenceStatus" AS ENUM ('GENERATED', 'SKIPPED', 'FAILED');

CREATE TABLE "RecurringTransaction" (
  "id"              TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "title"           TEXT NOT NULL,
  "type"            "TransactionType" NOT NULL,
  "amount"          DECIMAL(12,2) NOT NULL,
  "category"        TEXT NOT NULL,
  "notes"           TEXT,
  "frequency"       "RecurrenceFrequency" NOT NULL,
  "startDate"       TIMESTAMP(3) NOT NULL,
  "endDate"         TIMESTAMP(3),
  -- next scheduled date still to be handled; NULL once the schedule has finished (past its end date)
  "nextOccurrence"  TIMESTAMP(3),
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "pausedAt"        TIMESTAMP(3),
  "lastGeneratedAt" TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecurringTransaction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RecurringTransaction_userId_idx" ON "RecurringTransaction"("userId");
-- lets the scheduler find due schedules quickly
CREATE INDEX "RecurringTransaction_isActive_nextOccurrence_idx" ON "RecurringTransaction"("isActive", "nextOccurrence");
ALTER TABLE "RecurringTransaction" ADD CONSTRAINT "RecurringTransaction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Which transactions came from a schedule, and for which scheduled date.
ALTER TABLE "Transaction"
  ADD COLUMN "recurringId"    TEXT,
  ADD COLUMN "occurrenceDate" TIMESTAMP(3);
-- IDEMPOTENCY GUARANTEE: a schedule can produce at most one transaction per scheduled date, enforced by the
-- database itself. (NULLs are distinct in a Postgres unique index, so ordinary transactions are unaffected.)
CREATE UNIQUE INDEX "Transaction_recurringId_occurrenceDate_key" ON "Transaction"("recurringId", "occurrenceDate");
-- Deleting a schedule keeps the transactions it already generated (history is never silently removed).
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_recurringId_fkey"
  FOREIGN KEY ("recurringId") REFERENCES "RecurringTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RecurringOccurrence" (
  "id"            TEXT NOT NULL,
  "recurringId"   TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "scheduledDate" TIMESTAMP(3) NOT NULL,
  "status"        "OccurrenceStatus" NOT NULL,
  "transactionId" TEXT,
  "amount"        DECIMAL(12,2) NOT NULL,
  "error"         TEXT,
  "attempts"      INTEGER NOT NULL DEFAULT 0,
  "generatedAt"   TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecurringOccurrence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecurringOccurrence_recurringId_scheduledDate_key" ON "RecurringOccurrence"("recurringId", "scheduledDate");
CREATE INDEX "RecurringOccurrence_userId_idx" ON "RecurringOccurrence"("userId");
ALTER TABLE "RecurringOccurrence" ADD CONSTRAINT "RecurringOccurrence_recurringId_fkey"
  FOREIGN KEY ("recurringId") REFERENCES "RecurringTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecurringOccurrence" ADD CONSTRAINT "RecurringOccurrence_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecurringOccurrence" ADD CONSTRAINT "RecurringOccurrence_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
