export const CONFIG_KEY = 'comments.config';

export interface CommentConfig {
  firstComment: boolean;
  aiReply: boolean; // generate replies, a human approves
  autoReply: boolean; // send replies judged safe without approval
  moderation: boolean;
  firstCommentTemplate: string; // {hashtags}
  blockedWords: string[];
  hideLinks: boolean;
  moderationAction: 'HIDE' | 'DELETE';
  autoReplyMaxPerHour: number;
  maxCommentAgeHours: number;
  /** Set by the server when firstComment is switched on: only posts published after it get a first comment. */
  firstCommentSince: string | null;
}

export const DEFAULT_CONFIG: CommentConfig = {
  firstComment: false,
  aiReply: false,
  autoReply: false,
  moderation: false,
  firstCommentTemplate: '{hashtags}',
  blockedWords: [],
  hideLinks: false,
  moderationAction: 'HIDE',
  autoReplyMaxPerHour: 10,
  maxCommentAgeHours: 24,
  firstCommentSince: null,
};

/** Merge untrusted input over `base`, keeping only valid values of the right type. */
export function sanitizeConfig(input: unknown, base: CommentConfig): CommentConfig {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const bool = (k: string, d: boolean) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : d);
  const int = (k: string, d: number, min: number, max: number) =>
    typeof o[k] === 'number' && Number.isFinite(o[k]) ? Math.min(max, Math.max(min, Math.round(o[k] as number))) : d;
  const words = Array.isArray(o.blockedWords)
    ? [...new Set((o.blockedWords as unknown[]).filter((w): w is string => typeof w === 'string').map((w) => w.trim().toLowerCase().slice(0, 100)).filter(Boolean))].slice(0, 200)
    : base.blockedWords;
  return {
    firstComment: bool('firstComment', base.firstComment),
    aiReply: bool('aiReply', base.aiReply),
    autoReply: bool('autoReply', base.autoReply),
    moderation: bool('moderation', base.moderation),
    firstCommentTemplate: typeof o.firstCommentTemplate === 'string' ? o.firstCommentTemplate.slice(0, 500) : base.firstCommentTemplate,
    blockedWords: words,
    hideLinks: bool('hideLinks', base.hideLinks),
    moderationAction: o.moderationAction === 'DELETE' || o.moderationAction === 'HIDE' ? o.moderationAction : base.moderationAction,
    autoReplyMaxPerHour: int('autoReplyMaxPerHour', base.autoReplyMaxPerHour, 0, 100),
    maxCommentAgeHours: int('maxCommentAgeHours', base.maxCommentAgeHours, 1, 168),
    firstCommentSince: typeof o.firstCommentSince === 'string' || o.firstCommentSince === null ? (o.firstCommentSince as string | null) : base.firstCommentSince,
  };
}