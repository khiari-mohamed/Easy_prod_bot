import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Platform } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../auth/auth.types';
import { FeaturePolicyService } from '../features/feature-policy.service';
import { HashtagsService } from '../hashtags/hashtags.service';
import { normalizeTag } from '../hashtags/hashtag-utils';
import { AddTrendDto, ListTrendsQuery } from './trends.dto';
import { ManualTrendsProvider } from './providers/manual-trends.provider';
import { MetaInsightsTrendsProvider } from './providers/meta-insights-trends.provider';
import { TrendCandidate } from './trend-provider';
import { trendFreshness, usableWhere } from './trend-rules';

export interface UsableTrend {
  tag: string;
  normalizedTag: string;
  source: string;
  region: string;
  observedAt: Date;
  score: number;
  sourceNote: string | null;
}

@Injectable()
export class TrendsService {
  private readonly log = new Logger(TrendsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly policy: FeaturePolicyService,
    private readonly hashtags: HashtagsService,
    private readonly manual: ManualTrendsProvider,
    private readonly meta: MetaInsightsTrendsProvider,
  ) {}

  /** Only verified, unexpired, recent, in-region signals. Nothing here is ever "made up" to fill a gap. */
  async usable(platform: Platform, limit = 10): Promise<UsableTrend[]> {
    const now = new Date();
    const rows = await this.prisma.trendSignal.findMany({
      where: { platform, ...usableWhere(now) },
      include: { hashtag: { select: { displayTag: true } } },
    });
    return rows
      .map((r) => ({ r, v: r.score * trendFreshness(r.observedAt, now) }))
      .sort((a, b) => b.v - a.v)
      .slice(0, limit)
      .map(({ r }) => ({
        tag: r.hashtag?.displayTag ?? r.rawTag,
        normalizedTag: r.normalizedTag || normalizeTag(r.rawTag),
        source: r.source,
        region: r.region,
        observedAt: r.observedAt,
        score: r.score,
        sourceNote: r.sourceNote,
      }));
  }

  async list(q: ListTrendsQuery) {
    const enabled = (await this.policy.evaluate({ feature: 'ai.trends', action: 'READ' })).allowed;
    const items = await this.prisma.trendSignal.findMany({
      where: {
        platform: q.platform,
        ...(q.includeExpired ? {} : { expiresAt: { gt: new Date() } }),
      },
      include: { hashtag: { select: { displayTag: true } } },
      orderBy: { observedAt: 'desc' },
      take: 300,
    });
    const now = Date.now();
    return {
      enabled,
      items: items.map((i) => ({
        ...i,
        tag: i.hashtag?.displayTag ?? i.rawTag,
        expired: i.expiresAt.getTime() <= now,
      })),
    };
  }

  async add(dto: AddTrendDto, user: AuthUser) {
    return this.ingest([this.manual.toCandidate(dto)], user.id);
  }

  async importBatch(rows: AddTrendDto[], user: AuthUser) {
    return this.ingest(rows.map((r) => this.manual.toCandidate(r)), user.id);
  }

  async remove(id: string, user: AuthUser) {
    const row = await this.prisma.trendSignal.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Tendance introuvable');
    await this.prisma.trendSignal.delete({ where: { id } });
    await this.audit.log(user.id, 'trend.delete', 'TrendSignal', id, { tag: row.rawTag, platform: row.platform });
    return { ok: true };
  }

  /** Admin button: same gates as the cron. */
  async syncNow(user: AuthUser) {
    const stored = await this.syncMeta();
    await this.audit.log(user.id, 'trend.sync', 'TrendSignal', undefined, { stored });
    return { stored };
  }

  @Cron('0 */6 * * *')
  async cron() {
    try {
      await this.syncMeta();
    } catch (e) {
      this.log.warn(`Trend sync failed: ${(e as Error).message}`);
    }
  }

  @Cron('30 3 * * *')
  async purge() {
    const cutoff = new Date(Date.now() - 30 * 86_400_000);
    const res = await this.prisma.trendSignal.deleteMany({ where: { expiresAt: { lt: cutoff } } });
    if (res.count) this.log.log(`Purged ${res.count} expired trend signals`);
  }

  private async syncMeta(): Promise<number> {
    // Policy right before the external calls: trends must be switched on AND collection allowed
    // (this also covers the emergency stop and the environment ceiling).
    const trends = await this.policy.evaluate({ feature: 'ai.trends', need: 'AUTO', fresh: true, action: 'SYNC' });
    const collect = await this.policy.evaluate({ feature: 'analytics.collection', need: 'AUTO', fresh: true, action: 'SYNC' });
    if (!trends.allowed || !collect.allowed) return 0;
    return this.ingest(await this.meta.collect());
  }

  private async ingest(candidates: TrendCandidate[], userId?: string): Promise<number> {
    if (!candidates.length) return 0;
    const map = await this.hashtags.upsertMany(
      candidates.map((c) => ({ display: c.tag, origin: 'TREND_SOURCE' as const, createdById: userId ?? null })),
    );
    const now = new Date();
    let stored = 0;
    for (const c of candidates) {
      const normalizedTag = normalizeTag(c.tag);
      const hashtag = map.get(normalizedTag);
      if (!hashtag) continue;
      if (hashtag.blocked) continue; // a blocked tag never becomes a "trend"
      const data = {
        hashtagId: hashtag.id,
        rawTag: c.tag,
        score: c.score,
        observedAt: now,
        expiresAt: new Date(now.getTime() + c.ttlHours * 3_600_000),
        sourceNote: c.sourceNote,
        createdById: userId ?? null,
      };
      await this.prisma.trendSignal.upsert({
        where: {
          platform_normalizedTag_source_region: {
            platform: c.platform,
            normalizedTag,
            source: c.source,
            region: c.region,
          },
        },
        create: { platform: c.platform, normalizedTag, source: c.source, region: c.region, ...data },
        update: data,
      });
      stored++;
    }
    if (userId) await this.audit.log(userId, 'trend.ingest', 'TrendSignal', undefined, { stored });
    return stored;
  }

  /** Guard used by callers that must not accept trend data when the feature is off. */
  async assertEnabled() {
    const d = await this.policy.evaluate({ feature: 'ai.trends', action: 'WRITE' });
    if (!d.allowed) throw new ForbiddenException(d.reason);
  }
}