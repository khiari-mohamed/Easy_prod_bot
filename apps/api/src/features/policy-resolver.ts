import { FeatureMode, Platform, SettingScope } from '@prisma/client';
import { FeatureDef, getFeature, minMode, MODE_RANK, atLeast } from './feature-registry';

/** One stored override (FeatureConfig row), reduced to what resolution needs. */
export interface ConfigRow {
  featureKey: string;
  scope: SettingScope;
  scopeId: string;
  mode: FeatureMode;
  updatedAt?: Date;
  updatedById?: string | null;
}

export interface CampaignFlags {
  autoPublishEnabled: boolean;
  publishingPaused: boolean;
}

/** Everything the resolver needs, loaded once and cached by FeaturePolicyService. */
export interface PolicySnapshot {
  emergencyActive: boolean;
  publishingPaused: boolean;
  rows: ConfigRow[];
  campaigns: Record<string, CampaignFlags>;
  /** Hard ceilings coming from environment switches (true = allowed). */
  env: { COMMENT_AUTOMATION: boolean; BACKGROUND_SYNC: boolean };
}

export interface PolicyContext {
  campaignId?: string | null;
  accountId?: string | null;
  platform?: Platform | null;
}

export type BlockedBy =
  | 'EMERGENCY_STOP'
  | 'PUBLISHING_PAUSED'
  | 'GLOBAL'
  | 'CAMPAIGN'
  | 'PLATFORM'
  | 'ACCOUNT'
  | 'CAMPAIGN_FLAG'
  | 'DEPENDENCY'
  | 'ENVIRONMENT'
  | 'UNKNOWN_FEATURE';

export interface Restriction {
  by: BlockedBy;
  mode: FeatureMode;
  detail: string;
}

export interface Effective {
  feature: string;
  mode: FeatureMode;
  /** Every restriction that lowered the mode, strongest first. Empty = nothing is restricting it. */
  restrictions: Restriction[];
  /** The mode before any restriction other than the global setting was applied. */
  globalMode: FeatureMode;
}

const SCOPE_ORDER: SettingScope[] = ['CAMPAIGN', 'PLATFORM', 'ACCOUNT'];

function rowFor(rows: ConfigRow[], featureKey: string, scope: SettingScope, scopeId: string): ConfigRow | undefined {
  return rows.find((r) => r.featureKey === featureKey && r.scope === scope && r.scopeId === scopeId);
}

function scopeIdOf(scope: SettingScope, ctx: PolicyContext): string | null {
  if (scope === 'GLOBAL') return '';
  if (scope === 'CAMPAIGN') return ctx.campaignId ?? null;
  if (scope === 'PLATFORM') return ctx.platform ?? null;
  return ctx.accountId ?? null;
}

/** Global mode: the stored value if valid for this feature, else the registry default. */
export function globalMode(def: FeatureDef, rows: ConfigRow[]): FeatureMode {
  if (def.locked) return def.locked;
  const row = rowFor(rows, def.key, 'GLOBAL', '');
  if (row && def.modes.includes(row.mode)) return row.mode;
  return def.default;
}

/**
 * The effective mode of a feature in a context.
 *
 * Precedence (a lower level can only RESTRICT, never widen):
 *   1. emergency stop            -> OFF for every `stopByEmergency` feature
 *   2. global publishing pause   -> OFF for every `stopByPause` feature
 *   3. environment ceiling       -> OFF when the env switch is off
 *   4. global setting            -> the maximum permitted behaviour
 *   5. campaign / platform / account overrides and campaign flags -> min()
 *   6. dependencies              -> OFF unless the required feature is on
 * Individual content approval (step 5 of the spec) is checked by the workflow itself.
 */
export function resolveEffective(
  def: FeatureDef,
  snap: PolicySnapshot,
  ctx: PolicyContext = {},
  depth = 0,
): Effective {
  const restrictions: Restriction[] = [];
  const g = globalMode(def, snap.rows);
  let mode: FeatureMode = g;

  // `always` records a system-wide stop even when the stored mode was already OFF, so the
  // reason shown to the administrator is the stop, not a plain "disabled".
  const restrict = (by: BlockedBy, to: FeatureMode, detail: string, always = false) => {
    if (MODE_RANK[to] < MODE_RANK[mode]) {
      mode = to;
      restrictions.push({ by, mode: to, detail });
    } else if (always) {
      restrictions.push({ by, mode: to, detail });
    }
  };

  if (def.stopByEmergency && snap.emergencyActive) {
    restrict('EMERGENCY_STOP', 'OFF', 'Arrêt d’urgence actif', true);
  }
  if (def.stopByPause && snap.publishingPaused) {
    restrict('PUBLISHING_PAUSED', 'OFF', 'Les publications sont en pause', true);
  }
  if (def.envGate && !snap.env[def.envGate]) {
    restrict('ENVIRONMENT', 'OFF', `Désactivé par la configuration serveur (${def.envGate})`, true);
  }

  if (!def.locked) {
    for (const scope of SCOPE_ORDER) {
      if (!def.scopes.includes(scope)) continue;
      const id = scopeIdOf(scope, ctx);
      if (id === null || id === '') continue;
      const row = rowFor(snap.rows, def.key, scope, id);
      if (row && def.modes.includes(row.mode)) {
        restrict(scope as BlockedBy, row.mode, `Restreint au niveau ${scope.toLowerCase()} (${id})`);
      }
    }
  }

  // Legacy campaign switches stay the source of truth for campaign-level publishing control.
  if (ctx.campaignId && def.group === 'publishing' && !def.locked) {
    const c = snap.campaigns[ctx.campaignId];
    if (c) {
      if (c.publishingPaused) restrict('CAMPAIGN_FLAG', 'OFF', 'Publication en pause pour cette campagne');
      if (def.key === 'publishing.auto' && !c.autoPublishEnabled) {
        restrict('CAMPAIGN_FLAG', 'OFF', 'Publication automatique désactivée pour cette campagne');
      }
    }
  }

  if (def.requires && depth < 4) {
    for (const dep of def.requires) {
      const depDef = getFeature(dep.feature);
      if (!depDef) continue;
      const depEff = resolveEffective(depDef, snap, ctx, depth + 1);
      if (!atLeast(depEff.mode, dep.min)) {
        restrict('DEPENDENCY', 'OFF', `Nécessite « ${depDef.label} »`);
      }
    }
  }

  return { feature: def.key, mode, restrictions, globalMode: g };
}

export interface Decision {
  allowed: boolean;
  mode: FeatureMode;
  /** Machine-readable cause when not allowed. */
  code: BlockedBy | 'POLICY_UNAVAILABLE' | null;
  /** Human-readable reason (French, safe to show in the UI). */
  reason: string;
  restrictions: Restriction[];
}

/** `need` = the minimum mode the caller requires (default REVIEW = "feature is on in any form"). */
export function decide(
  featureKey: string,
  snap: PolicySnapshot,
  ctx: PolicyContext = {},
  need: FeatureMode = 'REVIEW',
): Decision {
  const def = getFeature(featureKey);
  if (!def) {
    return {
      allowed: false,
      mode: 'OFF',
      code: 'UNKNOWN_FEATURE',
      reason: `Fonctionnalité inconnue : ${featureKey}`,
      restrictions: [],
    };
  }
  const eff = resolveEffective(def, snap, ctx);
  if (atLeast(eff.mode, need)) {
    return { allowed: true, mode: eff.mode, code: null, reason: 'OK', restrictions: eff.restrictions };
  }
  const top = eff.restrictions[0];
  return {
    allowed: false,
    mode: eff.mode,
    code: top?.by ?? 'GLOBAL',
    reason: top
      ? `${def.label} : ${top.detail}`
      : `${def.label} est désactivée par l’administrateur`,
    restrictions: eff.restrictions,
  };
}

/** Lowest of two modes, re-exported for callers that merge decisions. */
export { minMode };