'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, useFetch } from '@/lib/api';
import { fromInputValue } from '@/lib/format';
import type { Asset, CaptionLanguage, ContentItem, Me, Platform, PostFormat, PublishMode } from '@/lib/types';
import { CaptionStudio } from '@/components/CaptionStudio';
import { ErrorNote, Loading, PageTitle, PlatformTag, StatusBadge } from '@/components/ui';

const PLATFORMS: Platform[] = ['FACEBOOK', 'INSTAGRAM'];
const FORMATS: PostFormat[] = ['IMAGE', 'VIDEO', 'REEL', 'STORY', 'TEXT'];
const LANG_OPTIONS: { value: CaptionLanguage; label: string }[] = [
  { value: 'DARIJA_FRENCH', label: 'Darija + Français' },
  { value: 'DARIJA', label: 'Darija' },
  { value: 'FRENCH', label: 'Français' },
];

export default function ContentItemPage() {
  const params = useParams<{ id: string }>();
  const isNew = params.id === 'new';
  const router = useRouter();

  const item = useFetch<ContentItem>(isNew ? null : `/content/${params.id}`);
  const assets = useFetch<Asset[]>('/assets');
  const me = useFetch<Me>('/auth/me');

  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [language, setLanguage] = useState<CaptionLanguage>('DARIJA_FRENCH');
  const [publishMode, setPublishMode] = useState<PublishMode>('MANUAL');
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [genPlatforms, setGenPlatforms] = useState<Platform[]>(['FACEBOOK', 'INSTAGRAM']);
  const [genFormat, setGenFormat] = useState<PostFormat>('REEL');
  const [genScheduledAt, setGenScheduledAt] = useState('');
  const [genCaptions, setGenCaptions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const d = item.data;
  useEffect(() => {
    if (!d) return;
    setTitle(d.title);
    setCaption(d.baseCaption);
    setHashtags(d.hashtags.join(' '));
    setLanguage(d.captionLanguage ?? 'DARIJA_FRENCH');
    setPublishMode(d.defaultPublishMode);
    setSelectedAssets(d.assets.map((a) => a.assetId));
  }, [d]);

  if (!isNew && item.loading) return <Loading />;

  const isApprover = me.data?.role === 'ADMIN' || me.data?.role === 'APPROVER';
  const editable = isNew || !d || ['DRAFT', 'REJECTED'].includes(d.approvalStatus);
  const tags = () => hashtags.split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (!isNew) await item.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const body = {
      title,
      baseCaption: caption,
      hashtags: tags(),
      captionLanguage: language,
      defaultPublishMode: publishMode,
      assets: selectedAssets.map((id, i) => ({ assetId: id, order: i, role: 'MAIN' as const })),
    };
    if (isNew) {
      const created = await api<ContentItem>('/content', { method: 'POST', body });
      router.push(`/content/${created.id}`);
    } else {
      await api(`/content/${params.id}`, { method: 'PATCH', body });
      await item.reload();
    }
  }

  async function generatePosts() {
    await run(() =>
      api(`/content/${params.id}/generate-posts`, {
        method: 'POST',
        body: {
          platforms: genPlatforms,
          format: genFormat,
          scheduledAt: fromInputValue(genScheduledAt) ?? undefined,
          generateCaptions: genCaptions,
        },
      }),
    );
  }

  function toggleAsset(id: string) {
    setSelectedAssets((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  function togglePlatform(p: Platform) {
    setGenPlatforms((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);
  }

  const allAssets = assets.data ?? [];
  const pageTitle = isNew ? 'Nouveau contenu' : (d?.title ?? 'Contenu');

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle title={pageTitle}>
        {d && (
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${
            d.approvalStatus === 'APPROVED' ? 'bg-green-100 text-green-800' :
            d.approvalStatus === 'PENDING' ? 'bg-yellow-100 text-yellow-800' :
            d.approvalStatus === 'REJECTED' ? 'bg-red-100 text-red-700' :
            'bg-neutral-100 text-neutral-700'
          }`}>{d.approvalStatus}</span>
        )}
      </PageTitle>

      <ErrorNote message={error ?? item.error} />

      {d?.rejectionNote && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">Refusé : {d.rejectionNote}</div>
      )}

      <div className="card space-y-3">
        <div>
          <label className="label">Titre</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={!editable} placeholder="ex. Teaser avant-première" />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label">Langue de la légende</label>
            <select className="input" value={language} onChange={(e) => setLanguage(e.target.value as CaptionLanguage)} disabled={!editable}>
              {LANG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Mode de publication par défaut</label>
            <select className="input" value={publishMode} onChange={(e) => setPublishMode(e.target.value as PublishMode)} disabled={!editable}>
              <option value="MANUAL">Manuel</option>
              <option value="AUTO">Automatique</option>
            </select>
          </div>
        </div>

        <div>
          <label className="label">Légende de base ({caption.length})</label>
          <textarea
            className="input min-h-36 font-[inherit]"
            dir="auto"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            disabled={!editable}
            placeholder="Rédigez en Darija, Français, ou les deux… ou utilisez Caption Studio ci-dessous."
          />
        </div>

        <div>
          <label className="label">Hashtags (sans #, séparés par un espace)</label>
          <input className="input" dir="auto" value={hashtags} onChange={(e) => setHashtags(e.target.value)} disabled={!editable} />
        </div>

        <div>
          <label className="label">Médias ({selectedAssets.length} sélectionné{selectedAssets.length !== 1 ? 's' : ''})</label>
          {allAssets.length === 0 ? (
            <p className="text-xs text-neutral-500">Aucun média. <Link href="/assets" className="underline">Ajoutez-en d&apos;abord.</Link></p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {allAssets.map((a) => {
                const sel = selectedAssets.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    disabled={!editable}
                    onClick={() => toggleAsset(a.id)}
                    className={`rounded-md border p-2 text-left text-xs transition-colors ${sel ? 'border-blue-500 bg-blue-50' : 'border-neutral-200 hover:border-neutral-400'}`}
                  >
                    {a.kind === 'IMAGE' ? (
                      <img src={a.url.replace(/^https?:\/\/[^/]+/, '')} alt={a.name} className="mb-1 h-20 w-full rounded object-cover" />
                    ) : (
                      <div className="mb-1 flex h-20 items-center justify-center rounded bg-neutral-100 text-2xl">🎬</div>
                    )}
                    <span className="line-clamp-1">{a.name}</span>
                    {a.processingStatus !== 'READY' && <span className="text-amber-600"> ⏳</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {editable && (
          <button className="btn btn-primary" disabled={busy} onClick={() => run(save)}>
            {isNew ? 'Créer' : 'Enregistrer'}
          </button>
        )}
      </div>

      {isNew && (
        <p className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
          Enregistrez d&apos;abord ce contenu : Caption Studio utilise son contexte (campagne, plan, médias) pour proposer des légendes et des hashtags.
        </p>
      )}

      {!isNew && d && (
        <>
          <CaptionStudio
            contentItemId={d.id}
            planEntryId={d.planEntryId}
            campaignId={d.campaignId}
            defaultLanguage={d.captionLanguage ?? 'DARIJA_FRENCH'}
            canApprove={isApprover}
            canApply={editable}
            posts={d.posts.map((p) => ({ id: p.id, platform: p.platform, status: p.status }))}
            onApplied={() => item.reload()}
          />

          <div className="card space-y-3">
            <h2 className="font-bold">Workflow</h2>
            <div className="flex flex-wrap gap-2">
              {d.approvalStatus === 'DRAFT' && (
                <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api(`/content/${params.id}/submit`, { method: 'POST' }))}>
                  Soumettre pour validation
                </button>
              )}
              {d.approvalStatus === 'PENDING' && isApprover && (
                <>
                  <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api(`/content/${params.id}/approve`, { method: 'POST' }))}>
                    Approuver
                  </button>
                  <button className="btn" disabled={busy} onClick={() => {
                    const reason = window.prompt('Motif du refus :');
                    if (reason) run(() => api(`/content/${params.id}/reject`, { method: 'POST', body: { reason } }));
                  }}>
                    Refuser
                  </button>
                </>
              )}
              {d.approvalStatus === 'PENDING' && !isApprover && (
                <span className="text-sm text-neutral-600">En attente d&apos;un validateur.</span>
              )}
            </div>
          </div>

          <div className="card space-y-3">
            <h2 className="font-bold">Générer les posts par plateforme</h2>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="label">Plateformes</label>
                <div className="flex gap-3">
                  {PLATFORMS.map((p) => (
                    <label key={p} className="flex items-center gap-1 text-sm">
                      <input type="checkbox" checked={genPlatforms.includes(p)} onChange={() => togglePlatform(p)} />
                      {p}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="label">Format</label>
                <select className="input" value={genFormat} onChange={(e) => setGenFormat(e.target.value as PostFormat)}>
                  {FORMATS.map((f) => <option key={f}>{f}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Date/heure de publication (optionnel)</label>
                <input type="datetime-local" className="input" value={genScheduledAt} onChange={(e) => setGenScheduledAt(e.target.value)} />
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={genCaptions} onChange={(e) => setGenCaptions(e.target.checked)} />
                  Générer des légendes IA par plateforme
                </label>
              </div>
            </div>
            <button className="btn btn-primary" disabled={busy || genPlatforms.length === 0} onClick={generatePosts}>
              Générer les posts
            </button>
          </div>

          {d.posts.length > 0 && (
            <div className="card space-y-2">
              <h2 className="font-bold">Posts liés</h2>
              {d.posts.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 rounded-md border border-neutral-100 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <PlatformTag platform={p.platform} />
                    <StatusBadge status={p.status} />
                    <span className="text-xs text-neutral-500">{p.format}</span>
                  </div>
                  <Link href={`/posts/${p.id}`} className="btn text-xs">Voir</Link>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}