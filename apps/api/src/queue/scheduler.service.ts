import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.module';
import { FeaturePolicyService } from '../features/feature-policy.service';
import { supportsAutoPublish } from '../posts/post.rules';
import { withState } from '../posts/post-state';
import { QueueService } from './queue.service';

const MISSED_AFTER_MS = 30 * 60_000;
const STUCK_AFTER_MS = 15 * 60_000;

@Injectable()
export class SchedulerService {
  private readonly log = new Logger(SchedulerService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly queue: QueueService,
    private readonly policy: FeaturePolicyService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.run();
    } catch (e) {
      this.log.error(`Scheduler tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async run() {
    await this.recoverStuck();
    if (await this.settings.isPaused()) return;

    const now = new Date();
    // Fail-closed: only posts that are BOTH in status APPROVED and approvalStatus APPROVED are considered.
    const due = await this.prisma.post.findMany({
      where: { status: 'APPROVED', approvalStatus: 'APPROVED', scheduledAt: { lte: now } },
      orderBy: { scheduledAt: 'asc' },
      take: 50,
    });
    if (due.length === 0) return;

    // Each post is governed by ITS OWN campaign (never "the first campaign").
    const campaignIds = [...new Set(due.map((p) => p.campaignId).filter((x): x is string => !!x))];
    const campaigns = await this.prisma.campaign.findMany({
      where: { id: { in: campaignIds } },
      select: { id: true, autoPublishEnabled: true, publishingPaused: true },
    });
    const byId = new Map(campaigns.map((c) => [c.id, c]));

    const toManual = (id: string, note: string) =>
      this.prisma.post.updateMany({
        where: { id, status: 'APPROVED' },
        data: withState('MANUAL_REQUIRED', { statusNote: note }),
      });

    for (const post of due) {
      // Administration Center: when scheduled publishing is off for this post's campaign, platform or
      // account, the post is left exactly as it is. Nothing is queued, and it is never moved forward
      // silently: once the feature is back on, a slot missed by more than 30 min goes to manual publishing.
      const scheduling = await this.policy.evaluate({
        feature: 'publishing.scheduled',
        campaignId: post.campaignId,
        platform: post.platform,
        accountId: post.accountId,
        action: 'ENQUEUE',
      });
      if (!scheduling.allowed) continue;

      const lateBy = now.getTime() - post.scheduledAt!.getTime();
      const campaign = post.campaignId ? byId.get(post.campaignId) : undefined;

      if (lateBy > MISSED_AFTER_MS) {
        await toManual(post.id, 'Missed its slot (paused or offline): confirm before publishing late');
        continue;
      }

      // Manual mode: always notify, never auto-queue
      if (post.publishMode === 'MANUAL') {
        await toManual(post.id, `Time to publish manually on ${post.platform}`);
        continue;
      }

      // Campaign-level pause or auto-publish disabled (or no campaign): move to manual
      if (!campaign || campaign.publishingPaused || !campaign.autoPublishEnabled) {
        await toManual(
          post.id,
          campaign?.publishingPaused
            ? 'Campaign publishing is paused — publish manually or resume'
            : 'Auto-publish is disabled for this campaign — enable it or publish manually',
        );
        continue;
      }

      if (!supportsAutoPublish(post.platform, post.format)) {
        await toManual(post.id, `Time to publish manually on ${post.platform}`);
        continue;
      }

      // Unattended execution needs publishing.auto in AUTO mode for this campaign / platform / account.
      const autoDecision = await this.policy.evaluate({
        feature: 'publishing.auto',
        need: 'AUTO',
        campaignId: post.campaignId,
        platform: post.platform,
        accountId: post.accountId,
        action: 'ENQUEUE',
      });
      if (!autoDecision.allowed) {
        await toManual(post.id, `Publication automatique désactivée — publiez manuellement (${autoDecision.reason})`);
        continue;
      }

      const claimed = await this.prisma.post.updateMany({
        where: { id: post.id, status: 'APPROVED' },
        data: withState('QUEUED'),
      });
      if (!claimed.count) continue;
      try {
        await this.queue.enqueue(post.id);
      } catch (e) {
        // Redis/BullMQ unavailable: put the post back so the next tick retries.
        this.log.error(`Could not enqueue ${post.id}: ${(e as Error).message}`);
        await this.prisma.post.updateMany({
          where: { id: post.id, status: 'QUEUED' },
          data: withState('APPROVED', { statusNote: 'The publishing queue was unavailable: will retry' }),
        });
      }
    }
  }

  private async recoverStuck() {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
    // The request may have succeeded on Meta before the crash: NEVER treat this as a
    // plain retryable failure. A human must check the platform first.
    await this.prisma.post.updateMany({
      where: { status: 'PUBLISHING', updatedAt: { lt: cutoff } },
      data: withState('NEEDS_RECONCILIATION', {
        statusNote:
          'Interrupted while publishing: check the platform. If it is live, use "Mark as published"; otherwise reschedule.',
      }),
    });
    await this.prisma.post.updateMany({
      where: { status: 'QUEUED', updatedAt: { lt: new Date(Date.now() - 2 * STUCK_AFTER_MS) } },
      data: withState('MANUAL_REQUIRED', {
        statusNote: 'The queue did not process this post: check, then reschedule',
      }),
    });
  }
}