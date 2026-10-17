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

export type PlanActionType = 'POST' | 'COMMENT' | 'ENGAGEMENT' | 'SPONSORING' | 'PREPARATION' | 'REPORTING' | 'OTHER';
export type PlanProgress = 'PENDING' | 'DONE' | 'SKIPPED' | 'BLOCKED';

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
  actionType: PlanActionType;
  text: string | null;
  sourceRef: string | null;
  sourceText: string | null;
  progress: PlanProgress;
  progressNote: string | null;
  progressAt: string | null;
  contentItems?: Array<{ id: string; approvalStatus: string }>;
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
  date: string | null;
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
  actionType: PlanActionType;
  sourceRef: string | null;
  sourceText: string | null;
  dateText: string | null;
  confidence: number | null;
  verified: boolean;
  edited: boolean;
  original: Record<string, unknown> | null;
}

export interface PlanImport {
  id: string;
  filename: string;
  status: PlanImportStatus;
  rowCount: number;
  errorCount: number;
  warningCount: number;
  createdAt: string;
  source?: string;
  hasSource?: boolean;
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
/* ───────────── AI Content Studio ───────────── */

export type SuggestionStatus = 'GENERATED' | 'NEEDS_REVIEW' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED';

export type HashtagOrigin = 'MANUAL' | 'AI_GENERATED' | 'IMPORTED' | 'TREND_SOURCE';

export type HashtagLinkStatus = 'GENERATED' | 'APPROVED' | 'REJECTED';

export interface SuggestionHashtag {
  /** Library hashtag id. */
  id: string;
  /** Display form. */
  tag: string;
  normalized: string;
  rank: number;
  reason: string | null;
  status: HashtagLinkStatus;
  origin: HashtagOrigin;
}

export interface CaptionReviewEntry {
  id: string;
  decision: string;
  editedText: string | null;
  feedback: string | null;
  reviewedAt: string;
  reviewer: { id: string; name: string } | null;
}

/** Shape returned by the captions controller (Prisma row + fields computed server-side). */
export interface CaptionSuggestion {
  id: string;
  contentItemId: string | null;
  platform: Platform;
  language: CaptionLanguage;
  tone: string | null;
  /** Text exactly as generated by the model. */
  text: string;
  editedText: string | null;
  /** Text frozen at approval; null while not approved. */
  finalText: string | null;
  status: SuggestionStatus;
  /** Incremented on every edit; every write must send the revision it read. */
  revision: number;
  approvedRevision: number | null;
  approvedAt: string | null;
  appliedAt: string | null;
  warnings: string[];
  model: string | null;
  batchId: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  /** editedText ?? text */
  effectiveText: string;
  /** True only when APPROVED and the approval matches the current revision. */
  approvalCurrent: boolean;
  /** Caption already supplied (plan or content), shown next to the AI version, never overwritten silently. */
  planOriginal: string | null;
  missingInfo: string[];
  hashtags: SuggestionHashtag[];
  removedHashtags: string[];
  reviews: CaptionReviewEntry[];
}

export interface GenerateCaptionsResult {
  batchId: string;
  suggestions: CaptionSuggestion[];
  notes: string[];
}

/** Item of GET /hashtags/recommendations (`items`), normalised by the studio. */
export interface HashtagRecommendation {
  key: string;
  tag: string;
  /** 0..100 (server score is 0..1). */
  score: number;
  reasons: string[];
  origin: string | null;
  official: boolean;
  /** 0..1 each; null = that signal was inactive or had no data. */
  parts: { relevance: number; performance: number | null; feedback: number | null; trend: number | null };
}

/** Normalised by the studio from whatever shape /trends returns. */
export interface TrendSignal {
  key: string;
  /** Backend id, needed to delete a manual trend. */
  id: string | null;
  label: string;
  source: string;
  region: string | null;
  observedAt: string | null;
  expiresAt: string | null;
  /** How the trend was verified (required when it was entered). */
  sourceNote: string | null;
}

/* ───────────── Administration Center ───────────── */

export type FeatureMode = 'OFF' | 'REVIEW' | 'AUTO';
export type SettingScope = 'GLOBAL' | 'CAMPAIGN' | 'PLATFORM' | 'ACCOUNT';
export type FeatureKind = 'toggle' | 'tri' | 'review_toggle' | 'locked';

export interface FeatureRestriction {
  by: string;
  mode: FeatureMode;
  detail: string;
}

export interface FeatureOverride {
  scope: SettingScope;
  scopeId: string;
  mode: FeatureMode;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface FeatureView {
  key: string;
  group: string;
  label: string;
  description: string;
  kind: FeatureKind;
  /** The only modes the backend accepts for this feature. */
  modes: FeatureMode[];
  locked: boolean;
  scopes: SettingScope[];
  requires: { feature: string; min: FeatureMode }[];
  /** Mode configured at GLOBAL scope. */
  globalMode: FeatureMode;
  /** Mode after emergency stop, pause, environment, overrides and dependencies. */
  effectiveMode: FeatureMode;
  restrictions: FeatureRestriction[];
  lastChangedBy: string | null;
  lastChangedAt: string | null;
  overrides: FeatureOverride[];
}

export interface EmergencyStopState {
  active: boolean;
  reason?: string | null;
  at?: string | null;
  by?: string | { id?: string; name?: string } | null;
}

export interface AdminOverview {
  emergency: EmergencyStopState;
  publishingPaused: boolean;
  features: FeatureView[];
  campaigns: Array<{ id: string; titleLatin: string; autoPublishEnabled: boolean; publishingPaused: boolean }>;
  accounts: Array<{ id: string; platform: Platform; name: string; status: string }>;
}

/** GET /administration/effective: readable by any signed-in user. */
export type EffectiveMap = Record<string, { mode: FeatureMode; restrictions: FeatureRestriction[] }>;

export interface FeatureAuditEntry {
  id: string;
  featureKey: string;
  scope: SettingScope;
  scopeId: string;
  previous: { mode?: string; active?: boolean } | null;
  next: { mode?: string; active?: boolean };
  changedById: string;
  changedByName?: string | null;
  reason: string | null;
  createdAt: string;
}