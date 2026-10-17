'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useFetch } from '@/lib/api';
import { EP } from '@/lib/endpoints';
import type { AdminOverview, Me } from '@/lib/types';
import { EmptyState, ErrorNote, Loading, PageTitle } from '@/components/ui';
import { FeatureRow, groupMeta } from '@/components/admin/feature-ui';

export default function AdministrationGroupPage() {
  const params = useParams<{ group: string }>();
  const slug = decodeURIComponent(params.group);
  const me = useFetch<Me>('/auth/me');
  const role = me.data?.role;
  const allowed = role === 'ADMIN' || role === 'APPROVER';
  const ov = useFetch<AdminOverview>(allowed ? EP.features.overview : null);

  if (me.loading || (allowed && ov.loading)) return <Loading />;
  if (!allowed) return <ErrorNote message="Accès réservé aux administrateurs et validateurs." />;

  const items = (ov.data?.features ?? []).filter((f) => f.group === slug);
  const meta = groupMeta(slug);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle title={meta.title} subtitle={meta.description}>
        <Link href="/administration" className="btn text-xs">← Centre d’administration</Link>
      </PageTitle>

      <ErrorNote message={ov.error} />
      {role === 'APPROVER' && <p className="rounded-md bg-neutral-50 p-2 text-xs text-neutral-600">Lecture seule : seul un administrateur peut modifier les réglages.</p>}

      {items.length === 0 ? (
        <EmptyState title="Aucune fonction dans ce groupe" />
      ) : (
        <div className="space-y-2">
          {items.map((f) => (
            <FeatureRow
              key={f.key}
              feature={f}
              campaigns={ov.data?.campaigns ?? []}
              accounts={ov.data?.accounts ?? []}
              canEdit={role === 'ADMIN'}
              onChanged={ov.reload}
            />
          ))}
        </div>
      )}
    </div>
  );
}