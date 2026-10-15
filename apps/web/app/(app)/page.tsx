'use client';

import Link from 'next/link';
import { useFetch } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { Campaign, Post, PostStatus } from '@/lib/types';
import { daysToRelease, releaseLabel } from '@/components/Shell';
import { EmptyState, ErrorNote, Loading, ModeTag, PageTitle, PlatformTag, StatusBadge } from '@/components/ui';

function Row({ p }: { p: Post }) {
  return (
    <li>
      <Link href={`/posts/${p.id}`} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-2.5 transition-colors hover:bg-neutral-50">
        <PlatformTag platform={p.platform} />
        <ModeTag mode={p.publishMode} />
        <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{p.caption || '(légende vide)'}</span>
        <span className="text-xs tabular-nums text-neutral-500">{fmtDateTime(p.scheduledAt)}</span>
        <StatusBadge status={p.status} />
      </Link>
      {p.statusNote && <p className="px-2 pb-2 text-xs text-neutral-500">{p.statusNote}</p>}
    </li>
  );
}

function Panel({ title, hint, posts, tone }: { title: string; hint?: string; posts: Post[]; tone?: 'alert' }) {
  if (!posts.length) return null;
  return (
    <section className={`card ${tone === 'alert' ? 'border-red-200 bg-red-50/40' : ''}`}>
      <h2 className="section-title">
        {title} <span className="font-normal text-neutral-400">{posts.length}</span>
      </h2>
      {hint && <p className="mb-1 text-xs text-neutral-500">{hint}</p>}
      <ul className="mt-1 divide-y divide-line/70">{posts.map((p) => <Row key={p.id} p={p} />)}</ul>
    </section>
  );
}

export default function Dashboard() {
  const posts = useFetch<Post[]>('/posts');
  const campaign = useFetch<Campaign>('/campaign');

  if (posts.loading) return <Loading />;
  const all = posts.data ?? [];
  const by = (s: PostStatus) => all.filter((p) => p.status === s);
  const bySchedule = (a: Post, b: Post) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? '');
  const upcoming = by('APPROVED').sort(bySchedule);
  const urgent = [...by('NEEDS_RECONCILIATION'), ...by('FAILED'), ...by('MANUAL_REQUIRED')];
  const c = campaign.data;
  const rel = c ? daysToRelease(c.releaseDate) : null;

  const stats: Array<[string, number, string]> = [
    ['Brouillons', by('DRAFT').length, '/calendar'],
    ['À valider', by('PENDING_APPROVAL').length, '/calendar'],
    ['Programmés', upcoming.length, '/calendar'],
    ['Publiés', by('PUBLISHED').length, '/analytics'],
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageTitle title="Tableau de bord" subtitle="Ce qui demande votre attention, puis ce qui part ensuite.">
        <Link href="/calendar" className="btn btn-primary">Ouvrir le calendrier</Link>
      </PageTitle>
      <ErrorNote message={posts.error} />

      <section className="relative overflow-hidden rounded-2xl bg-graphite p-6 text-white shadow-pop md:p-8">
        <div className="relative z-10 flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-sm text-neutral-400">Sortie en salle · {c ? new Date(c.releaseDate).toLocaleDateString('fr-TN', { timeZone: 'Africa/Tunis', day: 'numeric', month: 'long' }) : '—'}</p>
            <p className="mt-1 text-5xl font-extrabold tracking-tight text-brand md:text-6xl">{rel === null ? '—' : releaseLabel(rel)}</p>
          </div>
          {c && (
            <ul className="flex flex-wrap gap-2 text-xs font-medium">
              <li className={`rounded-full px-3 py-1 ${c.autoPublishEnabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/10 text-neutral-300'}`}>
                Auto-publication {c.autoPublishEnabled ? 'activée' : 'désactivée'}
              </li>
              {c.publishingPaused && <li className="rounded-full bg-red-500/25 px-3 py-1 text-red-200">Campagne en pause</li>}
            </ul>
          )}
        </div>
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-brand/15 blur-3xl" aria-hidden />
      </section>

      {urgent.length > 0 ? (
        <Panel
          tone="alert"
          title="À traiter maintenant"
          hint="« À vérifier » : regardez la plateforme avant toute action, le post a peut-être déjà été publié."
          posts={urgent}
        />
      ) : (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          Rien d&apos;urgent : aucun échec, aucune publication manuelle en attente.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map(([label, n, href]) => (
          <Link key={label} href={href} className="card transition-shadow hover:shadow-pop">
            <div className="text-3xl font-bold tabular-nums">{n}</div>
            <div className="text-sm text-neutral-500">{label}</div>
          </Link>
        ))}
      </div>

      <Panel title="En attente de validation" posts={by('PENDING_APPROVAL')} />
      <Panel title="Prochaines publications" posts={upcoming.slice(0, 10)} />

      {!all.length && (
        <EmptyState title="Aucun post pour l’instant" hint="Ouvrez le calendrier, choisissez un jour du plan et générez ses brouillons.">
          <Link href="/calendar" className="btn btn-primary">Ouvrir le calendrier</Link>
        </EmptyState>
      )}
    </div>
  );
}