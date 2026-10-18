-- Migration: 0006_caption_studio
-- Extends the Caption Studio models added in 0005 with new fields and constraints.
-- Adds aiCaptionSuggestionId to Post.
-- Additive only: no existing column, table or index is dropped, renamed or retyped.

-- ── Post: AI Caption Studio link ─────────────────────────────────────

ALTER TABLE "Post"
  ADD COLUMN IF NOT EXISTS "aiCaptionSuggestionId" TEXT;

ALTER TABLE "Post"
  DROP CONSTRAINT IF EXISTS "Post_aiCaptionSuggestionId_fkey";

ALTER TABLE "Post"
  ADD CONSTRAINT "Post_aiCaptionSuggestionId_fkey"
    FOREIGN KEY ("aiCaptionSuggestionId")
    REFERENCES "CaptionSuggestion"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Post_aiCaptionSuggestionId_idx"
  ON "Post"("aiCaptionSuggestionId");

-- ── CaptionSuggestion: review-workflow fields ─────────────────────────

ALTER TABLE "CaptionSuggestion"
  ADD COLUMN IF NOT EXISTS "batchId"          TEXT,
  ADD COLUMN IF NOT EXISTS "revision"         INTEGER      NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "approvedById"     TEXT,
  ADD COLUMN IF NOT EXISTS "approvedAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "approvedRevision" INTEGER,
  ADD COLUMN IF NOT EXISTS "appliedAt"        TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "CaptionSuggestion_batchId_idx"
  ON "CaptionSuggestion"("batchId");

-- ── Hashtag: blocked flag + ownership ────────────────────────────────

ALTER TABLE "Hashtag"
  ADD COLUMN IF NOT EXISTS "blocked"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "blockedReason" TEXT,
  ADD COLUMN IF NOT EXISTS "createdById"   TEXT;

-- ── HashtagPerformance: unique constraint (was index only) ────────────

DROP INDEX IF EXISTS "HashtagPerformance_hashtagId_platform_measuredAt_idx";

ALTER TABLE "HashtagPerformance"
  DROP CONSTRAINT IF EXISTS "HashtagPerformance_hashtagId_platform_postId_key";

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'HashtagPerformance_hashtagId_platform_postId_key') THEN
    ALTER TABLE "HashtagPerformance" ADD CONSTRAINT "HashtagPerformance_hashtagId_platform_postId_key" UNIQUE ("hashtagId","platform","postId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "HashtagPerformance_hashtagId_platform_measuredAt_idx"
  ON "HashtagPerformance"("hashtagId", "platform", "measuredAt");

-- ── TrendSignal: new fields + unique constraint ───────────────────────

ALTER TABLE "TrendSignal"
  ADD COLUMN IF NOT EXISTS "normalizedTag" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "sourceNote"    TEXT,
  ADD COLUMN IF NOT EXISTS "createdById"   TEXT;

-- Replace the old non-unique indexes with the new unique constraint.
DROP INDEX IF EXISTS "TrendSignal_platform_expiresAt_idx";
DROP INDEX IF EXISTS "TrendSignal_hashtagId_platform_idx";

ALTER TABLE "TrendSignal"
  DROP CONSTRAINT IF EXISTS "TrendSignal_platform_normalizedTag_source_region_key";

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'TrendSignal_platform_normalizedTag_source_region_key') THEN
    ALTER TABLE "TrendSignal" ADD CONSTRAINT "TrendSignal_platform_normalizedTag_source_region_key" UNIQUE ("platform","normalizedTag","source","region");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "TrendSignal_platform_expiresAt_idx"
  ON "TrendSignal"("platform", "expiresAt");

CREATE INDEX IF NOT EXISTS "TrendSignal_hashtagId_platform_idx"
  ON "TrendSignal"("hashtagId", "platform");

-- ── GenerationFeedback: add userId ───────────────────────────────────

ALTER TABLE "GenerationFeedback"
  ADD COLUMN IF NOT EXISTS "userId" TEXT;
