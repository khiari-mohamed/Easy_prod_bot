'use client';

import { useRef, useState } from 'react';
import { api, RESUMABLE_THRESHOLD, upload, uploadResumable, useFetch } from '@/lib/api';
import type { Asset, Me } from '@/lib/types';
import { ErrorNote, Loading, PageTitle } from '@/components/ui';

const localUrl = (url: string) => url.replace(/^https?:\/\/[^/]+(?=\/media\/)/, '');
const mb = (n: number | null | string) => {
  const bytes = typeof n === 'string' ? parseInt(n, 10) : n;
  return bytes ? `${(bytes / 1024 / 1024).toFixed(1)} Mo` : '';
};
const fmtDim = (a: Asset) =>
  a.widthPx && a.heightPx ? `${a.widthPx}×${a.heightPx}` : '';
const fmtDur = (a: Asset) =>
  a.durationSecs ? `${Math.floor(a.durationSecs)}s` : '';

const STATUS_BADGE: Record<string, string> = {
  READY: 'bg-green-100 text-green-800',
  PENDING: 'bg-amber-100 text-amber-800',
  INVALID: 'bg-red-100 text-red-800',
  UPLOADING: 'bg-blue-100 text-blue-800',
  PROCESSING: 'bg-purple-100 text-purple-800',
};
const STATUS_LABEL: Record<string, string> = {
  READY: 'Prêt',
  PENDING: 'En attente',
  INVALID: 'Invalide',
  UPLOADING: 'Envoi…',
  PROCESSING: 'Traitement…',
};

function PlatformReadyBadges({ ready }: { ready: Asset['platformReady'] }) {
  if (!ready) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {Object.entries(ready).map(([key, val]) => (
        <span
          key={key}
          title={val.reason}
          className={`rounded px-1 py-0.5 text-[10px] font-medium ${val.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}
        >
          {key.replace('_', ' ')} {val.ok ? '✓' : '✗'}
        </span>
      ))}
    </div>
  );
}

export default function AssetsPage() {
  const assets = useFetch<Asset[]>('/assets');
  const me = useFetch<Me>('/auth/me');
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterKind, setFilterKind] = useState<'ALL' | 'IMAGE' | 'VIDEO'>('ALL');

  // Import-URL form (Drive / Dropbox)
  const [importUrl, setImportUrl] = useState('');
  const [importName, setImportName] = useState('');
  const [importBusy, setImportBusy] = useState(false);

  const isApprover = me.data?.role === 'ADMIN' || me.data?.role === 'APPROVER';

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      const list = Array.from(files);
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const label = `${i + 1}/${list.length} · ${f.name}`;
        setProgress(label);
        if (f.size > RESUMABLE_THRESHOLD) {
          await uploadResumable(f, (pct) => setProgress(`${label} · ${pct}%`));
        } else {
          await upload('/assets/upload', f);
        }
      }
      assets.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function importFromUrl() {
    if (!importUrl || !importName) return;
    setImportBusy(true);
    setError(null);
    try {
      await api('/assets/import-url', { method: 'POST', body: { url: importUrl, name: importName } });
      setImportUrl('');
      setImportName('');
      assets.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImportBusy(false);
    }
  }

  async function reprocess(id: string) {
    setError(null);
    try {
      await api(`/assets/${id}/reprocess`, { method: 'POST' });
      assets.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Supprimer ce média ?')) return;
    setError(null);
    try {
      await api(`/assets/${id}`, { method: 'DELETE' });
      assets.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const filtered = (assets.data ?? []).filter(
    (a) => filterKind === 'ALL' || a.kind === filterKind,
  );

  return (
    <div className="space-y-4">
      <PageTitle title="Médiathèque">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"
          hidden
          onChange={(e) => onFiles(e.target.files)}
        />
        <button className="btn btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Envoi…' : '+ Téléverser'}
        </button>
      </PageTitle>

      <ErrorNote message={error ?? assets.error} />

      {progress && <p className="text-sm text-blue-700">Envoi : {progress}</p>}

      <p className="text-xs text-neutral-500">
        JPEG, PNG, WebP, MP4, MOV · les gros fichiers (&gt; 50 Mo) sont envoyés par morceaux avec reprise automatique · le type réel du fichier est vérifié · Les vidéos sont analysées automatiquement (ffprobe) pour vérifier la compatibilité Instagram/Facebook.
      </p>

      {/* Filters */}
      <div className="flex gap-2">
        {(['ALL', 'IMAGE', 'VIDEO'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setFilterKind(k)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${filterKind === k ? 'bg-ink text-white' : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'}`}
          >
            {k === 'ALL' ? 'Tous' : k === 'IMAGE' ? 'Images' : 'Vidéos'}
          </button>
        ))}
        <span className="ml-auto self-center text-xs text-neutral-400">{filtered.length} fichier{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {assets.loading ? (
        <Loading />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {filtered.map((a) => (
            <div key={a.id} className="card space-y-2 p-2">
              {a.kind === 'IMAGE' ? (
                <img src={localUrl(a.url)} alt={a.name} className="h-32 w-full rounded object-cover" />
              ) : (
                <video src={localUrl(a.url)} className="h-32 w-full rounded bg-black object-cover" preload="metadata" />
              )}

              <div className="truncate text-xs font-medium" title={a.name}>{a.name}</div>

              <div className="flex flex-wrap items-center justify-between gap-1 text-xs text-neutral-500">
                <span>{a.kind.toLowerCase()} {mb(a.sizeBytesBig ?? a.sizeBytes)}</span>
                <span className={`rounded-full px-1.5 py-0.5 text-xs font-semibold ${STATUS_BADGE[a.processingStatus] ?? ''}`}>
                  {STATUS_LABEL[a.processingStatus] ?? a.processingStatus}
                </span>
              </div>

              {(fmtDim(a) || fmtDur(a)) && (
                <p className="text-xs text-neutral-400">{[fmtDim(a), fmtDur(a)].filter(Boolean).join(' · ')}</p>
              )}

              <PlatformReadyBadges ready={a.platformReady} />

              {a.processingNote && <p className="text-xs text-amber-700">{a.processingNote}</p>}

              <div className="flex flex-wrap gap-1">
                {isApprover && (
                  <button className="btn text-xs" onClick={() => reprocess(a.id)}>Retraiter</button>
                )}
                <a href={localUrl(a.url)} download className="btn text-xs">↓</a>
                {isApprover && (
                  <button className="text-xs text-red-600 underline hover:text-red-800" onClick={() => remove(a.id)}>Suppr.</button>
                )}
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="col-span-full text-sm text-neutral-500">Aucun média{filterKind !== 'ALL' ? ` de type ${filterKind.toLowerCase()}` : ''}.</p>
          )}
        </div>
      )}

      {/* Import from Drive / Dropbox */}
      <details className="card">
        <summary className="cursor-pointer font-semibold">Importer depuis Google Drive ou Dropbox</summary>
        <div className="mt-3 space-y-2">
          <p className="text-xs text-neutral-500">
            Collez un lien de téléchargement direct. Pour Google Drive : <code>drive.google.com/uc?export=download&id=…</code>. Pour Dropbox : remplacez <code>dl=0</code> par <code>dl=1</code>.
          </p>
          <div className="grid gap-2 md:grid-cols-3">
            <input
              className="input md:col-span-2"
              placeholder="https://drive.google.com/uc?export=download&id=…"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
            />
            <input
              className="input"
              placeholder="Nom du fichier"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
            />
          </div>
          <button
            className="btn btn-primary"
            disabled={importBusy || !importUrl || !importName}
            onClick={importFromUrl}
          >
            {importBusy ? 'Import en cours…' : 'Importer'}
          </button>
        </div>
      </details>
    </div>
  );
}
