-- Migration: 0002_media_pipeline
-- Adds the resumable (chunked) upload session used by the media pipeline.
-- Additive and idempotent: safe to run on databases created from an older
-- baseline. The two Post columns added for "publish now" live in 0001_expand
-- (guarded here as well for databases that predate that edit).

-- ─── Enums ────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "UploadStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Post: one-off "publish now" authorization (also in 0001 for fresh DBs) ────

ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "publishNowAuthorizedAt" TIMESTAMP(3);
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "publishNowAuthorizedById" TEXT;

-- ─── Tables ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "MediaUpload" (
  "id"            TEXT         NOT NULL,
  "name"          TEXT         NOT NULL,
  "mime"          TEXT,
  "kind"          "AssetKind"  NOT NULL,
  "totalBytes"    BIGINT,
  "receivedBytes" BIGINT       NOT NULL DEFAULT 0,
  "partCount"     INTEGER      NOT NULL DEFAULT 0,
  "status"        "UploadStatus" NOT NULL DEFAULT 'OPEN',
  "tempKey"       TEXT         NOT NULL,
  "assetId"       TEXT,
  "createdById"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MediaUpload_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MediaUpload_status_expiresAt_idx" ON "MediaUpload"("status", "expiresAt");

-- ─── Foreign keys ─────────────────────────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE "MediaUpload"
    ADD CONSTRAINT "MediaUpload_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
