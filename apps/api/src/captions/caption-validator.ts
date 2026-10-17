import { CaptionLanguage, Platform } from '@prisma/client';
import { displayTag, isValidTag, normalizeTag } from '../hashtags/hashtag-utils';
import { checkFacts, checkTrendClaims, lintCaption } from './caption-language';
import { PLATFORM_LIMITS } from './caption-rules';

export type TagSource = 'OFFICIAL' | 'LIBRARY' | 'NEW' | 'TREND';

export interface ParsedTag {
  normalized: string;
  display: string;
  reason: string;
  source: TagSource;
}

export interface ParsedVariant {
  tone: string;
  caption: string;
  hashtags: ParsedTag[];
  modelWarnings: string[];
  missingInfo: string[];
}

export interface ValidatedVariant {
  tone: string;
  caption: string;
  hashtags: ParsedTag[];
  warnings: string[];
  missingInfo: string[];
}

export interface ValidationContext {
  platform: Platform;
  language: CaptionLanguage;
  /** Everything the model was allowed to know, as plain text, for the fact check. */
  allowedFacts: string;
  officialTags: Set<string>;
  libraryTags: Set<string>;
  trendTags: Set<string>;
  blockedTags: Set<string>;
  allowAiHashtags: boolean;
}

export class GenerationFormatError extends Error {}

const SOURCES: TagSource[] = ['OFFICIAL', 'LIBRARY', 'NEW', 'TREND'];
const strArr = (v: unknown, max: number, len: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, len)).filter(Boolean).slice(0, max) : [];

/** Strict shape check of the model reply. Throws GenerationFormatError so the caller can retry once. */
export function parseGeneration(raw: unknown, maxVariants: number): ParsedVariant[] {
  if (!raw || typeof raw !== 'object') throw new GenerationFormatError('la réponse n’est pas un objet JSON');
  const list = (raw as { variants?: unknown }).variants;
  if (!Array.isArray(list) || list.length === 0) throw new GenerationFormatError('le champ "variants" est absent ou vide');

  const out: ParsedVariant[] = [];
  for (const v of list.slice(0, maxVariants)) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    if (typeof o.caption !== 'string' || !o.caption.trim()) continue;

    // Hashtags the model put inside the caption are moved to the hashtag list.
    const tags: ParsedTag[] = [];
    const inline: string[] = [];
    const caption = o.caption
      .replace(/#[\p{L}\p{N}_]+/gu, (m) => {
        inline.push(m);
        return '';
      })
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
    if (!caption) continue;

    const rawTags: unknown[] = [...(Array.isArray(o.hashtags) ? o.hashtags : []), ...inline.map((t) => ({ tag: t, source: 'NEW' }))];
    for (const t of rawTags) {
      const obj = typeof t === 'string' ? { tag: t } : (t as Record<string, unknown>);
      if (!obj || typeof obj.tag !== 'string') continue;
      const normalized = normalizeTag(obj.tag);
      if (!isValidTag(normalized)) continue;
      const src = typeof obj.source === 'string' && (SOURCES as string[]).includes(obj.source.toUpperCase()) ? (obj.source.toUpperCase() as TagSource) : 'NEW';
      tags.push({
        normalized,
        display: displayTag(obj.tag),
        reason: typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 160) : '',
        source: src,
      });
    }

    out.push({
      tone: typeof o.tone === 'string' && o.tone.trim() ? o.tone.trim().toLowerCase().slice(0, 30) : 'neutral',
      caption,
      hashtags: tags,
      modelWarnings: strArr(o.warnings, 6, 200),
      missingInfo: strArr(o.missingInfo, 8, 120),
    });
  }
  if (!out.length) throw new GenerationFormatError('aucune variante exploitable (légende manquante)');
  return out;
}

/** Cleans hashtags, corrects false source claims, then lints language, facts and trend claims. */
export function validateVariant(v: ParsedVariant, ctx: ValidationContext): ValidatedVariant {
  const lim = PLATFORM_LIMITS[ctx.platform];
  const warnings = [...v.modelWarnings];
  const seen = new Set<string>();
  const tags: ParsedTag[] = [];

  for (const t of v.hashtags) {
    if (seen.has(t.normalized)) continue;
    seen.add(t.normalized);
    if (ctx.blockedTags.has(t.normalized)) {
      warnings.push(`#${t.display} est bloqué dans la bibliothèque : retiré.`);
      continue;
    }
    let source: TagSource;
    if (ctx.officialTags.has(t.normalized)) source = 'OFFICIAL';
    else if (t.source === 'TREND') {
      if (ctx.trendTags.has(t.normalized)) source = 'TREND';
      else {
        source = ctx.libraryTags.has(t.normalized) ? 'LIBRARY' : 'NEW';
        warnings.push(`#${t.display} : affirmation de tendance non vérifiée retirée.`);
      }
    } else source = ctx.libraryTags.has(t.normalized) ? 'LIBRARY' : 'NEW';

    if (!ctx.allowAiHashtags && source !== 'OFFICIAL') continue; // AI hashtags are off: official tags only
    tags.push({ ...t, source });
  }

  // Official tags always come first, then the model's order, capped to the platform recommendation.
  const official = tags.filter((t) => t.source === 'OFFICIAL');
  const rest = tags.filter((t) => t.source !== 'OFFICIAL');
  const max = Math.min(lim.hashtags, official.length + lim.recommended[1]);
  const finalTags = [...official, ...rest].slice(0, max);
  if (rest.length + official.length > finalTags.length) warnings.push('Certains hashtags ont été retirés pour respecter la limite recommandée.');

  if (v.caption.length > lim.caption) warnings.push(`La légende dépasse ${lim.caption} caractères (${ctx.platform}).`);
  warnings.push(...lintCaption(v.caption, ctx.language));
  warnings.push(...checkFacts(v.caption, ctx.allowedFacts));
  warnings.push(...checkTrendClaims(v.caption, ctx.trendTags.size > 0));

  return {
    tone: v.tone,
    caption: v.caption,
    hashtags: finalTags,
    warnings: [...new Set(warnings)].slice(0, 12),
    missingInfo: v.missingInfo,
  };
}