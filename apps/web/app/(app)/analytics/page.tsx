'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDateTime, fmtPct, PLATFORM_LABEL } from '@/lib/format';
import type { BestTime, Platform } from '@/lib/types';
import { fmtMetric, UNAVAILABLE_TEXT } from '@/lib/metrics';
import { ErrorNote, Loading, PageTitle, PlatformTag } from '@/components/ui';
import {
  METRICS, PLATFORMS, addDays, dayKey,
  type Overview, type PostRow, type SeriesPoint, type Stats,
} from '@/lib/analytics';
import { exportCsv, exportPdf, exportXlsx, type ExportCtx } from '@/lib/analytics-export';
import {
  ChartCard, EngagementByPlatform, HourChart, InteractionMix, MIX_COLORS, PLATFORM_LEGEND,
  TopPostsChart, TrendChart, ViewsShare, type TrendMetric,
} from '@/components/analytics/charts';

// ------------------------------------------------------------------ data hook

function useApi<T>(path: string | null, tick: number) {
  const [s, setS] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  useEffect(() => {
    if (!path) return;
    let live = true;
    setS((p) => ({ ...p, loading: true, error: null }));
    api<T>(path)
      .then((data) => live && setS({ data, loading: false, error: null }))
      .catch((e: Error) => live && setS((p) => ({ ...p, loading: false, error: e.message })));
    return () => { live = false; };
  }, [path, tick]);
  return s;
}

// ------------------------------------------------------------------ import card (unchanged behaviour)

const CSV_TEMPLATE =
  'platform,publishedAt,views,reach,likes,comments,shares,saves,externalUrl,caption\n' +
  'TIKTOK,2026-10-03T19:00:00+01:00,12000,,800,40,25,,https://www.tiktok.com/@easy_distribution_/video/123,Bande-annonce';

/** Minimal CSV parser: handles quoted fields and commas inside quotes. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

function ImportCard({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setMsg(null);
    try {
      const num = (v: string) => (v ? Number(v) : undefined);
      const rows = parseCsv(text).map((r) => ({
        platform: r.platform?.toUpperCase(),
        publishedAt: r.publishedAt,
        views: num(r.views), reach: num(r.reach), likes: num(r.likes), comments: num(r.comments),
        shares: num(r.shares), saves: num(r.saves),
        externalUrl: r.externalUrl || undefined,
        caption: r.caption || undefined,
      }));
      const res = await api<{ created: number; updated: number }>('/analytics/import', { method: 'POST', body: { rows } });
      setMsg(`${res.created} post(s) importé(s), ${res.updated} mis à jour.`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <details className="card">
      <summary className="cursor-pointer font-semibold">Importer l&apos;historique (3–9 octobre, exports Meta / TikTok)</summary>
      <p className="my-2 text-xs text-neutral-500">
        Collez un CSV avec l&apos;en-tête ci-dessous. Cet historique alimente les meilleurs horaires et le classement des posts.
        Une colonne vide = « indisponible » (pas un zéro).
      </p>
      <textarea className="input min-h-32 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={CSV_TEMPLATE} />
      <div className="mt-2 flex gap-2">
        <button className="btn btn-primary" disabled={!text.trim()} onClick={submit}>Importer</button>
        <button className="btn" onClick={() => setText(CSV_TEMPLATE)}>Insérer le modèle</button>
      </div>
      <div className="mt-2 space-y-2"><ErrorNote message={error} />{msg && <p className="text-sm text-green-700">{msg}</p>}</div>
    </details>
  );
}

// ------------------------------------------------------------------ small pieces

type Preset = '7' | '14' | '30' | 'all' | 'custom';
const PRESETS: [Preset, string][] = [['7', '7 jours'], ['14', '14 jours'], ['30', '30 jours'], ['all', 'Tout']];

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${active ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50'}`}
    >
      {children}
    </button>
  );
}

function Delta({ cur, prev }: { cur: number | null; prev: number | null | undefined }) {
  if (cur === null || prev === null || prev === undefined || prev === 0) return null;
  const d = (cur - prev) / prev;
  const up = d >= 0;
  return (
    <span className={`text-xs font-medium ${up ? 'text-emerald-600' : 'text-red-600'}`} title="Par rapport à la période précédente de même durée">
      {up ? '▲' : '▼'} {Math.abs(d * 100).toFixed(0)} %
    </span>
  );
}

function Kpi({ label, value, cur, prev, title }: { label: string; value: string; cur: number | null; prev?: number | null; title?: string }) {
  return (
    <div className="card" title={title}>
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums">{value}</span>
        <Delta cur={cur} prev={prev} />
      </div>
    </div>
  );
}

function MetricCell({ value, have, posts }: { value: number | null; have: number; posts: number }) {
  if (value === null) return <td className="pr-3 text-neutral-400" title={UNAVAILABLE_TEXT}>—</td>;
  const partial = have < posts;
  return (
    <td className="pr-3" title={partial ? `Calculé sur ${have}/${posts} posts (les autres : indisponible)` : undefined}>
      {fmtMetric(value)}
      {partial && <span className="text-amber-700">*</span>}
    </td>
  );
}

type SortKey = 'publishedAt' | 'views' | 'reach' | 'interactions' | 'engagementRate';

// ------------------------------------------------------------------ page

export default function AnalyticsPage() {
  const [preset, setPreset] = useState<Preset>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<Platform[]>([]);
  const [metric, setMetric] = useState<TrendMetric>('views');
  const [tick, setTick] = useState(0);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'publishedAt', dir: -1 });
  const [shown, setShown] = useState(25);
  const chartsRef = useRef<HTMLDivElement>(null);

  const invalid = !!from && !!to && from > to;
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (selected.length && selected.length < PLATFORMS.length) p.set('platforms', selected.join(','));
    const s = p.toString();
    return s ? `?${s}` : '';
  }, [from, to, selected]);

  const overview = useApi<Overview>(invalid ? null : `/analytics/overview${qs}`, tick);
  const series = useApi<SeriesPoint[]>(invalid ? null : `/analytics/timeseries${qs}`, tick);
  const posts = useApi<PostRow[]>(invalid ? null : `/analytics/posts${qs}`, tick);
  const best = useApi<Record<Platform, BestTime>>('/analytics/best-times', tick);

  function applyPreset(p: Preset) {
    setPreset(p);
    setShown(25);
    if (p === 'all') { setFrom(''); setTo(''); return; }
    if (p === 'custom') return;
    const today = dayKey(new Date());
    setFrom(addDays(today, -(Number(p) - 1)));
    setTo(today);
  }

  function togglePlatform(p: Platform) {
    setSelected((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  }

  async function sync() {
    setError(null);
    try {
      const r = await api<{ checked: number; updated: number }>('/analytics/sync', { method: 'POST' });
      setSyncMsg(`${r.updated}/${r.checked} posts mis à jour`);
      setTick((t) => t + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const [backfilling, setBackfilling] = useState(false);

  async function backfill() {
    setError(null);
    setBackfilling(true);
    try {
      const r = await api<Record<string, { fetched: number; created: number; updated: number; error?: string }>>('/analytics/backfill', { method: 'POST' });
      setSyncMsg(
        Object.entries(r)
          .map(([p, v]) => `${p} : ${v.error ? `erreur (${v.error})` : `${v.created} importés, ${v.updated} mis à jour`}`)
          .join(' · '),
      );
      setTick((t) => t + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBackfilling(false);
    }
  }

  const o = overview.data;
  const activePlatforms = selected.length ? selected : PLATFORMS;
  const periodLabel = from || to ? `${from || 'début'} → ${to || 'aujourd’hui'}` : 'Toute la période';
  const platformsLabel = activePlatforms.map((p) => PLATFORM_LABEL[p]).join(', ');
  const ready = !!o && !!series.data && !!posts.data;

  async function runExport(kind: 'csv' | 'xlsx' | 'pdf') {
    if (!o || !series.data || !posts.data) return;
    setError(null);
    setExporting(kind);
    const ctx: ExportCtx = {
      periodLabel, platformsLabel, overview: o, series: series.data, posts: posts.data, root: chartsRef.current,
    };
    try {
      if (kind === 'csv') exportCsv(ctx);
      else if (kind === 'xlsx') await exportXlsx(ctx);
      else await exportPdf(ctx);
    } catch (e) {
      setError(`Export impossible : ${(e as Error).message}`);
    } finally {
      setExporting(null);
    }
  }

  const tableRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (posts.data ?? []).filter((p) => !q || p.caption.toLowerCase().includes(q));
    const val = (p: PostRow) => (sort.key === 'publishedAt' ? (p.publishedAt ? Date.parse(p.publishedAt) : null) : p[sort.key]);
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1; // unavailable always last
      if (y === null) return -1;
      return (x - y) * sort.dir;
    });
  }, [posts.data, search, sort]);

  function th(key: SortKey, label: string) {
    const active = sort.key === key;
    return (
      <th key={key} className="cursor-pointer select-none py-1 pr-3" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : -1 }))}>
        {label} {active ? (sort.dir === 1 ? '↑' : '↓') : ''}
      </th>
    );
  }

  if (!o && overview.loading) return <Loading />;
  const t = o?.totals;
  const pv = o?.previousTotals;
  const busy = overview.loading || series.loading || posts.loading;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageTitle title="Analytics" subtitle={`${periodLabel} · ${platformsLabel}`}>
        <div className="flex flex-wrap gap-2">
          <button className="btn" disabled={backfilling} onClick={backfill}>
            {backfilling ? 'Import en cours…' : 'Importer l’historique Meta'}
          </button>
          <button className="btn" onClick={sync}>Actualiser depuis Meta</button>
          {(['csv', 'xlsx', 'pdf'] as const).map((k) => (
            <button key={k} className="btn" disabled={!ready || !!exporting} onClick={() => runExport(k)}>
              {exporting === k ? 'Export…' : k === 'xlsx' ? 'Excel' : k.toUpperCase()}
            </button>
          ))}
        </div>
      </PageTitle>
      {syncMsg && <p className="text-sm text-green-700">{syncMsg}</p>}
      <ErrorNote message={error ?? overview.error ?? series.error ?? posts.error} />

      {/* ---------------- filters */}
      <div className="card space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map(([p, label]) => <Chip key={p} active={preset === p} onClick={() => applyPreset(p)}>{label}</Chip>)}
          <span className="mx-1 h-5 w-px bg-neutral-200" />
          <label className="flex items-center gap-1 text-xs text-neutral-500">
            Du
            <input type="date" className="input !w-auto !py-1 text-xs" value={from} onChange={(e) => { setFrom(e.target.value); setPreset('custom'); }} />
          </label>
          <label className="flex items-center gap-1 text-xs text-neutral-500">
            au
            <input type="date" className="input !w-auto !py-1 text-xs" value={to} onChange={(e) => { setTo(e.target.value); setPreset('custom'); }} />
          </label>
          {busy && <span className="text-xs text-neutral-400">Chargement…</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-neutral-500">Plateformes :</span>
          <Chip active={!selected.length} onClick={() => setSelected([])}>Toutes</Chip>
          {PLATFORMS.map((p) => <Chip key={p} active={selected.includes(p)} onClick={() => togglePlatform(p)}>{PLATFORM_LABEL[p]}</Chip>)}
        </div>
        {invalid && <p className="text-sm text-red-600">La date de début doit précéder la date de fin.</p>}
      </div>

      {/* ---------------- KPIs */}
      {t && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Kpi label="Posts" value={String(t.posts)} cur={t.posts} prev={pv?.posts} />
          <Kpi label="Vues" value={t.views === null ? '—' : fmtMetric(t.views)} cur={t.views} prev={pv?.views} title={t.views === null ? UNAVAILABLE_TEXT : undefined} />
          <Kpi label="Portée" value={t.reach === null ? '—' : fmtMetric(t.reach)} cur={t.reach} prev={pv?.reach} title={t.reach === null ? UNAVAILABLE_TEXT : undefined} />
          <Kpi label="Interactions" value={t.interactions === null ? '—' : fmtMetric(t.interactions)} cur={t.interactions} prev={pv?.interactions} />
          <Kpi label="Engagement" value={t.engagementRate === null ? '—' : fmtPct(t.engagementRate)} cur={t.engagementRate} prev={pv?.engagementRate} title={t.engagementRate === null ? UNAVAILABLE_TEXT : undefined} />
        </div>
      )}
      {pv && <p className="-mt-2 text-xs text-neutral-500">Les flèches comparent à la période précédente de même durée.</p>}

      {/* ---------------- charts */}
      <div ref={chartsRef} className="grid gap-4 md:grid-cols-2">
        <ChartCard
          wide
          title="Évolution par jour"
          legend={PLATFORM_LEGEND.filter(([l]) => activePlatforms.some((p) => PLATFORM_LABEL[p] === l))}
          hint="Un point = un jour avec au moins un post publié (heure de Tunis). Chiffre indisponible = pas de point."
        >
          <TrendChart series={series.data ?? []} metric={metric} platforms={activePlatforms} />
        </ChartCard>
        <ChartCard title="Engagement par plateforme" hint="(j’aime + commentaires + partages + enregistrements) / portée.">
          <EngagementByPlatform stats={o?.platforms ?? []} />
        </ChartCard>
        <ChartCard title="Répartition des vues" legend={PLATFORM_LEGEND}>
          <ViewsShare stats={o?.platforms ?? []} />
        </ChartCard>
        <ChartCard title="Mix des interactions" legend={MIX_COLORS} hint="Les chiffres indisponibles comptent pour 0 dans ce graphique seulement.">
          <InteractionMix stats={o?.platforms ?? []} />
        </ChartCard>
        <ChartCard title="Engagement par heure de publication" hint="Moyenne par heure de publication (Tunis). Peu fiable avec peu de posts.">
          <HourChart posts={posts.data ?? []} />
        </ChartCard>
        <ChartCard wide title="Meilleurs posts (engagement)">
          <TopPostsChart posts={o?.topPosts ?? []} />
        </ChartCard>
      </div>
      <div className="-mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-neutral-500">Courbe :</span>
        {([['views', 'Vues'], ['reach', 'Portée'], ['interactions', 'Interactions'], ['posts', 'Posts']] as [TrendMetric, string][]).map(([k, l]) => (
          <Chip key={k} active={metric === k} onClick={() => setMetric(k)}>{l}</Chip>
        ))}
      </div>

      {/* ---------------- platform table */}
      <div className="card overflow-x-auto">
        <h2 className="mb-2 font-bold">Par plateforme (posts publiés avec chiffres)</h2>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-neutral-500">
            <tr>{['Plateforme', 'Posts', ...METRICS.map((m) => m.label), 'Engagement'].map((h) => <th key={h} className="py-1 pr-3">{h}</th>)}</tr>
          </thead>
          <tbody>
            {o?.platforms.map((r: Stats) => (
              <tr key={r.platform} className="border-t border-neutral-100">
                <td className="py-1.5 pr-3"><PlatformTag platform={r.platform as Platform} /></td>
                <td className="pr-3">{r.posts}</td>
                {METRICS.map((m) => <MetricCell key={m.key} value={r[m.key]} have={r.coverage?.[m.key] ?? 0} posts={r.posts} />)}
                <td className="font-semibold" title={r.engagementRate === null ? UNAVAILABLE_TEXT : undefined}>
                  {r.engagementRate === null ? '—' : fmtPct(r.engagementRate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-neutral-500">« — » = indisponible (la plateforme ne fournit pas ce chiffre), ce n’est pas un zéro. « * » = calculé seulement sur une partie des posts.</p>
      </div>

      {/* ---------------- best times */}
      <div className="grid gap-4 md:grid-cols-3">
        {(['INSTAGRAM', 'FACEBOOK', 'TIKTOK'] as Platform[]).map((pl) => {
          const b = best.data?.[pl];
          return (
            <div key={pl} className="card">
              <h3 className="mb-1 font-bold">Meilleur moment — {PLATFORM_LABEL[pl]}</h3>
              {!b ? <Loading /> : (
                <>
                  <p className={`text-sm ${b.provisional ? 'text-amber-700' : ''}`}>{b.suggestion}</p>
                  {!b.provisional && (
                    <ul className="mt-2 space-y-0.5 text-xs text-neutral-600">
                      {b.hourBlocks.slice(0, 3).map((s) => (
                        <li key={s.label}>{s.label} — {fmtPct(s.score)} ({s.n} post{s.n > 1 ? 's' : ''}{s.reliable ? '' : ', peu fiable'})</li>
                      ))}
                    </ul>
                  )}
                  {b.followerActivity && b.followerActivity.length === 24 && Math.max(...b.followerActivity) > 0 && (
                    <p className="mt-2 text-xs text-neutral-600">
                      Abonnés en ligne : pic vers {b.followerActivity.indexOf(Math.max(...b.followerActivity))}h.
                    </p>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <p className="-mt-2 text-xs text-neutral-500">Les meilleurs moments utilisent tout l’historique, indépendamment du filtre de dates.</p>

      {/* ---------------- posts table */}
      <div className="card">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold">Tous les posts <span className="font-normal text-neutral-400">{tableRows.length}</span></h2>
          <input className="input !w-56 !py-1 text-sm" placeholder="Rechercher dans les légendes…" value={search} onChange={(e) => { setSearch(e.target.value); setShown(25); }} />
        </div>
        {!tableRows.length ? (
          <p className="text-sm text-neutral-500">Aucun post sur cette période. Importez l&apos;historique ci-dessous ou élargissez les dates.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-neutral-500">
                <tr>
                  <th className="py-1 pr-3">Plateforme</th>
                  {th('publishedAt', 'Date')}
                  <th className="py-1 pr-3">Légende</th>
                  {th('views', 'Vues')}
                  {th('reach', 'Portée')}
                  {th('interactions', 'Interactions')}
                  {th('engagementRate', 'Engagement')}
                </tr>
              </thead>
              <tbody>
                {tableRows.slice(0, shown).map((p) => (
                  <tr key={p.id} className="border-t border-neutral-100">
                    <td className="py-1.5 pr-3"><PlatformTag platform={p.platform} /></td>
                    <td className="whitespace-nowrap pr-3 text-xs text-neutral-500">{p.publishedAt ? fmtDateTime(p.publishedAt) : '—'}</td>
                    <td className="max-w-xs truncate pr-3" dir="auto">
                      <Link href={`/posts/${p.id}`} className="hover:underline">{p.caption}</Link>
                      {p.externalUrl && <a href={p.externalUrl} target="_blank" rel="noreferrer" className="ml-1 text-neutral-400 hover:text-neutral-700" title="Ouvrir sur la plateforme">↗</a>}
                    </td>
                    {[p.views, p.reach, p.interactions].map((v, i) => (
                      <td key={i} className={`pr-3 ${v === null ? 'text-neutral-400' : ''}`} title={v === null ? UNAVAILABLE_TEXT : undefined}>{v === null ? '—' : fmtMetric(v)}</td>
                    ))}
                    <td className={`font-semibold ${p.engagementRate === null ? 'text-neutral-400' : ''}`}>{p.engagementRate === null ? '—' : fmtPct(p.engagementRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tableRows.length > shown && (
          <button className="btn mt-3" onClick={() => setShown((n) => n + 25)}>Afficher plus ({tableRows.length - shown} restants)</button>
        )}
      </div>

      <ImportCard onDone={() => setTick((n) => n + 1)} />
    </div>
  );
}