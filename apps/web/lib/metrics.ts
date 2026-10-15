import { fmtNum } from './format';
import type { Platform } from './types';

export const METRIC_KEYS = ['views', 'reach', 'likes', 'comments', 'shares', 'saves'] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export const METRIC_LABEL: Record<MetricKey, string> = {
  views: 'Vues',
  reach: 'Port\u00e9e',
  likes: "J'aime",
  comments: 'Commentaires',
  shares: 'Partages',
  saves: 'Enregistrements',
};

/** One stored metric snapshot. Columns listed in `unavailable` hold a placeholder 0, NOT a real zero. */
export interface MetricSnap {
  views: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  unavailable?: string[];
  capturedAt: string;
  source: string;
}

export const UNAVAILABLE_TEXT = 'Indisponible';

export const isUnavailable = (m: Pick<MetricSnap, 'unavailable'>, k: MetricKey) =>
  (m.unavailable ?? []).includes(k);

/** A number, or an em dash when the metric is unavailable. Never shows 0 for a missing value. */
export const fmtMetric = (n: number | null | undefined) => (n === null || n === undefined ? '\u2014' : fmtNum(n));

export interface PlatformStats {
  platform: Platform;
  posts: number;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  /** Number of posts for which each metric is available. */
  coverage: Record<string, number>;
  engagementRate: number | null;
}

export interface OverviewData {
  statusCounts: Record<string, number>;
  platforms: PlatformStats[];
  topPosts: Array<{
    id: string;
    platform: Platform;
    caption: string;
    publishedAt: string | null;
    externalUrl: string | null;
    views: number | null;
    reach: number | null;
    interactions: number | null;
    engagementRate: number;
  }>;
}
