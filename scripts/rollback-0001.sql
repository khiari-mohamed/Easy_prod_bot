-- Rollback for Stage 1 (expand). Only needed if you must remove the new structures.
-- Because Stage 1 is additive, the usual rollback is simply: redeploy the previous API image;
-- it ignores the new columns/tables. Use this file only to physically remove them.
-- DESTRUCTIVE for the new tables' data (ContentItem, PlanEntry...). Take a pg_dump first.
BEGIN;
DROP TABLE IF EXISTS "AccountMetricSnapshot", "ContentAsset", "ContentItem", "PlanEntry" CASCADE;

ALTER TABLE "Campaign"       DROP COLUMN IF EXISTS "autoPublishEnabled", DROP COLUMN IF EXISTS "publishingPaused", DROP COLUMN IF EXISTS "timezone";
ALTER TABLE "Asset"          DROP COLUMN IF EXISTS "sizeBytesBig", DROP COLUMN IF EXISTS "storageProvider", DROP COLUMN IF EXISTS "storageKey",
  DROP COLUMN IF EXISTS "previewKey", DROP COLUMN IF EXISTS "checksumSha256", DROP COLUMN IF EXISTS "source", DROP COLUMN IF EXISTS "sourceUrl",
  DROP COLUMN IF EXISTS "processingError", DROP COLUMN IF EXISTS "platformReady", DROP COLUMN IF EXISTS "folder", DROP COLUMN IF EXISTS "tags", DROP COLUMN IF EXISTS "deletedAt";
ALTER TABLE "SocialAccount"  DROP COLUMN IF EXISTS "tokenIssuedAt", DROP COLUMN IF EXISTS "grantedScopes", DROP COLUMN IF EXISTS "lastVerifiedAt",
  DROP COLUMN IF EXISTS "lastError", DROP COLUMN IF EXISTS "canPublish", DROP COLUMN IF EXISTS "canReadInsights";
ALTER TABLE "Post"           DROP COLUMN IF EXISTS "contentItemId", DROP COLUMN IF EXISTS "captionLanguage", DROP COLUMN IF EXISTS "approvalStatus",
  DROP COLUMN IF EXISTS "publishState", DROP COLUMN IF EXISTS "rejectionNote", DROP COLUMN IF EXISTS "stateMigratedAt",
  DROP COLUMN IF EXISTS "manualReminderSentAt", DROP COLUMN IF EXISTS "manualConfirmedAt", DROP COLUMN IF EXISTS "manualConfirmedById",
  DROP COLUMN IF EXISTS "remoteContainerId";
ALTER TABLE "PlanImport"     DROP COLUMN IF EXISTS "source", DROP COLUMN IF EXISTS "kind", DROP COLUMN IF EXISTS "campaignId", DROP COLUMN IF EXISTS "rangeStart",
  DROP COLUMN IF EXISTS "rangeEnd", DROP COLUMN IF EXISTS "errorCount", DROP COLUMN IF EXISTS "warningCount", DROP COLUMN IF EXISTS "fileChecksum", DROP COLUMN IF EXISTS "committedAt";
ALTER TABLE "PlanImportRow"  DROP COLUMN IF EXISTS "timeOfDay", DROP COLUMN IF EXISTS "caption", DROP COLUMN IF EXISTS "captionLanguage", DROP COLUMN IF EXISTS "publishMode",
  DROP COLUMN IF EXISTS "assetRef", DROP COLUMN IF EXISTS "warning", DROP COLUMN IF EXISTS "dedupeKey", DROP COLUMN IF EXISTS "planEntryId";
ALTER TABLE "PublishAttempt" DROP COLUMN IF EXISTS "state", DROP COLUMN IF EXISTS "finishedAt", DROP COLUMN IF EXISTS "remoteContainerId",
  DROP COLUMN IF EXISTS "remoteId", DROP COLUMN IF EXISTS "httpStatus", DROP COLUMN IF EXISTS "idempotencyKey";
ALTER TABLE "MetricSnapshot" DROP COLUMN IF EXISTS "unavailable", DROP COLUMN IF EXISTS "fetchError";
ALTER TABLE "Post" ALTER COLUMN "publishMode" SET DEFAULT 'AUTO';
-- Enum types/values added by Stage 1 (ApprovalStatus, PublishState, CaptionLanguage, AssetRole, AssetSource,
-- StorageProvider, PlanImportSource, PlanKind, AttemptState, and new values on PostStatus/AssetStatus/PlanImportStatus)
-- are harmless if left in place; Postgres cannot remove an enum value without recreating the type.
COMMIT;