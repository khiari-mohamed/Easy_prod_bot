import { createHash } from 'crypto';
import { Platform, PlanActionType, PostFormat } from '@prisma/client';

export const ACTION_TYPES: PlanActionType[] = [
  'POST',
  'COMMENT',
  'ENGAGEMENT',
  'SPONSORING',
  'PREPARATION',
  'REPORTING',
  'OTHER',
];

/** Actions that happen on a social platform, so they need at least one platform. */
const NEEDS_PLATFORM = new Set<PlanActionType>(['POST', 'COMMENT', 'ENGAGEMENT', 'SPONSORING']);

export const needsPlatform = (t: PlanActionType) => NEEDS_PLATFORM.has(t);

export function toActionType(v: unknown): PlanActionType {
  const s = String(v ?? '').trim().toUpperCase();
  return (ACTION_TYPES as string[]).includes(s) ? (s as PlanActionType) : 'POST';
}

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "10h", "10h30", "9:5", "14:00" -> "HH:mm", or null when it is not a clock time. */
export function normalizeTime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^\s*(\d{1,2})\s*(?:[:hH]\s*(\d{1,2})?)?\s*$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export interface RowInput {
  label: string;
  date: Date | null;
  dateText?: string | null;
  timeOfDay: string | null;
  actionType: PlanActionType;
  platforms: Platform[];
  format: PostFormat;
  caption: string | null;
  assetRef: string | null;
  confidence?: number | null;
  /** Injectable clock for tests. */
  now?: number;
}

export interface RowCheck {
  error: string | null;
  warning: string | null;
}

/**
 * Verification rules shared by the extraction, CSV import and manual edits.
 * Errors block the commit. Warnings are shown to the reviewer but do not.
 */
export function checkRow(r: RowInput): RowCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const now = r.now ?? Date.now();

  if (!r.label.trim()) errors.push('Titre manquant');

  if (!r.date) {
    errors.push(
      r.dateText
        ? `Date introuvable ou ambiguë : « ${r.dateText} ». À corriger d’après le document.`
        : 'Date manquante',
    );
  } else if (r.date.getTime() < now - 24 * 3600_000) {
    warnings.push('Date déjà passée');
  }

  if (r.timeOfDay && !TIME_RE.test(r.timeOfDay)) errors.push(`Heure invalide : « ${r.timeOfDay} » (format HH:mm)`);
  if (!r.timeOfDay && r.actionType === 'POST') warnings.push('Heure non précisée : à fixer avant la planification');

  if (needsPlatform(r.actionType) && r.platforms.length === 0) errors.push('Aucune plateforme valide');

  if (r.actionType === 'POST') {
    if (!r.caption) warnings.push('Pas de légende : à rédiger avant publication');
    if (!r.assetRef && r.format !== 'TEXT') warnings.push('Pas de média référencé : à joindre');
    if (r.platforms.includes('INSTAGRAM') && r.format === 'TEXT') {
      warnings.push('Instagram ne publie pas de texte seul : choisissez IMAGE, VIDEO, REEL ou STORY');
    }
    if (r.platforms.includes('TIKTOK')) warnings.push('TikTok : publication manuelle (aucune publication automatique)');
  }
  if (r.actionType === 'COMMENT' && !r.caption) warnings.push('Texte du commentaire non fourni : à rédiger');

  if (r.confidence != null && r.confidence < 0.6) {
    warnings.push('Extraction peu fiable : comparez avec l’original');
  }

  return {
    error: errors.length ? errors.join('; ') : null,
    warning: warnings.length ? warnings.join('; ') : null,
  };
}

/** Same action on the same day, time and platforms: used to avoid importing a plan twice. */
export function rowDedupeKey(
  date: Date | null,
  time: string | null,
  platforms: Platform[],
  label: string,
  actionType: PlanActionType,
): string | null {
  if (!date) return null;
  if (needsPlatform(actionType) && !platforms.length) return null;
  return createHash('sha256')
    .update(`${actionType}|${date.toISOString()}|${time ?? ''}|${[...platforms].sort().join(',')}|${label}`)
    .digest('hex')
    .slice(0, 16);
}