'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, upload, useFetch } from '@/lib/api';
import type { Asset, CaptionLanguage, ContentItem, Me, Platform, PostFormat, PublishMode } from '@/lib/types';
import { ErrorNote, Loading, PageTitle, PlatformTag, StatusBadge } from '@/components/ui';

const LANG_LABELS: Record<CaptionLanguage, string> = {
  DARIJA: 'Darija',
  FRENCH: 'Français',
  DARIJA_FRENCH: 'Darija + Français',
};

const APPROVAL_COLORS: Record<string, string> = {
  DRAFT: 'bg-neutral-100 text-neutral-700',
  PENDING: 'bg-yellow-100 text-yellow-800',
  APPROVED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-700',
};

export default function ContentPage() {
  const items = useFetch<ContentItem[]>('/content');
  const me = useFetch<Me>('/auth/me');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isApprover = me.data?.role === 'ADMIN' || me.data?.role === 'APPROVER';

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await items.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (items.loading) return <Loading />;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageTitle title="Contenu">
        <Link href="/content/new" className="btn btn-primary">+ Nouveau contenu</Link>
      </PageTitle>
      <ErrorNote message={error ?? items.error} />

      {(items.data ?? []).length === 0 && (
        <p className="text-sm text-neutral-500">Aucun contenu. <Link href="/content/new" className="underline">Créez le premier.</Link></p>
      )}

      <div className="space-y-2">
        {(items.data ?? []).map((item) => (
          <div key={item.id} className="card flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/content/${item.id}`} className="font-semibold hover:underline">{item.title}</Link>
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${APPROVAL_COLORS[item.approvalStatus]}`}>
                  {item.approvalStatus}
                </span>
                {item.captionLanguage && (
                  <span className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                    {LANG_LABELS[item.captionLanguage]}
                  </span>
                )}
                <span className="text-xs text-neutral-400">{item.defaultPublishMode}</span>
              </div>
              {item.baseCaption && (
                <p className="mt-1 line-clamp-2 text-sm text-neutral-600" dir="auto">{item.baseCaption}</p>
              )}
              <div className="mt-1 flex flex-wrap gap-1">
                {item.posts.map((p) => (
                  <Link key={p.id} href={`/posts/${p.id}`}>
                    <PlatformTag platform={p.platform} />
                  </Link>
                ))}
              </div>
              {item.rejectionNote && (
                <p className="mt-1 text-xs text-red-600">Refusé : {item.rejectionNote}</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {item.approvalStatus === 'DRAFT' && (
                <button className="btn" disabled={busy} onClick={() => run(() => api(`/content/${item.id}/submit`, { method: 'POST' }))}>
                  Soumettre
                </button>
              )}
              {item.approvalStatus === 'PENDING' && isApprover && (
                <>
                  <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api(`/content/${item.id}/approve`, { method: 'POST' }))}>
                    Approuver
                  </button>
                  <button className="btn" disabled={busy} onClick={() => {
                    const reason = window.prompt('Motif du refus :');
                    if (reason) run(() => api(`/content/${item.id}/reject`, { method: 'POST', body: { reason } }));
                  }}>
                    Refuser
                  </button>
                </>
              )}
              <Link href={`/content/${item.id}`} className="btn">Éditer</Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
