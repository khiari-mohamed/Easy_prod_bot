import { Prisma } from '@prisma/client';

/** Tunisia first, plus the French-speaking audience the campaign also targets. Other regions never influence suggestions. */
export const TREND_REGIONS = ['TN', 'FR'];
/** A signal older than this is ignored even if its expiry has not passed. */
export const TREND_MAX_AGE_HOURS = 24 * 7;
export const TREND_MAX_TTL_HOURS = 24 * 14;
export const TREND_DEFAULT_TTL_HOURS = 72;
export const TREND_SOURCES = [
  'manual',
  'tiktok_creative_center',
  'instagram_manual',
  'facebook_insights',
  'meta_insights',
] as const;
export type TrendSource = (typeof TREND_SOURCES)[number];

export function usableWhere(now: Date = new Date()): Prisma.TrendSignalWhereInput {
  return {
    expiresAt: { gt: now },
    observedAt: { gte: new Date(now.getTime() - TREND_MAX_AGE_HOURS * 3_600_000) },
    region: { in: TREND_REGIONS },
  };
}

/** 1.0 when just observed, 0.5 after 48 h, 0.25 after 96 h. */
export function trendFreshness(observedAt: Date, now: Date = new Date()): number {
  const hours = Math.max(0, (now.getTime() - observedAt.getTime()) / 3_600_000);
  return Math.pow(0.5, hours / 48);
}