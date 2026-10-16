'use client';

import { useState } from 'react';
import { api, useFetch } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { Platform } from '@/lib/types';
import { EmptyState, ErrorNote, Loading, PageTitle, PlatformTag } from '@/components/ui';

interface Config {
  firstComment: boolean; aiReply: boolean; autoReply: boolean; moderation: boolean;
  firstCommentTemplate: string; blockedWords: string[]; hideLinks: boolean;
  moderationAction: 'HIDE' | 'DELETE'; autoReplyMaxPerHour: number; maxCommentAgeHours: number;
}
interface Status {
  config: Config; paused: boolean; aiKey: boolean;
  accounts: { platform: Platform; name: string; missingScopes: string[] }[];
  counts: Record<string, number>;
}
interface Job {
  id: string; platform: Platform; kind: 'FIRST_COMMENT' | 'REPLY' | 'MODERATION'; status: string;
  authorName: string | null; incomingText: string | null; text: string; aiGenerated: boolean; auto: boolean;
  note: string | null; error: string | null; createdAt: string; post: { caption: string } | null;
}

const FEATURES = [
  ['firstComment', 'Premier commentaire', "Après publication, poste les hashtags en commentaire (posts publiés par le bot, à partir de l'activation)."],
  ['aiReply', 'Réponses IA avec validation', "Lit les commentaires, propose une réponse et attend l'approbation d'un humain."],
  ['autoReply', 'Réponses automatiques', 'Envoie sans validation les réponses jugées sûres. Les autres passent en validation.'],
  ['moderation', 'Modération', 'Masque (ou supprime) les commentaires avec un mot interdit ou un lien.'],
] as const;

const TABS: [string, string][] = [
  ['PENDING_APPROVAL', 'À valider'], ['NEEDS_CHECK', 'À vérifier'], ['APPROVED', "En attente d'envoi"],
  ['SENT', 'Envoyés'], ['FAILED', 'Échecs'], ['SKIPPED', 'À traiter à la main'], ['REJECTED', 'Rejetés'],
];
const KIND: Record<Job['kind'], string> = { FIRST_COMMENT: 'Premier commentaire', REPLY: 'Réponse', MODERATION: 'Modération' };

function Features({ status, onChange }: { status: Status; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const c = status.config;

  async function save(patch: Partial<Config>) {
    setError(null);
    try {
      await api('/comments/config', { method: 'PATCH', body: patch });
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function toggle(key: (typeof FEATURES)[number][0]) {
    if (key === 'autoReply' && !c.autoReply && !window.confirm('Les réponses jugées sûres seront publiées sans validation humaine, au nom de la page. Activer ?')) return;
    save({ [key]: !c[key] });
  }

  return (
    <div className="card space-y-3">
      <h2 className="font-bold">Fonctions (administrateur)</h2>
      <ErrorNote message={error} />
      <ul className="divide-y divide-neutral-100">
        {FEATURES.map(([key, label, hint]) => (
          <li key={key} className="flex items-start justify-between gap-4 py-2">
            <div>
              <div className="text-sm font-semibold">{label}</div>
              <div className="text-xs text-neutral-500">{hint}</div>
            </div>
            <button className={`btn ${c[key] ? 'btn-primary' : ''}`} onClick={() => toggle(key)}>{c[key] ? 'Activé' : 'Désactivé'}</button>
          </li>
        ))}
      </ul>
      <SettingsForm key={JSON.stringify(c)} config={c} onSave={save} />
    </div>
  );
}

function SettingsForm({ config, onSave }: { config: Config; onSave: (p: Partial<Config>) => void }) {
  const [tpl, setTpl] = useState(config.firstCommentTemplate);
  const [words, setWords] = useState(config.blockedWords.join('\n'));
  const [hideLinks, setHideLinks] = useState(config.hideLinks);
  const [action, setAction] = useState(config.moderationAction);
  const [cap, setCap] = useState(String(config.autoReplyMaxPerHour));
  const [age, setAge] = useState(String(config.maxCommentAgeHours));
  return (
    <details>
      <summary className="cursor-pointer text-sm font-semibold">Réglages</summary>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        <label className="text-xs text-neutral-500">Modèle du premier commentaire ({'{hashtags}'})
          <input className="input mt-1" value={tpl} onChange={(e) => setTpl(e.target.value)} />
        </label>
        <label className="text-xs text-neutral-500">Action de modération
          <select className="input mt-1" value={action} onChange={(e) => setAction(e.target.value as Config['moderationAction'])}>
            <option value="HIDE">Masquer (réversible)</option>
            <option value="DELETE">Supprimer (définitif)</option>
          </select>
        </label>
        <label className="text-xs text-neutral-500">Mots interdits (un par ligne)
          <textarea className="input mt-1 min-h-24" value={words} onChange={(e) => setWords(e.target.value)} />
        </label>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={hideLinks} onChange={(e) => setHideLinks(e.target.checked)} /> Masquer les commentaires avec un lien</label>
          <label className="block text-xs text-neutral-500">Plafond de réponses automatiques par heure
            <input className="input mt-1" type="number" min={0} max={100} value={cap} onChange={(e) => setCap(e.target.value)} />
          </label>
          <label className="block text-xs text-neutral-500">Ignorer les commentaires de plus de (heures)
            <input className="input mt-1" type="number" min={1} max={168} value={age} onChange={(e) => setAge(e.target.value)} />
          </label>
        </div>
      </div>
      <button className="btn btn-primary mt-3" onClick={() => onSave({
        firstCommentTemplate: tpl, blockedWords: words.split('\n').map((w) => w.trim()).filter(Boolean), hideLinks,
        moderationAction: action, autoReplyMaxPerHour: Number(cap), maxCommentAgeHours: Number(age),
      })}>Enregistrer les réglages</button>
    </details>
  );
}

function JobCard({ job, onDone }: { job: Job; onDone: () => void }) {
  const [text, setText] = useState(job.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try { await fn(); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const post = (action: string, body?: unknown) => api(`/comments/jobs/${job.id}/${action}`, { method: 'POST', body });
  const editable = job.status === 'PENDING_APPROVAL' && job.kind !== 'MODERATION';

  return (
    <li className="space-y-2 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <PlatformTag platform={job.platform} />
        <span className="font-semibold">{KIND[job.kind]}</span>
        {job.aiGenerated && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700">IA</span>}
        {job.auto && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">Auto</span>}
        <span className="text-xs text-neutral-500">{fmtDateTime(job.createdAt)}</span>
      </div>
      {job.post && <p className="truncate text-xs text-neutral-500" dir="auto">Post : {job.post.caption}</p>}
      {job.incomingText && (
        <p className="rounded-lg bg-neutral-50 px-3 py-2" dir="auto"><span className="text-xs text-neutral-500">{job.authorName ?? 'Utilisateur'} :</span> {job.incomingText}</p>
      )}
      {job.kind !== 'MODERATION' && (editable
        ? <textarea className="input min-h-16" dir="auto" value={text} onChange={(e) => setText(e.target.value)} />
        : job.text && <p className="whitespace-pre-wrap" dir="auto">{job.text}</p>)}
      {job.note && <p className="text-xs text-amber-700">{job.note}</p>}
      {job.error && <p className="text-xs text-red-600">{job.error}</p>}
      <ErrorNote message={error} />
      <div className="flex flex-wrap gap-2">
        {job.status === 'PENDING_APPROVAL' && (
          <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => run(async () => {
            if (text !== job.text) await api(`/comments/jobs/${job.id}`, { method: 'PATCH', body: { text } });
            await post('approve');
          })}>Approuver et envoyer</button>
        )}
        {job.status === 'FAILED' && <button className="btn" disabled={busy} onClick={() => run(() => post('retry'))}>Réessayer</button>}
        {job.status === 'NEEDS_CHECK' && (
          <>
            <button className="btn" disabled={busy} onClick={() => run(() => post('resolve', { sent: true }))}>Vérifié : bien envoyé</button>
            <button className="btn" disabled={busy} onClick={() => run(() => post('resolve', { sent: false }))}>Vérifié : pas envoyé, renvoyer</button>
          </>
        )}
        {['PENDING_APPROVAL', 'APPROVED', 'FAILED', 'NEEDS_CHECK'].includes(job.status) && (
          <button className="btn" disabled={busy} onClick={() => run(() => post('reject'))}>Rejeter</button>
        )}
      </div>
    </li>
  );
}

function JobsList({ status, onChange }: { status: string; onChange: () => void }) {
  const jobs = useFetch<Job[]>(`/comments/jobs?status=${status}`);
  if (jobs.loading) return <Loading />;
  if (!jobs.data?.length) return <EmptyState title="Rien ici" hint="Aucun élément avec ce statut." />;
  return (
    <ul className="divide-y divide-neutral-100">
      {jobs.data.map((j) => <JobCard key={j.id} job={j} onDone={() => { jobs.reload(); onChange(); }} />)}
    </ul>
  );
}

export default function CommentsPage() {
  const status = useFetch<Status>('/comments/status');
  const [tab, setTab] = useState('PENDING_APPROVAL');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [version, setVersion] = useState(0);

  async function poll() {
    setPolling(true);
    setError(null);
    try {
      const r = await api<{ posts: number; comments: number; moderated: number; queued: number; auto: number; skipped: number; errors: string[] }>('/comments/poll', { method: 'POST' });
      setMsg(`${r.posts} posts lus · ${r.comments} nouveaux commentaires · ${r.queued} à valider · ${r.auto} auto · ${r.moderated} modérés · ${r.skipped} à traiter à la main${r.errors.length ? ` · ${r.errors.length} erreur(s) : ${r.errors[0]}` : ''}`);
      status.reload();
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPolling(false);
    }
  }

  if (status.loading) return <Loading />;
  const s = status.data;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageTitle title="Commentaires" subtitle="Premier commentaire, réponses et modération">
        <button className="btn" disabled={polling} onClick={poll}>{polling ? 'Lecture…' : 'Vérifier les commentaires maintenant'}</button>
      </PageTitle>
      {msg && <p className="text-sm text-green-700">{msg}</p>}
      <ErrorNote message={error ?? status.error} />

      {s?.paused && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">Une campagne est en pause : aucun commentaire n'est envoyé.</p>}
      {s && !s.aiKey && (s.config.aiReply || s.config.autoReply) && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">Clé Anthropic absente : les réponses IA ne peuvent pas être générées.</p>
      )}
      {s?.accounts.filter((a) => a.missingScopes.length).map((a) => (
        <p key={a.platform} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {a.platform} ({a.name}) : permissions manquantes sur le token : {a.missingScopes.join(', ')}.
        </p>
      ))}

      {s && <Features status={s} onChange={status.reload} />}

      <div className="card">
        <div className="mb-3 flex flex-wrap gap-2">
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={`rounded-full border px-3 py-1 text-xs font-medium ${tab === k ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50'}`}>
              {label} {s?.counts[k] ? `(${s.counts[k]})` : ''}
            </button>
          ))}
        </div>
        <JobsList key={`${tab}-${version}`} status={tab} onChange={status.reload} />
      </div>
    </div>
  );
}
