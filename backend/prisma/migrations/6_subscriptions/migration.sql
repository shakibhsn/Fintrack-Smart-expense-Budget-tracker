-- Phase 13: subscription tracker.
-- Additive and safe: new enums/tables and one NULLABLE column on "Transaction".

CREATE TYPE "SubscriptionFrequency" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'CUSTOM');
-- Only what the USER chose is stored. "Expired" is derived (end date passed / no further renewals), never stored.
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');
CREATE TYPE "PaymentStatus" AS ENUM ('PAID', 'SKIPPED');

CREATE TABLE "Subscription" (
  "id"                 TEXT NOT NULL,
  "userId"             TEXT NOT NULL,
  "name"               TEXT NOT NULL,
  "provider"           TEXT,
  "category"           TEXT NOT NULL,
  "amount"             DECIMAL(12,2) NOT NULL,
  "currency"           TEXT NOT NULL DEFAULT 'BDT',
  "frequency"          "SubscriptionFrequency" NOT NULL,
  "customIntervalDays" INTEGER,
  "startDate"          TIMESTAMP(3) NOT NULL,
  -- the next renewal still to be handled; NULL when no further renewal exists (past the end date)
  "nextRenewalDate"    TIMESTAMP(3),
  -- renewal dates are computed from this anchor, so a 31st-of-month plan never drifts after a short month
  "billingAnchor"      TIMESTAMP(3) NOT NULL,
  "endDate"            TIMESTAMP(3),
  "paymentMethod"      TEXT,
  "notes"              TEXT,
  "status"             "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
  "autoRecord"         BOOLEAN NOT NULL DEFAULT false,
  "reminderDays"       INTEGER,
  "pausedAt"           TIMESTAMP(3),
  "cancelledAt"        TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Subscription_userId_idx" ON "Subscription"("userId");
CREATE INDEX "Subscription_status_nextRenewalDate_idx" ON "Subscription"("status", "nextRenewalDate");
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The ACTUAL payment history. A renewal is only ever recorded when the user (or an opted-in auto-record) says so.
CREATE TABLE "SubscriptionPayment" (
  "id"             TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "dueDate"        TIMESTAMP(3) NOT NULL,
  "amount"         DECIMAL(12,2) NOT NULL,
  "currency"       TEXT NOT NULL,
  "status"         "PaymentStatus" NOT NULL DEFAULT 'PAID',
  "source"         TEXT NOT NULL DEFAULT 'MANUAL',
  "transactionId"  TEXT,
  "paidAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);
-- one payment record per subscription per renewal date: duplicates are impossible
CREATE UNIQUE INDEX "SubscriptionPayment_subscriptionId_dueDate_key" ON "SubscriptionPayment"("subscriptionId", "dueDate");
CREATE INDEX "SubscriptionPayment_userId_idx" ON "SubscriptionPayment"("userId");
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Expense transactions created for a payment point back at the subscription (and are never counted twice).
ALTER TABLE "Transaction" ADD COLUMN "subscriptionId" TEXT;
CREATE UNIQUE INDEX "Transaction_subscriptionId_occurrenceDate_key" ON "Transaction"("subscriptionId", "occurrenceDate");
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
