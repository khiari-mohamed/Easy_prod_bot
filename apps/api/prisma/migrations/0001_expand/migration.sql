-- Migration: 0001_expand
-- Full baseline: creates all enums, tables, indexes and foreign keys from scratch.
-- Safe to run on a fresh database. Idempotent via IF NOT EXISTS guards.

-- ─── Enums ────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "Role" AS ENUM ('ADMIN', 'APPROVER', 'EDITOR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "Platform" AS ENUM ('FACEBOOK', 'INSTAGRAM', 'TIKTOK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "PostFormat" AS ENUM ('IMAGE', 'VIDEO', 'REEL', 'STORY', 'TEXT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "PostStatus" AS ENUM (
    'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'PUBLISHING',
    'PUBLISHED', 'FAILED', 'MANUAL_REQUIRED', 'CANCELLED', 'NEEDS_RECONCILIATION'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ApprovalStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "PublishState" AS ENUM (
    'NOT_SCHEDULED', 'SCHEDULED', 'QUEUED', 'PUBLISHING', 'PUBLISHED',
    'FAILED', 'MANUAL_PENDING', 'MANUAL_CONFIRMED', 'NEEDS_RECONCILIATION', 'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "CaptionLanguage" AS ENUM ('DARIJA', 'FRENCH', 'DARIJA_FRENCH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'DISCONNECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "AssetKind" AS ENUM ('IMAGE', 'VIDEO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "AssetStatus" AS ENUM ('PENDING', 'READY', 'INVALID', 'UPLOADING', 'PROCESSING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "AssetRole" AS ENUM ('MAIN', 'COVER', 'CAROUSEL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "AssetSource" AS ENUM ('UPLOAD', 'GOOGLE_DRIVE', 'DROPBOX');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "StorageProvider" AS ENUM ('LOCAL', 'S3');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "PublishMode" AS ENUM ('AUTO', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "PlanImportStatus" AS ENUM ('PREVIEW', 'COMMITTED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "PlanImportSource" AS ENUM ('CSV', 'XLSX', 'PDF', 'DOCX', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "PlanKind" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "AttemptState" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED', 'AMBIGUOUS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "MetricSource" AS ENUM ('API', 'MANUAL', 'IMPORT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Tables ───────────────────────────────────────────────────────────────────

CREATE TABLE "User" (
  "id"           TEXT         NOT NULL,
  "email"        TEXT         NOT NULL,
  "name"         TEXT         NOT NULL,
  "passwordHash" TEXT         NOT NULL,
  "role"         "Role"       NOT NULL DEFAULT 'EDITOR',
  "active"       BOOLEAN      NOT NULL DEFAULT TRUE,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE TABLE "Campaign" (
  "id"                 TEXT         NOT NULL,
  "slug"               TEXT         NOT NULL,
  "titleLatin"         TEXT         NOT NULL,
  "titleArabic"        TEXT,
  "hashtags"           TEXT[]       NOT NULL DEFAULT '{}',
  "releaseDate"        TIMESTAMP(3) NOT NULL,
  "brief"              TEXT         NOT NULL DEFAULT '',
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "autoPublishEnabled" BOOLEAN      NOT NULL DEFAULT FALSE,
  "publishingPaused"   BOOLEAN      NOT NULL DEFAULT FALSE,
  "timezone"           TEXT         NOT NULL DEFAULT 'Africa/Tunis',
  CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Campaign_slug_key" ON "Campaign"("slug");

CREATE TABLE "CampaignDay" (
  "id"         TEXT         NOT NULL,
  "campaignId" TEXT         NOT NULL,
  "date"       TIMESTAMP(3) NOT NULL,
  "phase"      TEXT         NOT NULL,
  "label"      TEXT         NOT NULL,
  "content"    TEXT         NOT NULL,
  "execution"  TEXT         NOT NULL,
  "objective"  TEXT         NOT NULL,
  "platforms"  "Platform"[],
  "format"     "PostFormat" NOT NULL DEFAULT 'REEL',
  CONSTRAINT "CampaignDay_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CampaignDay_campaignId_date_key" ON "CampaignDay"("campaignId", "date");

CREATE TABLE "Asset" (
  "id"               TEXT            NOT NULL,
  "name"             TEXT            NOT NULL,
  "kind"             "AssetKind"     NOT NULL,
  "url"              TEXT            NOT NULL,
  "mime"             TEXT,
  "sizeBytes"        INTEGER,
  "storedAs"         TEXT,
  "processingStatus" "AssetStatus"   NOT NULL DEFAULT 'READY',
  "durationSecs"     DOUBLE PRECISION,
  "widthPx"          INTEGER,
  "heightPx"         INTEGER,
  "processingNote"   TEXT,
  "createdAt"        TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sizeBytesBig"     BIGINT,
  "storageProvider"  "StorageProvider" NOT NULL DEFAULT 'LOCAL',
  "storageKey"       TEXT,
  "previewKey"       TEXT,
  "checksumSha256"   TEXT,
  "source"           "AssetSource"   NOT NULL DEFAULT 'UPLOAD',
  "sourceUrl"        TEXT,
  "processingError"  TEXT,
  "platformReady"    JSONB,
  "folder"           TEXT,
  "tags"             TEXT[]          NOT NULL DEFAULT '{}',
  "deletedAt"        TIMESTAMP(3),
  CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Asset_checksumSha256_idx" ON "Asset"("checksumSha256");
CREATE INDEX "Asset_kind_createdAt_idx" ON "Asset"("kind", "createdAt");

CREATE TABLE "SocialAccount" (
  "id"             TEXT            NOT NULL,
  "platform"       "Platform"      NOT NULL,
  "externalId"     TEXT            NOT NULL,
  "name"           TEXT            NOT NULL,
  "username"       TEXT,
  "encryptedToken" TEXT            NOT NULL,
  "tokenExpiresAt" TIMESTAMP(3),
  "status"         "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt"      TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3)    NOT NULL,
  "tokenIssuedAt"  TIMESTAMP(3),
  "grantedScopes"  TEXT[]          NOT NULL DEFAULT '{}',
  "lastVerifiedAt" TIMESTAMP(3),
  "lastError"      TEXT,
  "canPublish"     BOOLEAN,
  "canReadInsights" BOOLEAN,
  CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SocialAccount_platform_externalId_key" ON "SocialAccount"("platform", "externalId");

CREATE TABLE "PlanImport" (
  "id"           TEXT               NOT NULL,
  "filename"     TEXT               NOT NULL,
  "status"       "PlanImportStatus" NOT NULL DEFAULT 'PREVIEW',
  "rowCount"     INTEGER            NOT NULL,
  "createdById"  TEXT,
  "createdAt"    TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source"       "PlanImportSource" NOT NULL DEFAULT 'CSV',
  "kind"         "PlanKind"         NOT NULL DEFAULT 'CUSTOM',
  "campaignId"   TEXT,
  "rangeStart"   TIMESTAMP(3),
  "rangeEnd"     TIMESTAMP(3),
  "errorCount"   INTEGER            NOT NULL DEFAULT 0,
  "warningCount" INTEGER            NOT NULL DEFAULT 0,
  "fileChecksum" TEXT,
  "committedAt"  TIMESTAMP(3),
  CONSTRAINT "PlanImport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PlanImport_fileChecksum_idx" ON "PlanImport"("fileChecksum");

CREATE TABLE "PlanEntry" (
  "id"          TEXT         NOT NULL,
  "campaignId"  TEXT         NOT NULL,
  "importId"    TEXT,
  "legacyDayId" TEXT         UNIQUE,
  "date"        TIMESTAMP(3) NOT NULL,
  "timeOfDay"   TEXT,
  "phase"       TEXT         NOT NULL DEFAULT '',
  "label"       TEXT         NOT NULL,
  "content"     TEXT         NOT NULL DEFAULT '',
  "execution"   TEXT         NOT NULL DEFAULT '',
  "objective"   TEXT         NOT NULL DEFAULT '',
  "platforms"   "Platform"[],
  "format"      "PostFormat" NOT NULL DEFAULT 'REEL',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlanEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PlanEntry_campaignId_date_idx" ON "PlanEntry"("campaignId", "date");

CREATE TABLE "PlanImportRow" (
  "id"              TEXT         NOT NULL,
  "importId"        TEXT         NOT NULL,
  "rowIndex"        INTEGER      NOT NULL,
  "date"            TIMESTAMP(3) NOT NULL,
  "phase"           TEXT         NOT NULL,
  "label"           TEXT         NOT NULL,
  "content"         TEXT         NOT NULL,
  "execution"       TEXT         NOT NULL,
  "objective"       TEXT         NOT NULL,
  "platforms"       "Platform"[],
  "format"          "PostFormat" NOT NULL,
  "error"           TEXT,
  "timeOfDay"       TEXT,
  "caption"         TEXT,
  "captionLanguage" "CaptionLanguage",
  "publishMode"     "PublishMode",
  "assetRef"        TEXT,
  "warning"         TEXT,
  "dedupeKey"       TEXT,
  "planEntryId"     TEXT,
  CONSTRAINT "PlanImportRow_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PlanImportRow_importId_rowIndex_idx" ON "PlanImportRow"("importId", "rowIndex");
CREATE INDEX "PlanImportRow_dedupeKey_idx" ON "PlanImportRow"("dedupeKey");

CREATE TABLE "ContentItem" (
  "id"                 TEXT             NOT NULL,
  "campaignId"         TEXT,
  "planEntryId"        TEXT,
  "title"              TEXT             NOT NULL,
  "captionLanguage"    "CaptionLanguage",
  "baseCaption"        TEXT             NOT NULL DEFAULT '',
  "hashtags"           TEXT[]           NOT NULL DEFAULT '{}',
  "defaultPublishMode" "PublishMode"    NOT NULL DEFAULT 'MANUAL',
  "approvalStatus"     "ApprovalStatus" NOT NULL DEFAULT 'DRAFT',
  "approvedById"       TEXT,
  "approvedAt"         TIMESTAMP(3),
  "rejectionNote"      TEXT,
  "createdById"        TEXT,
  "createdAt"          TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContentItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ContentItem_campaignId_approvalStatus_idx" ON "ContentItem"("campaignId", "approvalStatus");

CREATE TABLE "ContentAsset" (
  "id"            TEXT        NOT NULL,
  "contentItemId" TEXT        NOT NULL,
  "assetId"       TEXT        NOT NULL,
  "order"         INTEGER     NOT NULL DEFAULT 0,
  "role"          "AssetRole" NOT NULL DEFAULT 'MAIN',
  CONSTRAINT "ContentAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContentAsset_contentItemId_assetId_key" UNIQUE ("contentItemId", "assetId")
);
CREATE INDEX "ContentAsset_contentItemId_order_idx" ON "ContentAsset"("contentItemId", "order");

CREATE TABLE "Post" (
  "id"                   TEXT             NOT NULL,
  "campaignId"           TEXT,
  "dayId"                TEXT,
  "platform"             "Platform"       NOT NULL,
  "format"               "PostFormat"     NOT NULL,
  "caption"              TEXT             NOT NULL,
  "hashtags"             TEXT[]           NOT NULL DEFAULT '{}',
  "assetId"              TEXT,
  "accountId"            TEXT,
  "scheduledAt"          TIMESTAMP(3),
  "publishMode"          "PublishMode"    NOT NULL DEFAULT 'MANUAL',
  "status"               "PostStatus"     NOT NULL DEFAULT 'DRAFT',
  "isExternal"           BOOLEAN          NOT NULL DEFAULT FALSE,
  "createdById"          TEXT,
  "approvedById"         TEXT,
  "approvedAt"           TIMESTAMP(3),
  "externalId"           TEXT,
  "externalUrl"          TEXT,
  "publishedAt"          TIMESTAMP(3),
  "statusNote"           TEXT,
  "createdAt"            TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3)     NOT NULL,
  "contentItemId"        TEXT,
  "captionLanguage"      "CaptionLanguage",
  "approvalStatus"       "ApprovalStatus" NOT NULL DEFAULT 'DRAFT',
  "publishState"         "PublishState"   NOT NULL DEFAULT 'NOT_SCHEDULED',
  "rejectionNote"        TEXT,
  "stateMigratedAt"      TIMESTAMP(3),
  "manualReminderSentAt" TIMESTAMP(3),
  "manualConfirmedAt"    TIMESTAMP(3),
  "manualConfirmedById"  TEXT,
  "remoteContainerId"    TEXT,
  CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Post_status_scheduledAt_idx" ON "Post"("status", "scheduledAt");
CREATE INDEX "Post_platform_publishedAt_idx" ON "Post"("platform", "publishedAt");
CREATE INDEX "Post_approvalStatus_publishState_scheduledAt_idx" ON "Post"("approvalStatus", "publishState", "scheduledAt");
CREATE INDEX "Post_contentItemId_idx" ON "Post"("contentItemId");

CREATE TABLE "PublishAttempt" (
  "id"                TEXT          NOT NULL,
  "postId"            TEXT          NOT NULL,
  "startedAt"         TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ok"                BOOLEAN       NOT NULL,
  "error"             TEXT,
  "state"             "AttemptState",
  "finishedAt"        TIMESTAMP(3),
  "remoteContainerId" TEXT,
  "remoteId"          TEXT,
  "httpStatus"        INTEGER,
  "idempotencyKey"    TEXT,
  CONSTRAINT "PublishAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PublishAttempt_postId_startedAt_idx" ON "PublishAttempt"("postId", "startedAt");

CREATE TABLE "MetricSnapshot" (
  "id"          TEXT          NOT NULL,
  "postId"      TEXT          NOT NULL,
  "capturedAt"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source"      "MetricSource" NOT NULL,
  "views"       INTEGER       NOT NULL DEFAULT 0,
  "reach"       INTEGER       NOT NULL DEFAULT 0,
  "likes"       INTEGER       NOT NULL DEFAULT 0,
  "comments"    INTEGER       NOT NULL DEFAULT 0,
  "shares"      INTEGER       NOT NULL DEFAULT 0,
  "saves"       INTEGER       NOT NULL DEFAULT 0,
  "clicks"      INTEGER       NOT NULL DEFAULT 0,
  "unavailable" TEXT[]        NOT NULL DEFAULT '{}',
  "fetchError"  TEXT,
  CONSTRAINT "MetricSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MetricSnapshot_postId_capturedAt_idx" ON "MetricSnapshot"("postId", "capturedAt");

CREATE TABLE "AccountMetricSnapshot" (
  "id"           TEXT          NOT NULL,
  "accountId"    TEXT          NOT NULL,
  "capturedAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source"       "MetricSource" NOT NULL DEFAULT 'API',
  "followers"    INTEGER,
  "reach"        INTEGER,
  "views"        INTEGER,
  "profileViews" INTEGER,
  "engagements"  INTEGER,
  "fetchError"   TEXT,
  CONSTRAINT "AccountMetricSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AccountMetricSnapshot_accountId_capturedAt_idx" ON "AccountMetricSnapshot"("accountId", "capturedAt");

CREATE TABLE "Setting" (
  "key"       TEXT         NOT NULL,
  "value"     JSONB        NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "AuditLog" (
  "id"       TEXT         NOT NULL,
  "at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId"   TEXT,
  "action"   TEXT         NOT NULL,
  "entity"   TEXT         NOT NULL,
  "entityId" TEXT,
  "data"     JSONB,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- ─── Foreign keys ─────────────────────────────────────────────────────────────

ALTER TABLE "CampaignDay"
  ADD CONSTRAINT "CampaignDay_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE;

ALTER TABLE "PlanEntry"
  ADD CONSTRAINT "PlanEntry_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "PlanEntry_importId_fkey"
    FOREIGN KEY ("importId") REFERENCES "PlanImport"("id") ON DELETE SET NULL;

ALTER TABLE "PlanImport"
  ADD CONSTRAINT "PlanImport_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "PlanImport_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL;

ALTER TABLE "PlanImportRow"
  ADD CONSTRAINT "PlanImportRow_importId_fkey"
    FOREIGN KEY ("importId") REFERENCES "PlanImport"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "PlanImportRow_planEntryId_fkey"
    FOREIGN KEY ("planEntryId") REFERENCES "PlanEntry"("id") ON DELETE SET NULL;

ALTER TABLE "ContentItem"
  ADD CONSTRAINT "ContentItem_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "ContentItem_planEntryId_fkey"
    FOREIGN KEY ("planEntryId") REFERENCES "PlanEntry"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "ContentItem_approvedById_fkey"
    FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "ContentItem_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL;

ALTER TABLE "ContentAsset"
  ADD CONSTRAINT "ContentAsset_contentItemId_fkey"
    FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "ContentAsset_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT;

ALTER TABLE "Post"
  ADD CONSTRAINT "Post_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "Post_dayId_fkey"
    FOREIGN KEY ("dayId") REFERENCES "CampaignDay"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "Post_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "Post_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "Post_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "Post_approvedById_fkey"
    FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "Post_contentItemId_fkey"
    FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "Post_manualConfirmedById_fkey"
    FOREIGN KEY ("manualConfirmedById") REFERENCES "User"("id") ON DELETE SET NULL;

ALTER TABLE "PublishAttempt"
  ADD CONSTRAINT "PublishAttempt_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE;

ALTER TABLE "MetricSnapshot"
  ADD CONSTRAINT "MetricSnapshot_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE;

ALTER TABLE "AccountMetricSnapshot"
  ADD CONSTRAINT "AccountMetricSnapshot_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE;

ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL;
