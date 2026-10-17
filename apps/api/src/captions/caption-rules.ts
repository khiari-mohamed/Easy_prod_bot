import { CaptionLanguage, Platform } from '@prisma/client';

/** The only feature keys Caption Studio uses (they all exist in features/feature-registry.ts). */
export const AI_FEATURE = {
  CAPTIONS: 'ai.captions',
  HASHTAGS: 'ai.hashtags',
  LEARNING: 'ai.learning',
  RANKING: 'ai.performance_ranking',
  TRENDS: 'ai.trends',
} as const;

export const PROMPT_VERSION = 'v2-strict-json';

/** Publication languages are a fixed campaign rule, not a toggle: English can never be selected. */
export const GENERATION_LANGUAGES: CaptionLanguage[] = ['DARIJA', 'FRENCH', 'DARIJA_FRENCH'];

export const PLATFORM_LIMITS: Record<Platform, { caption: number; hashtags: number; recommended: [number, number] }> = {
  INSTAGRAM: { caption: 2200, hashtags: 30, recommended: [4, 8] },
  FACEBOOK: { caption: 5000, hashtags: 30, recommended: [2, 5] },
  TIKTOK: { caption: 2200, hashtags: 30, recommended: [3, 5] },
};

export const DEFAULT_TONES = ['energetic', 'emotional', 'concise'];
export const TONE_RE = /^[a-z][a-z _-]{1,29}$/i;
export const TONE_BRIEF: Record<string, string> = {
  energetic: 'high energy, a hook that stops the scroll, exclamation allowed, makes people want to go this week',
  emotional: 'warm, human, evokes feeling and curiosity without spoilers or fake audience reactions',
  concise: 'very short and direct: one strong line plus the essential information',
};

export type ScriptPref = 'AUTO' | 'ARABIC' | 'LATIN';

const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Every way the release date may legitimately be written, so the fact check does not flag it. */
export function frenchDateVariants(d: Date): string[] {
  const day = d.getUTCDate();
  const m = d.getUTCMonth();
  const y = d.getUTCFullYear();
  const dd = String(day).padStart(2, '0');
  const mm = String(m + 1).padStart(2, '0');
  return [
    `${day} ${FR_MONTHS[m]} ${y}`,
    `${day} ${FR_MONTHS[m]}`,
    `${dd}/${mm}/${y}`,
    `${dd}/${mm}`,
    `${day}/${m + 1}`,
    `${day}.${m + 1}`,
  ];
}