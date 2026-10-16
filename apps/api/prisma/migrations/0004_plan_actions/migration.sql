-- Migration: 0004_plan_actions
-- Planning v2: action types, source references, verification state, progress tracking.

DO $$ BEGIN
  CREATE TYPE "PlanActionType" AS ENUM ('POST', 'COMMENT', 'ENGAGEMENT', 'SPONSORING', 'PREPARATION', 'REPORTING', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PlanProgress" AS ENUM ('PENDING', 'DONE', 'SKIPPED', 'BLOCKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "PlanImport"
  ADD COLUMN IF NOT EXISTS "sourcePath" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceMime" TEXT;

ALTER TABLE "PlanEntry"
  ADD COLUMN IF NOT EXISTS "actionType"   "PlanActionType" NOT NULL DEFAULT 'POST',
  ADD COLUMN IF NOT EXISTS "text"         TEXT,
  ADD COLUMN IF NOT EXISTS "sourceRef"    TEXT,
  ADD COLUMN IF NOT EXISTS "sourceText"   TEXT,
  ADD COLUMN IF NOT EXISTS "progress"     "PlanProgress"   NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "progressNote" TEXT,
  ADD COLUMN IF NOT EXISTS "progressAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "progressById" TEXT;

ALTER TABLE "PlanImportRow"
  ADD COLUMN IF NOT EXISTS "actionType" "PlanActionType" NOT NULL DEFAULT 'POST',
  ADD COLUMN IF NOT EXISTS "sourceRef"  TEXT,
  ADD COLUMN IF NOT EXISTS "sourceText" TEXT,
  ADD COLUMN IF NOT EXISTS "dateText"   TEXT,
  ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "verified"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "edited"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "original"   JSONB;

CREATE INDEX IF NOT EXISTS "PlanEntry_actionType_progress_idx" ON "PlanEntry"("actionType", "progress");

-- A row whose date could not be read stays in the review table instead of being dropped.
ALTER TABLE "PlanImportRow" ALTER COLUMN "date" DROP NOT NULL;
