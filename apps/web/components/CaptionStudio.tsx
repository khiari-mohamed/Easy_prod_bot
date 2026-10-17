'use client';

import { useEffect, useState } from 'react';
import { ApiError, api, useFetch } from '@/lib/api';
import { EP } from '@/lib/endpoints';
import type {
  CaptionLanguage,
  CaptionSuggestion,
  EffectiveMap,
  GenerateCaptionsResult,
  HashtagRecommendation,
  Platform,
  PostStatus,
  SuggestionStatus,
  TrendSignal,
} from '@/lib/types';
import { EmptyState, ErrorNote, Loading, PlatformTag } from '@/components/ui';

const PLATFORMS: Platform[] = ['INSTAGRAM', 'FACEBOOK', 'TIKTOK'];
const LANGS: { value: CaptionLanguage; label: string }[] = [
  { value: 'DARIJA_FRENCH', label: 'Darija + Français' },
  { value: 'DARIJA', label: 'Darija' },
  { value: 'FRENCH', label: 'Français' },
];
const LANG_LABEL = Object.fromEntries(LANGS.map((l) => [l.value, l.label])) as Record<CaptionLanguage, string>;
const TONES = [
  { value: 'energetic', label: 'Énergique' },
  { value: 'emotional', label: 'Émotionnelle' },
  { value: 'concise', label: 'Concise' },
];
// Same limits as the server (caption-rules.ts).
const CHAR_LIMIT: Record<Platform, number> = { INSTAGRAM: 2200, FACEBOOK: 5000, TIKTOK: 2200 };
const TAG_LIMIT = 30;
const TAG_HINT: Record<Platform, string> = { INSTAGRAM: '4 à 8', FACEBOOK: '2 à 5', TIKTOK: '3 à 5' };

const STATUS_UI: Record<SuggestionStatus, { label: string; chip: string }> = {
  GENERATED: { label: 'Généré', chip: 'bg-neutral-100 text-neutral-700' },
  NEEDS_REVIEW: { label: 'À valider', chip: 'bg-amber-50 text-amber-800' },
  APPROVED: { label: 'Approuvé', chip: 'bg-emerald-50 text-emerald-800' },
  REJECTED: { label: 'Refusé', chip: 'bg-red-50 text-red-800' },
  SUPERSEDED: { label: 'Remplacé', chip: 'bg-neutral-100 text-neutral-400' },
};
const ORIGIN_LABEL: Record<string, string> = { AI_GENERATED: 'IA', TREND_SOURCE: 'tendance', IMPORTED: 'importé' };
const SIGNALS: [string, string][] = [
  ['ai.hashtags', 'Hashtags IA'],
  ['ai.learning', 'Apprentissage'],
  ['ai.performance_ranking', 'Performance'],
  ['ai.trends', 'Tendances'],
];

const norm = (t: string) => t.trim().replace(/^#+/, '').replace(/\s+/g, '');
const pct = (n: number) => Math.round(n * 100);
const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t.toLowerCase() === b[i].toLowerCase());
const fmt = (iso: string) => new Date(iso).toLocaleString('fr-TN', { timeZone: 'Africa/Tunis', dateStyle: 'short', timeStyle: 'short' });

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const listOf = (data: unknown): Raw[] => {
  const l = Array.isArray(data) ? data : (data as { items?: unknown } | null)?.items;
  return Array.isArray(l) ? (l as Raw[]) : [];
};
function toReco(r: Raw): HashtagRecommendation | null {
  const tag = norm(str(r.tag));
  if (!tag) return null;
  const b = (r.breakdown ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    key: str(r.id) || tag.toLowerCase(),
    tag,
    score: Math.max(0, Math.min(100, Math.round((typeof r.score === 'number' ? r.score : 0) * 100))),
    reasons: Array.isArray(r.reasons) ? (r.reasons as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    origin: str(r.origin) || null,
    official: r.official === true,
    parts: { relevance: n(b.relevance) ?? 0, performance: n(b.performance), feedback: n(b.feedback), trend: n(b.trend) },
  };
}
function toTrend(r: Raw): TrendSignal | null {
  const label = str(r.tag) || str(r.rawTag);
  if (!label) return null;
  const id = str(r.id) || null;
  return {
    key: id ?? label,
    id,
    label,
    source: str(r.source),
    region: str(r.region) || null,
    observedAt: str(r.observedAt) || null,
    expiresAt: str(r.expiresAt) || null,
    sourceNote: str(r.sourceNote) || null,
  };
}

interface PostRef {
  id: string;
  platform: Platform;
  status: PostStatus;
}

function SuggestionCard({
  s,
  library,
  posts,
  canApprove,
  canApplyContent,
  locked,
  onChanged,
  onApplied,
}: {
  s: CaptionSuggestion;
  library: HashtagRecommendation[];
  posts: PostRef[];
  canApprove: boolean;
  canApplyContent: boolean;
  locked: boolean;
  onChanged: () => void;
  onApplied: () => void;
}) {
  const current = s.effectiveText;
  const currentTags = s.hashtags.map((h) => norm(h.tag));
  const tagInfo = new Map(s.hashtags.map((h) => [norm(h.tag).toLowerCase(), h]));

  const [text, setText] = useState(current);
  const [tags, setTags] = useState<string[]>(currentTags);
  const [newTag, setNewTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [rejectTags, setRejectTags] = useState(false);
  const [rated, setRated] = useState<number | null>(null);

  // The server is the truth: reset the form whenever the suggestion changes revision or status.
  const key = `${s.id}:${s.revision}:${s.status}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setText(current); setTags(currentTags); setRejecting(false); }, [key]);

  const approved = s.status === 'APPROVED' && s.approvalCurrent;
  const readOnly = s.status === 'REJECTED' || s.status === 'SUPERSEDED';
  const frozen = readOnly || locked;
  const dirty = text !== current || !sameTags(tags, currentTags);
  const ui = STATUS_UI[s.status];
  const limit = CHAR_LIMIT[s.platform];
  const overLimit = text.length > limit;
  const overTags = tags.length > TAG_LIMIT;
  const reviewable = s.status === 'GENERATED' || s.status === 'NEEDS_REVIEW';
  const approver = s.reviews.find((r) => r.decision === 'APPROVED')?.reviewer?.name;
  const exact = s.metadata?.planCaptionExact === true;

  const targets = [
    ...(canApplyContent && s.contentItemId ? [{ value: 'CONTENT', label: 'Brouillon du contenu' }] : []),
    ...posts.filter((p) => p.platform === s.platform && p.status !== 'CANCELLED').map((p) => ({ value: `POST:${p.id}`, label: `Post ${p.platform} (${p.status})` })),
  ];
  const [target, setTarget] = useState(targets[0]?.value ?? '');
  const chosen = targets.find((t) => t.value === target)?.value ?? targets[0]?.value ?? '';

  async function call(fn: () => Promise<unknown>, after: () => void = onChanged) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function addTag(raw: string) {
    const t = norm(raw);
    if (!t || tags.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    setTags([...tags, t]);
    setNewTag('');
  }

  const save = () => call(() => api(EP.captions.one(s.id), { method: 'PATCH', body: { text, hashtags: tags, revision: s.revision } }));

  const approve = () =>
    call(async () => {
      try {
        await api(EP.captions.approve(s.id), { method: 'POST', body: { revision: s.revision } });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.body.code === 'WARNINGS_NOT_ACKNOWLEDGED') {
          const w = Array.isArray(e.body.warnings) ? (e.body.warnings as string[]) : [];
          if (!window.confirm(`Avertissements à confirmer :\n\n- ${w.join('\n- ')}\n\nApprouver malgré tout ?`)) return;
          await api(EP.captions.approve(s.id), { method: 'POST', body: { revision: s.revision, acknowledgeWarnings: true } });
        } else throw e;
      }
    });

  const reject = () =>
    call(() =>
      api(EP.captions.reject(s.id), {
        method: 'POST',
        body: { feedback: rejectNote.trim() || undefined, rejectHashtags: rejectTags },
      }),
    );

  const rate = (rating: number) =>
    call(async () => {
      await api(EP.captions.feedback(s.id), { method: 'POST', body: { rating } });
      setRated(rating);
    }, () => undefined);

  const apply = () => {
    if (!chosen) return;
    const isPost = chosen !== 'CONTENT';
    if (isPost && !window.confirm('Ce post repassera en brouillon et devra être ré-approuvé avant publication. Continuer ?')) return;
    const base = isPost ? { target: 'POST', postId: chosen.slice(5), revision: s.revision } : { target: 'CONTENT', revision: s.revision };
    return call(async () => {
      try {
        await api(EP.captions.apply(s.id), { method: 'POST', body: base });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.body.code === 'OVERWRITE_REQUIRED') {
          const cur = String(e.body.current ?? '').slice(0, 240);
          if (!window.confirm(`${e.message}\n\nTexte actuel :\n${cur}\n\nLe remplacer ?`)) return;
          await api(EP.captions.apply(s.id), { method: 'POST', body: { ...base, confirmOverwrite: true } });
        } else throw e;
      }
    }, onApplied);
  };

  return (
    <div className={`rounded-lg border p-3 ${approved ? 'border-emerald-300 bg-emerald-50/30' : 'border-line bg-white'} ${readOnly ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <PlatformTag platform={s.platform} />
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">{LANG_LABEL[s.language]}</span>
        {s.tone && <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold capitalize text-indigo-800">{s.tone}</span>}
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ui.chip}`}>{ui.label}</span>
        <span className="text-xs text-neutral-400">révision {s.revision}</span>
        <span className="ml-auto text-xs text-neutral-400">{fmt(s.createdAt)}</span>
      </div>

      {s.missingInfo.length > 0 && (
        <p className="mt-2 rounded-md bg-red-50 p-2 text-xs font-semibold text-red-800">
          Informations manquantes, à compléter par un humain : {s.missingInfo.join(', ')}
        </p>
      )}
      {s.warnings.length > 0 && (
        <ul className="mt-2 space-y-0.5 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
          {s.warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
        </ul>
      )}

      {s.planOriginal && (
        <div className="mt-2 rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-2 text-xs">
          <p className="font-semibold text-neutral-500">
            {exact ? 'Légende exacte du planning (jamais remplacée automatiquement)' : 'Légende de départ'}
          </p>
          <p className="mt-0.5 whitespace-pre-wrap text-neutral-700" dir="auto">{s.planOriginal}</p>
          {!frozen && (
            <button type="button" className="mt-1 underline underline-offset-2" onClick={() => setText(s.planOriginal ?? '')}>
              Utiliser cette légende
            </button>
          )}
        </div>
      )}

      <label className="mt-2 block text-xs font-semibold text-neutral-600">
        Légende ({text.length}/{limit})
        <textarea
          className="input mt-1 min-h-28 font-[inherit] font-normal"
          dir="auto"
          value={text}
          disabled={frozen || busy}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {overLimit && <p className="text-xs font-semibold text-red-600">Trop long pour {s.platform} ({limit} caractères maximum).</p>}

      <div className="mt-2">
        <p className="text-xs font-semibold text-neutral-600">
          Hashtags ({tags.length}/{TAG_LIMIT}) <span className="font-normal text-neutral-400">· recommandé {TAG_HINT[s.platform]}</span>
        </p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {tags.map((t) => {
            const info = tagInfo.get(t.toLowerCase());
            const origin = info ? ORIGIN_LABEL[info.origin] : 'ajouté';
            return (
              <span key={t} title={info?.reason ?? ''} className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-2 py-0.5 text-xs" dir="auto">
                #{t}
                {origin && <span className="text-[10px] uppercase text-neutral-400">{origin}</span>}
                {!frozen && (
                  <button type="button" aria-label={`Retirer #${t}`} className="text-neutral-400 hover:text-red-600" disabled={busy} onClick={() => setTags(tags.filter((x) => x !== t))}>
                    ×
                  </button>
                )}
              </span>
            );
          })}
          {tags.length === 0 && <span className="text-xs text-neutral-400">Aucun hashtag.</span>}
        </div>
        {overTags && <p className="mt-1 text-xs font-semibold text-red-600">{TAG_LIMIT} hashtags maximum.</p>}
        {!frozen && (
          <div className="mt-2 flex gap-2">
            <input
              className="input flex-1 text-xs"
              dir="auto"
              list={`lib-${s.id}`}
              maxLength={80}
              placeholder="Ajouter un hashtag (bibliothèque ou nouveau)"
              value={newTag}
              disabled={busy}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(newTag); } }}
            />
            <datalist id={`lib-${s.id}`}>{library.map((h) => <option key={h.key} value={h.tag} />)}</datalist>
            <button type="button" className="btn text-xs" disabled={busy || !norm(newTag)} onClick={() => addTag(newTag)}>Ajouter</button>
          </div>
        )}
        {s.removedHashtags.length > 0 && (
          <p className="mt-1 text-[11px] text-neutral-400">Retirés : {s.removedHashtags.join(', ')}</p>
        )}
      </div>

      {approved && (
        <p className="mt-2 text-xs text-emerald-800">
          Approuvé{approver ? ` par ${approver}` : ''}{s.approvedAt ? ` le ${fmt(s.approvedAt)}` : ''} (révision {s.approvedRevision}).
          {s.appliedAt ? ` Appliqué le ${fmt(s.appliedAt)}.` : ''}
        </p>
      )}
      {approved && dirty && (
        <p className="mt-2 text-xs font-semibold text-amber-700">Enregistrer ces modifications invalidera l’approbation : il faudra approuver à nouveau.</p>
      )}

      {!frozen && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="btn text-xs" disabled={busy || !dirty || overLimit || overTags} onClick={save}>Enregistrer les modifications</button>
          {canApprove && reviewable && (
            <button className="btn btn-primary text-xs" disabled={busy || dirty || overLimit || overTags} onClick={approve} title={dirty ? 'Enregistrez d’abord vos modifications' : ''}>
              Approuver
            </button>
          )}
          <button className="btn text-xs text-red-600" disabled={busy} onClick={() => setRejecting((v) => !v)}>Refuser</button>
          {approved && !dirty && targets.length > 0 && (
            <>
              <select className="input w-auto text-xs" value={chosen} onChange={(e) => setTarget(e.target.value)} aria-label="Cible d’application">
                {targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <button className="btn btn-primary text-xs" disabled={busy} onClick={apply}>Appliquer</button>
            </>
          )}
        </div>
      )}

      {rejecting && !frozen && (
        <div className="mt-2 space-y-2 rounded-md bg-red-50 p-2">
          <textarea className="input min-h-16 text-xs" dir="auto" maxLength={500} placeholder="Pourquoi refuser ? (aide l’IA à s’améliorer)" value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={rejectTags} onChange={(e) => setRejectTags(e.target.checked)} />
            Rejeter aussi ses hashtags (sinon ils restent utilisables)
          </label>
          <div className="flex gap-2">
            <button className="btn text-xs text-red-700" disabled={busy} onClick={reject}>Confirmer le refus</button>
            <button className="btn text-xs" disabled={busy} onClick={() => setRejecting(false)}>Annuler</button>
          </div>
        </div>
      )}

      {s.status !== 'SUPERSEDED' && !locked && (
        <div className="mt-2 flex items-center gap-1 text-xs text-neutral-500">
          <span>Qualité :</span>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`Note ${n} sur 5`}
              disabled={busy}
              onClick={() => rate(n)}
              className={`h-6 w-6 rounded-full border text-[11px] ${rated === n ? 'border-amber-500 bg-amber-100 font-bold' : 'border-line hover:bg-neutral-50'}`}
            >
              {n}
            </button>
          ))}
          {rated && <span className="text-emerald-700">enregistrée</span>}
        </div>
      )}
      <ErrorNote message={error} />
    </div>
  );
}

export function CaptionStudio({
  contentItemId,
  planEntryId,
  campaignId,
  defaultLanguage,
  canApprove,
  canApply,
  posts,
  onApplied,
}: {
  contentItemId: string;
  planEntryId?: string | null;
  campaignId?: string | null;
  defaultLanguage: CaptionLanguage;
  canApprove: boolean;
  /** False when the content item is pending/approved: the CONTENT target is then unavailable. */
  canApply: boolean;
  posts: PostRef[];
  onApplied: () => void;
}) {
  const [platform, setPlatform] = useState<Platform>('INSTAGRAM');
  const [language, setLanguage] = useState<CaptionLanguage>(defaultLanguage);
  const [script, setScript] = useState<'AUTO' | 'ARABIC' | 'LATIN'>('AUTO');
  const [tones, setTones] = useState<string[]>(TONES.map((t) => t.value));
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [libTag, setLibTag] = useState('');
  const [tTag, setTTag] = useState('');
  const [tNote, setTNote] = useState('');
  const [tRegion, setTRegion] = useState('TN');
  const [tTtl, setTTtl] = useState('');

  const effective = useFetch<EffectiveMap>(
    EP.features.effectiveFor(new URLSearchParams({ platform, ...(campaignId ? { campaignId } : {}) }).toString()),
  );
  const aiOff = effective.data?.['ai.captions']?.mode === 'OFF';
  const aiReason = effective.data?.['ai.captions']?.restrictions[0]?.detail ?? 'La génération IA est désactivée par l’administrateur.';
  const trendsOff = effective.data?.['ai.trends']?.mode === 'OFF';

  const list = useFetch<CaptionSuggestion[]>(EP.captions.list(new URLSearchParams({ contentItemId, platform }).toString()));
  const recos = useFetch<unknown>(
    EP.hashtags.recommendations(new URLSearchParams({ platform, language, contentItemId }).toString()),
  );
  const trends = useFetch<unknown>(trendsOff ? null : EP.trends(new URLSearchParams({ platform }).toString()));

  const all = list.data ?? [];
  const live = all.filter((s) => s.status !== 'REJECTED' && s.status !== 'SUPERSEDED');
  const visible = showArchived ? all : live;
    const library = listOf(recos.data).map(toReco).filter((x): x is HashtagRecommendation => x !== null);
  const recoSignals = (recos.data as { signals?: Record<string, boolean> } | null)?.signals ?? null;
    const trendList = listOf(trends.data).map(toTrend).filter((x): x is TrendSignal => x !== null);
  const trendsDisabled = (trends.data as { enabled?: boolean } | null)?.enabled === false;

  async function generate() {
    setBusy(true);
    setError(null);
    setNotes([]);
    try {
      const r = await api<GenerateCaptionsResult>(EP.captions.generate, {
        method: 'POST',
        body: {
          contentItemId,
          planEntryId: planEntryId ?? undefined,
          platforms: [platform],
          language,
          script: language === 'FRENCH' ? undefined : script,
          tones,
        },
      });
      setNotes(r.notes ?? []);
      await Promise.all([list.reload(), recos.reload()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

    async function addToLibrary() {
    const tag = norm(libTag);
    if (!tag) return;
    setBusy(true);
    setError(null);
    try {
      await api(EP.hashtags.create, { method: 'POST', body: { tags: [tag], language } });
      setLibTag('');
      await recos.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addTrend() {
    const tag = norm(tTag);
    if (!tag || tNote.trim().length < 5) return;
    const ttl = tTtl.trim() ? Number(tTtl) : undefined;
    setBusy(true);
    setError(null);
    try {
      await api(EP.trendAdd, {
        method: 'POST',
        body: {
          platform,
          tag,
          region: tRegion.trim() ? tRegion.trim().toUpperCase() : undefined,
          ttlHours: ttl && Number.isInteger(ttl) && ttl > 0 ? ttl : undefined,
          sourceNote: tNote.trim(),
        },
      });
      setTTag('');
      setTNote('');
      setTTtl('');
      await Promise.all([trends.reload(), recos.reload()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeTrend(id: string) {
    if (!window.confirm('Supprimer cette tendance ?')) return;
    setBusy(true);
    setError(null);
    try {
      await api(EP.trendOne(id), { method: 'DELETE' });
      await Promise.all([trends.reload(), recos.reload()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const toggleTone = (v: string) => setTones((t) => (t.includes(v) ? t.filter((x) => x !== v) : [...t, v]));

  return (
    <div className="card space-y-3">
      <div>
        <h2 className="font-bold">Caption Studio</h2>
        <p className="text-xs text-neutral-500">
          Propositions IA par plateforme. Rien n’est utilisé avant l’approbation d’un validateur ; seules les propositions approuvées nourrissent les suggestions futures.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs font-semibold">Plateforme
          <select className="input mt-1 font-normal" value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
            {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold">Langue
          <select className="input mt-1 font-normal" value={language} onChange={(e) => setLanguage(e.target.value as CaptionLanguage)}>
            {LANGS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold">Écriture du Darija
          <select className="input mt-1 font-normal" value={script} disabled={language === 'FRENCH'} onChange={(e) => setScript(e.target.value as typeof script)}>
            <option value="AUTO">Automatique</option>
            <option value="ARABIC">Arabe</option>
            <option value="LATIN">Latin (arabizi)</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="font-semibold">Tons</span>
        {TONES.map((t) => (
          <label key={t.value} className="flex items-center gap-1">
            <input type="checkbox" checked={tones.includes(t.value)} onChange={() => toggleTone(t.value)} />
            {t.label}
          </label>
        ))}
        <button className="btn btn-primary ml-auto" disabled={busy || aiOff || tones.length === 0} title={aiOff ? aiReason : ''} onClick={generate}>
          {busy ? 'Génération…' : live.length > 0 ? 'Régénérer' : `Générer ${tones.length} variante${tones.length > 1 ? 's' : ''}`}
        </button>
      </div>

      {effective.data && (
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {SIGNALS.map(([k, label]) => {
            const e = effective.data?.[k];
            const on = !!e && e.mode !== 'OFF';
            return (
              <span key={k} title={e?.restrictions[0]?.detail ?? ''} className={`rounded-full px-2 py-0.5 font-semibold ${on ? 'bg-emerald-50 text-emerald-800' : 'bg-neutral-100 text-neutral-500'}`}>
                {label} : {on ? 'actif' : 'désactivé'}
              </span>
            );
          })}
        </div>
      )}

      {aiOff && (
        <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
          ⚠ {aiReason} Consultation seule : modification, approbation et application sont aussi bloquées tant que cette fonction est désactivée.
        </p>
      )}
      <ErrorNote message={error ?? list.error} />
      {notes.length > 0 && (
        <ul className="rounded-md bg-sky-50 p-2 text-xs text-sky-900">{notes.map((n, i) => <li key={i}>ℹ {n}</li>)}</ul>
      )}

      {list.loading ? (
        <Loading />
      ) : visible.length === 0 ? (
        <EmptyState title="Aucune proposition pour cette plateforme" hint="Lancez la génération : une variante par ton choisi sera proposée, jamais publiée sans validation." />
      ) : (
        <div className="space-y-3">
          {visible.map((s) => (
            <SuggestionCard
              key={s.id}
              s={s}
              library={library}
              posts={posts}
              canApprove={canApprove}
              canApplyContent={canApply}
              locked={aiOff}
              onChanged={() => { list.reload(); recos.reload(); }}
              onApplied={() => { list.reload(); onApplied(); }}
            />
          ))}
        </div>
      )}
      {all.length > live.length && (
        <button type="button" className="text-xs underline underline-offset-2" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? 'Masquer' : 'Afficher'} les {all.length - live.length} proposition(s) refusée(s) ou remplacée(s)
        </button>
      )}

      <details className="rounded-lg border border-line bg-neutral-50 p-3">
        <summary className="cursor-pointer text-sm font-semibold">Bibliothèque de hashtags et tendances</summary>
        <div className="mt-3 space-y-4">
          <div>
            <p className="text-xs font-semibold">Ajouter un hashtag à la bibliothèque</p>
            <div className="mt-1 flex gap-2">
              <input
                className="input flex-1 text-xs"
                dir="auto"
                placeholder="ex. CinemaTunisien"
                value={libTag}
                onChange={(e) => setLibTag(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addToLibrary(); } }}
              />
              <button className="btn text-xs" disabled={busy || !norm(libTag)} onClick={addToLibrary}>Ajouter</button>
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold">Recommandations classées ({platform})</p>
            {recoSignals && (
              <p className="text-[11px] text-neutral-500">
                Signaux utilisés : pertinence
                {recoSignals.feedback ? ' · validations' : ''}
                {recoSignals.performance ? ' · performance' : ''}
                {recoSignals.trends ? ' · tendances' : ''}
              </p>
            )}
            {recos.loading ? (
              <p className="text-xs text-neutral-500">Chargement…</p>
            ) : recos.error ? (
              <p className="text-xs text-neutral-500">Indisponible : {recos.error}</p>
            ) : library.length === 0 ? (
              <p className="text-xs text-neutral-500">Bibliothèque vide : ajoutez des hashtags ou approuvez des propositions.</p>
            ) : (
              <ul className="mt-1 space-y-1.5">
                {library.slice(0, 15).map((h) => (
                  <li key={h.key} className="rounded-md bg-white p-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold" dir="auto">#{h.tag}</span>
                      {h.official && <span className="rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-800">officiel</span>}
                      {h.origin && <span className="text-[10px] uppercase text-neutral-400">{h.origin.replace('_', ' ')}</span>}
                      <span className="ml-auto tabular-nums text-neutral-500">{h.score}/100</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-100">
                      <div className="h-full bg-emerald-500" style={{ width: `${h.score}%` }} />
                    </div>
                    <p className="mt-1 text-neutral-500">
                      Pertinence {pct(h.parts.relevance)}
                      {h.parts.performance != null ? ` · Performance ${pct(h.parts.performance)}` : ''}
                      {h.parts.feedback != null ? ` · Validation ${pct(h.parts.feedback)}` : ''}
                      {h.parts.trend != null ? ` · Tendance ${pct(h.parts.trend)}` : ''}
                    </p>
                    {h.reasons.length > 0 && <p className="text-neutral-400">{h.reasons.join(' · ')}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="text-xs font-semibold">Tendances enregistrées ({platform})</p>
            <p className="text-[11px] text-neutral-500">Seules les tendances récentes, non expirées et de la bonne région influencent les suggestions.</p>
            {trendsOff || trendsDisabled ? (
              <p className="text-xs text-neutral-500">L’intelligence des tendances est désactivée par l’administrateur.</p>
            ) : trends.error ? (
              <p className="text-xs text-neutral-500">Tendances indisponibles : {trends.error}</p>
            ) : trendList.length === 0 ? (
              <p className="text-xs text-neutral-500">Aucune tendance récente et vérifiée. Les suggestions reposent sur la pertinence et l’historique approuvé.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {trendList.map((t) => (
                  <li key={t.key} className="flex items-start justify-between gap-2 rounded-md bg-white p-2 text-xs">
                    <span>
                      <span className="font-semibold" dir="auto">{t.label}</span>
                      <span className="text-neutral-500">
                        {t.source ? ` · ${t.source}` : ''}{t.region ? ` · ${t.region}` : ''}
                        {t.observedAt ? ` · observé le ${fmt(t.observedAt)}` : ''}{t.expiresAt ? ` · expire le ${fmt(t.expiresAt)}` : ''}
                        {t.sourceNote ? ` · ${t.sourceNote}` : ''}
                      </span>
                    </span>
                    {canApprove && t.id && (
                      <button type="button" className="text-red-600 underline underline-offset-2" disabled={busy} onClick={() => removeTrend(t.id as string)}>
                        Supprimer
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {canApprove && (
            <div className="rounded-md border border-line bg-white p-2">
              <p className="text-xs font-semibold">Ajouter une tendance vérifiée ({platform})</p>
              <p className="text-[11px] text-neutral-500">
                Saisissez uniquement une tendance que vous avez vérifiée vous-même sur la plateforme. Elle expire automatiquement.
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_5rem_6rem]">
                <input className="input text-xs" dir="auto" maxLength={80} placeholder="Hashtag (ex. CinemaTunisien)" value={tTag} onChange={(e) => setTTag(e.target.value)} />
                <input className="input text-xs" maxLength={2} placeholder="Pays" value={tRegion} onChange={(e) => setTRegion(e.target.value)} aria-label="Code pays (2 lettres)" />
                <input className="input text-xs" type="number" min={1} placeholder="Durée (h)" value={tTtl} onChange={(e) => setTTtl(e.target.value)} aria-label="Durée de validité en heures" />
              </div>
              <textarea
                className="input mt-2 min-h-14 text-xs"
                dir="auto"
                maxLength={300}
                placeholder="Source de la vérification (obligatoire, 5 caractères minimum) : ex. TikTok Creative Center, Tunisie, 17/10"
                value={tNote}
                onChange={(e) => setTNote(e.target.value)}
              />
              <button className="btn text-xs mt-2" disabled={busy || !norm(tTag) || tNote.trim().length < 5} onClick={addTrend}>
                Ajouter la tendance
              </button>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}