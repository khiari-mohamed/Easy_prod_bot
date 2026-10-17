'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useFetch } from '@/lib/api';
import { EP } from '@/lib/endpoints';
import type { FeatureAuditEntry, Me } from '@/lib/types';
import { EmptyState, ErrorNote, Loading, ModeBadge, PageTitle } from '@/components/ui';
import { fmtDate } from '@/components/admin/feature-ui';

function State({ v }: { v: { mode?: string; active?: boolean } | null }) {
  if (!v) return <span className="text-neutral-400">—</span>;
  if (v.active !== undefined)
    return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${v.active ? 'bg-red-50 text-red-800' : 'bg-neutral-100 text-neutral-600'}`}>{v.active ? 'Actif' : 'Inactif'}</span>;
  if (v.mode === 'OFF' || v.mode === 'REVIEW' || v.mode === 'AUTO') return <ModeBadge mode={v.mode} />;
  if (v.mode === 'INHERIT') return <span className="text-xs text-neutral-500">Hérité du global</span>;
  return <span className="text-neutral-400">—</span>;
}

export default function AdministrationActivityPage() {
  const me = useFetch<Me>('/auth/me');
  const [filter, setFilter] = useState('');
  const isAdmin = me.data?.role === 'ADMIN';
  const qs = new URLSearchParams({ limit: '100', ...(filter.trim() ? { feature: filter.trim() } : {}) }).toString();
  const audit = useFetch<FeatureAuditEntry[]>(isAdmin ? EP.features.history(qs) : null);

  if (me.loading) return <Loading />;
  if (!isAdmin) return <ErrorNote message="Accès réservé aux administrateurs." />;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageTitle title="Journal des modifications" subtitle="Qui a changé quoi, et quand.">
        <Link href="/administration" className="btn text-xs">← Centre d’administration</Link>
      </PageTitle>

      <input className="input max-w-xs text-xs" placeholder="Filtrer par clé exacte (ex. comments.reply)" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ErrorNote message={audit.error} />

      {audit.loading ? (
        <Loading />
      ) : (audit.data ?? []).length === 0 ? (
        <EmptyState title="Aucune modification enregistrée" />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-line bg-neutral-50 text-neutral-500">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Fonction</th>
                <th className="px-3 py-2">Portée</th>
                <th className="px-3 py-2">Avant</th>
                <th className="px-3 py-2">Après</th>
                <th className="px-3 py-2">Par</th>
                <th className="px-3 py-2">Raison</th>
              </tr>
            </thead>
            <tbody>
              {(audit.data ?? []).map((e) => (
                <tr key={e.id} className="border-b border-line last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{fmtDate(e.createdAt)}</td>
                  <td className="px-3 py-2 font-mono">{e.featureKey}</td>
                  <td className="px-3 py-2">{e.scope}{e.scopeId ? ` · ${e.scopeId}` : ''}</td>
                  <td className="px-3 py-2"><State v={e.previous} /></td>
                  <td className="px-3 py-2"><State v={e.next} /></td>
                  <td className="px-3 py-2">{e.changedByName ?? e.changedById}</td>
                  <td className="px-3 py-2 text-neutral-600">{e.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}