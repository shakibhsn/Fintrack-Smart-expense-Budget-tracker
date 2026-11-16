-- Phase 14: notification center (categories, de-duplication, read state, per-user preferences).
-- Additive and safe: existing notifications keep working and are back-filled with a category.

CREATE TYPE "NotificationCategory" AS ENUM ('BUDGET', 'GOALS', 'SUBSCRIPTIONS', 'RECURRING', 'UNUSUAL_SPENDING', 'INSIGHTS', 'SYSTEM');

ALTER TABLE "Notification"
  ADD COLUMN "category"    "NotificationCategory" NOT NULL DEFAULT 'SYSTEM',
  -- One deterministic key per EVENT (e.g. budget:<id>:90:<limit>). Unique per user, so the same event can never notify twice,
  -- however many requests, retries or scheduler runs hit it at once.
  ADD COLUMN "dedupeKey"   TEXT,
  ADD COLUMN "relatedType" TEXT,
  ADD COLUMN "relatedId"   TEXT,
  ADD COLUMN "link"        TEXT,
  ADD COLUMN "readAt"      TIMESTAMP(3);

-- back-fill existing rows (their old titles keep working; they just get a category and a unique legacy key)
UPDATE "Notification" SET "category" = CASE
    WHEN "type" IN ('BUDGET_EXCEEDED', 'BUDGET_CRITICAL', 'BUDGET_WARNING') THEN 'BUDGET'::"NotificationCategory"
    WHEN "type" = 'GOAL_PROGRESS' THEN 'GOALS'::"NotificationCategory"
    WHEN "type" = 'RECURRING' THEN 'RECURRING'::"NotificationCategory"
    ELSE 'SYSTEM'::"NotificationCategory" END;
UPDATE "Notification" SET "dedupeKey" = 'legacy:' || "id";
UPDATE "Notification" SET "readAt" = "createdAt" WHERE "isRead" = true;

CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");
CREATE INDEX "Notification_userId_category_idx" ON "Notification"("userId", "category");

-- What each user wants to hear about. A category switched off stores NOTHING (nothing is hidden, it is never created).
CREATE TABLE "NotificationPreference" (
  "userId"              TEXT NOT NULL,
  "budget"              BOOLEAN NOT NULL DEFAULT true,
  "goals"               BOOLEAN NOT NULL DEFAULT true,
  "subscriptions"       BOOLEAN NOT NULL DEFAULT true,
  "recurring"           BOOLEAN NOT NULL DEFAULT true,
  "unusualSpending"     BOOLEAN NOT NULL DEFAULT true,
  "insights"            BOOLEAN NOT NULL DEFAULT true,
  "system"              BOOLEAN NOT NULL DEFAULT true,
  "renewalReminderDays" INTEGER NOT NULL DEFAULT 3,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
