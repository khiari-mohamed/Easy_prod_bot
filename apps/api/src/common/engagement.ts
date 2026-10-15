/**
 * Metric helpers. A metric the platform did not return (or the user did not type)
 * is "unavailable" and is represented as `null` here: it is NEVER treated as a real 0.
 */
export const METRIC_FIELDS = ['views', 'reach', 'likes', 'comments', 'shares', 'saves', 'clicks'] as const;
export type MetricField = (typeof METRIC_FIELDS)[number];

/** One stored snapshot row. `unavailable` lists the columns whose stored 0 is NOT a real zero. */
export interface SnapshotLike {
  views: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks?: number;
  unavailable?: string[];
}

/** Effective metrics of a post: a number, or null when the metric was never available. */
export type MetricValues = Record<MetricField, number | null>;

/**
 * Merge snapshots (newest first) into one value per metric: the most recent snapshot in which
 * that metric was AVAILABLE wins. A later snapshot that lacks a metric cannot hide an earlier real value.
 */
export function mergeSnapshots(snaps: SnapshotLike[]): MetricValues {
  const out = {} as MetricValues;
  for (const f of METRIC_FIELDS) {
    const hit = snaps.find((s) => !(s.unavailable ?? []).includes(f));
    out[f] = hit ? (hit[f] ?? null) : null;
  }
  return out;
}

/** Sum of the available interaction metrics. Null when likes are unavailable (rate would be misleading). */
export function interactions(m: MetricValues): number | null {
  if (m.likes === null) return null;
  return m.likes + (m.comments ?? 0) + (m.shares ?? 0) + (m.saves ?? 0);
}

/** Denominator for engagement: reach when known, otherwise views. 0 if neither is available. */
export function audience(m: MetricValues): number {
  if (m.reach !== null && m.reach > 0) return m.reach;
  if (m.views !== null && m.views > 0) return m.views;
  return 0;
}

/** Engagement rate, or null when it cannot be computed honestly. */
export function engagementRate(m: MetricValues): number | null {
  const base = audience(m);
  const inter = interactions(m);
  return base > 0 && inter !== null ? inter / base : null;
}