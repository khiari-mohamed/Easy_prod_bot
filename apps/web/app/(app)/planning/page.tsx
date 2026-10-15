'use client';

import { useRef, useState } from 'react';
import { api, useFetch } from '@/lib/api';
import type { Me, PlanImport, PlanImportRow } from '@/lib/types';
import { ErrorNote, Loading, PageTitle } from '@/components/ui';

const ACCEPT = [
  '.csv', '.txt', '.pdf', '.pptx', '.docx',
  'text/csv', 'text/plain', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
].join(',');

type ImportMeta = { warnings?: string[]; documentHashtags?: string[] } | null;
type ImportDetail = PlanImport & { meta?: ImportMeta };
type Row = PlanImportRow & { warning?: string | null };

const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString('fr-TN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

function RowTable({ rows }: { rows: Row[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-left text-neutral-500">
            <th className="py-1 pr-2">#</th>
            <th className="py-1 pr-2">Date</th>
            <th className="py-1 pr-2">Phase</th>
            <th className="py-1 pr-2">Label</th>
            <th className="py-1 pr-2">Plateformes</th>
            <th className="py-1 pr-2">Format</th>
            <th className="py-1">Remarque</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`border-b ${r.error ? 'bg-red-50' : ''}`}>
              <td className="py-1 pr-2 text-neutral-400">{r.rowIndex}</td>
              <td className="py-1 pr-2 whitespace-nowrap">{fmtDate(r.date)}</td>
              <td className="py-1 pr-2">{r.phase}</td>
              <td className="py-1 pr-2 max-w-[180px] truncate" title={r.label}>{r.label}</td>
              <td className="py-1 pr-2">{r.platforms.join(', ')}</td>
              <td className="py-1 pr-2">{r.format}</td>
              <td className={`py-1 ${r.error ? 'text-red-600' : 'text-amber-700'}`}>{r.error ?? r.warning ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ImportCard({
  imp,
  onRefresh,
  isApprover,
  defaultOpen,
}: {
  imp: PlanImport;
  onRefresh: () => void;
  isApprover: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const detail = useFetch<ImportDetail>(open ? `/planning/imports/${imp.id}` : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  const source = (imp as PlanImport & { source?: string }).source;
  const meta = detail.data?.meta;
  const docTags = meta?.documentHashtags ?? [];

  async function commit() {
    if (!window.confirm('Créer les jours de campagne à partir de cet import ?')) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ ok: boolean; created: number; skipped: number; drafts: number }>(
        `/planning/imports/${imp.id}/commit`,
        { method: 'POST', body: { addHashtags: picked } },
      );
      alert(
        `✅ ${r.created} entrée(s) créée(s), ${r.skipped} ignorée(s) (déjà existantes)` +
          (r.drafts ? `, ${r.drafts} brouillon(s) de contenu avec légende.` : '.'),
      );
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('Supprimer cet import ?')) return;
    setBusy(true);
    try {
      await api(`/planning/imports/${imp.id}`, { method: 'DELETE' });
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const validRows = detail.data?.rows?.filter((r) => !r.error).length ?? 0;
  const errorRows = detail.data?.rows?.filter((r) => r.error).length ?? 0;

  return (
    <div className="card space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-semibold">{imp.filename}</div>
          <div className="text-xs text-neutral-500">
            {source ? `${source} · ` : ''}
            {imp.rowCount} ligne(s) · {fmtDate(imp.createdAt)} ·{' '}
            <span className={`font-semibold ${imp.status === 'COMMITTED' ? 'text-green-700' : 'text-amber-700'}`}>
              {imp.status === 'COMMITTED' ? 'Validé' : 'Aperçu'}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <button className="btn text-xs" onClick={() => setOpen((v) => !v)}>
            {open ? 'Masquer' : 'Voir les lignes'}
          </button>
          {isApprover && imp.status === 'PREVIEW' && (
            <button className="btn btn-primary text-xs" disabled={busy} onClick={commit}>
              {busy ? 'Validation…' : 'Valider et créer les jours'}
            </button>
          )}
          {isApprover && (
            <button className="btn text-xs text-red-600" disabled={busy} onClick={remove}>Supprimer</button>
          )}
        </div>
      </div>
      <ErrorNote message={error} />
      {open && (
        <div className="mt-2 space-y-2">
          {detail.loading && <Loading />}
          {meta?.warnings && meta.warnings.length > 0 && (
            <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
              <p className="font-semibold">Points à vérifier dans l’extraction :</p>
              <ul className="list-disc pl-4">
                {meta.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
          {docTags.length > 0 && imp.status === 'PREVIEW' && isApprover && (
            <div className="rounded-md bg-neutral-50 p-2 text-xs">
              <p className="font-semibold">Hashtags trouvés dans le document</p>
              <p className="text-neutral-500">Cochez ceux à ajouter aux hashtags officiels de la campagne (utilisés dans toutes les légendes IA).</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {docTags.map((t) => (
                  <label key={t} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={picked.includes(t)}
                      onChange={() => setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))}
                    />
                    #{t}
                  </label>
                ))}
              </div>
            </div>
          )}
          {detail.data?.rows && (
            <>
              {errorRows > 0 && (
                <p className="text-xs text-red-600">{errorRows} ligne(s) avec erreurs : elles seront ignorées lors de la validation.</p>
              )}
              {validRows > 0 && (
                <p className="text-xs text-green-700">{validRows} ligne(s) valides prêtes à être importées.</p>
              )}
              <RowTable rows={detail.data.rows as Row[]} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function PlanningPage() {
  const imports = useFetch<PlanImport[]>('/planning/imports');
  const me = useFetch<Me>('/auth/me');
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [busyName, setBusyName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [newId, setNewId] = useState<string | null>(null);

  const isApprover = me.data?.role === 'ADMIN' || me.data?.role === 'APPROVER';

  async function onFile(files: FileList | null) {
    if (!files?.length) return;
    const file = files[0];
    setBusy(true);
    setBusyName(file.name);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/planning/imports/upload', {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(Array.isArray(body.message) ? body.message.join(' • ') : body.message ?? res.statusText);
      }
      const created = (await res.json()) as { id: string };
      setNewId(created.id);
      imports.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setBusyName('');
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="space-y-4">
      <PageTitle title="Gestion du planning">
        <input ref={fileRef} type="file" accept={ACCEPT} hidden onChange={(e) => onFile(e.target.files)} />
        <button className="btn btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Analyse…' : 'Importer un plan'}
        </button>
      </PageTitle>

      {busy && (
        <p className="text-sm text-neutral-600">
          Lecture de « {busyName} » en cours. Un PDF, PPTX ou Word est analysé par l’IA : cela peut prendre jusqu’à une minute.
        </p>
      )}

      <div className="card bg-neutral-50 text-sm space-y-1">
        <p className="font-semibold">Formats acceptés</p>
        <p className="text-xs text-neutral-600">
          <strong>PDF</strong> (y compris scanné), <strong>PPTX</strong>, <strong>Word (.docx)</strong> : l’IA extrait le planning, puis vous vérifiez les lignes avant de valider.
          Un PPTX dont les diapositives ne sont que des images n’a pas de texte lisible : exportez-le en PDF.
        </p>
        <p className="text-xs text-neutral-600">
          <strong>CSV</strong> (virgule ou point-virgule) : <code>date, phase, label, content, execution, objective, platforms, format</code>
          {' '}+ optionnel : <code>caption, caption_language, publish_mode, time_of_day, asset_ref</code>
        </p>
        <p className="text-xs text-neutral-600">
          <strong>platforms</strong> : FACEBOOK|INSTAGRAM|TIKTOK séparés par <code>|</code> &nbsp;·&nbsp;
          <strong>format</strong> : IMAGE, VIDEO, REEL, STORY ou TEXT &nbsp;·&nbsp;
          <strong>date</strong> : YYYY-MM-DD ou JJ/MM/AAAA
        </p>
        <p className="text-xs text-neutral-500">
          L’import crée un aperçu. Un approbateur valide pour créer les jours dans le calendrier. Les légendes trouvées dans le plan deviennent des brouillons de contenu : rien n’est publié sans approbation.
        </p>
      </div>

      <ErrorNote message={error ?? imports.error} />

      {imports.loading ? (
        <Loading />
      ) : imports.data?.length === 0 ? (
        <p className="text-sm text-neutral-500">Aucun import pour l’instant. Téléversez un plan pour commencer.</p>
      ) : (
        <div className="space-y-3">
          {imports.data?.map((imp) => (
            <ImportCard
              key={imp.id}
              imp={imp}
              onRefresh={imports.reload}
              isApprover={isApprover}
              defaultOpen={imp.id === newId}
            />
          ))}
        </div>
      )}
    </div>
  );
}