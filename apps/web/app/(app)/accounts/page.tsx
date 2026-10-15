'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, useFetch } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { Account, Me } from '@/lib/types';
import { ErrorNote, Loading, PageTitle, PlatformTag } from '@/components/ui';

const STATUS: Record<Account['status'], string> = {
  ACTIVE: 'text-green-700',
  EXPIRED: 'text-red-700',
  DISCONNECTED: 'text-neutral-400',
};

export default function AccountsPage() {
  const accounts = useFetch<Account[]>('/accounts');
  const me = useFetch<Me>('/auth/me');
  const [token, setToken] = useState('');
  const [pageId, setPageId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isAdmin = me.data?.role === 'ADMIN';
  const isApprover = isAdmin || me.data?.role === 'APPROVER';

  const searchParams = useSearchParams();
  const tiktokOk = searchParams.get('tiktok_connected');
  const tiktokErr = searchParams.get('tiktok_error');

  // Reload accounts list after a successful TikTok connect.
  useEffect(() => { if (tiktokOk) accounts.reload(); }, [tiktokOk]); // eslint-disable-line react-hooks/exhaustive-deps

  async function connect() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r = await api<unknown[]>('/accounts/meta/connect', {
        method: 'POST',
        body: { accessToken: token.trim(), ...(pageId.trim() ? { pageId: pageId.trim() } : {}) },
      });
      setMsg(`${r.length} compte(s) connecté(s).`);
      setToken('');
      setPageId('');
      accounts.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, kind: 'verify' | 'disconnect') {
    setError(null);
    setMsg(null);
    try {
      if (kind === 'verify') {
        const r = await api<{ ok: boolean; error?: string | null }>(`/accounts/${id}/verify`, { method: 'POST' });
        if (r.ok) setMsg('Compte vérifié : publication autorisée.');
        else setError(r.error ?? 'Vérification impossible : la publication n’est pas prouvée.');
      } else if (window.confirm('Déconnecter ce compte ? Les posts programmés passeront en publication manuelle.')) {
        await api(`/accounts/${id}`, { method: 'DELETE' });
      }
      accounts.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (accounts.loading) return <Loading />;

  const tone = (v: boolean | null | undefined) => (v ? 'text-green-700' : v === false ? 'text-red-700' : 'text-amber-700');

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle title="Comptes connectés" />
      <ErrorNote message={error ?? accounts.error} />
      {msg && <p className="text-sm text-green-700">{msg}</p>}

      <div className="card">
        {!accounts.data?.length ? (
          <p className="text-sm text-neutral-600">Aucun compte connecté : tout est en publication manuelle.</p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {accounts.data.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 py-2">
                <PlatformTag platform={a.platform} />
                <span className="flex-1 text-sm font-medium">{a.username ? `@${a.username}` : a.name}</span>
                <span className={`text-xs font-semibold ${STATUS[a.status]}`}>{a.status}</span>
                {isApprover && a.status !== 'DISCONNECTED' && <button className="btn" onClick={() => act(a.id, 'verify')}>Vérifier</button>}
                {isAdmin && a.status !== 'DISCONNECTED' && <button className="btn" onClick={() => act(a.id, 'disconnect')}>Déconnecter</button>}
                {a.status !== 'DISCONNECTED' && (
                  <p className="w-full text-xs text-neutral-600">
                    Publication :{' '}
                    <b className={tone(a.canPublish)}>
                      {a.canPublish ? 'autorisée' : a.canPublish === false ? 'NON autorisée' : 'non vérifiée'}
                    </b>
                    {' · '}Statistiques :{' '}
                    <b className={tone(a.canReadInsights)}>
                      {a.canReadInsights ? 'autorisées' : a.canReadInsights === false ? 'NON autorisées' : 'non vérifiées'}
                    </b>
                    {a.lastVerifiedAt && <> · vérifié {fmtDateTime(a.lastVerifiedAt)}</>}
                    {a.tokenExpiresAt && <> · expire {fmtDateTime(a.tokenExpiresAt)}</>}
                    {a.lastError && <span className="block text-red-700">{a.lastError}</span>}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {isAdmin && (
        <div className="card space-y-3">
          <h2 className="font-bold">Connecter Facebook + Instagram</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-neutral-700">
            <li>L&apos;administrateur de la Page ajoute l&apos;application Meta (rôle développeur/testeur) et autorise la Page et le compte Instagram.</li>
            <li>Générez un jeton utilisateur avec <code>pages_show_list</code>, <code>pages_manage_posts</code>, <code>pages_read_engagement</code>, <code>instagram_basic</code>, <code>instagram_content_publish</code>, <code>instagram_manage_insights</code>.</li>
            <li>Collez-le ci-dessous. Il est échangé contre des jetons de Page, chiffrés en base ; le jeton collé n&apos;est pas conservé.</li>
          </ol>
          <textarea className="input min-h-24 font-mono text-xs" value={token} onChange={(e) => setToken(e.target.value)} placeholder="EAAB…" />
          <div>
            <label className="label">ID de la Page (obligatoire si le jeton donne accès à plusieurs Pages)</label>
            <input className="input" value={pageId} onChange={(e) => setPageId(e.target.value)} placeholder="111445260402987" />
          </div>
          <button className="btn btn-primary" disabled={busy || token.trim().length < 20} onClick={connect}>
            {busy ? 'Connexion…' : 'Connecter'}
          </button>
        </div>
      )}

      {isAdmin && (
        <div className="card space-y-3">
          <h2 className="font-bold">Connecter TikTok</h2>
          {tiktokOk && <p className="text-sm text-green-700">Compte TikTok connecté avec succès.</p>}
          {tiktokErr && <p className="text-sm text-red-700">Erreur TikTok : {tiktokErr}</p>}
          <p className="text-sm text-neutral-700">
            Cliquez sur le bouton ci-dessous pour autoriser l&apos;application via TikTok Login Kit.
            Vous serez redirigé vers TikTok puis renvoyé ici automatiquement.
          </p>
          <a href="/api/auth/tiktok/connect" className="btn btn-primary inline-block">
            Connecter via TikTok
          </a>
        </div>
      )}
    </div>
  );
}