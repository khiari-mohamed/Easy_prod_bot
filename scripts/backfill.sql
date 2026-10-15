-- Stage 1 data backfill. Run AFTER the expand migration is applied.
-- Idempotent: safe to run more than once. Non-destructive: only fills NEW columns/tables.
-- Take a pg_dump first. Run inside a transaction and check the counts at the bottom.
BEGIN;

-- 1. PlanEntry from legacy CampaignDay (deterministic ids => re-runnable)
INSERT INTO "PlanEntry" ("id","campaignId","legacyDayId","date","phase","label","content","execution","objective","platforms","format","updatedAt")
SELECT 'pe_' || d."id", d."campaignId", d."id", d."date", d."phase", d."label", d."content", d."execution", d."objective", d."platforms", d."format", now()
FROM "CampaignDay" d
ON CONFLICT ("id") DO NOTHING;

-- 2. ContentItem: one per CampaignDay group, or one per standalone post
INSERT INTO "ContentItem" ("id","campaignId","planEntryId","title","baseCaption","hashtags","approvalStatus","approvedById","approvedAt","createdById","updatedAt")
SELECT DISTINCT ON (COALESCE(p."dayId", p."id"))
  'ci_' || COALESCE(p."dayId", p."id"),
  p."campaignId",
  CASE WHEN p."dayId" IS NOT NULL THEN 'pe_' || p."dayId" END,
  COALESCE(NULLIF(d."label", ''), left(p."caption", 60), 'Untitled'),
  p."caption",
  p."hashtags",
  CASE WHEN p."approvedAt" IS NOT NULL THEN 'APPROVED'
       WHEN p."status" = 'PENDING_APPROVAL' THEN 'PENDING'
       ELSE 'DRAFT' END::"ApprovalStatus",
  p."approvedById",
  p."approvedAt",
  p."createdById",
  now()
FROM "Post" p
LEFT JOIN "CampaignDay" d ON d."id" = p."dayId"
WHERE p."contentItemId" IS NULL
ORDER BY COALESCE(p."dayId", p."id"), p."createdAt"
ON CONFLICT ("id") DO NOTHING;

-- 3. Link posts to their ContentItem
UPDATE "Post" SET "contentItemId" = 'ci_' || COALESCE("dayId", "id")
WHERE "contentItemId" IS NULL;

-- 4. Media: the legacy single asset becomes the MAIN asset of the content item
INSERT INTO "ContentAsset" ("id","contentItemId","assetId","order","role")
SELECT DISTINCT ON (p."contentItemId")
  'ca_' || p."contentItemId", p."contentItemId", p."assetId", 0, 'MAIN'
FROM "Post" p
WHERE p."contentItemId" IS NOT NULL AND p."assetId" IS NOT NULL
ORDER BY p."contentItemId", p."createdAt"
ON CONFLICT ("id") DO NOTHING;

-- 5. Split legacy status into approvalStatus + publishState (only rows not yet migrated)
UPDATE "Post" SET
  "approvalStatus" = CASE
    WHEN "approvedAt" IS NOT NULL THEN 'APPROVED'
    WHEN "status" = 'PENDING_APPROVAL' THEN 'PENDING'
    ELSE 'DRAFT' END::"ApprovalStatus",
  "publishState" = CASE "status"
    WHEN 'QUEUED'          THEN 'QUEUED'
    -- A post stuck in PUBLISHING at migration time is ambiguous: never auto-retry it.
    WHEN 'PUBLISHING'      THEN 'NEEDS_RECONCILIATION'
    WHEN 'PUBLISHED'       THEN 'PUBLISHED'
    WHEN 'FAILED'          THEN 'FAILED'
    WHEN 'MANUAL_REQUIRED' THEN 'MANUAL_PENDING'
    WHEN 'CANCELLED'       THEN 'CANCELLED'
    WHEN 'APPROVED'        THEN CASE WHEN "scheduledAt" IS NOT NULL THEN 'SCHEDULED' ELSE 'NOT_SCHEDULED' END
    ELSE 'NOT_SCHEDULED' END::"PublishState",
  "stateMigratedAt" = now()
WHERE "stateMigratedAt" IS NULL;

-- 6. Asset size to BigInt
UPDATE "Asset" SET "sizeBytesBig" = "sizeBytes"::bigint
WHERE "sizeBytesBig" IS NULL AND "sizeBytes" IS NOT NULL;

-- 7. Attempt state for legacy attempts
UPDATE "PublishAttempt" SET "state" = CASE WHEN "ok" THEN 'SUCCEEDED' ELSE 'FAILED' END::"AttemptState"
WHERE "state" IS NULL;

-- 8. Verification (all should be 0 / match)
SELECT 'posts without contentItem'      AS check, count(*) FROM "Post" WHERE "contentItemId" IS NULL
UNION ALL SELECT 'posts not state-migrated',  count(*) FROM "Post" WHERE "stateMigratedAt" IS NULL
UNION ALL SELECT 'days without planEntry',    count(*) FROM "CampaignDay" d WHERE NOT EXISTS (SELECT 1 FROM "PlanEntry" e WHERE e."legacyDayId" = d."id")
UNION ALL SELECT 'assets sizeBytes unmigrated', count(*) FROM "Asset" WHERE "sizeBytes" IS NOT NULL AND "sizeBytesBig" IS NULL;

COMMIT;

-- OPTIONAL, separate decision (NOT run by default):
-- Existing campaigns default to autoPublishEnabled=false. Once the new worker enforces it,
-- already-approved AUTO posts will wait until someone enables it per campaign. To preserve
-- today's behaviour instead, run:
--   UPDATE "Campaign" SET "autoPublishEnabled" = true;
-- To make everything not yet published manual before go-live:
--   UPDATE "Post" SET "publishMode" = 'MANUAL' WHERE "publishedAt" IS NULL;