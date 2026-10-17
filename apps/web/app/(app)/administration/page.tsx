'use client';

import Link from 'next/link';
import { useFetch } from '@/lib/api';
import { EP } from '@/lib/endpoints';
import type { AdminOverview, Me } from '@/lib/types';
import { ErrorNote, Loading, PageTitle } from '@/components/ui';
import { EmergencyStopCard, GROUP_ORDER, groupMeta } from '@/components/admin/feature-ui';

export default function AdministrationPage() {
  const me = useFetch<Me>('/auth/me');
  const role = me.data?.role;
  const allowed = role === 'ADMIN' || role === 'APPROVER';
  const ov = useFetch<AdminOverview>(allowed ? EP.features.overview : null);

  if (me.loading || (allowed && ov.loading)) return <Loading />;
  if (!allowed) return <ErrorNote message="Accès réservé aux administrateurs et validateurs." />;

  const features = ov.data?.features ?? [];
  const extra = [...new Set(features.map((f) => f.group))].filter((g) => !(GROUP_ORDER as readonly string[]).includes(g));
  const groups = [...GROUP_ORDER, ...extra];

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageTitle title="Centre d’administration" subtitle="Décidez ce qui est actif, ce qui exige une validation et ce qui peut tourner seul.">
        {role === 'ADMIN' && <Link href="/administration/activity" className="btn text-xs">Journal des modifications</Link>}
      </PageTitle>

      <ErrorNote message={ov.error} />
      {role === 'APPROVER' && <p className="rounded-md bg-neutral-50 p-2 text-xs text-neutral-600">Lecture seule : seul un administrateur peut modifier les réglages.</p>}

      <EmergencyStopCard
        state={ov.data?.emergency ?? null}
        canStop={allowed}
        canResume={role === 'ADMIN'}
        onChanged={ov.reload}
      />

      {ov.data?.publishingPaused && (
        <p className="rounded-md bg-red-50 p-2 text-sm font-semibold text-red-800">Les publications sont en pause (pause globale) : les fonctions de publication sont effectivement désactivées.</p>
      )}

      <p className="text-xs text-neutral-500">
        Désactiver une fonction ne supprime aucune donnée. Les validations humaines (publication, vérification du planning) sont des règles de sécurité non modifiables.
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        {groups.map((slug) => {
          const items = features.filter((f) => f.group === slug);
          if (items.length === 0) return null;
          const meta = groupMeta(slug);
          const count = (m: string) => items.filter((f) => f.effectiveMode === m && !f.locked).length;
          return (
            <Link key={slug} href={`/administration/${slug}`} className="card block transition-shadow hover:shadow-md">
              <p className="font-bold">{meta.title}</p>
              {meta.description && <p className="mt-0.5 text-xs text-neutral-500">{meta.description}</p>}
              <p className="mt-3 flex flex-wrap gap-3 text-xs">
                <span className="font-semibold text-emerald-700">{count('AUTO')} actif(s)</span>
                <span className="font-semibold text-amber-700">{count('REVIEW')} avec validation</span>
                <span className="text-neutral-500">{count('OFF')} désactivé(s)</span>
                {items.some((f) => f.overrides.length > 0) && <span className="text-indigo-700">exceptions définies</span>}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}