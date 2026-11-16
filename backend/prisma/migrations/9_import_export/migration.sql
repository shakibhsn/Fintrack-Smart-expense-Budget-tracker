-- Phase 16: import history + the link from a transaction to the import that created it. Additive and safe.
CREATE TYPE "ImportKind" AS ENUM ('TRANSACTIONS_CSV', 'BACKUP_RESTORE');
CREATE TYPE "ImportStatus" AS ENUM ('COMPLETED', 'FAILED', 'UNDONE');

CREATE TABLE "ImportBatch" (
    "id"               TEXT NOT NULL,
    "userId"           TEXT NOT NULL,
    "kind"             "ImportKind" NOT NULL,
    "status"           "ImportStatus" NOT NULL,
    "fileName"         TEXT,
    "fileHash"         TEXT,
    "mode"             TEXT,
    "totalRows"        INTEGER NOT NULL DEFAULT 0,
    "importedRows"     INTEGER NOT NULL DEFAULT 0,
    "duplicateSkipped" INTEGER NOT NULL DEFAULT 0,
    "invalidRows"      INTEGER NOT NULL DEFAULT 0,
    "summary"          JSONB,
    "errorMessage"     TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt"         TIMESTAMP(3),
    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ImportBatch_userId_createdAt_idx" ON "ImportBatch"("userId", "createdAt");
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Transaction" ADD COLUMN "importBatchId" TEXT;
CREATE INDEX "Transaction_importBatchId_idx" ON "Transaction"("importBatchId");
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
