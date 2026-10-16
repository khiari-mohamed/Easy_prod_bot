-- Migration: 0003_comments_pptx
-- Brings the database in line with schema.prisma for the comment automation
-- (CommentJob) and PPTX plan import. Additive and idempotent.

ALTER TYPE "PlanImportSource" ADD VALUE IF NOT EXISTS 'PPTX';

DO $$ BEGIN
  CREATE TYPE "CommentJobKind" AS ENUM ('FIRST_COMMENT', 'REPLY', 'MODERATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CommentJobStatus" AS ENUM (
    'PENDING_APPROVAL', 'APPROVED', 'SENDING', 'SENT', 'FAILED', 'REJECTED', 'NEEDS_CHECK', 'SKIPPED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "CommentJob" (
  "id"              TEXT               NOT NULL,
  "platform"        "Platform"         NOT NULL,
  "kind"            "CommentJobKind"   NOT NULL,
  "status"          "CommentJobStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "postId"          TEXT,
  "accountId"       TEXT,
  "remoteMediaId"   TEXT,
  "remoteCommentId" TEXT,
  "authorName"      TEXT,
  "incomingText"    TEXT,
  "text"            TEXT               NOT NULL DEFAULT '',
  "aiGenerated"     BOOLEAN            NOT NULL DEFAULT false,
  "auto"            BOOLEAN            NOT NULL DEFAULT false,
  "note"            TEXT,
  "error"           TEXT,
  "attempts"        INTEGER            NOT NULL DEFAULT 0,
  "approvedById"    TEXT,
  "approvedAt"      TIMESTAMP(3),
  "sentAt"          TIMESTAMP(3),
  "resultRemoteId"  TEXT,
  "createdAt"       TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3)       NOT NULL,
  CONSTRAINT "CommentJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CommentJob_platform_remoteCommentId_key" ON "CommentJob"("platform", "remoteCommentId");
CREATE INDEX IF NOT EXISTS "CommentJob_status_kind_createdAt_idx" ON "CommentJob"("status", "kind", "createdAt");
CREATE INDEX IF NOT EXISTS "CommentJob_postId_kind_idx" ON "CommentJob"("postId", "kind");

DO $$ BEGIN
  ALTER TABLE "CommentJob"
    ADD CONSTRAINT "CommentJob_postId_fkey"
      FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
