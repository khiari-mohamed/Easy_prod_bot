import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { Campaign, CampaignDay, CaptionLanguage, Platform, PostFormat } from '@prisma/client';
import { getEnv } from '../env';

export { CaptionLanguage };

export interface CaptionRequest {
  campaign: Campaign;
  platform: Platform;
  format: PostFormat;
  day?: CampaignDay | null;
  extraBrief?: string;
  language?: CaptionLanguage;
  variants?: number;
}

export interface CaptionVariant {
  caption: string;
  hashtags: string[];
}

export interface CaptionResult {
  source: 'ai' | 'template';
  variants: CaptionVariant[];
}

const LANGUAGE_RULES: Record<CaptionLanguage, string> = {
  FRENCH: 'Write in French only. No English, no Arabic, no Tunisian dialect.',
  DARIJA_FRENCH:
    'Write mainly in French, with short Tunisian Darija (Arabic script) touches where natural. Keep the Arabic title exactly as given. No English, no Modern Standard Arabic (fusha).',
  DARIJA:
    'Write entirely in Tunisian Darija using Arabic script, with a few French words mixed in the way young Tunisians do on TikTok and Instagram. Keep it natural and conversational. No English, no Modern Standard Arabic (fusha).',
};

const LANGUAGE_VALIDATION: Record<CaptionLanguage, string> = {
  FRENCH:
    'IMPORTANT: Your output must be in French only. If you find yourself writing in English or Arabic, stop and rewrite in French.',
  DARIJA_FRENCH:
    'IMPORTANT: Your output must be French + Tunisian Darija only. If you find yourself writing in English or Modern Standard Arabic (fusha), stop and rewrite.',
  DARIJA:
    'IMPORTANT: Your output must be Tunisian Darija (Arabic script) + French only. If you find yourself writing in English or Modern Standard Arabic (fusha), stop and rewrite.',
};

const PLATFORM_RULES: Record<Platform, string> = {
  INSTAGRAM:
    'Instagram: cinematic and polished. A strong first line, short body, a clear call to action. Max 2 or 3 emojis.',
  FACEBOOK:
    'Facebook: warm and informative, slightly longer is fine, practical details welcome. Max 2 emojis.',
  TIKTOK:
    'TikTok: spontaneous, playful, punchy. One short hook line, very short caption, trend-aware but never cringe.',
};

export function defaultLanguage(platform: Platform): CaptionLanguage {
  return platform === 'TIKTOK' ? 'DARIJA' : 'DARIJA_FRENCH';
}

export const ALLOWED_LANGUAGES: CaptionLanguage[] = ['DARIJA', 'FRENCH', 'DARIJA_FRENCH'];

export function isAllowedLanguage(v: unknown): v is CaptionLanguage {
  return ALLOWED_LANGUAGES.includes(v as CaptionLanguage);
}

@Injectable()
export class AiService {
  private readonly log = new Logger(AiService.name);

  get enabled(): boolean {
    return !!getEnv().ANTHROPIC_API_KEY;
  }

  async captions(req: CaptionRequest): Promise<CaptionResult> {
    const n = Math.min(Math.max(req.variants ?? 1, 1), 4);
    if (!this.enabled) return { source: 'template', variants: [this.template(req)] };

    try {
      const variants = await this.callModel(req, n);
      if (variants.length) return { source: 'ai', variants };
      this.log.warn('Model returned no usable variants, using the template');
    } catch (e) {
      this.log.error(`Caption generation failed: ${(e as Error).message}`);
    }
    return { source: 'template', variants: [this.template(req)] };
  }

  private async callModel(req: CaptionRequest, n: number): Promise<CaptionVariant[]> {
    const env = getEnv();
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const language = req.language ?? defaultLanguage(req.platform);
    const { campaign, day } = req;

    const system = [
      'You write social media captions for the promotion of a Tunisian feature film, for its distributor.',
      'HARD RULES:',
      '- Use ONLY the facts in the CAMPAIGN FACTS section. Never invent venues, times, showtimes, ticket links, quotes, names, awards, reviews or audience reactions.',
      '- If a fact you need is missing (venue, time, cinema list, ticket link, a handle), write a visible placeholder in capitals in square brackets, such as [LIEU], [HEURE], [LIEN BILLETS], [@ACTEUR]. Never guess.',
      '- No spoilers. No claims that people loved the film unless the facts say reactions were recorded.',
      `- ${LANGUAGE_RULES[language]}`,
      `- ${LANGUAGE_VALIDATION[language]}`,
      `- ${PLATFORM_RULES[req.platform]}`,
      '- Do not put hashtags inside the caption; return them separately (without the # sign), at most 5, in addition to the official ones.',
      `Reply with ONLY valid JSON: {"variants":[{"caption":"...","hashtags":["..."]}]} containing exactly ${n} variant(s).`,
    ].join('\n');

    const facts = [
      `Film title (Latin): ${campaign.titleLatin}`,
      campaign.titleArabic ? `Film title (Arabic): ${campaign.titleArabic}` : '',
      `In cinemas: ${campaign.releaseDate.toISOString().slice(0, 10)}`,
      `Official hashtags: ${campaign.hashtags.join(', ') || '(none)'}`,
      campaign.brief ? `Notes and facts:\n${campaign.brief}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const today = day
      ? [
          `Campaign day: ${day.label} (phase ${day.phase})`,
          `Planned content: ${day.content}`,
          `Execution notes: ${day.execution}`,
          `Objective: ${day.objective}`,
        ].join('\n')
      : 'No specific campaign day.';

    const user = [
      '## CAMPAIGN FACTS',
      facts,
      '',
      '## TODAY',
      today,
      '',
      '## TASK',
      `Write ${n} caption variant(s) for a ${req.format} post on ${req.platform}.`,
      req.extraBrief ? `Extra instructions from the team: ${req.extraBrief}` : '',
    ].join('\n');

    const msg = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return this.parse(text, campaign.hashtags, n);
  }

  private parse(text: string, official: string[], n: number): CaptionVariant[] {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [];
    let json: any;
    try {
      json = JSON.parse(match[0]);
    } catch {
      return [];
    }
    const raw: any[] = Array.isArray(json.variants) ? json.variants : [];
    return raw
      .filter((v) => v && typeof v.caption === 'string' && v.caption.trim())
      .slice(0, n)
      .map((v) => {
        const extra: string[] = Array.isArray(v.hashtags)
          ? v.hashtags.filter((h: unknown) => typeof h === 'string')
          : [];
        const tags = [...official, ...extra].map((h) => h.replace(/^#/, '').replace(/\s+/g, ''));
        return { caption: v.caption.trim(), hashtags: [...new Set(tags)].filter(Boolean).slice(0, 10) };
      });
  }

  private template(req: CaptionRequest): CaptionVariant {
    const title = req.campaign.titleLatin;
    const hook = req.day ? req.day.label.replace(/^\d+\s+\w+\s+[—-]\s*/, '') : title;
    const caption = `[ACCROCHE À RÉDIGER] ${hook} | ${title}${
      req.campaign.titleArabic ? ` ${req.campaign.titleArabic}` : ''
    }. Au cinéma le ${req.campaign.releaseDate.getUTCDate()} octobre. [LIEN BILLETS]`;
    return { caption, hashtags: req.campaign.hashtags };
  }

  assertEnabled() {
    if (!this.enabled) throw new BadRequestException('ANTHROPIC_API_KEY is not configured: AI captions are off');
  }
}
