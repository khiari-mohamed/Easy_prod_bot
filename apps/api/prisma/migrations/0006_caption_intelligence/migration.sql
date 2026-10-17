-- Migration: 0006_caption_intelligence
-- Additive only. Revisions + approval snapshot on suggestions, blocked hashtags,
-- trend evidence/uniqueness, hashtag performance uniqueness, Post -> AI suggestion link.

-- ── CaptionSuggestion ────────────────────────────────────────────────
ALTER TABLE "CaptionSuggestion"
  ADD COLUMN IF NOT EXISTS "batchId"          TEXT,
  ADD COLUMN IF NOT EXISTS "revision"         INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "approvedById"     TEXT,
  ADD COLUMN IF NOT EXISTS "approvedAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "approvedRevision" INTEGER,
  ADD COLUMN IF NOT EXISTS "appliedAt"        TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "CaptionSuggestion_batchId_idx" ON "CaptionSuggestion"("batchId");

-- ── Hashtag ──────────────────────────────────────────────────────────
ALTER TABLE "Hashtag"
  ADD COLUMN IF NOT EXISTS "blocked"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "blockedReason" TEXT,
  ADD COLUMN IF NOT EXISTS "createdById"   TEXT;

-- ── HashtagPerformance: one measurement row per hashtag/platform/post ─
DELETE FROM "HashtagPerformance" p USING (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "hashtagId", "platform", "postId" ORDER BY "measuredAt" DESC
  ) AS rn
  FROM "HashtagPerformance" WHERE "postId" IS NOT NULL
) d WHERE p."id" = d."id" AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "HashtagPerformance_hashtagId_platform_postId_key"
  ON "HashtagPerformance"("hashtagId", "platform", "postId");

-- ── TrendSignal ──────────────────────────────────────────────────────
ALTER TABLE "TrendSignal"
  ADD COLUMN IF NOT EXISTS "normalizedTag" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "sourceNote"    TEXT,
  ADD COLUMN IF NOT EXISTS "createdById"   TEXT;

UPDATE "TrendSignal" SET "normalizedTag" = lower("rawTag") WHERE "normalizedTag" = '';

DELETE FROM "TrendSignal" t USING (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "platform", "normalizedTag", "source", "region" ORDER BY "observedAt" DESC
  ) AS rn
  FROM "TrendSignal"
) d WHERE t."id" = d."id" AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "TrendSignal_platform_normalizedTag_source_region_key"
  ON "TrendSignal"("platform", "normalizedTag", "source", "region");

-- ── GenerationFeedback ───────────────────────────────────────────────
ALTER TABLE "GenerationFeedback" ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- ── Post -> AI suggestion link ───────────────────────────────────────
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "aiCaptionSuggestionId" TEXT;

DO $$ BEGIN
  ALTER TABLE "Post" ADD CONSTRAINT "Post_aiCaptionSuggestionId_fkey"
    FOREIGN KEY ("aiCaptionSuggestionId") REFERENCES "CaptionSuggestion"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "Post_aiCaptionSuggestionId_idx" ON "Post"("aiCaptionSuggestionId");