/**
 * Central registry of every feature key used in FeatureConfig.
 * Keep this file as the single source of truth — import from here everywhere.
 */

export const FEATURE = {
  // Publishing
  PUBLISHING_AUTO:       'publishing.auto',
  PUBLISHING_SCHEDULED:  'publishing.scheduled',
  PUBLISHING_NOW:        'publishing.now',
  PUBLISHING_APPROVAL:   'publishing.approval_required',

  // Comments
  COMMENTS_FIRST:        'comments.first_comment',
  COMMENTS_AI_SUGGEST:   'comments.ai_suggest',
  COMMENTS_AUTO_REPLY:   'comments.auto_reply',
  COMMENTS_MODERATION:   'comments.moderation',

  // AI Caption Studio
  AI_CAPTION_GEN:        'ai.caption_generation',
  AI_HASHTAG_GEN:        'ai.hashtag_generation',
  AI_FEEDBACK_LEARNING:  'ai.feedback_learning',
  AI_TREND_INTEL:        'ai.trend_intelligence',
  AI_HUMAN_REVIEW:       'ai.human_review_required',

  // Hashtag intelligence
  HASHTAG_RANKING:       'hashtag.performance_ranking',
  HASHTAG_TREND:         'hashtag.trend_signals',
  HASHTAG_MANUAL:        'hashtag.manual_entry',

  // Planning
  PLANNING_AI_EXTRACT:   'planning.ai_extraction',
  PLANNING_VERIFICATION: 'planning.editable_verification',
  PLANNING_CALENDAR_SYNC:'planning.calendar_sync',
  PLANNING_AUTO_DRAFT:   'planning.auto_draft_creation',

  // Media & Analytics
  MEDIA_PROCESSING:      'media.processing',
  ANALYTICS_COLLECTION:  'analytics.collection',
  ANALYTICS_AI_SUGGEST:  'analytics.ai_suggestions',
} as const;

export type FeatureKey = typeof FEATURE[keyof typeof FEATURE];

/**
 * Safe defaults that preserve today's behaviour on first deploy.
 * A feature NOT listed here defaults to OFF (safest).
 */
export const DEFAULT_MODES: Partial<Record<FeatureKey, 'OFF' | 'REVIEW' | 'AUTO'>> = {
  [FEATURE.PUBLISHING_AUTO]:       'AUTO',
  [FEATURE.PUBLISHING_SCHEDULED]:  'AUTO',
  [FEATURE.PUBLISHING_NOW]:        'AUTO',
  [FEATURE.PUBLISHING_APPROVAL]:   'AUTO',  // approval is always required
  [FEATURE.COMMENTS_FIRST]:        'REVIEW',
  [FEATURE.COMMENTS_AI_SUGGEST]:   'REVIEW',
  [FEATURE.COMMENTS_AUTO_REPLY]:   'OFF',
  [FEATURE.COMMENTS_MODERATION]:   'REVIEW',
  [FEATURE.AI_CAPTION_GEN]:        'REVIEW',
  [FEATURE.AI_HASHTAG_GEN]:        'REVIEW',
  [FEATURE.AI_FEEDBACK_LEARNING]:  'OFF',
  [FEATURE.AI_TREND_INTEL]:        'OFF',
  [FEATURE.AI_HUMAN_REVIEW]:       'AUTO',  // human review enforced
  [FEATURE.HASHTAG_RANKING]:       'AUTO',
  [FEATURE.HASHTAG_TREND]:         'OFF',
  [FEATURE.HASHTAG_MANUAL]:        'AUTO',
  [FEATURE.PLANNING_AI_EXTRACT]:   'REVIEW',
  [FEATURE.PLANNING_VERIFICATION]: 'AUTO',
  [FEATURE.PLANNING_CALENDAR_SYNC]:'AUTO',
  [FEATURE.PLANNING_AUTO_DRAFT]:   'OFF',
  [FEATURE.MEDIA_PROCESSING]:      'AUTO',
  [FEATURE.ANALYTICS_COLLECTION]:  'AUTO',
  [FEATURE.ANALYTICS_AI_SUGGEST]:  'REVIEW',
};
