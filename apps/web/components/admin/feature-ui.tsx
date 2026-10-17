'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { EP } from '@/lib/endpoints';
import type { AdminOverview, EmergencyStopState, FeatureMode, FeatureOverride, FeatureView, SettingScope } from '@/lib/types';
import { ErrorNote, ModeBadge, ModeSwitch, Toggle, modeLabel } from '@/components/ui';

export const GROUP_ORDER = ['publishing', 'comments', 'ai', 'planning', 'media', 'analytics'] as const;

export const GROUPS: Record<string, { title: string; description: string }> = {
  publishing: { title: 'Publication', description: 'Publication automatique, programmation, publication immédiate et validation humaine.' },
  comments: { title: 'Commentaires', description: 'Premier commentaire, réponses aux commentaires et modération.' },
  ai: { title: 'AI Content Studio', description: 'Légendes et hashtags IA, apprentissage par feedback, classement et tendances.' },
  planning: { title: 'Planning', description: 'Extraction IA des documents, vérification, calendrier et brouillons.' },
  media: { title: 'Médias', description: 'Téléversement et traitement automatique des fichiers.' },
  analytics: { title: 'Analytics', description: 'Collecte automatique des statistiques.' },
};

export const groupMeta = (slug: string) =>
  GROUPS[slug] ?? { title: slug.charAt(0).toUpperCase() + slug.slice(1), description: '' };

const RANK: Record<FeatureMode, number> = { OFF: 0, REVIEW: 1, AUTO: 2 };
const PLATFORMS = ['FACEBOOK', 'INSTAGRAM', 'TIKTOK'];
const SCOPE_LABEL: Record<SettingScope, string> = { GLOBAL: 'Global', CAMPAIGN: 'Campagne', PLATFORM: 'Plateforme', ACCOUNT: 'Compte' };

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('fr-TN', { timeZone: 'Africa/Tunis', dateStyle: 'short', timeStyle: 'short' });

type Ctx = Pick<AdminOverview, 'campaigns' | 'accounts'>;

function targetLabel(ctx: Ctx, scope: SettingScope, id: string): string {
  if (scope === 'CAMPAIGN') return ctx.campaigns.find((c) => c.id === id)?.titleLatin ?? id;
  if (scope === 'ACCOUNT') {
    const a = ctx.accounts.find((x) => x.id === id);
    return a ? `${a.platform} · ${a.name}` : id;
  }
  return id;
}

function targetsFor(ctx: Ctx, scope: SettingScope): { value: string; label: string }[] {
  if (scope === 'CAMPAIGN') return ctx.campaigns.map((c) => ({ value: c.id, label: c.titleLatin }));
  if (scope === 'PLATFORM') return PLATFORMS.map((p) => ({ value: p, label: p }));
  if (scope === 'ACCOUNT') return ctx.accounts.map((a) => ({ value: a.id, label: `${a.platform} · ${a.name}` }));
  return [];
}

export function FeatureRow({
  feature,
  campaigns,
  accounts,
  canEdit,
  onChanged,
}: {
  feature: FeatureView;
  campaigns: AdminOverview['campaigns'];
  accounts: AdminOverview['accounts'];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const ctx: Ctx = { campaigns, accounts };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopes = feature.scopes.filter((s) => s !== 'GLOBAL');
  const [scope, setScope] = useState<SettingScope>(scopes[0] ?? 'CAMPAIGN');
  const [scopeId, setScopeId] = useState('');
  const [ovMode, setOvMode] = useState<FeatureMode>('OFF');

  const toggleOnly = feature.modes.length === 2 && feature.modes.includes('OFF');
  const onMode = feature.modes.find((m) => m !== 'OFF') ?? 'AUTO';
  const disabled = busy || !canEdit || feature.locked;

  // A scoped setting can only restrict: offer modes at or below the global one.
  const ovModes = feature.modes.filter((m) => RANK[m] <= RANK[feature.globalMode]);
  const ovValue = ovModes.includes(ovMode) ? ovMode : ovModes[0];
  const canOverride = canEdit && !feature.locked && scopes.length > 0 && feature.globalMode !== 'OFF';
  const targets = targetsFor(ctx, scope);

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

  function setGlobal(mode: FeatureMode) {
    if (mode === feature.globalMode || feature.locked) return;
    if (
      mode === 'AUTO' &&
      !window.confirm(`Passer « ${feature.label} » en mode automatique ?\n\nLes actions éligibles pourront s’exécuter sans validation manuelle.`)
    )
      return;
    return call(() => api(EP.features.one(feature.key), { method: 'PUT', body: { scope: 'GLOBAL', scopeId: '', mode } }));
  }

  const addOverride = () =>
    call(async () => {
      await api(EP.features.one(feature.key), { method: 'PUT', body: { scope, scopeId, mode: ovValue } });
      setScopeId('');
    });

  const clearOverride = (o: FeatureOverride) =>
    call(() => api(EP.features.clear(feature.key, o.scope, o.scopeId), { method: 'DELETE' }));

  const limited = feature.effectiveMode !== feature.globalMode;

  return (
    <div className="rounded-lg border border-line bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <p className="font-semibold">{feature.label}</p>
          <p className="text-xs text-neutral-500">{feature.description}</p>
          <p className="mt-0.5 font-mono text-[11px] text-neutral-400">{feature.key}</p>
        </div>
        <div className="flex items-center gap-2">
          {feature.locked ? (
            <span className="flex items-center gap-1.5 text-xs font-semibold text-neutral-600">
              🔒 <ModeBadge mode={feature.globalMode} />
            </span>
          ) : toggleOnly ? (
            <Toggle label={feature.label} checked={feature.globalMode !== 'OFF'} disabled={disabled} onChange={() => setGlobal(feature.globalMode === 'OFF' ? onMode : 'OFF')} />
          ) : (
            <ModeSwitch label={feature.label} value={feature.globalMode} options={feature.modes} disabled={disabled} onChange={setGlobal} />
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
        <span className="flex items-center gap-1">Effectif : <ModeBadge mode={feature.effectiveMode} /></span>
        {feature.requires.length > 0 && <span>Dépend de : {feature.requires.map((r) => r.feature).join(', ')}</span>}
        {feature.lastChangedAt && (
          <span className="ml-auto">
            Modifié le {fmtDate(feature.lastChangedAt)}{feature.lastChangedBy ? ` par ${feature.lastChangedBy}` : ''}
          </span>
        )}
      </div>

      {feature.restrictions.length > 0 && (
        <ul className="mt-2 space-y-0.5 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
          {feature.restrictions.map((r, i) => (
            <li key={i}>⚠ {r.detail}{limited && i === 0 ? ` → effectif « ${modeLabel(feature.effectiveMode)} »` : ''}</li>
          ))}
        </ul>
      )}

      {(feature.overrides.length > 0 || canOverride) && (
        <details className="mt-2 rounded-md bg-neutral-50 p-2">
          <summary className="cursor-pointer text-xs font-semibold">
            Exceptions par campagne, plateforme ou compte ({feature.overrides.length})
          </summary>
          <div className="mt-2 space-y-2 text-xs">
            {feature.overrides.length === 0 && <p className="text-neutral-500">Aucune exception : le réglage global s’applique partout.</p>}
            {feature.overrides.map((o) => (
              <div key={`${o.scope}:${o.scopeId}`} className="flex flex-wrap items-center gap-2 rounded bg-white px-2 py-1.5">
                <span className="font-semibold">{SCOPE_LABEL[o.scope]}</span>
                <span dir="auto">{targetLabel(ctx, o.scope, o.scopeId)}</span>
                <ModeBadge mode={o.mode} />
                {o.updatedAt && <span className="text-neutral-400">{fmtDate(o.updatedAt)}{o.updatedBy ? ` · ${o.updatedBy}` : ''}</span>}
                {canEdit && (
                  <button className="ml-auto text-red-600 underline underline-offset-2" disabled={busy} onClick={() => clearOverride(o)}>
                    Retirer
                  </button>
                )}
              </div>
            ))}

            {canOverride && (
              <div className="flex flex-wrap items-end gap-2">
                <label>Portée
                  <select className="input" value={scope} onChange={(e) => { setScope(e.target.value as SettingScope); setScopeId(''); }}>
                    {scopes.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
                  </select>
                </label>
                <label>Cible
                  <select className="input" value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                    <option value="">Choisir…</option>
                    {targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </label>
                <label>Restreindre à
                  <select className="input" value={ovValue} onChange={(e) => setOvMode(e.target.value as FeatureMode)}>
                    {ovModes.map((m) => <option key={m} value={m}>{modeLabel(m)}</option>)}
                  </select>
                </label>
                <button className="btn text-xs" disabled={busy || !scopeId} onClick={addOverride}>Appliquer</button>
              </div>
            )}
          </div>
        </details>
      )}
      <ErrorNote message={error} />
    </div>
  );
}

function who(by: EmergencyStopState['by']): string {
  if (!by) return '';
  return typeof by === 'string' ? by : by.name ?? '';
}

export function EmergencyStopCard({
  state,
  canStop,
  canResume,
  onChanged,
}: {
  state: EmergencyStopState | null;
  canStop: boolean;
  canResume: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = !!state?.active;

  async function toggle() {
    let reason: string | undefined;
    if (!active) {
      const r = window.prompt('Raison de l’arrêt d’urgence (optionnel) :');
      if (r === null) return;
      reason = r || undefined;
      if (!window.confirm('Bloquer immédiatement toute nouvelle action automatique externe (publication, commentaires, modération) ?\n\nLes réponses déjà approuvées devront être ré-approuvées.')) return;
    } else if (!window.confirm('Lever l’arrêt d’urgence ? Les actions annulées ne seront pas relancées automatiquement.')) return;
    setBusy(true);
    setError(null);
    try {
      await api(EP.features.emergency, { method: 'POST', body: { active: !active, reason } });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const allowed = active ? canResume : canStop;
  const detail = [state?.reason, state?.at ? fmtDate(state.at) : '', who(state?.by)].filter(Boolean).join(' · ');

  return (
    <div className={`rounded-xl border-2 p-4 ${active ? 'border-red-500 bg-red-50' : 'border-line bg-white'}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold">{active ? 'Arrêt d’urgence ACTIF' : 'Arrêt d’urgence de l’automatisation'}</p>
          <p className="text-sm text-neutral-600">
            Bloque les nouvelles publications, commentaires et actions de modération automatiques. Une requête déjà acceptée par Meta ne peut pas être annulée. Un approbateur peut arrêter ; seul un administrateur peut reprendre.
          </p>
          {active && detail && <p className="mt-1 text-xs font-semibold text-red-700">{detail}</p>}
        </div>
        {allowed ? (
          <button className={active ? 'btn' : 'btn btn-danger'} disabled={busy} onClick={toggle}>
            {busy ? '…' : active ? 'Lever l’arrêt' : 'Tout arrêter'}
          </button>
        ) : (
          active && <span className="text-xs font-semibold text-red-700">Réservé aux administrateurs</span>
        )}
      </div>
      <ErrorNote message={error} />
    </div>
  );
}