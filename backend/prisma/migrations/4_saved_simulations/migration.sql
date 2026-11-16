-- Phase 11: saved What-If simulations.
-- Additive and safe: one new table. A simulation only stores what-if inputs + the numbers it produced;
-- it never references or modifies transactions, budgets or goals.

CREATE TABLE "SavedSimulation" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  -- what the user adjusted (category reductions, income increase, savings target, budget limits)
  "inputs"    JSONB NOT NULL,
  -- snapshot of the real data the simulation started from (reference months + monthly averages)
  "baseline"  JSONB NOT NULL,
  -- results calculated by the server at save time (the "original saved result")
  "results"   JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SavedSimulation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SavedSimulation_userId_createdAt_idx" ON "SavedSimulation"("userId", "createdAt");

ALTER TABLE "SavedSimulation" ADD CONSTRAINT "SavedSimulation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
