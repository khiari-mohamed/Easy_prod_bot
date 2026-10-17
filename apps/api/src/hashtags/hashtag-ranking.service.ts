import { Injectable } from '@nestjs/common';
import { CaptionLanguage, Hashtag, Platform } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FeaturePolicyService } from '../features/feature-policy.service';
import { usableWhere, trendFreshness } from '../trends/trend-rules';
import { HashtagsService } from './hashtags.service';
import { normalizeTag } from './hashtag-utils';

/** Illustrative starting weights: tune them with real results, not assumptions about platform algorithms. */
export const WEIGHTS = { relevance: 0.4, performance: 0.25, feedback: 0.2, trend: 0.15 } as const;
const PERF_HALF_LIFE_DAYS = 30;
const FEEDBACK_HALF_LIFE_DAYS = 60;
const PRIOR_OBSERVATIONS = 3; // shrinkage: a tag with 1 lucky post does not jump to the top
const NEUTRAL = 0.5; // unknown is not bad: new tags are never scored 0 for lack of history
const DAY_MS = 86_400_000;

const decay = (ageDays: number, halfLife: number) => Math.pow(0.5, Math.max(ageDays, 0) / halfLife);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const STOP = new Set(['dans', 'pour', 'avec', 'cette', 'nous', 'vous', 'plus', 'tout', 'tous', 'bientot', 'votre', 'notre', 'sont', 'fait']);

export interface RankInput {
  platform: Platform;
  language?: CaptionLanguage | null;
  campaignId?: string | null;
  /** Free text describing the post (title, plan entry, caption): the relevance signal. */
  context: string;
  limit?: number;
  usePerformance: boolean;
  useFeedback: boolean;
  useTrends: boolean;
}

export interface RankedHashtag {
  id: string;
  tag: string;
  normalizedTag: string;
  origin: Hashtag['origin'];
  official: boolean;
  score: number;
  breakdown: { relevance: number; performance: number | null; feedback: number | null; trend: number | null };
  weights: { relevance: number; performance: number; feedback: number; trend: number };
  reasons: string[];
}

function tokens(text: string): string[] {
  const words = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  return [...new Set((words ?? []).filter((w) => w.length >= 4 && !STOP.has(w)))];
}

@Injectable()
export class HashtagRankingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashtags: HashtagsService,
    private readonly policy: FeaturePolicyService,
  ) {}

  /** Policy-aware entry point (controllers, Caption Studio). Each signal is used only if its feature is on. */
  async recommendFor(p: {
    platform: Platform;
    language?: CaptionLanguage | null;
    campaignId?: string | null;
    context: string;
    limit?: number;
  }) {
    const ask = async (feature: string) =>
      (await this.policy.evaluate({ feature, campaignId: p.campaignId, platform: p.platform, action: 'RANK' })).allowed;
    const [performance, feedback, trends] = await Promise.all([
      ask('ai.performance_ranking'),
      ask('ai.learning'),
      ask('ai.trends'),
    ]);
    const items = await this.recommend({
      ...p,
      usePerformance: performance,
      useFeedback: feedback,
      useTrends: trends,
    });
    return { items, flags: { performance, feedback, trends } };
  }

  async recommend(input: RankInput): Promise<RankedHashtag[]> {
    const now = new Date();
    const limit = Math.min(Math.max(input.limit ?? 12, 1), 40);

    const campaign = input.campaignId
      ? await this.prisma.campaign.findUnique({
          where: { id: input.campaignId },
          select: { titleLatin: true, titleArabic: true, hashtags: true },
        })
      : null;
    if (campaign?.hashtags.length) {
      await this.hashtags.upsertMany(campaign.hashtags.map((display) => ({ display, origin: 'MANUAL' as const })));
    }
    const official = new Set((campaign?.hashtags ?? []).map(normalizeTag));
    const titleTokens = tokens(`${campaign?.titleLatin ?? ''} ${campaign?.titleArabic ?? ''}`);
    const ctxTokens = tokens(input.context);

    const pool = await this.prisma.hashtag.findMany({
      where: { blocked: false },
      orderBy: { createdAt: 'desc' },
      take: 800,
    });

    const [perfRows, feedbackRows, trendRows] = await Promise.all([
      input.usePerformance ? this.loadPerformance(input.platform, now) : Promise.resolve([]),
      input.useFeedback ? this.loadFeedback(input.platform) : Promise.resolve([]),
      input.useTrends ? this.loadTrends(input.platform, now) : Promise.resolve([]),
    ]);

    // --- performance: platform-normalised engagement rate, time-decayed, shrunk toward the platform mean
    const rate = (r: { engagements: number | null; reach: number | null; impressions: number | null }) => {
      const denom = r.reach ?? r.impressions;
      return r.engagements !== null && denom && denom > 0 ? r.engagements / denom : null;
    };
    const rated = perfRows.map((r) => ({ ...r, rate: rate(r) })).filter((r) => r.rate !== null) as Array<
      (typeof perfRows)[number] & { rate: number }
    >;
    const platformMean = rated.length ? rated.reduce((s, r) => s + r.rate, 0) / rated.length : 0;
    const perfByTag = new Map<string, { w: number; wr: number }>();
    for (const r of rated) {
      const w = decay((now.getTime() - r.measuredAt.getTime()) / DAY_MS, PERF_HALF_LIFE_DAYS);
      const cur = perfByTag.get(r.hashtagId) ?? { w: 0, wr: 0 };
      cur.w += w;
      cur.wr += w * r.rate;
      perfByTag.set(r.hashtagId, cur);
    }

    // --- feedback: decayed approvals vs rejections, Laplace-smoothed
    const fbByTag = new Map<string, { a: number; r: number }>();
    for (const f of feedbackRows) {
      const w = decay((now.getTime() - f.at.getTime()) / DAY_MS, FEEDBACK_HALF_LIFE_DAYS);
      const cur = fbByTag.get(f.hashtagId) ?? { a: 0, r: 0 };
      if (f.status === 'APPROVED') cur.a += w;
      else cur.r += w;
      fbByTag.set(f.hashtagId, cur);
    }

    // --- trends: verified, unexpired signals only, decayed by age
    const trendByTag = new Map<string, number>();
    for (const t of trendRows) {
      const key = t.normalizedTag || normalizeTag(t.rawTag);
      const v = clamp01(t.score) * trendFreshness(t.observedAt, now);
      if (v > (trendByTag.get(key) ?? 0)) trendByTag.set(key, v);
    }

    const active = {
      relevance: true,
      performance: input.usePerformance && platformMean > 0,
      feedback: input.useFeedback && feedbackRows.length > 0,
      trend: input.useTrends && trendRows.length > 0,
    };
    // A signal that has no data at all for this platform is dropped and its weight redistributed.
    const totalW =
      (active.relevance ? WEIGHTS.relevance : 0) +
      (active.performance ? WEIGHTS.performance : 0) +
      (active.feedback ? WEIGHTS.feedback : 0) +
      (active.trend ? WEIGHTS.trend : 0);
    const w = {
      relevance: WEIGHTS.relevance / totalW,
      performance: active.performance ? WEIGHTS.performance / totalW : 0,
      feedback: active.feedback ? WEIGHTS.feedback / totalW : 0,
      trend: active.trend ? WEIGHTS.trend / totalW : 0,
    };

    const ranked: RankedHashtag[] = pool.map((h) => {
      const reasons: string[] = [];
      const isOfficial = official.has(h.normalizedTag);

      // relevance
      let relevance: number;
      if (isOfficial) {
        relevance = 1;
        reasons.push('Hashtag officiel de la campagne');
      } else {
        const matches = ctxTokens.filter(
          (t) => h.normalizedTag.includes(t) || (h.normalizedTag.length >= 4 && t.includes(h.normalizedTag)),
        ).length;
        const overlap = Math.min(1, matches / 2);
        const title = titleTokens.some((t) => h.normalizedTag.includes(t)) ? 1 : 0;
        let lang = 1;
        if (h.language && input.language && input.language !== 'DARIJA_FRENCH' && h.language !== input.language) {
          lang = h.language === 'DARIJA_FRENCH' ? 0.7 : 0;
        }
        relevance = clamp01(0.2 + 0.45 * overlap + 0.2 * title + 0.15 * lang);
        if (overlap > 0) reasons.push('Lié au contenu du post');
        if (title) reasons.push('Contient le titre du film');
        if (lang === 0) reasons.push('Langue différente de la légende');
      }

      // performance
      let performance: number | null = null;
      if (active.performance) {
        const p = perfByTag.get(h.id);
        if (p) {
          const est = (p.wr + PRIOR_OBSERVATIONS * platformMean) / (p.w + PRIOR_OBSERVATIONS);
          const ratio = est / platformMean;
          performance = (ratio * ratio) / (1 + ratio * ratio);
          reasons.push(ratio >= 1 ? 'Performances mesurées au-dessus de la moyenne' : 'Performances mesurées sous la moyenne');
        } else {
          performance = NEUTRAL;
          reasons.push('Pas encore mesuré (score neutre)');
        }
      }

      // human feedback
      let feedback: number | null = null;
      if (active.feedback) {
        const f = fbByTag.get(h.id);
        if (f) {
          feedback = (f.a + 1) / (f.a + f.r + 2);
          reasons.push(f.a >= f.r ? 'Souvent approuvé par l’équipe' : 'Souvent retiré par l’équipe');
        } else feedback = NEUTRAL;
      }

      // trend
      let trend: number | null = null;
      if (active.trend) {
        trend = trendByTag.get(h.normalizedTag) ?? 0;
        if (trend > 0) reasons.push('Signal de tendance vérifié et récent');
      }

      const score =
        w.relevance * relevance +
        w.performance * (performance ?? 0) +
        w.feedback * (feedback ?? 0) +
        w.trend * (trend ?? 0);

      return {
        id: h.id,
        tag: h.displayTag,
        normalizedTag: h.normalizedTag,
        origin: h.origin,
        official: isOfficial,
        score: Math.round(score * 1000) / 1000,
        breakdown: {
          relevance: Math.round(relevance * 1000) / 1000,
          performance: performance === null ? null : Math.round(performance * 1000) / 1000,
          feedback: feedback === null ? null : Math.round(feedback * 1000) / 1000,
          trend: trend === null ? null : Math.round(trend * 1000) / 1000,
        },
        weights: w,
        reasons,
      };
    });

    return ranked.sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag)).slice(0, limit);
  }

  private loadPerformance(platform: Platform, now: Date) {
    return this.prisma.hashtagPerformance.findMany({
      where: { platform, measuredAt: { gte: new Date(now.getTime() - 120 * DAY_MS) } },
      select: { hashtagId: true, engagements: true, reach: true, impressions: true, measuredAt: true },
    });
  }

  /** Only explicit human decisions count: APPROVED and REJECTED. Anything else is not a signal. */
  private async loadFeedback(platform: Platform) {
    const rows = await this.prisma.hashtagSuggestion.findMany({
      where: { status: { in: ['APPROVED', 'REJECTED'] }, captionSuggestion: { platform } },
      select: { hashtagId: true, status: true, captionSuggestion: { select: { updatedAt: true } } },
      orderBy: { captionSuggestion: { updatedAt: 'desc' } },
      take: 5000,
    });
    return rows.map((r) => ({ hashtagId: r.hashtagId, status: r.status, at: r.captionSuggestion.updatedAt }));
  }

  private loadTrends(platform: Platform, now: Date) {
    return this.prisma.trendSignal.findMany({
      where: { platform, ...usableWhere(now) },
      select: { normalizedTag: true, rawTag: true, score: true, observedAt: true },
    });
  }
}