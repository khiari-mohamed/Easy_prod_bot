'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, useFetch } from '@/lib/api';
import { fmtDateTime, fromInputValue, toInputValue } from '@/lib/format';
import { fmtMetric, isUnavailable, METRIC_KEYS, METRIC_LABEL, MetricKey, MetricSnap, UNAVAILABLE_TEXT } from '@/lib/metrics';
import type { Asset, Me, Post, PostFormat, PublishMode } from '@/lib/types';
import { ErrorNote, Loading, PageTitle, PlatformTag, StatusBadge, Toggle } from '@/components/ui';

const FORMATS: PostFormat[] = ['IMAGE', 'VIDEO', 'REEL', 'STORY', 'TEXT'];
type Variant = { caption: string; hashtags: string[]; reasoning?: string; warnings?: string[] };
type AiResponse = {
  source: string;
  variants: Variant[];
  fallbackReason?: string;
  context?: { planUsed: boolean; page: { name: string; postsAnalyzed: number } | null; note?: string };
};

export default function PostPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const post = useFetch<Post>(`/posts/${id}`);
  const assets = useFetch<Asset[]>('/assets');
  const me = useFetch<Me>('/auth/me');

  const [caption, setCaption] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [format, setFormat] = useState<PostFormat>('REEL');
  const [assetId, setAssetId] = useState('');
  const [when, setWhen] = useState('');
  const [publishMode, setPublishMode] = useState<PublishMode>('MANUAL');
  const [aiInfo, setAiInfo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [aiBrief, setAiBrief] = useState('');
  const [aiLang, setAiLang] = useState('');

  const p = post.data;
  useEffect(() => {
    if (!p) return;
    setCaption(p.caption);
    setHashtags(p.hashtags.join(' '));
    setFormat(p.format);
    setAssetId(p.assetId ?? '');
    setWhen(toInputValue(p.scheduledAt));
    setPublishMode(p.publishMode);
  }, [p]);

  if (post.loading) return <Loading />;
  if (!p) return <ErrorNote message={post.error} />;

  const isApprover = me.data?.role === 'ADMIN' || me.data?.role === 'APPROVER';
  const editable = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'FAILED', 'MANUAL_REQUIRED'].includes(p.status);
  const tags = () => hashtags.split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await post.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const post_ = (action: string, body?: unknown) => api(`/posts/${id}/${action}`, { method: 'POST', body });

  const save = () =>
    run(() =>
      api(`/posts/${id}`, {
        method: 'PATCH',
        body: { caption, hashtags: tags(), format, assetId: assetId || null, scheduledAt: fromInputValue(when), publishMode },
      }),
    );

  async function generate() {
    setBusy(true);
    setError(null);
    setAiInfo('');
    try {
      const r = await api<AiResponse>('/ai/captions', {
        method: 'POST',
        body: {
          platform: p!.platform,
          format,
          dayId: p!.day?.id,
          contentItemId: p!.contentItem?.id,
          brief: aiBrief || undefined,
          language: aiLang || undefined,
          variants: 3,
        },
      });
      setVariants(r.variants);
      if (r.source === 'gemini') {
        const c = r.context;
        setAiInfo(
          [
            c?.page ? `Données analysées : ${c.page.postsAnalyzed} publications de ${c.page.name}` : c?.note,
            c?.planUsed ? 'plan du jour utilisé' : null,
          ]
            .filter(Boolean)
            .join(' · '),
        );
      } else {
        setError(`Gemini indisponible (${r.fallbackReason ?? 'erreur inconnue'}) : légendes de secours, à réécrire.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function togglePublishMode() {
    const next: PublishMode = publishMode === 'AUTO' ? 'MANUAL' : 'AUTO';
    setPublishMode(next);
    await run(() => api(`/posts/${id}`, { method: 'PATCH', body: { publishMode: next } }));
  }

  const needsVideo = format === 'VIDEO' || format === 'REEL';
  const usable = (assets.data ?? []).filter((a) => (needsVideo ? a.kind === 'VIDEO' : format === 'IMAGE' ? a.kind === 'IMAGE' : true));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle title="Post">
        <PlatformTag platform={p.platform} />
        <StatusBadge status={p.status} />
      </PageTitle>
      {p.day && <p className="-mt-3 text-sm text-neutral-500">{p.day.label}</p>}
      <ErrorNote message={error} />
      {p.status === 'NEEDS_RECONCILIATION' && (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          <p className="font-semibold">Résultat inconnu : vérifiez la plateforme.</p>
          <p className="mt-0.5">Ouvrez la page {p.platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'} : si le post y est, marquez-le publié. Sinon, annulez-le et recréez-le. Aucune relance automatique n'est faite pour éviter un doublon.</p>
        </div>
      )}
      {p.statusNote && <div className="rounded-lg bg-neutral-100 px-3 py-2 text-sm">{p.statusNote}</div>}

      <div className="card space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label">Format</label>
            <select className="input" value={format} onChange={(e) => setFormat(e.target.value as PostFormat)} disabled={!editable}>
              {FORMATS.map((f) => <option key={f}>{f}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Publication (heure de Tunis)</label>
            <input type="datetime-local" className="input" value={when} onChange={(e) => setWhen(e.target.value)} disabled={!editable} />
          </div>
        </div>

        <div>
          <label className="label">Mode de publication</label>
          <div className="flex items-center gap-3">
            <Toggle label="Mode de publication automatique" checked={publishMode === 'AUTO'} onChange={togglePublishMode} disabled={!editable && !isApprover} />
            <span className="text-sm">
              {publishMode === 'AUTO'
                ? 'Auto-publication activée — le système publiera à l\'heure prévue'
                : 'Publication manuelle — vous serez notifié à l\'heure prévue'}
            </span>
          </div>
        </div>

        <div>
          <label className="label">Média</label>
          <select className="input" value={assetId} onChange={(e) => setAssetId(e.target.value)} disabled={!editable || format === 'TEXT'}>
            <option value="">— aucun —</option>
            {usable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.kind.toLowerCase()}){a.processingStatus === 'PENDING' ? ' ⏳ traitement…' : a.processingStatus === 'INVALID' ? ' ❌ invalide' : ''}
              </option>
            ))}
          </select>
          {p.asset && p.asset.processingStatus === 'PENDING' && (
            <p className="mt-1 text-xs text-amber-600">⏳ Ce média est en cours de traitement. Vous ne pourrez pas soumettre le post tant qu'il n'est pas prêt.</p>
          )}
          {p.asset && p.asset.processingStatus === 'INVALID' && (
            <p className="mt-1 text-xs text-red-600">❌ Ce média a été rejeté : {p.asset.processingNote ?? 'format ou dimensions non conformes'}. Téléversez un remplacement.</p>
          )}
          {p.asset && p.asset.kind === 'IMAGE' && p.asset.processingStatus === 'READY' && <img src={p.asset.url.replace(/^https?:\/\/[^/]+/, '')} alt="" className="mt-2 max-h-48 rounded" />}
          {p.asset && p.asset.kind === 'VIDEO' && p.asset.processingStatus === 'READY' && <video src={p.asset.url.replace(/^https?:\/\/[^/]+/, '')} controls className="mt-2 max-h-64 rounded" />}
          {(assets.data ?? []).length === 0 && <p className="mt-1 text-xs text-neutral-500">Aucun média : <Link className="underline" href="/assets">ajoutez-en</Link>.</p>}
        </div>

        <div>
          <label className="label">Légende ({caption.length})</label>
          <textarea className="input min-h-40 font-[inherit]" dir="auto" value={caption} onChange={(e) => setCaption(e.target.value)} disabled={!editable} />
        </div>
        <div>
          <label className="label">Hashtags (sans #, séparés par un espace)</label>
          <div className="flex gap-2">
            <input className="input flex-1" dir="auto" value={hashtags} onChange={(e) => setHashtags(e.target.value)} disabled={!editable} />
            {editable && (
              <button className="btn text-xs" disabled={busy} onClick={async () => {
                if (!caption.trim()) return;
                setBusy(true);
                try {
                  const r = await api<{ hashtags: string[]; source?: string; reason?: string }>('/ai/hashtags', {
                    method: 'POST',
                    body: { caption, platform: p.platform },
                  });
                  setHashtags(r.hashtags.join(' '));
                  if (r.source === 'fallback') setError(`Suggestion IA indisponible (${r.reason ?? 'erreur'}) : hashtags officiels uniquement.`);
                } catch (e) { setError((e as Error).message); }
                finally { setBusy(false); }
              }}>🏷 Suggérer</button>
            )}
          </div>
        </div>

        {editable && (
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={save}>Enregistrer</button>
            {p.status !== 'DRAFT' && <span className="self-center text-xs text-neutral-500">Enregistrer remet le post en brouillon (nouvelle validation).</span>}
          </div>
        )}
      </div>

      {editable && (
        <details className="card">
          <summary className="cursor-pointer font-semibold">Assistant légendes (IA)</summary>
          <div className="mt-3 space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="label">Langue</label>
                <select className="input" value={aiLang} onChange={(e) => setAiLang(e.target.value)}>
                  <option value="">Par défaut (Darija + Français)</option>
                  <option value="DARIJA_FRENCH">Darija + Français</option>
                  <option value="DARIJA">Darija</option>
                  <option value="FRENCH">Français</option>
                </select>
              </div>
              <div>
                <label className="label">Consigne (optionnel)</label>
                <input className="input" value={aiBrief} onChange={(e) => setAiBrief(e.target.value)} placeholder="ex. ton drôle, mentionner le compte à rebours" />
              </div>
            </div>
            <button className="btn" disabled={busy} onClick={generate}>Proposer 3 légendes</button>
            {aiInfo && <p className="text-xs text-neutral-500">{aiInfo}</p>}
            {variants.map((v, i) => (
              <div key={i} className="rounded-md border border-neutral-200 p-3 space-y-2">
                <p className="whitespace-pre-wrap text-sm" dir="auto">{v.caption}</p>
                <p className="text-xs text-neutral-500">{v.hashtags.map((h) => `#${h}`).join(' ')}</p>
                {v.reasoning && <p className="text-xs text-blue-600 italic">💡 {v.reasoning}</p>}
                {v.warnings?.map((w) => <p key={w} className="text-xs text-amber-700">⚠ {w}</p>)}
                <button className="btn mt-1" onClick={() => { setCaption(v.caption); setHashtags(v.hashtags.join(' ')); }}>Utiliser</button>
              </div>
            ))}
            <p className="text-xs text-neutral-500">Relisez toujours : l&apos;IA ne connaît que les faits de la fiche campagne. Les [PLACEHOLDERS] bloquent l&apos;envoi tant qu&apos;ils ne sont pas remplis.</p>
          </div>
        </details>
      )}

      <div className="card space-y-3">
        <h2 className="font-bold">Workflow</h2>
        <div className="flex flex-wrap gap-2">
          {p.status === 'DRAFT' && (
            <button className="btn btn-primary" disabled={busy} onClick={() => run(() => post_('submit'))}>Soumettre pour validation</button>
          )}
          {p.status === 'PENDING_APPROVAL' && isApprover && (
            <>
              <button className="btn btn-primary" disabled={busy} onClick={() => run(() => post_('approve'))}>Approuver et programmer</button>
              <button className="btn" disabled={busy} onClick={() => { const reason = window.prompt('Motif du refus :'); if (reason) run(() => post_('reject', { reason })); }}>Refuser</button>
            </>
          )}
          {p.status === 'PENDING_APPROVAL' && !isApprover && <span className="text-sm text-neutral-600">En attente d&apos;un validateur.</span>}
          {p.status === 'APPROVED' && isApprover && (
            <>
              <button className="btn btn-primary" disabled={busy} onClick={() => { if (window.confirm('Publier maintenant ?')) run(() => post_('publish-now', { confirm: true })); }}>Publier maintenant</button>
              <button className="btn" disabled={busy} onClick={() => run(() => post_('unschedule'))}>Retirer du planning</button>
            </>
          )}
          {['MANUAL_REQUIRED', 'FAILED'].includes(p.status) && isApprover && (
            <>
              <button className="btn" disabled={busy} onClick={() => { const url = window.prompt('Lien du post publié (optionnel) :') ?? undefined; run(() => post_('mark-published', { externalUrl: url || undefined })); }}>Marquer comme publié</button>
              <button className="btn" disabled={busy || !when} onClick={() => { if (p.status !== 'FAILED' || window.confirm('Vérifiez d’abord que le post n’existe pas déjà sur la plateforme. Replanifier ?')) run(() => post_('reschedule', { scheduledAt: fromInputValue(when) })); }}>Replanifier à l&apos;heure choisie</button>
            </>
          )}
          {p.status === 'NEEDS_RECONCILIATION' && isApprover && (
            <button className="btn btn-primary" disabled={busy} onClick={() => { const url = window.prompt('Le post existe sur la plateforme. Lien du post (optionnel) :') ?? undefined; run(() => post_('mark-published', { externalUrl: url || undefined })); }}>Le post est en ligne : marquer publié</button>
          )}
          {isApprover && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'FAILED', 'MANUAL_REQUIRED', 'NEEDS_RECONCILIATION'].includes(p.status) && (
            <button className="btn" disabled={busy} onClick={() => { if (window.confirm('Annuler ce post ?')) run(() => post_('cancel')); }}>Annuler le post</button>
          )}
          {['DRAFT', 'CANCELLED'].includes(p.status) && (
            <button className="btn" disabled={busy} onClick={async () => { if (window.confirm('Supprimer définitivement ?')) { await run(() => api(`/posts/${id}`, { method: 'DELETE' })); router.push('/calendar'); } }}>Supprimer</button>
          )}
        </div>

        {p.status === 'MANUAL_REQUIRED' && (
          <div className="rounded-md bg-orange-50 p-3 text-sm space-y-2">
            <p className="font-semibold">À publier à la main sur {p.platform.toLowerCase()} :</p>
            <div className="flex flex-wrap gap-2">
              <button className="btn" onClick={() => navigator.clipboard.writeText(`${p.caption}\n\n${p.hashtags.map((h) => `#${h}`).join(' ')}`)}>Copier la légende</button>
              {p.asset && <a className="btn" href={p.asset.url.replace(/^https?:\/\/[^/]+/, '')} download>Télécharger le média</a>}
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => {
                  const url = window.prompt('Lien du post publié (optionnel) :') ?? undefined;
                  run(() => post_('confirm-manual', { externalUrl: url || undefined }));
                }}
              >
                ✅ Marquer comme publié manuellement
              </button>
            </div>
          </div>
        )}
        {p.externalUrl && <a className="text-sm underline" href={p.externalUrl} target="_blank" rel="noreferrer">Voir le post publié ↗</a>}
        {p.publishedAt && <p className="text-xs text-neutral-500">Publié : {fmtDateTime(p.publishedAt)}</p>}
      </div>

      {p.status === 'PUBLISHED' && <MetricsCard post={p} onSaved={post.reload} />}

      {p.attempts && p.attempts.length > 0 && (
        <div className="card">
          <h2 className="mb-2 font-bold">Tentatives de publication</h2>
          <ul className="space-y-1 text-sm">
            {p.attempts.map((a) => (
              <li key={a.id}>{fmtDateTime(a.startedAt)} — {a.ok ? '✅ réussi' : `❌ ${a.error ?? 'échec'}`}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MetricsCard({ post, onSaved }: { post: Post; onSaved: () => void }) {
  const m = post.metrics[0] as unknown as MetricSnap | undefined;
  // Empty field = "unavailable" (not sent). Only typed numbers are saved as real values.
  const [form, setForm] = useState<Record<MetricKey, string>>({ views: '', reach: '', likes: '', comments: '', shares: '', saves: '' });
  const [error, setError] = useState<string | null>(null);
  const hasInput = METRIC_KEYS.some((k) => form[k].trim() !== '');

  async function save() {
    setError(null);
    try {
      const body: Partial<Record<MetricKey, number>> = {};
      for (const k of METRIC_KEYS) if (form[k].trim() !== '') body[k] = Number(form[k]);
      await api(`/posts/${post.id}/metrics`, { method: 'POST', body });
      setForm({ views: '', reach: '', likes: '', comments: '', shares: '', saves: '' });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="card space-y-3">
      <h2 className="font-bold">Résultats</h2>
      {m ? (
        <div className="text-sm">
          <p>
            {METRIC_KEYS.map((k, i) => (
              <span key={k}>
                {i > 0 && ' · '}
                {METRIC_LABEL[k]}{' '}
                {isUnavailable(m, k) ? (
                  <span className="text-neutral-400" title={UNAVAILABLE_TEXT}>—</span>
                ) : (
                  fmtMetric(m[k])
                )}
              </span>
            ))}
          </p>
          <span className="block text-xs text-neutral-500">
            {m.source} — {fmtDateTime(m.capturedAt)} · « — » = indisponible (pas un zéro)
          </span>
        </div>
      ) : (
        <p className="text-sm text-neutral-500">Pas encore de chiffres.</p>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-semibold">Saisir les chiffres à la main (ex. TikTok)</summary>
        <p className="mt-1 text-xs text-neutral-500">Laissez vide ce que vous ne connaissez pas : ce sera « indisponible », pas 0.</p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {METRIC_KEYS.map((k) => (
            <div key={k}>
              <label className="label">{METRIC_LABEL[k]}</label>
              <input
                type="number"
                min={0}
                step={1}
                className="input"
                placeholder="—"
                value={form[k]}
                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
              />
            </div>
          ))}
        </div>
        <ErrorNote message={error} />
        <button className="btn mt-2" disabled={!hasInput} onClick={save}>Enregistrer les chiffres</button>
      </details>
    </div>
  );
}