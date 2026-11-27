-- Phase 17: AI assistant settings, usage log (no question text / figures) and recommendation dismissals. Additive only.
CREATE TABLE "AiSetting" ("userId" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true, "externalAi" BOOLEAN NOT NULL DEFAULT false, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "AiSetting_pkey" PRIMARY KEY ("userId"));
CREATE TABLE "AiUsageLog" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "tool" TEXT, "source" TEXT NOT NULL, "status" TEXT NOT NULL, "latencyMs" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AiUsageLog_pkey" PRIMARY KEY ("id"));
CREATE TABLE "AiDismissal" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "key" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AiDismissal_pkey" PRIMARY KEY ("id"));
CREATE INDEX "AiUsageLog_userId_createdAt_idx" ON "AiUsageLog"("userId", "createdAt");
CREATE UNIQUE INDEX "AiDismissal_userId_key_key" ON "AiDismissal"("userId", "key");
ALTER TABLE "AiSetting" ADD CONSTRAINT "AiSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiUsageLog" ADD CONSTRAINT "AiUsageLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiDismissal" ADD CONSTRAINT "AiDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
