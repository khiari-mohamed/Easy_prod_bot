import type { Platform } from '@/lib/types';

export const PLATFORMS: Platform[] = ['INSTAGRAM', 'FACEBOOK', 'TIKTOK'];

export const PLATFORM_COLOR: Record<Platform, string> = {
  INSTAGRAM: '#e1306c',
  FACEBOOK: '#1877f2',
  TIKTOK: '#111827',
};

export type MetricKey = 'views' | 'reach' | 'likes' | 'comments' | 'shares' | 'saves';

export const METRICS: { key: MetricKey; label: string }[] = [
  { key: 'views', label: 'Vues' },
  { key: 'reach', label: 'Portée' },
  { key: 'likes', label: "J'aime" },
  { key: 'comments', label: 'Comm.' },
  { key: 'shares', label: 'Partages' },
  { key: 'saves', label: 'Enreg.' },
];

export interface Stats {
  platform: Platform | 'ALL';
  posts: number;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  interactions: number | null;
  coverage: Record<MetricKey, number>;
  engagementRate: number | null;
}

export interface TopPost {
  id: string;
  platform: Platform;
  caption: string;
  publishedAt: string | null;
  externalUrl: string | null;
  views: number | null;
  reach: number | null;
  interactions: number | null;
  engagementRate: number;
}

export interface Overview {
  totals: Stats;
  previousTotals: Stats | null;
  platforms: Stats[];
  topPosts: TopPost[];
}

export interface SeriesPoint extends Stats {
  date: string; // YYYY-MM-DD, Tunis time
  platform: Platform;
}

export interface PostRow {
  id: string;
  platform: Platform;
  format: string;
  caption: string;
  publishedAt: string | null;
  externalUrl: string | null;
  isExternal: boolean;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  interactions: number | null;
  engagementRate: number | null;
}

const TZ = 'Africa/Tunis';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export const dayKey = (d: Date) => dayFmt.format(d);
export const hourOf = (iso: string) => Number(hourFmt.format(new Date(iso)));

export function addDays(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "2026-10-14 19:05" in Tunis time. */
export function fmtLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${dayFmt.format(d)} ${timeFmt.format(d)}`;
}

/** Plain number formatting that is safe in PDF (no narrow no-break spaces). */
export function plainNum(n: number | null | undefined): string {
  return n === null || n === undefined ? '-' : Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function plainPct(r: number | null | undefined): string {
  return r === null || r === undefined ? '-' : `${(r * 100).toFixed(1)} %`;
}

export function shortDate(key: string): string {
  return `${key.slice(8, 10)}/${key.slice(5, 7)}`;
}
