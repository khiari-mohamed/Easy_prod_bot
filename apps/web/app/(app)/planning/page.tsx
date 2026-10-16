'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useFetch } from '@/lib/api';
import type { Me, Platform, PlanActionType, PlanImport, PlanImportRow, PostFormat } from '@/lib/types';
import { ErrorNote, Loading, PageTitle } from '@/components/ui';

const ACCEPT = [
  '.csv', '.txt', '.pdf', '.pptx', '.docx',
  'text/csv', 'text/plain', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
].join(',');

const TZ = 'Africa/Tunis';
const PLATFORMS: Platform[] = ['FACEBOOK', 'INSTAGRAM', 'TIKTOK'];
const FORMATS: PostFormat[] = ['IMAGE', 'VIDEO', 'REEL', 'STORY', 'TEXT'];

const ACTIONS: Record<PlanActionType, { label: string; chip: string; hint: string }> = {
  POST: { label: 'Publication', chip: 'bg-sky-50 text-sky-800', hint: 'Crée un brouillon de post' },
  COMMENT: { label: 'Commentaire', chip: 'bg-violet-50 text-violet-800', hint: 'Tâche : commentaire à poster' },
  ENGAGEMENT: { label: 'Engagement', chip: 'bg-emerald-50 text-emerald-800', hint: 'Tâche : répondre à l’audience' },
  SPONSORING: { label: 'Sponsoring', chip: 'bg-amber-50 text-amber-800', hint: 'Tâche : booster / publicité' },
  PREPARATION: { label: 'Préparation', chip: 'bg-orange-50 text-orange-800', hint: 'Tâche : produire un visuel ou une vidéo' },
  REPORTING: { label: 'Reporting', chip: 'bg-neutral-100 text-neutral-700', hint: 'Tâche : analyser les résultats' },
  OTHER: { label: 'Autre', chip: 'bg-neutral-100 text-neutral-700', hint: 'Tâche libre' },
};

type ImportMeta = { warnings?: string[]; documentHashtags?: string[] } | null;
type ImportDetail = PlanImport & { meta?: ImportMeta };
type Filter = 'all' | 'todo' | 'errors';

const dayKey = (iso: string | null) => (iso ? new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(iso)) : '');
const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('fr-TN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : 'Sans date';
const pageOf = (ref: string | null) => {
  const m = ref ? /(\d+)/.exec(ref) : null;
  return m ? Number(m[1]) : null;
};

interface Draft {
  date: string;
  timeOfDay: string;
  label: string;
  actionType: PlanActionType;
  platforms: Platform[];
  format: PostFormat;
  caption: string;
  content: string;
  execution: string;
  assetRef: string;
}

const toDraft = (r: PlanImportRow): Draft => ({
  date: dayKey(r.date),
  timeOfDay: r.timeOfDay ?? '',
  label: r.label,
  actionType: r.actionType,
  platforms: r.platforms,
  format: r.format,
  caption: r.caption ?? '',
  content: r.content,
  execution: r.execution,
  assetRef: r.assetRef ?? '',
});

/** Only the fields the reviewer actually changed, so untouched rows stay "not edited". */
function diff(a: Draft, b: Draft): Partial<Draft> {
  const out: Partial<Draft> = {};
  (Object.keys(a) as (keyof Draft)[]).forEach((k) => {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) (out as Record<string, unknown>)[k] = b[k];
  });
  return out;
}

function RowCard({
  importId,
  row,
  editable,
  hasPdf,
  onShowSource,
  onChanged,
}: {
  importId: string;
  row: PlanImportRow;
  editable: boolean;
  hasPdf: boolean;
  onShowSource: (page: number) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(!!row.error);
  const [draft, setDraft] = useState<Draft>(() => toDraft(row));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Server state is the truth: reset the form whenever the row comes back from the API.
  useEffect(() => setDraft(toDraft(row)), [row]);

  const changes = diff(toDraft(row), draft);
  const dirty = Object.keys(changes).length > 0;
  const base = `/planning/imports/${importId}/rows/${row.id}`;
  const page = pageOf(row.sourceRef);
  const act = ACTIONS[row.actionType];
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  async function call(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const save = (verified?: boolean) =>
    call(() => api(base, { method: 'PATCH', body: { ...changes, ...(verified !== undefined ? { verified } : {}) } }));

  return (
    <div className={`rounded-lg border p-3 ${row.error ? 'border-red-300 bg-red-50/40' : row.verified ? 'border-emerald-300 bg-emerald-50/30' : 'border-line bg-white'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-neutral-400">#{row.rowIndex}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${act.chip}`} title={act.hint}>{act.label}</span>
        <span className="text-sm font-semibold">{fmtDate(row.date)}</span>
        <span className="text-sm tabular-nums text-neutral-600">{row.timeOfDay ?? '—'}</span>
        <span className="text-xs text-neutral-500">{row.platforms.length ? row.platforms.join(' + ') : 'sans plateforme'}</span>
        {row.edited && <span className="rounded bg-indigo-50 px-1.5 text-xs font-semibold text-indigo-700">modifié</span>}
        {row.confidence != null && row.confidence < 0.6 && <span className="rounded bg-amber-100 px-1.5 text-xs font-semibold text-amber-800">peu fiable</span>}
        <label className="ml-auto flex items-center gap-1.5 text-xs font-semibold">
          <input
            type="checkbox"
            checked={row.verified}
            disabled={!editable || busy || !!row.error || dirty}
            onChange={(e) => save(e.target.checked)}
            aria-label={`Ligne ${row.rowIndex} vérifiée`}
          />
          Vérifié
        </label>
      </div>

      <p className="mt-1 font-medium" dir="auto">{row.label || '(sans titre)'}</p>

      {(row.sourceRef || row.sourceText || row.dateText) && (
        <div className="mt-2 rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-2 text-xs">
          <p className="font-semibold text-neutral-500">
            Dans le document {row.sourceRef ? `· ${row.sourceRef}` : ''}
            {hasPdf && page != null && (
              <button type="button" className="ml-2 underline underline-offset-2 hover:text-ink" onClick={() => onShowSource(page)}>
                Voir la page {page}
              </button>
            )}
          </p>
          {row.dateText && <p className="mt-0.5 text-neutral-600">Date écrite : « {row.dateText} »</p>}
          {row.sourceText && <p className="mt-0.5 whitespace-pre-wrap text-neutral-700" dir="auto">{row.sourceText}</p>}
        </div>
      )}

      {row.error && <p className="mt-2 text-xs font-semibold text-red-700">⛔ {row.error}</p>}
      {row.warning && <p className="mt-1 text-xs text-amber-700">⚠ {row.warning}</p>}

      {editable && (
        <button type="button" className="mt-2 text-xs underline underline-offset-2" onClick={() => setOpen((v) => !v)}>
          {open ? 'Fermer l’édition' : 'Corriger cette ligne'}
        </button>
      )}

      {editable && open && (
        <div className="mt-2 space-y-2 rounded-md bg-white p-2">
          <div className="grid gap-2 sm:grid-cols-4">
            <label className="text-xs">Type
              <select className="input" value={draft.actionType} onChange={(e) => set('actionType', e.target.value as PlanActionType)}>
                {(Object.keys(ACTIONS) as PlanActionType[]).map((t) => <option key={t} value={t}>{ACTIONS[t].label}</option>)}
              </select>
            </label>
            <label className="text-xs">Date
              <input className="input" type="date" value={draft.date} onChange={(e) => set('date', e.target.value)} />
            </label>
            <label className="text-xs">Heure
              <input className="input" type="time" value={draft.timeOfDay} onChange={(e) => set('timeOfDay', e.target.value)} />
            </label>
            <label className="text-xs">Format
              <select className="input" value={draft.format} disabled={draft.actionType !== 'POST'} onChange={(e) => set('format', e.target.value as PostFormat)}>
                {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
          </div>
          <label className="block text-xs">Titre
            <input className="input" value={draft.label} onChange={(e) => set('label', e.target.value)} dir="auto" />
          </label>
          <div className="flex flex-wrap gap-3 text-xs">
            <span className="font-semibold">Plateformes</span>
            {PLATFORMS.map((p) => (
              <label key={p} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={draft.platforms.includes(p)}
                  onChange={() => set('platforms', draft.platforms.includes(p) ? draft.platforms.filter((x) => x !== p) : [...draft.platforms, p])}
                />
                {p}
              </label>
            ))}
          </div>
          <label className="block text-xs">
            {draft.actionType === 'COMMENT' ? 'Texte du commentaire (exact)' : 'Légende (exacte, telle que dans le document)'}
            <textarea className="input min-h-20" value={draft.caption} onChange={(e) => set('caption', e.target.value)} dir="auto" />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs">Contenu / description
              <textarea className="input min-h-16" value={draft.content} onChange={(e) => set('content', e.target.value)} dir="auto" />
            </label>
            <label className="text-xs">Consignes d’exécution
              <textarea className="input min-h-16" value={draft.execution} onChange={(e) => set('execution', e.target.value)} dir="auto" />
            </label>
          </div>
          <label className="block text-xs">Média (nom de fichier)
            <input className="input" value={draft.assetRef} onChange={(e) => set('assetRef', e.target.value)} />
          </label>

          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary text-xs" disabled={busy || !dirty} onClick={() => save()}>Enregistrer</button>
            <button className="btn text-xs" disabled={busy || !dirty} onClick={() => save(true)}>Enregistrer et marquer vérifié</button>
            {row.edited && row.original && (
              <button className="btn text-xs" disabled={busy} onClick={() => call(() => api(`${base}/reset`, { method: 'POST', body: {} }))}>
                Rétablir l’extraction d’origine
              </button>
            )}
            <button
              className="btn text-xs text-red-600"
              disabled={busy}
              onClick={() => window.confirm('Supprimer cette ligne du plan ?') && call(() => api(base, { method: 'DELETE' }))}
            >
              Supprimer la ligne
            </button>
          </div>
        </div>
      )}
      <ErrorNote message={error} />
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
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);

  const data = detail.data;
  const meta = data?.meta;
  const docTags = meta?.documentHashtags ?? [];
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const editable = (data?.status ?? imp.status) === 'PREVIEW';
  const isPdf = (data?.source ?? imp.source) === 'PDF';
  const hasSource = !!data?.hasSource;

  const errorRows = rows.filter((r) => r.error).length;
  const verifiedRows = rows.filter((r) => r.verified).length;
  const todoRows = rows.filter((r) => !r.error && !r.verified).length;
  const ready = rows.length > 0 && errorRows === 0 && todoRows === 0;
  const shown = rows.filter((r) => (filter === 'errors' ? r.error : filter === 'todo' ? !r.verified : true));
  const byType = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.actionType]: (m[r.actionType] ?? 0) + 1 }), {});

  const refresh = () => {
    detail.reload();
    onRefresh();
  };

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const commit = () =>
    run(async () => {
      if (!window.confirm('Valider ce plan et créer les entrées du calendrier ? Rien ne sera publié automatiquement.')) return;
      const r = await api<{ created: number; skipped: number; drafts: number; tasks: number }>(`/planning/imports/${imp.id}/commit`, {
        method: 'POST',
        body: { addHashtags: picked },
      });
      alert(
        `✅ ${r.created} entrée(s) ajoutée(s) au calendrier dont ${r.tasks} tâche(s) (${r.skipped} déjà existante(s) ignorée(s)).` +
          (r.drafts ? ` ${r.drafts} brouillon(s) de contenu avec légende.` : ''),
      );
      refresh();
    });

  const verifyAll = () => run(async () => { await api(`/planning/imports/${imp.id}/verify-all`, { method: 'POST', body: {} }); refresh(); });
  const addRow = () => run(async () => { await api(`/planning/imports/${imp.id}/rows`, { method: 'POST', body: { label: 'Nouvelle action' } }); refresh(); });
  const remove = () =>
    run(async () => {
      if (!window.confirm('Supprimer cet import ?')) return;
      await api(`/planning/imports/${imp.id}`, { method: 'DELETE' });
      onRefresh();
    });

  return (
    <div className="card space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-semibold">{imp.filename}</div>
          <div className="text-xs text-neutral-500">
            {imp.source ? `${imp.source} · ` : ''}
            {imp.rowCount} action(s) · {fmtDate(imp.createdAt)} ·{' '}
            <span className={`font-semibold ${imp.status === 'COMMITTED' ? 'text-green-700' : 'text-amber-700'}`}>
              {imp.status === 'COMMITTED' ? 'Validé' : 'À vérifier'}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn text-xs" onClick={() => setOpen((v) => !v)}>{open ? 'Masquer' : imp.status === 'PREVIEW' ? 'Vérifier le plan' : 'Voir les lignes'}</button>
          {isApprover && imp.status === 'PREVIEW' && open && (
            <button className="btn btn-primary text-xs" disabled={busy || !ready} onClick={commit} title={ready ? '' : 'Corrigez les erreurs et vérifiez toutes les lignes'}>
              {busy ? 'Validation…' : 'Valider le plan'}
            </button>
          )}
          {isApprover && <button className="btn text-xs text-red-600" disabled={busy} onClick={remove}>Supprimer</button>}
        </div>
      </div>
      <ErrorNote message={error ?? detail.error} />

      {open && (
        <div className="mt-2 space-y-3">
          {detail.loading && <Loading />}
          {meta?.warnings && meta.warnings.length > 0 && (
            <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
              <p className="font-semibold">Points à vérifier dans l’extraction :</p>
              <ul className="list-disc pl-4">{meta.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}

          {rows.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={errorRows ? 'font-semibold text-red-600' : 'text-green-700'}>{errorRows ? `⛔ ${errorRows} erreur(s)` : '✔ 0 erreur'}</span>
              <span className={todoRows ? 'font-semibold text-amber-700' : 'text-green-700'}>{verifiedRows}/{rows.length} vérifiée(s)</span>
              <span className="text-neutral-500">
                {(Object.keys(byType) as PlanActionType[]).map((t) => `${byType[t]} ${ACTIONS[t].label.toLowerCase()}`).join(' · ')}
              </span>
              <span className="ml-auto flex flex-wrap gap-1">
                {(['all', 'todo', 'errors'] as const).map((f) => (
                  <button key={f} className={`rounded-full border px-2 py-0.5 ${filter === f ? 'bg-ink text-white' : 'bg-white'}`} onClick={() => setFilter(f)}>
                    {f === 'all' ? 'Toutes' : f === 'todo' ? 'À vérifier' : 'Erreurs'}
                  </button>
                ))}
              </span>
            </div>
          )}

          {editable && docTags.length > 0 && isApprover && (
            <div className="rounded-md bg-neutral-50 p-2 text-xs">
              <p className="font-semibold">Hashtags trouvés dans le document</p>
              <p className="text-neutral-500">Cochez ceux à ajouter aux hashtags officiels de la campagne.</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {docTags.map((t) => (
                  <label key={t} className="flex items-center gap-1">
                    <input type="checkbox" checked={picked.includes(t)} onChange={() => setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))} />
                    #{t}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className={`grid gap-3 ${hasSource ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]' : ''}`}>
            {hasSource && (
              <section className="space-y-2 lg:sticky lg:top-20 lg:self-start">
                <h3 className="text-sm font-semibold">Document original</h3>
                {isPdf ? (
                  <iframe
                    key={page}
                    title="Document original"
                    src={`/api/planning/imports/${imp.id}/source#page=${page}`}
                    className="h-[70vh] w-full rounded-lg border border-line"
                  />
                ) : (
                  <p className="rounded-lg border border-dashed p-3 text-xs text-neutral-600">
                    Ce format ne s’affiche pas dans le navigateur. Comparez avec le texte d’origine indiqué sur chaque ligne, ou{' '}
                    <a className="underline" href={`/api/planning/imports/${imp.id}/source`}>téléchargez l’original</a>.
                  </p>
                )}
                {isPdf && <a className="text-xs underline" href={`/api/planning/imports/${imp.id}/source`} target="_blank" rel="noreferrer">Ouvrir dans un nouvel onglet</a>}
              </section>
            )}

            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Plan extrait</h3>
                {editable && (
                  <div className="flex flex-wrap gap-2">
                    <button className="btn text-xs" disabled={busy} onClick={addRow}>+ Ajouter une action</button>
                    <button className="btn text-xs" disabled={busy || todoRows === 0} onClick={verifyAll}>Tout marquer vérifié</button>
                  </div>
                )}
              </div>
              {!ready && editable && rows.length > 0 && (
                <p className="text-xs text-neutral-500">Le plan peut être validé quand toutes les erreurs sont corrigées et toutes les lignes cochées « Vérifié ».</p>
              )}
              {shown.map((r) => (
                <RowCard key={r.id} importId={imp.id} row={r} editable={editable} hasPdf={isPdf && hasSource} onShowSource={setPage} onChanged={refresh} />
              ))}
              {rows.length > 0 && shown.length === 0 && <p className="text-sm text-neutral-500">Aucune ligne dans ce filtre.</p>}
            </section>
          </div>
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
      const res = await fetch('/api/planning/imports/upload', { method: 'POST', credentials: 'same-origin', body: form });
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
      <PageTitle title="Gestion du planning" subtitle="Importez un plan, comparez-le au document, corrigez, puis validez.">
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
        <p className="font-semibold">Comment ça marche</p>
        <ol className="list-decimal pl-5 text-xs text-neutral-600 space-y-0.5">
          <li><strong>Importer</strong> un plan (jour, semaine ou mois) : PDF (même scanné), PPTX, Word ou CSV.</li>
          <li><strong>Comparer</strong> chaque action extraite avec le document original, la page et le texte d’origine sont indiqués.</li>
          <li><strong>Corriger</strong> dates, heures, plateformes, légendes ; ajouter ou supprimer des actions ; cocher « Vérifié ».</li>
          <li><strong>Valider</strong> : les publications deviennent des brouillons, les commentaires, réponses, sponsoring, préparation et reporting deviennent des tâches du calendrier. Rien n’est publié automatiquement.</li>
        </ol>
        <p className="text-xs text-neutral-500">
          Un PPTX dont les diapositives ne sont que des images n’a pas de texte lisible : exportez-le en PDF.
          CSV : <code>date, label, platforms</code> + optionnel <code>action_type, time_of_day, phase, content, execution, objective, format, caption, caption_language, publish_mode, asset_ref</code>.
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
            <ImportCard key={imp.id} imp={imp} onRefresh={imports.reload} isApprover={isApprover} defaultOpen={imp.id === newId} />
          ))}
        </div>
      )}
    </div>
  );
}