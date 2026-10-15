import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Platform, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { audience, engagementRate, interactions, mergeSnapshots, METRIC_FIELDS, MetricField } from '../common/engagement';
import { computeBestTime, BestTime } from './best-time';
import { InsightsService } from './insights.service';
import { ImportRowDto } from './analytics.dto';
import { dayKey, previousRange, Range } from './analytics-range';
import { backgroundSyncEnabled, metaGuard } from '../meta/meta-guard';

const PLATFORMS: Platform[] = ['INSTAGRAM', 'FACEBOOK', 'TIKTOK'];

export interface Filter {
  range: Range;
  platforms?: Platform[];
}

type Row = Awaited<ReturnType<AnalyticsService['published']>>[number];

@Injectable()
export class AnalyticsService {
  private readonly log = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly insights: InsightsService,
  ) {}

  /**
   * Published posts with their effective metrics: per metric, the most recent snapshot in which it was
   * available. A metric that was never available is null ("unavailable"), never 0.
   */
  async published(filter: Filter = { range: {} }) {
    const where: Prisma.PostWhereInput = { status: 'PUBLISHED' };
    const { from, to } = filter.range;
    if (from || to) where.publishedAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    if (filter.platforms?.length) where.platform = { in: filter.platforms };
    const posts = await this.prisma.post.findMany({
      where,
      include: { metrics: { orderBy: { capturedAt: 'desc' }, take: 30 } },
    });
    return posts.filter((p) => p.metrics.length > 0).map((p) => ({ post: p, m: mergeSnapshots(p.metrics) }));
  }

  /** Totals for a group of posts. Sums only posts where the metric is available; null if none. */
  private summarize(platform: Platform | 'ALL', mine: Row[]) {
    const total = (f: MetricField): number | null => {
      const have = mine.filter((r) => r.m[f] !== null);
      return have.length ? have.reduce((a, r) => a + (r.m[f] as number), 0) : null;
    };
    const coverage = Object.fromEntries(
      METRIC_FIELDS.map((f) => [f, mine.filter((r) => r.m[f] !== null).length]),
    ) as Record<MetricField, number>;
    const rated = mine.filter((r) => engagementRate(r.m) !== null);
    const totalAudience = rated.reduce((a, r) => a + audience(r.m), 0);
    const totalInteractions = rated.reduce((a, r) => a + (interactions(r.m) ?? 0), 0);
    const withInter = mine.filter((r) => interactions(r.m) !== null);
    return {
      platform,
      posts: mine.length,
      views: total('views'),
      reach: total('reach'),
      likes: total('likes'),
      comments: total('comments'),
      shares: total('shares'),
      saves: total('saves'),
      interactions: withInter.length ? withInter.reduce((a, r) => a + (interactions(r.m) as number), 0) : null,
      coverage,
      engagementRate: totalAudience > 0 ? totalInteractions / totalAudience : null,
    };
  }

  async overview(filter: Filter) {
    const rows = await this.published(filter);
    const statusCounts = await this.prisma.post.groupBy({ by: ['status'], _count: { _all: true } });

    const platforms = PLATFORMS.map((p) => this.summarize(p, rows.filter((r) => r.post.platform === p)));
    const totals = this.summarize('ALL', rows);

    const prev = previousRange(filter.range);
    const previousTotals = prev
      ? this.summarize('ALL', await this.published({ range: prev, platforms: filter.platforms }))
      : null;

    const topPosts = rows
      .filter((r) => audience(r.m) >= 100 && engagementRate(r.m) !== null) // ignore tiny denominators
      .map((r) => ({
        id: r.post.id,
        platform: r.post.platform,
        caption: r.post.caption.slice(0, 120),
        publishedAt: r.post.publishedAt,
        externalUrl: r.post.externalUrl,
        views: r.m.views,
        reach: r.m.reach,
        interactions: interactions(r.m),
        engagementRate: engagementRate(r.m) as number,
      }))
      .sort((a, b) => b.engagementRate - a.engagementRate)
      .slice(0, 8);

    return {
      statusCounts: Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all])),
      totals,
      previousTotals,
      platforms,
      topPosts,
    };
  }

  /** One point per (day in Tunis time, platform). */
  async timeseries(filter: Filter) {
    const rows = await this.published(filter);
    const groups = new Map<string, { date: string; platform: Platform; rows: Row[] }>();
    for (const r of rows) {
      if (!r.post.publishedAt) continue;
      const date = dayKey(r.post.publishedAt);
      const key = `${date}|${r.post.platform}`;
      const g = groups.get(key) ?? { date, platform: r.post.platform, rows: [] };
      g.rows.push(r);
      groups.set(key, g);
    }
    return [...groups.values()]
      .sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform))
      .map((g) => ({ date: g.date, ...this.summarize(g.platform, g.rows), platform: g.platform }));
  }

  /** Flat list used by the table and the exports (capped). */
  async postsTable(filter: Filter) {
    const rows = await this.published(filter);
    return rows
      .sort((a, b) => (b.post.publishedAt?.getTime() ?? 0) - (a.post.publishedAt?.getTime() ?? 0))
      .slice(0, 1000)
      .map((r) => ({
        id: r.post.id,
        platform: r.post.platform,
        format: r.post.format,
        caption: r.post.caption,
        publishedAt: r.post.publishedAt,
        externalUrl: r.post.externalUrl,
        isExternal: r.post.isExternal,
        views: r.m.views,
        reach: r.m.reach,
        likes: r.m.likes,
        comments: r.m.comments,
        shares: r.m.shares,
        saves: r.m.saves,
        interactions: interactions(r.m),
        engagementRate: engagementRate(r.m),
      }));
  }

  /** Best times use the full history (a narrow date filter would make every suggestion "provisional"). */
  async bestTimes() {
    const rows = await this.published();
    const result: Record<string, BestTime & { followerActivity?: number[] | null }> = {};
    for (const platform of PLATFORMS) {
      const points = rows
        .filter((r) => r.post.platform === platform && r.post.publishedAt && engagementRate(r.m) !== null)
        .map((r) => ({ publishedAt: r.post.publishedAt!, rate: engagementRate(r.m) as number }));
      result[platform] = computeBestTime(platform, points);
    }

    // Instagram can tell us when followers are online: a useful prior while our own history is thin.
    const ig = await this.accounts.activeFor('INSTAGRAM');
    if (ig) result.INSTAGRAM.followerActivity = await this.insights.instagramOnlineFollowers(ig, this.accounts.token(ig));
    return result;
  }

  /** Pull fresh metrics every 2 hours (was every 30 min). Skipped while Meta calls are paused. */
  @Cron('0 0 */2 * * *')
  async scheduledSync() {
    if (!backgroundSyncEnabled() || metaGuard.isOpen()) return; // META_BACKGROUND_SYNC=false to disable
    try {
      await this.sync();
    } catch (e) {
      this.log.error(`Metric sync failed: ${(e as Error).message}`);
    }
  }

  async sync() {
    if (metaGuard.isOpen()) {
      return { checked: 0, updated: 0, skipped: 0, paused: metaGuard.status().reason };
    }
    const since = new Date(Date.now() - 7 * 24 * 3600_000);
    const posts = await this.prisma.post.findMany({
      where: {
        status: 'PUBLISHED',
        isExternal: false,
        externalId: { not: null },
        platform: { in: ['FACEBOOK', 'INSTAGRAM'] },
        publishedAt: { gte: since },
      },
      include: { metrics: { orderBy: { capturedAt: 'desc' }, take: 1, select: { capturedAt: true } } },
      orderBy: { publishedAt: 'desc' },
      take: 15,
    });

    let updated = 0;
    let skipped = 0;
    for (const post of posts) {
      if (metaGuard.isOpen()) break;
      // Do not re-read what was read recently: 90 min for posts under 48 h old, 12 h for older ones.
      const ageMs = Date.now() - (post.publishedAt?.getTime() ?? Date.now());
      const minGapMs = ageMs < 48 * 3600_000 ? 90 * 60_000 : 12 * 3600_000;
      const lastAt = post.metrics[0]?.capturedAt.getTime() ?? 0;
      if (Date.now() - lastAt < minGapMs) {
        skipped++;
        continue;
      }
      const account = post.accountId
        ? await this.prisma.socialAccount.findUnique({ where: { id: post.accountId } })
        : await this.accounts.activeFor(post.platform);
      if (!account || account.status !== 'ACTIVE') continue;

      const m = await this.insights.fetch(post, account, this.accounts.token(account));
      // Nothing readable (every metric unavailable): do not store an empty snapshot.
      if (!m || Object.keys(m.values).length === 0) continue;
      await this.prisma.metricSnapshot.create({
        data: { postId: post.id, source: 'API', ...m.values, unavailable: m.unavailable },
      });
      updated++;
    }
    return { checked: posts.length, updated, skipped };
  }

  /**
   * Import posts published before this tool existed (e.g. Oct 3-9 from Meta Business Suite / TikTok
   * Analytics exports) so best-time and top-post analysis has history from day one.
   */
  async importRows(rows: ImportRowDto[]) {
    let created = 0;
    let updated = 0;
    for (const row of rows) {
      // Only the columns present in the file are real numbers; the rest are UNAVAILABLE (not 0).
      const provided: Partial<Record<MetricField, number>> = {};
      for (const f of METRIC_FIELDS) {
        const v = (row as unknown as Record<string, number | undefined>)[f];
        if (typeof v === 'number' && Number.isFinite(v)) provided[f] = v;
      }
      const metrics = {
        ...provided,
        unavailable: METRIC_FIELDS.filter((f) => provided[f] === undefined) as string[],
      };
      const existing = row.externalUrl
        ? await this.prisma.post.findFirst({ where: { platform: row.platform, externalUrl: row.externalUrl } })
        : null;

      if (existing) {
        await this.prisma.metricSnapshot.create({ data: { postId: existing.id, source: 'IMPORT', ...metrics } });
        updated++;
      } else {
        await this.prisma.post.create({
          data: {
            platform: row.platform,
            format: row.format ?? 'REEL',
            caption: row.caption ?? '(imported)',
            hashtags: [],
            status: 'PUBLISHED',
            isExternal: true,
            publishedAt: new Date(row.publishedAt),
            externalUrl: row.externalUrl,
            statusNote: 'Imported from platform analytics',
            metrics: { create: { source: 'IMPORT', ...metrics } },
          },
        });
        created++;
      }
    }
    return { created, updated };
  }
}