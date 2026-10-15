import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Asset, Platform, PostFormat, PostStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { SettingsService } from '../settings/settings.module';
import { QueueService } from '../queue/queue.service';
import { AuthUser } from '../auth/auth.types';
import { supportsAutoPublish, validateForSubmit } from './post.rules';
import { PLANNABLE_PLATFORMS, withState } from './post-state';
import {
  ConfirmManualDto,
  CreatePostDto,
  ListPostsQuery,
  MarkPublishedDto,
  MetricsDto,
  UpdatePostDto,
} from './posts.dto';

const include = {
  asset: true,
  day: { select: { id: true, label: true, date: true } },
  account: {
    select: { id: true, name: true, platform: true, status: true, canPublish: true, tokenExpiresAt: true },
  },
  campaign: { select: { id: true, autoPublishEnabled: true, publishingPaused: true } },
  metrics: { orderBy: { capturedAt: 'desc' as const }, take: 1 },
  contentItem: { select: { id: true, title: true, approvalStatus: true } },
};

type LoadedPost = Awaited<ReturnType<PostsService['get']>>;

const EDITABLE: PostStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'FAILED', 'MANUAL_REQUIRED'];

/**
 * Platforms that can be planned and tracked. TikTok is included but is
 * MANUAL-only: supportsAutoPublish() returns false for it, and every path below
 * refuses to set AUTO on a platform/format the integration cannot publish.
 */
const PUBLISHABLE_PLATFORMS: Platform[] = PLANNABLE_PLATFORMS;

/** Metric columns a manual snapshot can carry. Any column not supplied is recorded as "unavailable", not 0. */
const METRIC_FIELDS = ['views', 'reach', 'likes', 'comments', 'shares', 'saves', 'clicks'] as const;

const PAST_TOLERANCE_MS = 60_000;
const FUTURE_PUBLISHED_TOLERANCE_MS = 5 * 60_000;

/** True when `next` was provided and differs from `current` (arrays/dates compared by value). */
function differs(next: unknown, current: unknown): boolean {
  if (next === undefined) return false;
  const norm = (v: unknown) => (v instanceof Date ? v.getTime() : JSON.stringify(v ?? null));
  return norm(next) !== norm(current);
}

@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly queue: QueueService,
  ) {}

  list(q: ListPostsQuery) {
    return this.prisma.post.findMany({
      where: {
        status: q.status,
        platform: q.platform,
        dayId: q.dayId,
        contentItemId: q.contentItemId,
      },
      include,
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'desc' }],
      take: 500,
    });
  }

  async get(id: string) {
    const post = await this.prisma.post.findUnique({
      where: { id },
      include: {
        ...include,
        attempts: { orderBy: { startedAt: 'desc' }, take: 10 },
        manualConfirmedBy: { select: { id: true, name: true } },
      },
    });
    if (!post) throw new NotFoundException('Post not found');
    return post;
  }

  async create(dto: CreatePostDto, user: AuthUser) {
    if (!PUBLISHABLE_PLATFORMS.includes(dto.platform)) {
      throw new BadRequestException(`Platform ${dto.platform} is not supported for publishing`);
    }
    const item = dto.contentItemId ? await this.requireContentItem(dto.contentItemId) : null;
    const campaign = await this.resolveCampaign(dto, item?.campaignId ?? null);
    if (dto.assetId) await this.requireAsset(dto.assetId, dto.platform, dto.format);

    // Safe default: nothing publishes automatically unless the content item says
    // so AND an approver approves the AUTO post. Platforms without an API
    // integration (TikTok) are always MANUAL.
    let publishMode = dto.publishMode ?? item?.defaultPublishMode ?? 'MANUAL';
    if (publishMode === 'AUTO' && !supportsAutoPublish(dto.platform, dto.format)) {
      if (dto.publishMode === 'AUTO') {
        throw new BadRequestException(`${dto.platform} ${dto.format} cannot be published automatically: use MANUAL`);
      }
      publishMode = 'MANUAL';
    }

    const post = await this.prisma.post.create({
      data: {
        campaignId: campaign.id,
        dayId: dto.dayId,
        contentItemId: dto.contentItemId,
        platform: dto.platform,
        format: dto.format,
        caption: dto.caption,
        hashtags: dto.hashtags ?? (item?.hashtags.length ? item.hashtags : campaign.hashtags),
        assetId: dto.assetId,
        scheduledAt: dto.scheduledAt ? this.parseDate(dto.scheduledAt) : null,
        publishMode,
        captionLanguage: dto.captionLanguage ?? item?.captionLanguage ?? undefined,
        createdById: user.id,
        // approvalStatus = DRAFT and publishState = NOT_SCHEDULED come from schema defaults
      },
      include,
    });
    await this.audit.log(user.id, 'post.create', 'Post', post.id, {
      campaignId: campaign.id,
      publishMode: post.publishMode,
    });
    return post;
  }

  /**
   * Re-approval rule: ANY material change (caption, hashtags, format, asset,
   * language, schedule, publish mode) sends the post back to DRAFT, revokes the
   * approval, clears any one-time publish authorization and removes the queued
   * job. Switching MANUAL -> AUTO therefore always needs a fresh approval, and
   * only approvers can approve. The write is conditional on the status that was
   * read, so a worker transition in between cannot be overwritten.
   */
  async update(id: string, dto: UpdatePostDto, user: AuthUser) {
    const post = await this.get(id);
    if (!EDITABLE.includes(post.status)) {
      throw new ConflictException(`A post in status ${post.status} can no longer be edited`);
    }
    if (dto.assetId) await this.requireAsset(dto.assetId, post.platform, dto.format ?? post.format);
    if ((dto.publishMode ?? post.publishMode) === 'AUTO' && !supportsAutoPublish(post.platform, dto.format ?? post.format)) {
      throw new BadRequestException(
        `${post.platform} ${dto.format ?? post.format} cannot be published automatically: use MANUAL`,
      );
    }

    const nextScheduled =
      dto.scheduledAt === undefined ? undefined : dto.scheduledAt ? this.parseDate(dto.scheduledAt) : null;

    const changedFields = (
      [
        ['format', differs(dto.format, post.format)],
        ['caption', differs(dto.caption, post.caption)],
        ['hashtags', differs(dto.hashtags, post.hashtags)],
        ['assetId', differs(dto.assetId, post.assetId)],
        ['captionLanguage', differs(dto.captionLanguage, post.captionLanguage)],
        ['scheduledAt', differs(nextScheduled, post.scheduledAt)],
        ['publishMode', differs(dto.publishMode, post.publishMode)],
      ] as [string, boolean][]
    )
      .filter(([, changed]) => changed)
      .map(([name]) => name);

    if (changedFields.length === 0) return post;

    const res = await this.prisma.post.updateMany({
      where: { id, status: post.status },
      data: {
        format: dto.format,
        caption: dto.caption,
        hashtags: dto.hashtags,
        assetId: dto.assetId,
        captionLanguage: dto.captionLanguage,
        scheduledAt: nextScheduled,
        publishMode: dto.publishMode,
        ...withState('DRAFT', {
          approvedById: null,
          approvedAt: null,
          statusNote: null,
          // A material change makes any earlier Instagram container (old caption/media) stale.
          remoteContainerId: null,
        }),
      },
    });
    if (res.count === 0) {
      throw new ConflictException('The post changed while you were editing it. Reload and try again.');
    }
    await this.safeDequeue(id);
    await this.audit.log(user.id, 'post.update', 'Post', id, {
      previousStatus: post.status,
      changedFields,
    });
    return this.get(id);
  }

  async submit(id: string, user: AuthUser) {
    const post = await this.get(id);
    const problems = validateForSubmit(post, post.asset);
    if (problems.length) throw new BadRequestException(problems);
    this.assertAssetUsable(post.asset, post.platform, post.format);
    await this.transition(id, ['DRAFT'], { status: 'PENDING_APPROVAL', statusNote: null });
    await this.audit.log(user.id, 'post.submit', 'Post', id);
    return this.get(id);
  }

  async approve(id: string, user: AuthUser) {
    const post = await this.get(id);
    if (!post.scheduledAt) throw new BadRequestException('Set a publication date and time before approving');
    const problems = validateForSubmit(post, post.asset);
    if (problems.length) throw new BadRequestException(problems);
    this.assertAssetUsable(post.asset, post.platform, post.format);

    let statusNote: string | null = null;
    let accountId: string | undefined;
    if (post.publishMode === 'AUTO') {
      if (!supportsAutoPublish(post.platform, post.format)) {
        throw new BadRequestException(
          `${post.platform} ${post.format} cannot be published automatically: switch the post to MANUAL`,
        );
      }
      // Automatic publishing needs an explicit automation policy.
      if (!post.campaignId || !post.campaign) {
        throw new BadRequestException('Automatic publishing requires the post to belong to a campaign');
      }
      if (post.scheduledAt.getTime() < Date.now() - PAST_TOLERANCE_MS) {
        throw new BadRequestException('Automatic publishing needs a scheduled time in the future');
      }
      accountId = (await this.resolvePublishAccount(post)).id;
      if (!post.campaign.autoPublishEnabled || post.campaign.publishingPaused) {
        statusNote =
          'Approved, but automation is disabled or paused for this campaign: it will not publish until re-enabled';
      }
    }

    await this.transition(id, ['PENDING_APPROVAL'], {
      status: 'APPROVED',
      approvedById: user.id,
      approvedAt: new Date(),
      statusNote,
      ...(accountId ? { accountId } : {}),
    });
    await this.audit.log(user.id, 'post.approve', 'Post', id, {
      scheduledAt: post.scheduledAt,
      publishMode: post.publishMode,
    });
    return this.get(id);
  }

  async reject(id: string, reason: string, user: AuthUser) {
    await this.transition(id, ['PENDING_APPROVAL'], {
      status: 'DRAFT',
      approvalStatus: 'REJECTED',
      statusNote: `Rejected: ${reason}`,
      rejectionNote: reason,
    });
    await this.audit.log(user.id, 'post.reject', 'Post', id, { reason });
    return this.get(id);
  }

  async unschedule(id: string, user: AuthUser) {
    await this.transition(id, ['APPROVED'], {
      status: 'DRAFT',
      approvedById: null,
      approvedAt: null,
    });
    await this.safeDequeue(id);
    await this.audit.log(user.id, 'post.unschedule', 'Post', id);
    return this.get(id);
  }

  /**
   * "Publish now" = ONE explicit, confirmed API publication of an approved post.
   * It never changes the post's permanent publishMode (MANUAL stays MANUAL).
   * The worker must publish a post when publishMode === 'AUTO' OR
   * publishNowAuthorizedAt is set. Global pause and campaign pause always apply.
   */
  async publishNow(id: string, user: AuthUser, confirm = false) {
    if (!confirm) {
      throw new BadRequestException('Publish now must be explicitly confirmed (confirm: true)');
    }
    if (await this.settings.isPaused()) throw new BadRequestException('Publishing is paused');

    const post = await this.get(id);
    if (post.campaign?.publishingPaused) {
      throw new BadRequestException('Publishing is paused for this campaign');
    }
    const problems = validateForSubmit(post, post.asset);
    if (problems.length) throw new BadRequestException(problems);
    this.assertAssetUsable(post.asset, post.platform, post.format);
    if (!supportsAutoPublish(post.platform, post.format)) {
      throw new BadRequestException(
        `${post.platform} ${post.format} cannot be published through the API: publish it manually and use "Mark as published"`,
      );
    }
    const account = await this.resolvePublishAccount(post);

    const previousScheduledAt = post.scheduledAt;
    await this.transition(id, ['APPROVED'], {
      status: 'QUEUED',
      scheduledAt: new Date(),
      accountId: account.id,
      publishNowAuthorizedAt: new Date(),
      publishNowAuthorizedById: user.id,
    });

    try {
      await this.queue.enqueue(id);
    } catch (err) {
      // Never leave the post stuck in QUEUED when Redis/BullMQ is unavailable.
      this.logger.error(`Could not enqueue post ${id}: ${(err as Error).message}`);
      await this.transition(id, ['QUEUED'], {
        status: 'APPROVED',
        scheduledAt: previousScheduledAt,
        statusNote: 'Publish now failed: the publishing queue is unavailable. Try again.',
      });
      throw new ServiceUnavailableException('The publishing queue is unavailable. Nothing was published.');
    }

    await this.audit.log(user.id, 'post.publishNow', 'Post', id, { publishMode: post.publishMode });
    return this.get(id);
  }

  /**
   * - APPROVED: the approver deliberately moves the time; stays approved.
   * - FAILED / MANUAL_REQUIRED: no silent re-approval. Either the caller passes
   *   `reapprove: true` (explicit retry decision) or the post goes back to
   *   PENDING_APPROVAL.
   */
  async reschedule(id: string, scheduledAt: string, user: AuthUser, opts: { reapprove?: boolean } = {}) {
    const when = this.parseDate(scheduledAt);
    if (when.getTime() < Date.now() - PAST_TOLERANCE_MS) {
      throw new BadRequestException('Pick a time in the future');
    }
    const post = await this.get(id);
    const problems = validateForSubmit(post, post.asset);
    if (problems.length) throw new BadRequestException(problems);
    this.assertAssetUsable(post.asset, post.platform, post.format);

    if (post.status === 'APPROVED') {
      await this.transition(id, ['APPROVED'], {
        status: 'APPROVED',
        scheduledAt: when,
        remoteContainerId: null, // a rescheduled post must never reuse an old (possibly expired) Instagram container
        approvedById: user.id,
        approvedAt: new Date(),
        statusNote: null,
      });
    } else if (post.status === 'FAILED' || post.status === 'MANUAL_REQUIRED') {
      if (opts.reapprove) {
        await this.transition(id, [post.status], {
          status: 'APPROVED',
          scheduledAt: when,
          remoteContainerId: null, // a rescheduled post must never reuse an old (possibly expired) Instagram container
          approvedById: user.id,
          approvedAt: new Date(),
          statusNote: null,
        });
      } else {
        await this.transition(id, [post.status], {
          status: 'PENDING_APPROVAL',
          scheduledAt: when,
          remoteContainerId: null, // a rescheduled post must never reuse an old (possibly expired) Instagram container
          approvedById: null,
          approvedAt: null,
          statusNote: 'Rescheduled: awaiting approval',
        });
      }
    } else {
      throw new ConflictException(`A post in status ${post.status} cannot be rescheduled`);
    }

    await this.safeDequeue(id); // any job for the old time is now stale
    await this.audit.log(user.id, 'post.reschedule', 'Post', id, {
      scheduledAt,
      previousStatus: post.status,
      reapprove: !!opts.reapprove,
    });
    return this.get(id);
  }

  /**
   * A human records that the post is live. Allowed only for posts that were
   * approved, including NEEDS_RECONCILIATION (the human checked the page).
   */
  async markPublished(id: string, dto: MarkPublishedDto, user: AuthUser) {
    const publishedAt = this.parsePublishedAt(dto.publishedAt);
    const externalUrl = this.parseExternalUrl(dto.externalUrl);
    await this.transition(id, ['APPROVED', 'MANUAL_REQUIRED', 'FAILED', 'NEEDS_RECONCILIATION'], {
      status: 'PUBLISHED',
      publishState: 'MANUAL_CONFIRMED',
      publishedAt,
      externalUrl,
      manualConfirmedAt: new Date(),
      manualConfirmedById: user.id,
      statusNote: 'Marked as published manually',
    });
    await this.safeDequeue(id);
    await this.audit.log(user.id, 'post.markPublished', 'Post', id, { externalUrl });
    return this.get(id);
  }

  /** Human confirms they published a MANUAL_REQUIRED post themselves. */
  async confirmManual(id: string, dto: ConfirmManualDto, user: AuthUser) {
    const publishedAt = this.parsePublishedAt(dto.publishedAt);
    const externalUrl = this.parseExternalUrl(dto.externalUrl);
    await this.transition(id, ['MANUAL_REQUIRED'], {
      status: 'PUBLISHED',
      publishState: 'MANUAL_CONFIRMED',
      publishedAt,
      externalUrl,
      manualConfirmedAt: new Date(),
      manualConfirmedById: user.id,
      statusNote: 'Published manually and confirmed',
    });
    await this.audit.log(user.id, 'post.confirmManual', 'Post', id, { externalUrl });
    return this.get(id);
  }

  async cancel(id: string, user: AuthUser) {
    await this.transition(
      id,
      ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'FAILED', 'MANUAL_REQUIRED', 'NEEDS_RECONCILIATION'],
      { status: 'CANCELLED' },
    );
    // DB state is already final; the worker also re-checks status before publishing.
    await this.safeDequeue(id);
    await this.audit.log(user.id, 'post.cancel', 'Post', id);
    return this.get(id);
  }

  async remove(id: string, user: AuthUser) {
    const res = await this.prisma.post.deleteMany({
      where: { id, status: { in: ['DRAFT', 'CANCELLED'] } },
    });
    if (res.count === 0) {
      const current = await this.prisma.post.findUnique({ where: { id }, select: { status: true } });
      if (!current) throw new NotFoundException('Post not found');
      throw new ConflictException('Only drafts and cancelled posts can be deleted');
    }
    await this.safeDequeue(id);
    await this.audit.log(user.id, 'post.delete', 'Post', id);
    return { ok: true };
  }

  /** Manual metrics: any metric the user did not provide is stored as "unavailable", never as a real 0. */
  async addMetrics(id: string, dto: MetricsDto, user: AuthUser) {
    const post = await this.get(id);
    if (post.status !== 'PUBLISHED') throw new BadRequestException('Metrics can only be added to published posts');
    const provided = dto as unknown as Record<string, unknown>;
    const unavailable = METRIC_FIELDS.filter((f) => provided[f] === undefined || provided[f] === null);
    const values = Object.fromEntries(METRIC_FIELDS.filter((f) => !unavailable.includes(f)).map((f) => [f, provided[f] as number]));
    const snapshot = await this.prisma.metricSnapshot.create({
      data: { postId: id, source: 'MANUAL', ...values, unavailable },
    });
    await this.audit.log(user.id, 'post.addMetrics', 'Post', id, {
      snapshotId: snapshot.id,
      unavailable,
    });
    return snapshot;
  }

  platforms(): Platform[] {
    return [...PUBLISHABLE_PLATFORMS];
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Atomic, conditional status change. Keeps `status`, `approvalStatus` and
   * `publishState` in sync; explicit values in `data` win. The one-time
   * "publish now" authorization only survives in QUEUED/PUBLISHING.
   */
  private async transition(
    id: string,
    from: PostStatus[],
    data: Prisma.PostUncheckedUpdateManyInput & { status: PostStatus },
  ) {
    const { status, ...extra } = data;
    const res = await this.prisma.post.updateMany({
      where: { id, status: { in: from } },
      data: withState(status, extra),
    });
    if (res.count === 0) {
      const current = await this.prisma.post.findUnique({ where: { id }, select: { status: true } });
      if (!current) throw new NotFoundException('Post not found');
      throw new ConflictException(`Not possible from status ${current.status}`);
    }
  }

  /** Best-effort job removal. The worker's final status check is the real safety net. */
  private async safeDequeue(id: string) {
    try {
      await this.queue.dequeue(id);
    } catch (err) {
      this.logger.warn(`Could not remove queued job for post ${id}: ${(err as Error).message}`);
    }
  }

  private async requireContentItem(id: string) {
    const item = await this.prisma.contentItem.findUnique({
      where: { id },
      select: { id: true, campaignId: true, hashtags: true, captionLanguage: true, defaultPublishMode: true },
    });
    if (!item) throw new BadRequestException('Content item not found');
    return item;
  }

  /** The content item and calendar day, when both supplied, must belong to the same campaign. */
  private async resolveCampaign(dto: CreatePostDto, itemCampaignId: string | null) {
    const ids = new Set<string>();
    if (itemCampaignId) ids.add(itemCampaignId);
    if (dto.dayId) {
      const day = await this.prisma.campaignDay.findUnique({
        where: { id: dto.dayId },
        select: { campaignId: true },
      });
      if (!day) throw new BadRequestException('Campaign day not found');
      ids.add(day.campaignId);
    }
    if (ids.size === 0) {
      throw new BadRequestException('A content item or campaign day is required to determine the campaign');
    }
    if (ids.size > 1) {
      throw new BadRequestException('The selected campaign, content item and day do not belong to the same campaign');
    }
    const [campaignId] = [...ids];
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, hashtags: true },
    });
    if (!campaign) throw new BadRequestException('Campaign not found');
    return campaign;
  }

  /**
   * Account that will publish this post. Uses the post's own account, or the
   * single ACTIVE account of the platform; refuses ambiguity. It must match the
   * platform, be ACTIVE, not be known to lack publish capability, and have a
   * non-expired token.
   */
  private async resolvePublishAccount(post: LoadedPost) {
    let account = post.account;
    if (!account) {
      const candidates = await this.prisma.socialAccount.findMany({
        where: { platform: post.platform, status: 'ACTIVE' },
        select: { id: true, name: true, platform: true, status: true, canPublish: true, tokenExpiresAt: true },
        take: 2,
      });
      if (candidates.length === 0) {
        throw new BadRequestException(`No active ${post.platform} account is connected`);
      }
      if (candidates.length > 1) {
        throw new BadRequestException(
          `Several ${post.platform} accounts are connected: assign the post to one of them first`,
        );
      }
      account = candidates[0];
    }
    if (account.platform !== post.platform) {
      throw new BadRequestException('The assigned account belongs to a different platform');
    }
    if (account.status !== 'ACTIVE') {
      throw new BadRequestException(`The connected account is ${account.status}: reconnect it first`);
    }
    if (account.canPublish === false) {
      throw new BadRequestException('The connected account does not have publishing permission');
    }
    if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() < Date.now()) {
      throw new BadRequestException('The account token has expired: reconnect the account');
    }
    return account;
  }

  /** The asset must exist, not be deleted, be fully processed and compatible with the target platform/format. */
  private async requireAsset(id: string, platform?: Platform, format?: PostFormat) {
    const asset = await this.prisma.asset.findUnique({ where: { id } });
    if (!asset) throw new BadRequestException('Asset not found');
    this.assertAssetUsable(asset, platform, format);
    return asset;
  }

  private assertAssetUsable(asset: Asset | null, platform?: Platform, format?: PostFormat) {
    if (!asset) return; // whether an asset is mandatory is decided by validateForSubmit
    if (asset.deletedAt) throw new BadRequestException('The attached asset was deleted');
    if (asset.processingStatus === 'INVALID') {
      throw new BadRequestException(
        `The attached asset is invalid: ${asset.processingError ?? asset.processingNote ?? 'unknown reason'}`,
      );
    }
    if (asset.processingStatus !== 'READY') {
      throw new BadRequestException(`The attached asset is not ready yet (${asset.processingStatus})`);
    }
    if (platform && format && asset.platformReady && typeof asset.platformReady === 'object') {
      const entry = (asset.platformReady as Record<string, { ok?: boolean; reason?: string }>)[
        `${platform}_${format}`
      ];
      if (entry && entry.ok === false) {
        throw new BadRequestException(
          `The attached asset is not compatible with ${platform} ${format}${entry.reason ? `: ${entry.reason}` : ''}`,
        );
      }
    }
  }

  private parseDate(value: string): Date {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date');
    return d;
  }

  private parsePublishedAt(value?: string): Date {
    if (!value) return new Date();
    const d = this.parseDate(value);
    if (d.getTime() > Date.now() + FUTURE_PUBLISHED_TOLERANCE_MS) {
      throw new BadRequestException('The publication date cannot be in the future');
    }
    return d;
  }

  /** Only http(s) links are accepted, so the UI never renders javascript: or data: URLs. */
  private parseExternalUrl(value?: string): string | undefined {
    if (!value) return undefined;
    try {
      const u = new URL(value);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    } catch {
      /* fall through */
    }
    throw new BadRequestException('externalUrl must be a valid http(s) URL');
  }
}