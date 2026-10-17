import { FeatureMode, Platform, SettingScope } from '@prisma/client';
import { atLeast, FEATURES, getFeature, MODE_RANK } from './feature-registry';
import { ConfigRow, globalMode } from './policy-resolver';

export interface ChangeRequest {
  featureKey: string;
  scope: SettingScope;
  scopeId: string; // '' for GLOBAL
  mode: FeatureMode;
}

const PLATFORMS: string[] = Object.values(Platform);

/**
 * Write-time safety checks. Returns a French error message, or null when the change is safe.
 * The resolver enforces the same rules again at read time, so a bad row can never widen access.
 */
export function validateChange(rows: ConfigRow[], req: ChangeRequest): string | null {
  const def = getFeature(req.featureKey);
  if (!def) return `Fonctionnalité inconnue : ${req.featureKey}`;
  if (def.locked) return `« ${def.label} » est une règle de sécurité : elle ne peut pas être modifiée.`;
  if (!def.scopes.includes(req.scope)) {
    return `« ${def.label} » ne peut pas être réglée au niveau ${req.scope.toLowerCase()}.`;
  }
  if (!def.modes.includes(req.mode)) {
    return `Mode ${req.mode} invalide pour « ${def.label} » (valeurs permises : ${def.modes.join(', ')}).`;
  }

  if (req.scope === 'GLOBAL') {
    if (req.scopeId !== '') return 'Le réglage global n’a pas d’identifiant de portée.';
  } else {
    if (!req.scopeId) return 'Identifiant de portée obligatoire (campagne, plateforme ou compte).';
    if (req.scope === 'PLATFORM' && !PLATFORMS.includes(req.scopeId)) return `Plateforme inconnue : ${req.scopeId}`;
    const g = globalMode(def, rows);
    if (MODE_RANK[req.mode] > MODE_RANK[g]) {
      return `Un réglage ${req.scope.toLowerCase()} ne peut pas dépasser le réglage global (${g}) : il ne peut que restreindre.`;
    }
    return null;
  }

  // GLOBAL change: dependency checks in both directions.
  for (const dep of def.requires ?? []) {
    const depDef = getFeature(dep.feature);
    if (!depDef) continue;
    if (atLeast(req.mode, 'REVIEW') && !atLeast(globalMode(depDef, rows), dep.min)) {
      return `Activez d’abord « ${depDef.label} » : « ${def.label} » en dépend.`;
    }
  }
  const dependents = FEATURES.filter((f) =>
    f.requires?.some((r) => r.feature === req.featureKey && !atLeast(req.mode, r.min)),
  ).filter((f) => atLeast(globalMode(f, rows), 'REVIEW'));
  if (dependents.length) {
    return `Désactivez d’abord : ${dependents.map((d) => `« ${d.label} »`).join(', ')} (dépend de « ${def.label} »).`;
  }
  return null;
}