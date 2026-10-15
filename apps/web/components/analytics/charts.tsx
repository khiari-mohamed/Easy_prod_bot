'use client';

import { ReactNode, useMemo } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { PLATFORM_LABEL } from '@/lib/format';
import type { Platform } from '@/lib/types';
import {
  PLATFORMS, PLATFORM_COLOR, hourOf, shortDate,
  type Overview, type PostRow, type SeriesPoint, type Stats,
} from '@/lib/analytics';

// Hex colours on purpose: the PDF export rasterises the SVG, where CSS variables/classes are lost.
const TICK = { fill: '#6b7280', fontSize: 11 };
const GRID = '#e5e7eb';
const compact = (n: number) => new Intl.NumberFormat('fr-FR', { notation: 'compact' }).format(n);
const full = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('fr-FR') : '\u2014');
const pct1 = (v: unknown) => (typeof v === 'number' ? `${v.toFixed(1)} %` : '\u2014');

export function ChartCard({
  title, hint, legend, wide, children,
}: {
  title: string;
  hint?: string;
  legend?: [string, string][];
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`card ${wide ? 'md:col-span-2' : ''}`}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="section-title">{title}</h3>
        {legend && (
          <ul className="flex flex-wrap gap-3 text-xs text-neutral-600">
            {legend.map(([label, color]) => (
              <li key={label} className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
                {label}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div
        data-export={title}
        data-wide={wide ? '1' : '0'}
        data-legend={legend ? JSON.stringify(legend) : undefined}
        className="h-64 w-full"
      >
        {children}
      </div>
      {hint && <p className="mt-2 text-xs text-neutral-500">{hint}</p>}
    </section>
  );
}

function Empty({ text = 'Pas assez de donn\u00e9es sur cette p\u00e9riode.' }: { text?: string }) {
  return <div className="flex h-full items-center justify-center text-sm text-neutral-400">{text}</div>;
}

export type TrendMetric = 'views' | 'reach' | 'interactions' | 'posts';

export function TrendChart({ series, metric, platforms }: { series: SeriesPoint[]; metric: TrendMetric; platforms: Platform[] }) {
  const rows = useMemo(() => {
    const m = new Map<string, Record<string, number | string | null>>();
    for (const p of series) {
      const row = m.get(p.date) ?? { date: p.date };
      row[p.platform] = p[metric];
      m.set(p.date, row);
    }
    return [...m.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [series, metric]);

  if (!rows.length) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDate} tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={TICK} tickLine={false} axisLine={false} width={48} allowDecimals={false} tickFormatter={compact} />
        <Tooltip formatter={full} labelFormatter={(l: unknown) => String(l)} />
        {platforms.map((p) => (
          <Line
            key={p} type="monotone" dataKey={p} name={PLATFORM_LABEL[p]} stroke={PLATFORM_COLOR[p]}
            strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function EngagementByPlatform({ stats }: { stats: Stats[] }) {
  const data = stats
    .filter((s) => s.posts > 0)
    .map((s) => ({ name: PLATFORM_LABEL[s.platform as Platform], platform: s.platform as Platform, rate: s.engagementRate === null ? null : s.engagementRate * 100 }));
  if (!data.length) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 20, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="name" tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={TICK} tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => `${v}%`} />
        <Tooltip formatter={pct1} />
        <Bar dataKey="rate" name="Engagement" radius={[4, 4, 0, 0]} isAnimationActive={false}>
          {data.map((d) => <Cell key={d.platform} fill={PLATFORM_COLOR[d.platform]} />)}
          <LabelList dataKey="rate" position="top" formatter={pct1} style={{ fill: '#374151', fontSize: 11 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ViewsShare({ stats }: { stats: Stats[] }) {
  const data = stats
    .filter((s) => (s.views ?? 0) > 0)
    .map((s) => ({ name: PLATFORM_LABEL[s.platform as Platform], platform: s.platform as Platform, value: s.views as number }));
  if (!data.length) return <Empty text="Aucune vue disponible." />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Tooltip formatter={full} />
        <Pie
          data={data} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}
          isAnimationActive={false}
          label={(d: { name?: string; percent?: number }) => `${d.name} ${Math.round((d.percent ?? 0) * 100)}%`}
        >
          {data.map((d) => <Cell key={d.platform} fill={PLATFORM_COLOR[d.platform]} />)}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

export const MIX_COLORS: [string, string][] = [
  ['J\u2019aime', '#ef4444'], ['Commentaires', '#f59e0b'], ['Partages', '#10b981'], ['Enregistrements', '#6366f1'],
];

export function InteractionMix({ stats }: { stats: Stats[] }) {
  const data = stats
    .filter((s) => s.posts > 0)
    .map((s) => ({
      name: PLATFORM_LABEL[s.platform as Platform],
      likes: s.likes ?? 0, comments: s.comments ?? 0, shares: s.shares ?? 0, saves: s.saves ?? 0,
    }));
  if (!data.length || data.every((d) => d.likes + d.comments + d.shares + d.saves === 0)) return <Empty />;
  const keys = ['likes', 'comments', 'shares', 'saves'] as const;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="name" tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={TICK} tickLine={false} axisLine={false} width={48} tickFormatter={compact} />
        <Tooltip formatter={full} />
        {keys.map((k, i) => (
          <Bar key={k} dataKey={k} name={MIX_COLORS[i][0]} stackId="a" fill={MIX_COLORS[i][1]} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function HourChart({ posts }: { posts: PostRow[] }) {
  const data = useMemo(() => {
    const acc = Array.from({ length: 24 }, (_, h) => ({ hour: h, sum: 0, n: 0 }));
    for (const p of posts) {
      if (!p.publishedAt || p.engagementRate === null) continue;
      const b = acc[hourOf(p.publishedAt)];
      b.sum += p.engagementRate;
      b.n++;
    }
    return acc.map((b) => ({ label: `${b.hour}h`, rate: b.n ? (b.sum / b.n) * 100 : null, n: b.n }));
  }, [posts]);
  if (!data.some((d) => d.n > 0)) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} interval={1} />
        <YAxis tick={TICK} tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => `${v}%`} />
        <Tooltip formatter={(v: unknown, _n: unknown, item: { payload?: { n?: number } }) => [`${pct1(v)} (${item.payload?.n ?? 0} post\u00b7s)`, 'Engagement moyen']} />
        <Bar dataKey="rate" fill="#f59e0b" radius={[3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function TopPostsChart({ posts }: { posts: Overview['topPosts'] }) {
  const data = posts.map((p) => ({
    name: `${PLATFORM_LABEL[p.platform]} \u00b7 ${p.caption.replace(/\s+/g, ' ').slice(0, 24)}`,
    platform: p.platform,
    rate: p.engagementRate * 100,
  }));
  if (!data.length) return <Empty text="Aucun post avec assez de port\u00e9e." />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 40, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis type="number" tick={TICK} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} />
        <YAxis type="category" dataKey="name" tick={TICK} tickLine={false} axisLine={false} width={160} />
        <Tooltip formatter={pct1} />
        <Bar dataKey="rate" name="Engagement" radius={[0, 4, 4, 0]} isAnimationActive={false}>
          {data.map((d, i) => <Cell key={i} fill={PLATFORM_COLOR[d.platform]} />)}
          <LabelList dataKey="rate" position="right" formatter={pct1} style={{ fill: '#374151', fontSize: 10 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export const PLATFORM_LEGEND: [string, string][] = PLATFORMS.map((p) => [PLATFORM_LABEL[p], PLATFORM_COLOR[p]]);
