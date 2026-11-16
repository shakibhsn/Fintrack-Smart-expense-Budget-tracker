-- Phase 10: persisted unusual-spending detections (so they can be reviewed/dismissed and never repeat).
-- Additive and safe: two new enums and one new table; no existing data is changed or dropped.

CREATE TYPE "DetectionType" AS ENUM ('LARGE_TRANSACTION', 'CATEGORY_INCREASE', 'UNUSUAL_MONTH', 'REPEATED_INCREASE');
CREATE TYPE "DetectionStatus" AS ENUM ('NEW', 'REVIEWED', 'DISMISSED');

CREATE TABLE "UnusualDetection" (
  "id"              TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "type"            "DetectionType" NOT NULL,
  -- Deterministic key for "the same finding" (type + transaction/category + period). Unique per user,
  -- which is what prevents duplicate alerts however often detection runs.
  "fingerprint"     TEXT NOT NULL,
  "category"        TEXT,
  "transactionId"   TEXT,
  "periodKey"       TEXT NOT NULL,
  "actualAmount"    DECIMAL(12,2) NOT NULL,
  "baselineAmount"  DECIMAL(12,2) NOT NULL,
  "difference"      DECIMAL(12,2) NOT NULL,
  "percentChange"   DOUBLE PRECISION,
  "windowStart"     TIMESTAMP(3) NOT NULL,
  "windowEnd"       TIMESTAMP(3) NOT NULL,
  "explanation"     TEXT NOT NULL,
  "details"         JSONB NOT NULL,
  "status"          "DetectionStatus" NOT NULL DEFAULT 'NEW',
  "detectedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "statusUpdatedAt" TIMESTAMP(3),
  CONSTRAINT "UnusualDetection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UnusualDetection_userId_fingerprint_key" ON "UnusualDetection"("userId", "fingerprint");
CREATE INDEX "UnusualDetection_userId_status_idx" ON "UnusualDetection"("userId", "status");

ALTER TABLE "UnusualDetection" ADD CONSTRAINT "UnusualDetection_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
