-- Phase 15: saved report snapshots (additive; no existing table is changed).
CREATE TABLE "ReportSnapshot" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "title"       TEXT NOT NULL,
    "period"      TEXT NOT NULL,
    "startDate"   TIMESTAMP(3) NOT NULL,
    "endDate"     TIMESTAMP(3) NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "payload"     JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReportSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReportSnapshot_userId_fingerprint_key" ON "ReportSnapshot"("userId", "fingerprint");
CREATE INDEX "ReportSnapshot_userId_generatedAt_idx" ON "ReportSnapshot"("userId", "generatedAt");
ALTER TABLE "ReportSnapshot" ADD CONSTRAINT "ReportSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
