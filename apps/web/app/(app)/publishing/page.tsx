'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, useFetch } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { Me, Platform, PostFormat, PublishingOverview } from '@/lib/types';
import { EmptyState, ErrorNote, Loading, PageTitle, PlatformTag, Toggle } from '@/components/ui';

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);

type Item = { id: string; platform: Platform; format: PostFormat; caption: string; scheduledAt?: string | null; statusNote?: string | null };

function Block({
  title,
  count,
  tone,
  hint,
  children,
}: {
  title: string;
  count: number;
  tone?: 'rose' | 'orange' | 'red' | 'blue';
  hint?: string;
  children: React.ReactNode;
}) {
  const border = { rose: 'border-rose-200', orange: 'border-orange-200', red: 'border-red-200', blue: 'border-sky-200' }[tone ?? 'blue'];
  const head = { rose: 'text-rose-800', orange: 'text-orange-800', red: 'text-red-800', blue: 'text-ink' }[tone ?? 'blue'];
  return (
    <section className={`card space-y-2 ${tone ? border : ''}`}>
      <h2 className={`section-title ${tone ? head : ''}`}>
        {title} <span className="font-normal text-neutral-400">{count}</span>
      </h2>
      {hint && <p className="text-xs text-neutral-500">{hint}</p>}
      {children}
    </section>
  );
}

function Line({ p, action, extra }: { p: Item; action: string; extra?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-white px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <PlatformTag platform={p.platform} />
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-600">{p.format}</span>
          {p.scheduledAt && <span className="text-xs tabular-nums text-neutral-500">{fmtDateTime(p.scheduledAt)}</span>}
        </div>
        <p className="mt-1 truncate text-sm text-neutral-700" dir="auto">{clip(p.caption) || '(légende vide)'}</p>
        {p.statusNote && <p className="mt-0.5 text-xs text-neutral-600">{p.statusNote}</p>}
      </div>
      <div className="flex gap-2">
        {extra}
        <Link href={`/posts/${p.id}`} className="btn">{action}</Link>
      </div>
    </div>
  );
}

export default function PublishingPage() {
  const overview = useFetch<PublishingOverview>('/publishing/overview');
  const me = useFetch<Me>('/auth/me');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isApprover = me.data?.role === 'ADMIN' || me.data?.role === 'APPROVER';

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await overview.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (overview.loading) return <Loading />;
  const d = overview.data;
  if (!d) return <ErrorNote message={overview.error} />;

  const { campaign, pauseState, queued, publishing, failed, manualRequired, recentPublished } = d;
  const needsCheck = d.needsCheck ?? [];
  const waiting = needsCheck.length + manualRequired.length + failed.length;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageTitle
        title="Contrôle de publication"
        subtitle={waiting ? `${waiting} élément${waiting > 1 ? 's' : ''} attend${waiting > 1 ? 'ent' : ''} un humain.` : 'Tout est sous contrôle : rien n’attend un humain.'}
      />
      <ErrorNote message={error} />

      {pauseState.paused && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span className="font-semibold">Publications en pause{pauseState.reason ? ` : ${pauseState.reason}` : ''}.</span>
          {isApprover && (
            <button className="btn" disabled={busy} onClick={() => run(() => api('/settings/pause', { method: 'POST', body: { paused: false } }))}>
              Reprendre
            </button>
          )}
        </div>
      )}

      {campaign && isApprover && (
        <section className="card space-y-4">
          <h2 className="section-title">Contrôles de la campagne</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
              <div>
                <p className="text-sm font-semibold">Auto-publication</p>
                <p className="text-xs text-neutral-500">{campaign.autoPublishEnabled ? 'Les posts en mode Auto partent à l’heure prévue.' : 'Désactivée : rien ne part tout seul.'}</p>
              </div>
              <Toggle
                label="Auto-publication"
                checked={campaign.autoPublishEnabled}
                disabled={busy}
                onChange={() => run(() => api('/publishing/campaign/auto-publish', { method: 'POST', body: { enabled: !campaign.autoPublishEnabled } }))}
              />
            </div>
            <div className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
              <div>
                <p className="text-sm font-semibold">Campagne en pause</p>
                <p className="text-xs text-neutral-500">{campaign.publishingPaused ? 'En pause : les jobs en file sont bloqués.' : 'Active.'}</p>
              </div>
              <Toggle
                label="Campagne en pause"
                tone="danger"
                checked={campaign.publishingPaused}
                disabled={busy}
                onChange={() => {
                  const paused = !campaign.publishingPaused;
                  const reason = paused ? window.prompt('Raison de la pause (optionnel) :') ?? undefined : undefined;
                  run(() => api('/publishing/campaign/pause', { method: 'POST', body: { paused, reason } }));
                }}
              />
            </div>
          </div>
          <p className="text-xs text-neutral-500">
            Un post part automatiquement uniquement si : il est approuvé, en mode Auto, l&apos;auto-publication est activée et ni la campagne ni le système ne sont en pause.
          </p>
        </section>
      )}

      {needsCheck.length > 0 && (
        <Block
          title="À vérifier sur la plateforme"
          count={needsCheck.length}
          tone="rose"
          hint="Le résultat de la publication est inconnu (coupure réseau ou délai). Ouvrez la page Facebook ou Instagram : si le post y est, marquez-le publié ; sinon replanifiez ou annulez. Ne relancez jamais à l’aveugle."
        >
          {needsCheck.map((p) => <Line key={p.id} p={p} action="Vérifier" />)}
        </Block>
      )}

      {manualRequired.length > 0 && (
        <Block title="À publier à la main" count={manualRequired.length} tone="orange" hint="Légende prête à copier et média à télécharger dans la fiche du post.">
          {manualRequired.map((p) => <Line key={p.id} p={p} action="Ouvrir" />)}
        </Block>
      )}

      {failed.length > 0 && (
        <Block title="Échecs" count={failed.length} tone="red" hint="Vérifiez la plateforme avant de relancer pour éviter un doublon.">
          {failed.map((p) => <Line key={p.id} p={p} action="Gérer" />)}
        </Block>
      )}

      <Block title="File d’attente" count={queued.length + publishing.length}>
        {queued.length === 0 && publishing.length === 0 && <p className="text-sm text-neutral-500">Aucun post en attente d’envoi.</p>}
        {publishing.map((p) => (
          <Line key={p.id} p={p} action="Voir" extra={<span className="self-center rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700">En cours</span>} />
        ))}
        {queued.map((p) => <Line key={p.id} p={p} action="Voir" />)}
      </Block>

      <Block title="Historique récent" count={recentPublished.length}>
        {recentPublished.length === 0 && <EmptyState title="Aucune publication pour l’instant" />}
        {recentPublished.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <PlatformTag platform={p.platform} />
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-600">{p.format}</span>
                <span className="text-xs font-medium text-neutral-500">{p.publishMode === 'MANUAL' ? 'Publié à la main' : 'Publié automatiquement'}</span>
                {p.publishedAt && <span className="text-xs tabular-nums text-neutral-500">{fmtDateTime(p.publishedAt)}</span>}
              </div>
              <p className="mt-1 truncate text-sm text-neutral-700" dir="auto">{clip(p.caption, 70)}</p>
            </div>
            <div className="flex gap-2">
              {p.externalUrl && <a href={p.externalUrl} target="_blank" rel="noreferrer" className="btn">Voir le post</a>}
              <Link href={`/posts/${p.id}`} className="btn">Détails</Link>
            </div>
          </div>
        ))}
      </Block>
    </div>
  );
}