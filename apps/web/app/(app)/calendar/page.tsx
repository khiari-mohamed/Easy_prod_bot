'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { api, useFetch } from '@/lib/api';
import { fmtDay, fromInputValue, toInputValue } from '@/lib/format';
import type { Campaign, CampaignDay, Me, Platform, Post, PostFormat } from '@/lib/types';
import { EmptyState, ErrorNote, Loading, ModeTag, PageTitle, PlatformTag, StatusBadge, platformDot, statusDot } from '@/components/ui';

const TZ = 'Africa/Tunis';
const dayKeyOf = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d);
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('fr-TN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const utc = (key: string) => new Date(`${key}T00:00:00Z`);
const addDays = (key: string, n: number) => new Date(utc(key).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const mondayOf = (key: string) => addDays(key, -((utc(key).getUTCDay() + 6) % 7));
const monthStart = (key: string) => `${key.slice(0, 7)}-01`;
const addMonths = (key: string, n: number) => {
  const d = utc(monthStart(key));
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const monthLabel = (key: string) => utc(key).toLocaleDateString('fr-TN', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

const PHASE_DOT: Record<string, string> = {
  CURIOSITÉ: 'bg-purple-500',
  ATTENTE: 'bg-blue-500',
  ÉVÉNEMENT: 'bg-brand',
  ENVIE: 'bg-green-500',
  URGENCE: 'bg-orange-500',
  CONVERSION: 'bg-red-500',
};

const postDay = (p: Post): string | null => {
  const iso = p.publishedAt ?? p.scheduledAt;
  return iso ? dayKeyOf(new Date(iso)) : null;
};

/** Reschedule is only offered where the API accepts it. Failed / manual posts go back to validation. */
const RESCHEDULABLE = ['APPROVED', 'FAILED', 'MANUAL_REQUIRED'];

function Reschedule({ post, onDone }: { post: Post; onDone: () => void }) {
  const [when, setWhen] = useState(toInputValue(post.scheduledAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/posts/${post.id}/reschedule`, { method: 'POST', body: { scheduledAt: fromInputValue(when) } });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input type="datetime-local" className="input !w-auto" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Nouvelle heure (Tunis)" />
        <button className="btn" disabled={busy || !when} onClick={save}>Replanifier</button>
      </div>
      {post.status !== 'APPROVED' && <p className="text-xs text-neutral-500">Ce post repassera en validation après le changement d&apos;heure.</p>}
      <ErrorNote message={error} />
    </div>
  );
}

function DayPanel({
  dayKey,
  campaignDay,
  posts,
  isApprover,
  onChange,
}: {
  dayKey: string;
  campaignDay: CampaignDay | undefined;
  posts: Post[];
  isApprover: boolean;
  onChange: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const missing = campaignDay
    ? campaignDay.platforms.filter((p) => !campaignDay.posts.some((x) => x.platform === p && x.status !== 'CANCELLED'))
    : [];

  async function generate() {
    if (!campaignDay) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/campaign/days/${campaignDay.id}/generate-drafts`, { method: 'POST', body: {} });
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function blank(platform: Platform) {
    if (!campaignDay) return;
    const format: PostFormat = platform === 'TIKTOK' ? 'REEL' : campaignDay.format;
    try {
      const post = await api<{ id: string }>('/posts', { method: 'POST', body: { dayId: campaignDay.id, platform, format, caption: '' } });
      router.push(`/posts/${post.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const sorted = [...posts].sort((a, b) => (a.scheduledAt ?? a.publishedAt ?? '').localeCompare(b.scheduledAt ?? b.publishedAt ?? ''));

  return (
    <aside className="card space-y-4 lg:sticky lg:top-20 lg:self-start">
      <div>
        <h2 className="text-lg font-bold capitalize tracking-tight">{fmtDay(`${dayKey}T12:00:00Z`)}</h2>
        {campaignDay && (
          <div className="mt-2 rounded-lg bg-neutral-50 p-3">
            <p className="flex items-center gap-2 text-xs font-semibold text-neutral-600">
              <span className={`h-2 w-2 rounded-full ${PHASE_DOT[campaignDay.phase] ?? 'bg-neutral-400'}`} aria-hidden />
              {campaignDay.phase}
            </p>
            <p className="mt-0.5 font-semibold">{campaignDay.label}</p>
            <p className="mt-1 text-sm text-neutral-700">{campaignDay.execution}</p>
            <p className="mt-1 text-xs text-neutral-500">Objectif : {campaignDay.objective}</p>
          </div>
        )}
      </div>

      <ErrorNote message={error} />

      {campaignDay && missing.length > 0 && (
        <div className="space-y-1.5">
          <button className="btn btn-primary w-full" disabled={busy} onClick={generate}>
            {busy ? 'Génération…' : `Générer ${missing.length} brouillon${missing.length > 1 ? 's' : ''}`}
          </button>
          <p className="text-xs text-neutral-500">
            Ou un post vide :{' '}
            {missing.map((p, i) => (
              <span key={p}>
                {i > 0 && ', '}
                <button className="underline underline-offset-2 hover:text-ink" onClick={() => blank(p)}>{p.toLowerCase()}</button>
              </span>
            ))}
          </p>
        </div>
      )}

      {sorted.length === 0 ? (
        <p className="text-sm text-neutral-500">Aucun post ce jour-là.</p>
      ) : (
        <ul className="space-y-2.5">
          {sorted.map((p) => {
            const when = p.publishedAt ?? p.scheduledAt;
            const canMove = isApprover && RESCHEDULABLE.includes(p.status);
            return (
              <li key={p.id} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {when && <span className="text-sm font-semibold tabular-nums">{timeOf(when)}</span>}
                  <PlatformTag platform={p.platform} />
                  <ModeTag mode={p.publishMode} />
                  <StatusBadge status={p.status} />
                </div>
                <p className="mt-1.5 line-clamp-2 text-sm text-neutral-700" dir="auto">{p.caption || '(légende vide)'}</p>
                {p.statusNote && <p className="mt-1 text-xs text-neutral-500">{p.statusNote}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  <Link href={`/posts/${p.id}`} className="btn">Ouvrir</Link>
                  {canMove && (
                    <button className="btn btn-ghost" onClick={() => setOpen(open === p.id ? null : p.id)}>
                      {open === p.id ? 'Fermer' : 'Changer l’heure'}
                    </button>
                  )}
                </div>
                {canMove && open === p.id && <Reschedule post={p} onDone={() => { setOpen(null); onChange(); }} />}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function Chip({ p }: { p: Post }) {
  const when = p.publishedAt ?? p.scheduledAt;
  return (
    <Link
      href={`/posts/${p.id}`}
      onClick={(e) => e.stopPropagation()}
      className="flex items-center gap-1 truncate rounded bg-neutral-50 px-1 py-0.5 text-[11px] leading-4 hover:bg-neutral-100"
      title={p.caption}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${platformDot(p.platform)}`} aria-hidden />
      <span className="tabular-nums text-neutral-700">{when ? timeOf(when) : ''}</span>
      <span className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(p.status)}`} aria-hidden />
    </Link>
  );
}

export default function CalendarPage() {
  const posts = useFetch<Post[]>('/posts');
  const campaign = useFetch<Campaign>('/campaign');
  const me = useFetch<Me>('/auth/me');
  const today = dayKeyOf(new Date());
  const [cursor, setCursor] = useState(today);
  const [selected, setSelected] = useState(today);
  const [view, setView] = useState<'month' | 'week'>('month');

  const byDay = useMemo(() => {
    const m = new Map<string, Post[]>();
    for (const p of posts.data ?? []) {
      if (p.status === 'CANCELLED') continue;
      const k = postDay(p);
      if (!k) continue;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return m;
  }, [posts.data]);

  const campaignDays = useMemo(() => {
    const m = new Map<string, CampaignDay>();
    for (const d of campaign.data?.days ?? []) m.set(d.date.slice(0, 10), d);
    return m;
  }, [campaign.data]);

  if (posts.loading || campaign.loading) return <Loading />;

  const isApprover = me.data?.role === 'ADMIN' || me.data?.role === 'APPROVER';
  const releaseKey = campaign.data ? dayKeyOf(new Date(campaign.data.releaseDate)) : null;
  const undated = (posts.data ?? []).filter((p) => p.status !== 'CANCELLED' && !postDay(p));
  const reload = () => { posts.reload(); campaign.reload(); };

  const step = (n: number) => setCursor(view === 'month' ? addMonths(cursor, n) : addDays(cursor, 7 * n));
  const goToday = () => { setCursor(today); setSelected(today); };

  let days: string[];
  if (view === 'month') {
    const first = monthStart(cursor);
    const start = mondayOf(first);
    const lastOfMonth = addDays(addMonths(first, 1), -1);
    const weeks = Math.ceil(((utc(lastOfMonth).getTime() - utc(start).getTime()) / 86_400_000 + 1) / 7);
    days = Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  } else {
    const start = mondayOf(cursor);
    days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }
  const title = view === 'month' ? monthLabel(cursor) : `Semaine du ${fmtDay(`${days[0]}T12:00:00Z`)}`;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageTitle title="Calendrier" subtitle={campaign.data ? `Campagne ${campaign.data.titleLatin}` : undefined}>
        <div className="flex rounded-lg border border-line bg-white p-0.5 text-sm" role="group" aria-label="Affichage">
          {(['month', 'week'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`rounded-md px-3 py-1 font-medium ${view === v ? 'bg-ink text-white' : 'text-neutral-600 hover:bg-neutral-100'}`}
            >
              {v === 'month' ? 'Mois' : 'Semaine'}
            </button>
          ))}
        </div>
      </PageTitle>
      <ErrorNote message={posts.error ?? campaign.error} />

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <section className="card !p-0 overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <h2 className="text-base font-semibold capitalize">{title}</h2>
            <div className="flex items-center gap-1">
              <button className="btn" onClick={() => step(-1)} aria-label="Précédent">‹</button>
              <button className="btn" onClick={goToday}>Aujourd&apos;hui</button>
              <button className="btn" onClick={() => step(1)} aria-label="Suivant">›</button>
            </div>
          </div>

          <div className="grid grid-cols-7 border-b border-line bg-neutral-50 text-center text-xs font-semibold text-neutral-500">
            {WEEKDAYS.map((w) => <div key={w} className="py-2">{w}</div>)}
          </div>

          <div className="grid grid-cols-7">
            {days.map((k) => {
              const list = byDay.get(k) ?? [];
              const cd = campaignDays.get(k);
              const outside = view === 'month' && k.slice(0, 7) !== cursor.slice(0, 7);
              const sel = k === selected;
              const max = view === 'week' ? 12 : 3;
              return (
                <div
                  key={k}
                  role="button"
                  tabIndex={0}
                  aria-label={fmtDay(`${k}T12:00:00Z`)}
                  aria-pressed={sel}
                  onClick={() => setSelected(k)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(k); } }}
                  className={`min-h-24 cursor-pointer border-b border-r border-line p-1.5 text-left transition-colors hover:bg-neutral-50 ${view === 'week' ? 'min-h-56' : ''} ${outside ? 'bg-neutral-50/60 text-neutral-400' : ''} ${sel ? 'bg-brand-soft/60 ring-2 ring-inset ring-brand' : ''}`}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className={`grid h-6 min-w-6 place-items-center rounded-full px-1 text-xs font-semibold tabular-nums ${k === today ? 'bg-ink text-white' : ''}`}>
                      {Number(k.slice(8))}
                    </span>
                    <span className="flex items-center gap-1">
                      {k === releaseKey && <span className="rounded bg-brand px-1 text-[10px] font-bold text-ink">Sortie</span>}
                      {cd && <span className={`h-2 w-2 rounded-full ${PHASE_DOT[cd.phase] ?? 'bg-neutral-400'}`} title={cd.phase} />}
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {list.slice(0, max).map((p) => <Chip key={p.id} p={p} />)}
                    {list.length > max && <span className="block px-1 text-[11px] text-neutral-500">+{list.length - max}</span>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-xs text-neutral-500">
            {Object.entries(PHASE_DOT).map(([name, cls]) => (
              <span key={name} className="flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${cls}`} />{name.charAt(0) + name.slice(1).toLowerCase()}</span>
            ))}
          </div>
        </section>

        <DayPanel
          dayKey={selected}
          campaignDay={campaignDays.get(selected)}
          posts={byDay.get(selected) ?? []}
          isApprover={isApprover}
          onChange={reload}
        />
      </div>

      {undated.length > 0 && (
        <section className="card">
          <h2 className="section-title">Sans date <span className="font-normal text-neutral-400">{undated.length}</span></h2>
          <p className="mb-1 text-xs text-neutral-500">Ces posts n&apos;ont pas encore d&apos;heure de publication : ils n&apos;apparaissent pas dans la grille.</p>
          <ul className="divide-y divide-line/70">
            {undated.map((p) => (
              <li key={p.id}>
                <Link href={`/posts/${p.id}`} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-2 hover:bg-neutral-50">
                  <PlatformTag platform={p.platform} />
                  <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{p.caption || '(légende vide)'}</span>
                  <StatusBadge status={p.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!posts.data?.length && !campaign.data?.days.length && (
        <EmptyState title="Calendrier vide" hint="Importez un plan dans Planning ou créez un contenu pour commencer." />
      )}
    </div>
  );
}