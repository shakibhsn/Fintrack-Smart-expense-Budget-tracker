-- Optional e-mail copy of notifications (additive; default OFF, nothing is sent unless the server has SMTP configured).
ALTER TABLE "NotificationPreference" ADD COLUMN "emailEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Notification" ADD COLUMN "emailStatus" TEXT, ADD COLUMN "emailedAt" TIMESTAMP(3);
