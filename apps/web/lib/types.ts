export type Platform = 'FACEBOOK' | 'INSTAGRAM' | 'TIKTOK';
export type PostFormat = 'IMAGE' | 'VIDEO' | 'REEL' | 'STORY' | 'TEXT';
export type PublishMode = 'AUTO' | 'MANUAL';
export type AssetStatus = 'PENDING' | 'READY' | 'INVALID' | 'UPLOADING' | 'PROCESSING';
export type CaptionLanguage = 'DARIJA' | 'FRENCH' | 'DARIJA_FRENCH';
export type ApprovalStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED';
export type PostStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'QUEUED'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'FAILED'
  | 'MANUAL_REQUIRED'
  | 'NEEDS_RECONCILIATION'
  | 'CANCELLED';
export type Role = 'ADMIN' | 'APPROVER' | 'EDITOR';

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface Asset {
  id: string;
  name: string;
  kind: 'IMAGE' | 'VIDEO';
  url: string;
  mime: string | null;
  sizeBytes: number | null;
  sizeBytesBig: string | null;
  durationSecs: number | null;
  widthPx: number | null;
  heightPx: number | null;
  processingStatus: AssetStatus;
  processingNote: string | null;
  platformReady: Record<string, { ok: boolean; reason?: string }> | null;
  source: 'UPLOAD' | 'GOOGLE_DRIVE' | 'DROPBOX';
  folder: string | null;
  tags: string[];
  createdAt: string;
}

export interface Metrics {
  views: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  capturedAt: string;
  source: string;
}

export interface Post {
  id: string;
  platform: Platform;
  format: PostFormat;
  caption: string;
  hashtags: string[];
  captionLanguage: CaptionLanguage | null;
  status: PostStatus;
  publishMode: PublishMode;
  statusNote: string | null;
  scheduledAt: string | null;
  publishedAt: string | null;
  externalUrl: string | null;
  manualConfirmedAt: string | null;
  assetId: string | null;
  asset: Asset | null;
  contentItemId: string | null;
  contentItem: { id: string; title: string; approvalStatus: ApprovalStatus } | null;
  day: { id: string; label: string; date: string } | null;
  metrics: Metrics[];
  attempts?: Array<{ id: string; startedAt: string; ok: boolean; error: string | null }>;
  manualConfirmedBy?: { id: string; name: string } | null;
}

export interface ContentAsset {
  id: string;
  assetId: string;
  order: number;
  role: 'MAIN' | 'COVER' | 'CAROUSEL';
  asset: Asset;
}

export interface ContentItem {
  id: string;
  title: string;
  captionLanguage: CaptionLanguage | null;
  baseCaption: string;
  hashtags: string[];
  defaultPublishMode: PublishMode;
  approvalStatus: ApprovalStatus;
  rejectionNote: string | null;
  campaignId: string | null;
  planEntryId: string | null;
  createdAt: string;
  updatedAt: string;
  assets: ContentAsset[];
  posts: Array<{
    id: string;
    platform: Platform;
    format: PostFormat;
    status: PostStatus;
    publishMode: PublishMode;
    scheduledAt: string | null;
    caption: string;
  }>;
  createdBy: { id: string; name: string } | null;
  approvedBy: { id: string; name: string } | null;
}

export interface PlanEntry {
  id: string;
  campaignId: string;
  date: string;
  timeOfDay: string | null;
  phase: string;
  label: string;
  content: string;
  execution: string;
  objective: string;
  platforms: Platform[];
  format: PostFormat;
  createdAt: string;
}

export interface CampaignDay {
  id: string;
  date: string;
  phase: string;
  label: string;
  content: string;
  execution: string;
  objective: string;
  platforms: Platform[];
  format: PostFormat;
  posts: Array<{ id: string; platform: Platform; format: PostFormat; status: PostStatus; scheduledAt: string | null; caption: string }>;
}

export interface Campaign {
  id: string;
  titleLatin: string;
  titleArabic: string | null;
  hashtags: string[];
  releaseDate: string;
  brief: string;
  autoPublishEnabled: boolean;
  publishingPaused: boolean;
  timezone: string;
  days: CampaignDay[];
}

export interface Account {
  id: string;
  platform: Platform;
  externalId: string;
  name: string;
  username: string | null;
  status: 'ACTIVE' | 'EXPIRED' | 'DISCONNECTED';
  /** null = never verified / cannot be verified. */
  canPublish?: boolean | null;
  canReadInsights?: boolean | null;
  tokenExpiresAt?: string | null;
  lastVerifiedAt?: string | null;
  lastError?: string | null;
}

export type PlanImportStatus = 'PREVIEW' | 'COMMITTED' | 'FAILED';

export interface PlanImportRow {
  id: string;
  rowIndex: number;
  date: string;
  phase: string;
  label: string;
  content: string;
  execution: string;
  objective: string;
  platforms: Platform[];
  format: PostFormat;
  timeOfDay: string | null;
  caption: string | null;
  captionLanguage: CaptionLanguage | null;
  publishMode: PublishMode | null;
  assetRef: string | null;
  error: string | null;
  warning: string | null;
}

export interface PlanImport {
  id: string;
  filename: string;
  status: PlanImportStatus;
  rowCount: number;
  errorCount: number;
  warningCount: number;
  createdAt: string;
  rows?: PlanImportRow[];
  _count?: { rows: number };
}

export interface PauseState {
  paused: boolean;
  reason?: string;
  at?: string;
}

export interface Slot {
  label: string;
  n: number;
  score: number;
  reliable: boolean;
}

export interface BestTime {
  provisional: boolean;
  sampleSize: number;
  hourBlocks: Slot[];
  weekdays: Slot[];
  suggestion: string;
  followerActivity?: number[] | null;
}

export interface Overview {
  statusCounts: Record<string, number>;
  platforms: Array<{
    platform: Platform;
    posts: number;
    views: number;
    reach: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    engagementRate: number;
  }>;
  topPosts: Array<{
    id: string;
    platform: Platform;
    caption: string;
    publishedAt: string | null;
    externalUrl: string | null;
    views: number;
    reach: number;
    interactions: number;
    engagementRate: number;
  }>;
}

export interface PublishingOverview {
  pauseState: PauseState;
  campaign: { id: string; autoPublishEnabled: boolean; publishingPaused: boolean; timezone: string } | null;
  queued: Array<{ id: string; platform: Platform; format: PostFormat; caption: string; scheduledAt: string | null; publishMode: PublishMode }>;
  publishing: Array<{ id: string; platform: Platform; format: PostFormat; caption: string; scheduledAt: string | null; updatedAt: string }>;
  failed: Array<{ id: string; platform: Platform; format: PostFormat; caption: string; scheduledAt: string | null; statusNote: string | null; updatedAt: string }>;
  manualRequired: Array<{ id: string; platform: Platform; format: PostFormat; caption: string; scheduledAt: string | null; statusNote: string | null; publishMode: PublishMode }>;
  needsCheck: Array<{ id: string; platform: Platform; format: PostFormat; caption: string; scheduledAt: string | null; statusNote: string | null; updatedAt: string }>;
  recentPublished: Array<{ id: string; platform: Platform; format: PostFormat; caption: string; publishedAt: string | null; externalUrl: string | null; publishMode: PublishMode; manualConfirmedAt: string | null }>;
}