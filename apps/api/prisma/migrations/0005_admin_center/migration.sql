-- Migration: 0005_admin_center
-- Adds: FeatureConfig, FeatureConfigAudit, CaptionSuggestion, CaptionReview,
--       Hashtag, HashtagSuggestion, HashtagUsage, HashtagPerformance,
--       TrendSignal, GenerationFeedback
-- Also adds: User.captionReviews, ContentItem.captionSuggestions,
--             Post.hashtagUsages (relation columns only, no data change)
-- Additive-only. Nothing existing is dropped, renamed, or retyped.

-- ── New enum types ────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "FeatureMode" AS ENUM ('OFF', 'REVIEW', 'AUTO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SettingScope" AS ENUM ('GLOBAL', 'CAMPAIGN', 'PLATFORM', 'ACCOUNT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SuggestionStatus" AS ENUM (
    'GENERATED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "HashtagOrigin" AS ENUM (
    'MANUAL', 'AI_GENERATED', 'IMPORTED', 'TREND_SOURCE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── FeatureConfig ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "FeatureConfig" (
  "id"          TEXT          NOT NULL,
  "featureKey"  TEXT          NOT NULL,
  "scope"       "SettingScope" NOT NULL DEFAULT 'GLOBAL',
  "scopeId"     TEXT          NOT NULL DEFAULT '',
  "mode"        "FeatureMode" NOT NULL DEFAULT 'OFF',
  "config"      JSONB,
  "updatedById" TEXT,
  "createdAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeatureConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FeatureConfig_featureKey_scope_scopeId_key"
  ON "FeatureConfig"("featureKey", "scope", "scopeId");
CREATE INDEX IF NOT EXISTS "FeatureConfig_scope_scopeId_idx"
  ON "FeatureConfig"("scope", "scopeId");

-- ── FeatureConfigAudit ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "FeatureConfigAudit" (
  "id"          TEXT          NOT NULL,
  "featureKey"  TEXT          NOT NULL,
  "scope"       "SettingScope" NOT NULL,
  "scopeId"     TEXT          NOT NULL DEFAULT '',
  "previous"    JSONB,
  "next"        JSONB         NOT NULL,
  "changedById" TEXT          NOT NULL,
  "reason"      TEXT,
  "createdAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeatureConfigAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FeatureConfigAudit_featureKey_createdAt_idx"
  ON "FeatureConfigAudit"("featureKey", "createdAt");

-- ── Hashtag ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Hashtag" (
  "id"            TEXT              NOT NULL,
  "normalizedTag" TEXT              NOT NULL,
  "displayTag"    TEXT              NOT NULL,
  "language"      "CaptionLanguage",
  "category"      TEXT,
  "origin"        "HashtagOrigin"   NOT NULL DEFAULT 'MANUAL',
  "notes"         TEXT,
  "createdAt"     TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Hashtag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Hashtag_normalizedTag_key" ON "Hashtag"("normalizedTag");

-- ── CaptionSuggestion ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "CaptionSuggestion" (
  "id"            TEXT               NOT NULL,
  "contentItemId" TEXT,
  "platform"      "Platform"         NOT NULL,
  "language"      "CaptionLanguage"  NOT NULL,
  "text"          TEXT               NOT NULL,
  "editedText"    TEXT,
  "finalText"     TEXT,
  "tone"          TEXT,
  "status"        "SuggestionStatus" NOT NULL DEFAULT 'GENERATED',
  "model"         TEXT               NOT NULL,
  "promptVersion" TEXT               NOT NULL DEFAULT 'v1',
  "warnings"      TEXT[]             NOT NULL DEFAULT '{}',
  "metadata"      JSONB,
  "createdAt"     TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CaptionSuggestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CaptionSuggestion_contentItemId_fkey"
    FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "CaptionSuggestion_contentItemId_platform_status_idx"
  ON "CaptionSuggestion"("contentItemId", "platform", "status");
CREATE INDEX IF NOT EXISTS "CaptionSuggestion_status_createdAt_idx"
  ON "CaptionSuggestion"("status", "createdAt");

-- ── CaptionReview ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "CaptionReview" (
  "id"           TEXT               NOT NULL,
  "suggestionId" TEXT               NOT NULL,
  "reviewerId"   TEXT               NOT NULL,
  "decision"     "SuggestionStatus" NOT NULL,
  "editedText"   TEXT,
  "feedback"     TEXT,
  "reviewedAt"   TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CaptionReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CaptionReview_suggestionId_fkey"
    FOREIGN KEY ("suggestionId") REFERENCES "CaptionSuggestion"("id") ON DELETE CASCADE,
  CONSTRAINT "CaptionReview_reviewerId_fkey"
    FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "CaptionReview_suggestionId_reviewedAt_idx"
  ON "CaptionReview"("suggestionId", "reviewedAt");

-- ── HashtagSuggestion ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "HashtagSuggestion" (
  "id"                  TEXT               NOT NULL,
  "captionSuggestionId" TEXT               NOT NULL,
  "hashtagId"           TEXT               NOT NULL,
  "rank"                INTEGER            NOT NULL DEFAULT 0,
  "reason"              TEXT,
  "status"              "SuggestionStatus" NOT NULL DEFAULT 'GENERATED',
  CONSTRAINT "HashtagSuggestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HashtagSuggestion_captionSuggestionId_fkey"
    FOREIGN KEY ("captionSuggestionId") REFERENCES "CaptionSuggestion"("id") ON DELETE CASCADE,
  CONSTRAINT "HashtagSuggestion_hashtagId_fkey"
    FOREIGN KEY ("hashtagId") REFERENCES "Hashtag"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "HashtagSuggestion_captionSuggestionId_hashtagId_key"
  ON "HashtagSuggestion"("captionSuggestionId", "hashtagId");
CREATE INDEX IF NOT EXISTS "HashtagSuggestion_hashtagId_status_idx"
  ON "HashtagSuggestion"("hashtagId", "status");

-- ── HashtagUsage ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "HashtagUsage" (
  "id"        TEXT          NOT NULL,
  "postId"    TEXT          NOT NULL,
  "hashtagId" TEXT          NOT NULL,
  "platform"  "Platform"    NOT NULL,
  "usedAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HashtagUsage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HashtagUsage_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE,
  CONSTRAINT "HashtagUsage_hashtagId_fkey"
    FOREIGN KEY ("hashtagId") REFERENCES "Hashtag"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "HashtagUsage_postId_hashtagId_key"
  ON "HashtagUsage"("postId", "hashtagId");
CREATE INDEX IF NOT EXISTS "HashtagUsage_hashtagId_platform_usedAt_idx"
  ON "HashtagUsage"("hashtagId", "platform", "usedAt");

-- ── HashtagPerformance ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "HashtagPerformance" (
  "id"          TEXT          NOT NULL,
  "hashtagId"   TEXT          NOT NULL,
  "platform"    "Platform"    NOT NULL,
  "postId"      TEXT,
  "impressions" INTEGER,
  "reach"       INTEGER,
  "engagements" INTEGER,
  "measuredAt"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HashtagPerformance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HashtagPerformance_hashtagId_fkey"
    FOREIGN KEY ("hashtagId") REFERENCES "Hashtag"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "HashtagPerformance_hashtagId_platform_measuredAt_idx"
  ON "HashtagPerformance"("hashtagId", "platform", "measuredAt");

-- ── TrendSignal ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "TrendSignal" (
  "id"         TEXT          NOT NULL,
  "platform"   "Platform"    NOT NULL,
  "hashtagId"  TEXT,
  "rawTag"     TEXT          NOT NULL,
  "source"     TEXT          NOT NULL,
  "region"     TEXT          NOT NULL DEFAULT 'TN',
  "score"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "observedAt" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"  TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "TrendSignal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrendSignal_hashtagId_fkey"
    FOREIGN KEY ("hashtagId") REFERENCES "Hashtag"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "TrendSignal_platform_expiresAt_idx"
  ON "TrendSignal"("platform", "expiresAt");
CREATE INDEX IF NOT EXISTS "TrendSignal_hashtagId_platform_idx"
  ON "TrendSignal"("hashtagId", "platform");

-- ── GenerationFeedback ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "GenerationFeedback" (
  "id"           TEXT          NOT NULL,
  "suggestionId" TEXT          NOT NULL,
  "rating"       INTEGER       NOT NULL,
  "reason"       TEXT,
  "createdAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GenerationFeedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GenerationFeedback_suggestionId_fkey"
    FOREIGN KEY ("suggestionId") REFERENCES "CaptionSuggestion"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "GenerationFeedback_suggestionId_idx"
  ON "GenerationFeedback"("suggestionId");
