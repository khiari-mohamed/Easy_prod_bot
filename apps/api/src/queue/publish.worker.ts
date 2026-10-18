import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import { Platform, SocialAccount } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.module';
import { AccountsService } from '../accounts/accounts.service';
import { PublisherService } from '../publishing/publisher.service';
import { FeaturePolicyService } from '../features/feature-policy.service';
import { MetaApiError } from '../meta/graph.client';
import { MetaBlockedError, metaGuard } from '../meta/meta-guard';
import { supportsAutoPublish } from '../posts/post.rules';
import { withState } from '../posts/post-state';
import { redisOptions } from '../env';
import { PUBLISH_QUEUE } from './queue.service';

@Injectable()
export class PublishWorker implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;
  private readonly log = new Logger(PublishWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly accounts: AccountsService,
    private readonly publisher: PublisherService,
    private readonly policy: FeaturePolicyService,
  ) {}

  onModuleInit() {
    this.worker = new Worker(PUBLISH_QUEUE, (job) => this.process(job), {
      connection: redisOptions(),
      concurrency: 2,
    });
    this.worker.on('error', (e) => this.log.error(`Worker error: ${e.message}`));
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  async process(job: Job<{ postId: string }>): Promise<void> {
    const { postId } = job.data;

    // Global kill switch: hand the post back to the schedule, never publish.
    if (await this.settings.isPaused()) {
      await this.prisma.post.updateMany({
        where: { id: postId, status: 'QUEUED' },
        data: withState('APPROVED', { statusNote: 'Publishing was paused: returned to the schedule' }),
      });
      return;
    }

    // Meta safety breaker open (rate limit / flagged activity / usage too high): never call Meta now.
    // The post goes back to the schedule; if its slot is missed by 30 min the scheduler makes it manual.
    if (metaGuard.isOpen()) {
      await this.prisma.post.updateMany({
        where: { id: postId, status: 'QUEUED' },
        data: withState('APPROVED', {
          statusNote: `Meta calls are paused (${metaGuard.status().reason}): returned to the schedule`,
        }),
      });
      return;
    }

    // Claim the post. If someone cancelled it or another worker took it, do nothing.
    // Fail-closed: only an approved post can be claimed (an edit/reject revokes approvalStatus).
    const claimed = await this.prisma.post.updateMany({
      where: { id: postId, status: 'QUEUED', approvalStatus: 'APPROVED' },
      data: withState('PUBLISHING'),
    });
    if (claimed.count === 0) return;

    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      include: { asset: true, campaign: { select: { autoPublishEnabled: true, publishingPaused: true } } },
    });
    if (!post) return;

    // Already published in a previous attempt: never publish twice.
    if (post.externalId) {
      await this.prisma.post.update({
        where: { id: postId },
        data: withState('PUBLISHED', { publishedAt: post.publishedAt ?? new Date() }),
      });
      return;
    }

    if (!supportsAutoPublish(post.platform, post.format)) {
      await this.toManual(postId, `${post.platform} ${post.format} is published manually`);
      return;
    }

    // FAIL-CLOSED publishing gate. A post is published through the API only when
    // ALL of these hold; anything else is handed back to a human (never published):
    //   1. it is approved (approvalStatus), so nothing unapproved can ever go out;
    //   2. neither the campaign nor (above) the whole system is paused;
    //   3. it is either AUTO on a campaign with automation enabled, or an approver
    //      explicitly authorized this one publication ("publish now").
    // A MANUAL post without that one-time authorization is therefore never sent.
    const authorizedNow = !!post.publishNowAuthorizedAt;
    if (post.approvalStatus !== 'APPROVED') {
      await this.toManual(postId, 'Not approved: it was not published');
      return;
    }
    if (post.campaign?.publishingPaused) {
      await this.toManual(postId, 'Campaign publishing is paused — publish manually or resume');
      return;
    }
    const autoAllowed = post.publishMode === 'AUTO' && !!post.campaign?.autoPublishEnabled;
    if (!autoAllowed && !authorizedNow) {
      await this.toManual(
        postId,
        post.publishMode === 'AUTO'
          ? 'Auto-publish is disabled for this campaign — enable it or publish manually'
          : 'Manual post: publish it yourself, or use "Publish now" to authorize one API publication',
      );
      return;
    }

    // Duplicate guard: the same caption + media already published recently is the classic spam signal.
    const duplicate = await this.recentDuplicate(post);
    if (duplicate) {
      await this.toManual(
        postId,
        'The same caption and media were already published in the last ' +
          `${this.duplicateWindowHours()} h (post ${duplicate.id}). Change the content, or set META_DUPLICATE_WINDOW_HOURS=0 for a test.`,
      );
      return;
    }

    // Publish ONLY to the account assigned to this post. If it is no longer usable we never fall back
    // to another account of the same platform: a human decides.
    const account = await this.accountFor(post);
    if (!account) {
      await this.toManual(
        postId,
        post.accountId
          ? 'The account assigned to this post is not usable (disconnected, expired or no publish permission): reconnect it or publish manually'
          : `No connected ${post.platform} account: publish manually or connect the account`,
      );
      return;
    }

    // Last check right before calling Meta: pause switches or an approval change since the claim must stop it.
    if (!(await this.stillAllowed(postId))) return;

    let attempt: { id: string };
    try {
      attempt = await this.prisma.publishAttempt.create({
        data: { postId, ok: false, state: 'STARTED', idempotencyKey: `${postId}:${post.updatedAt.getTime()}` },
      });
    } catch (e) {
      await this.toManual(postId, `Could not record publish attempt: ${(e as Error).message}`);
      throw new UnrecoverableError((e as Error).message);
    }

    try {
      const hooks = {
        onContainer: async (containerId: string): Promise<void> => {
          await this.prisma.post.update({ where: { id: postId }, data: { remoteContainerId: containerId } });
        },
        onPublished: async (externalId: string): Promise<void> => {
          await this.recordPublished(postId, externalId);
        },
      };
      const res =
        post.platform === 'INSTAGRAM' && post.remoteContainerId
          ? await this.publisher.publishExistingContainer(
              account.externalId,
              post.remoteContainerId,
              this.accounts.token(account),
              hooks,
            )
          : await this.publisher.publish(post, account, this.accounts.token(account), hooks);

      await this.prisma.post.update({
        where: { id: postId },
        data: withState('PUBLISHED', {
          publishedAt: new Date(),
          externalId: res.externalId,
          externalUrl: res.externalUrl,
          accountId: account.id,
          statusNote: null,
        }),
      });
      await this.prisma.publishAttempt.update({
        where: { id: attempt.id },
        data: { ok: true, state: 'SUCCEEDED', finishedAt: new Date(), remoteId: res.externalId, httpStatus: 200 },
      });
      this.log.log(`Published ${post.platform} post ${postId} as ${res.externalId}`);
    } catch (e) {
      await this.onFailure(job, postId, account.id, attempt.id, e);
    }
  }

  private recordPublished(postId: string, externalId: string) {
    return this.prisma.post.update({ where: { id: postId }, data: { externalId } });
  }

  private async onFailure(
    job: Job<{ postId: string }>,
    postId: string,
    accountId: string,
    attemptId: string,
    e: unknown,
  ): Promise<void> {
    const message = (e as Error).message;
    const httpStatus = e instanceof MetaApiError ? e.httpStatus : undefined;

    // The platform may have accepted the post before the error: never retry that.
    const after = await this.prisma.post.findUnique({ where: { id: postId }, select: { externalId: true } });
    if (after?.externalId) {
      await this.prisma.publishAttempt.update({
        where: { id: attemptId },
        data: { ok: true, state: 'SUCCEEDED', finishedAt: new Date(), remoteId: after.externalId, error: message },
      });
      await this.prisma.post.update({
        where: { id: postId },
        data: withState('PUBLISHED', { publishedAt: new Date(), accountId, statusNote: `Published, but: ${message}` }),
      });
      return;
    }

    // The safety guard refused BEFORE anything was sent to Meta: this is NOT an ambiguous result.
    // A human (or the schedule once the pause ends) decides; never burn retries against a paused Meta.
    if (e instanceof MetaBlockedError) {
      await this.prisma.publishAttempt.update({
        where: { id: attemptId },
        data: { state: 'FAILED', finishedAt: new Date(), error: message },
      });
      await this.prisma.post.update({
        where: { id: postId },
        data: withState('MANUAL_REQUIRED', { statusNote: `Not sent: ${message}` }),
      });
      throw new UnrecoverableError(message);
    }

    if (e instanceof MetaApiError && e.code === 190) {
      await this.prisma.socialAccount.update({ where: { id: accountId }, data: { status: 'EXPIRED' } });
    }

    const fatal = e instanceof MetaApiError && e.fatal;
    // Network error/timeout (0) or a 5xx: the request may have reached Meta and created the post.
    // Never retry blindly: a human checks the platform first.
    const ambiguous = e instanceof MetaApiError && (e.httpStatus === 0 || e.httpStatus >= 500);
    const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    // Ambiguous: the request may have reached Meta. Stop and make a human check,
    // otherwise a blind retry could publish twice.
    if (ambiguous) {
      await this.prisma.publishAttempt.update({
        where: { id: attemptId },
        data: { state: 'AMBIGUOUS', finishedAt: new Date(), httpStatus: httpStatus ?? 0, error: message },
      });
      await this.prisma.post.update({
        where: { id: postId },
        data: withState('NEEDS_RECONCILIATION', {
          statusNote: `Result unknown (${message}). Check the platform before retrying.`,
        }),
      });
      throw new UnrecoverableError(message);
    }

    await this.prisma.publishAttempt.update({
      where: { id: attemptId },
      data: {
        state: 'FAILED',
        finishedAt: new Date(),
        httpStatus: httpStatus ?? null,
        error: message,
      },
    });

    if (fatal || last) {
      await this.prisma.post.update({ where: { id: postId }, data: withState('FAILED', { statusNote: message }) });
      throw new UnrecoverableError(message);
    }
    await this.prisma.post.update({
      where: { id: postId },
      data: withState('QUEUED', { statusNote: `Retrying: ${message}` }),
    });
    throw e;
  }

  private duplicateWindowHours(): number {
    const h = Number(process.env.META_DUPLICATE_WINDOW_HOURS ?? 24);
    return Number.isFinite(h) && h > 0 ? h : 0;
  }

  /** Another post of the same platform with the same caption and media, published inside the window. */
  private async recentDuplicate(post: { id: string; platform: Platform; caption: string; assetId: string | null }) {
    const hours = this.duplicateWindowHours();
    if (hours <= 0) return null;
    return this.prisma.post.findFirst({
      where: {
        id: { not: post.id },
        platform: post.platform,
        caption: post.caption,
        assetId: post.assetId,
        status: 'PUBLISHED',
        publishedAt: { gte: new Date(Date.now() - hours * 3600_000) },
      },
      select: { id: true },
    });
  }

  /** The post's own account when it is usable; otherwise (no account assigned) the active account of the platform. */
  private async accountFor(post: { accountId: string | null; platform: Platform }): Promise<SocialAccount | null> {
    if (!post.accountId) return this.accounts.soleActiveFor(post.platform);
    const a = await this.prisma.socialAccount.findUnique({ where: { id: post.accountId } });
    if (!a || a.platform !== post.platform || a.status !== 'ACTIVE' || a.canPublish === false) return null;
    if (a.tokenExpiresAt && a.tokenExpiresAt.getTime() < Date.now()) return null;
    return a;
  }

  private async stillAllowed(postId: string): Promise<boolean> {
    const cur = await this.prisma.post.findUnique({
      where: { id: postId },
      select: {
        status: true,
        approvalStatus: true,
        platform: true,
        campaignId: true,
        accountId: true,
        publishNowAuthorizedAt: true,
        campaign: { select: { publishingPaused: true } },
      },
    });
    if (!cur || cur.status !== 'PUBLISHING' || cur.approvalStatus !== 'APPROVED') return false;
    if ((await this.settings.isPaused()) || cur.campaign?.publishingPaused) {
      await this.prisma.post.updateMany({
        where: { id: postId, status: 'PUBLISHING' },
        data: withState('APPROVED', { statusNote: 'Publishing was paused: returned to the schedule' }),
      });
      return false;
    }

    // Administration Center: the policy is re-read (no cache) right before the external call, so a
    // switch flipped or an emergency stop pressed after the job was queued still stops it.
    // A "publish now" post needs publishing.publish_now; any other post needs publishing.auto in AUTO mode.
    const decision = await this.policy.evaluate({
      feature: cur.publishNowAuthorizedAt ? 'publishing.publish_now' : 'publishing.auto',
      need: 'AUTO',
      campaignId: cur.campaignId,
      platform: cur.platform,
      accountId: cur.accountId,
      fresh: true,
      action: 'EXECUTE',
    });
    if (!decision.allowed) {
      await this.prisma.post.updateMany({
        where: { id: postId, status: 'PUBLISHING' },
        data: withState('APPROVED', { statusNote: `Bloqué par l'administration : ${decision.reason}` }),
      });
      return false;
    }
    return true;
  }

  /** Guarded: only moves a post that is still PUBLISHING, so it can never overwrite a newer human decision. */
  private toManual(postId: string, note: string) {
    return this.prisma.post.updateMany({
      where: { id: postId, status: 'PUBLISHING' },
      data: withState('MANUAL_REQUIRED', { statusNote: note }),
    });
  }
}