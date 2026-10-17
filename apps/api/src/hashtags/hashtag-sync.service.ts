import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { FeaturePolicyService } from '../features/feature-policy.service';
import { HashtagsService } from './hashtags.service';
import { normalizeTag } from './hashtag-utils';

const DAY_MS = 86_400_000;
const METRIC_ENGAGEMENT = ['likes', 'comments', 'shares', 'saves'] as const;

/**
 * Background learning loop. It only READS posts and metrics and WRITES library statistics:
 * it never publishes, edits a post or calls an external API, so it cannot trigger a duplicate publication.
 *  1. every published post's hashtags become HashtagUsage rows (idempotent);
 *  2. latest metrics become HashtagPerformance rows (only when ai.performance_ranking is on).
 * A metric the platform did not return stays NULL: unavailable is not zero.
 */
@Injectable()
export class HashtagSyncService {
  private readonly log = new Logger(HashtagSyncService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hashtags: HashtagsService,
    private readonly policy: FeaturePolicyService,
  ) {}

  @Cron('*/30 * * * *')
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const usage = await this.syncUsage();
      const perf = await this.syncPerformance();
      if (usage || perf) this.log.log(`Hashtag sync: ${usage} posts recorded, ${perf} measurements updated`);
    } catch (e) {
      this.log.warn(`Hashtag sync failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async syncUsage(): Promise<number> {
    const since = new Date(Date.now() - 120 * DAY_MS);
    const posts = await this.prisma.post.findMany({
      where: {
        status: 'PUBLISHED',
        hashtags: { isEmpty: false },
        hashtagUsages: { none: {} },
        OR: [{ publishedAt: { gte: since } }, { publishedAt: null }],
      },
      select: { id: true, platform: true, hashtags: true, publishedAt: true },
      take: 200,
      orderBy: { publishedAt: 'desc' },
    });
    let done = 0;
    for (const p of posts) {
      const map = await this.hashtags.upsertMany(p.hashtags.map((display) => ({ display, origin: 'IMPORTED' as const })));
      if (!map.size) continue;
      await this.prisma.hashtagUsage.createMany({
        data: [...map.values()].map((h) => ({
          postId: p.id,
          hashtagId: h.id,
          platform: p.platform,
          usedAt: p.publishedAt ?? new Date(),
        })),
        skipDuplicates: true,
      });
      done++;
    }
    return done;
  }

  async syncPerformance(): Promise<number> {
    const gate = await this.policy.evaluate({ feature: 'ai.performance_ranking', need: 'AUTO', fresh: true, action: 'SYNC' });
    if (!gate.allowed) return 0;

    const since = new Date(Date.now() - 120 * DAY_MS);
    const usages = await this.prisma.hashtagUsage.findMany({
      where: { usedAt: { gte: since } },
      select: { postId: true, hashtagId: true, platform: true },
      take: 3000,
    });
    if (!usages.length) return 0;

    const postIds = [...new Set(usages.map((u) => u.postId))];
    const snaps = await this.prisma.metricSnapshot.findMany({
      where: { postId: { in: postIds } },
      orderBy: { capturedAt: 'desc' },
      distinct: ['postId'],
    });
    const byPost = new Map(snaps.map((s) => [s.postId, s]));

    let done = 0;
    for (const u of usages) {
      const s = byPost.get(u.postId);
      if (!s) continue;
      const missing = new Set(s.unavailable);
      const parts = METRIC_ENGAGEMENT.filter((m) => !missing.has(m));
      const engagements = parts.length ? parts.reduce((sum, m) => sum + s[m], 0) : null;
      const reach = missing.has('reach') ? null : s.reach;
      const impressions = missing.has('views') ? null : s.views;
      if (engagements === null && reach === null && impressions === null) continue;

      // Honest attribution: every tag of the post shares the post's result. It is a correlation, not a cause.
      await this.prisma.hashtagPerformance.upsert({
        where: { hashtagId_platform_postId: { hashtagId: u.hashtagId, platform: u.platform, postId: u.postId } },
        create: { hashtagId: u.hashtagId, platform: u.platform, postId: u.postId, engagements, reach, impressions },
        update: { engagements, reach, impressions, measuredAt: new Date() },
      });
      done++;
    }
    return done;
  }

  /** Used by tests and admin tooling. */
  normalize(tag: string) {
    return normalizeTag(tag);
  }
}