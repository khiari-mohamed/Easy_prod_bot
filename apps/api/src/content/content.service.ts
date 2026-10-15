import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AiService, defaultLanguage } from '../ai/ai.service';
import { AuthUser } from '../auth/auth.types';
import { PostsService } from '../posts/posts.service';
import { withState } from '../posts/post-state';
import { QueueService } from '../queue/queue.service';
import {
  ContentAssetDto,
  CreateContentItemDto,
  GeneratePostsDto,
  ListContentQuery,
  RejectContentDto,
  UpdateContentItemDto,
} from './content.dto';

const INCLUDE = {
  assets: { include: { asset: true }, orderBy: { order: 'asc' as const } },
  posts: {
    select: {
      id: true,
      platform: true,
      format: true,
      status: true,
      publishMode: true,
      scheduledAt: true,
      caption: true,
    },
  },
  createdBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
};

@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ai: AiService,
    private readonly posts: PostsService,
    private readonly queue: QueueService,
  ) {}

  /** The campaign a new content item belongs to: its plan entry's campaign, else the oldest campaign. */
  private async resolveCampaign(planEntryId?: string | null) {
    if (planEntryId) {
      const entry = await this.prisma.planEntry.findUnique({
        where: { id: planEntryId },
        select: { campaignId: true },
      });
      if (!entry) throw new BadRequestException('Plan entry not found');
      if (entry.campaignId) {
        return this.prisma.campaign.findUnique({ where: { id: entry.campaignId } });
      }
    }
    return this.prisma.campaign.findFirst({ orderBy: { createdAt: 'asc' } });
  }

  /** Every asset must exist and not be deleted before it is attached. */
  private async assertAssetsExist(assets: ContentAssetDto[] | undefined) {
    if (!assets?.length) return;
    const ids = [...new Set(assets.map((a) => a.assetId))];
    if (ids.length !== assets.length) throw new BadRequestException('The same asset is attached twice');
    const found = await this.prisma.asset.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } });
    if (found.length !== ids.length) throw new BadRequestException('One of the selected assets does not exist or was deleted');
  }

  list(q: ListContentQuery) {
    return this.prisma.contentItem.findMany({
      where: {
        captionLanguage: q.captionLanguage,
        planEntryId: q.planEntryId,
      },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async get(id: string) {
    const item = await this.prisma.contentItem.findUnique({ where: { id }, include: INCLUDE });
    if (!item) throw new NotFoundException('Content item not found');
    return item;
  }

  async create(dto: CreateContentItemDto, user: AuthUser) {
    const campaign = await this.resolveCampaign(dto.planEntryId);
    await this.assertAssetsExist(dto.assets);
    const item = await this.prisma.contentItem.create({
      data: {
        campaignId: campaign?.id,
        planEntryId: dto.planEntryId,
        title: dto.title,
        captionLanguage: dto.captionLanguage,
        baseCaption: dto.baseCaption,
        hashtags: dto.hashtags ?? campaign?.hashtags ?? [],
        defaultPublishMode: dto.defaultPublishMode ?? 'MANUAL',
        createdById: user.id,
        assets: dto.assets?.length
          ? { create: dto.assets.map((a) => ({ assetId: a.assetId, order: a.order ?? 0, role: a.role ?? 'MAIN' })) }
          : undefined,
      },
      include: INCLUDE,
    });
    await this.audit.log(user.id, 'content.create', 'ContentItem', item.id);
    return item;
  }

  async update(id: string, dto: UpdateContentItemDto, user: AuthUser) {
    const item = await this.get(id);
    await this.assertAssetsExist(dto.assets);
    const wasApproved = item.approvalStatus === 'APPROVED';

    // Content change resets approval and cascades to every linked post that was
    // waiting, approved or queued: status + approvalStatus + publishState move
    // together, the stale Instagram container is dropped and queued jobs are removed.
    let resetIds: string[] = [];
    if (wasApproved) {
      const linked = await this.prisma.post.findMany({
        where: {
          contentItemId: id,
          status: { in: ['PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'MANUAL_REQUIRED'] },
        },
        select: { id: true },
      });
      resetIds = linked.map((p) => p.id);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (resetIds.length) {
        await tx.post.updateMany({
          where: { id: { in: resetIds }, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'MANUAL_REQUIRED'] } },
          data: withState('DRAFT', {
            approvedById: null,
            approvedAt: null,
            remoteContainerId: null,
            statusNote: 'Content updated — re-review required',
          }),
        });
      }
      if (dto.assets !== undefined) {
        await tx.contentAsset.deleteMany({ where: { contentItemId: id } });
      }
      return tx.contentItem.update({
        where: { id },
        data: {
          title: dto.title,
          captionLanguage: dto.captionLanguage,
          baseCaption: dto.baseCaption,
          hashtags: dto.hashtags,
          defaultPublishMode: dto.defaultPublishMode,
          approvalStatus: wasApproved ? 'DRAFT' : undefined,
          approvedById: wasApproved ? null : undefined,
          approvedAt: wasApproved ? null : undefined,
          assets: dto.assets?.length
            ? { create: dto.assets.map((a: ContentAssetDto) => ({ assetId: a.assetId, order: a.order ?? 0, role: a.role ?? 'MAIN' })) }
            : undefined,
        },
        include: INCLUDE,
      });
    });

    // Best effort: the worker's status check is the real guard for a job already running.
    for (const postId of resetIds) {
      try {
        await this.queue.dequeue(postId);
      } catch (err) {
        this.logger.warn(`Could not remove queued job for post ${postId}: ${(err as Error).message}`);
      }
    }
    await this.audit.log(user.id, 'content.update', 'ContentItem', id, { postsReset: resetIds.length });
    return updated;
  }

  async submit(id: string, user: AuthUser) {
    const item = await this.get(id);
    if (item.approvalStatus !== 'DRAFT')
      throw new ConflictException(`Cannot submit from status ${item.approvalStatus}`);
    if (!item.baseCaption.trim()) throw new BadRequestException('Caption is empty');
    if (!item.captionLanguage)
      throw new BadRequestException('Select a caption language (Darija, French, or Darija+French) before submitting');
    const updated = await this.prisma.contentItem.update({
      where: { id },
      data: { approvalStatus: 'PENDING' },
      include: INCLUDE,
    });
    await this.audit.log(user.id, 'content.submit', 'ContentItem', id);
    return updated;
  }

  async approve(id: string, user: AuthUser) {
    if (user.role !== Role.ADMIN && user.role !== Role.APPROVER)
      throw new ForbiddenException('Only an approver can do this');
    const item = await this.get(id);
    if (item.approvalStatus !== 'PENDING')
      throw new ConflictException(`Cannot approve from status ${item.approvalStatus}`);
    const updated = await this.prisma.contentItem.update({
      where: { id },
      data: { approvalStatus: 'APPROVED', approvedById: user.id, approvedAt: new Date(), rejectionNote: null },
      include: INCLUDE,
    });
    await this.audit.log(user.id, 'content.approve', 'ContentItem', id);
    return updated;
  }

  async reject(id: string, dto: RejectContentDto, user: AuthUser) {
    if (user.role !== Role.ADMIN && user.role !== Role.APPROVER)
      throw new ForbiddenException('Only an approver can do this');
    const current = await this.get(id);
    if (current.approvalStatus !== 'PENDING')
      throw new ConflictException(`Cannot reject from status ${current.approvalStatus}`);
    const updated = await this.prisma.contentItem.update({
      where: { id },
      data: { approvalStatus: 'DRAFT', rejectionNote: dto.reason },
      include: INCLUDE,
    });
    await this.audit.log(user.id, 'content.reject', 'ContentItem', id, { reason: dto.reason });
    return updated;
  }

  /**
   * Generate one Post per requested platform from this ContentItem.
   * Every post is created through PostsService.create(), so the same rules apply
   * as for a post made by hand: TikTok is MANUAL-only, the asset must be ready
   * and compatible, the campaign must match. Platforms that already have a
   * non-cancelled post for this item are skipped.
   *
   * Carousels are not published yet: an item with several images (or CAROUSEL
   * assets) is refused instead of silently posting only the first picture.
   */
  async generatePosts(id: string, dto: GeneratePostsDto, user: AuthUser) {
    const item = await this.get(id);
    if (!dto.platforms?.length) throw new BadRequestException('Select at least one platform');

    const sorted = [...item.assets].sort((a, b) => a.order - b.order);
    if (sorted.some((a) => a.role === 'CAROUSEL') || sorted.filter((a) => a.role === 'MAIN').length > 1) {
      throw new BadRequestException(
        'Carousel / multi-image publishing is not supported yet: keep ONE main asset (a cover is optional) and generate again',
      );
    }
    const main = sorted.find((a) => a.role === 'MAIN')?.asset ?? null;

    // Make sure the item carries its campaign (legacy items may not).
    const campaign = item.campaignId
      ? await this.prisma.campaign.findUnique({ where: { id: item.campaignId } })
      : await this.resolveCampaign(item.planEntryId);
    if (campaign && !item.campaignId) {
      await this.prisma.contentItem.update({ where: { id }, data: { campaignId: campaign.id } });
    }

    const existing = await this.prisma.post.findMany({
      where: { contentItemId: id, status: { not: 'CANCELLED' } },
      select: { platform: true },
    });
    const have = new Set(existing.map((p) => p.platform));

    const created = [];
    const errors: string[] = [];
    for (const platform of [...new Set(dto.platforms)]) {
      if (have.has(platform)) continue;

      // Format follows the media unless the caller chose one.
      const format =
        dto.format ??
        (main?.kind === 'VIDEO' ? 'REEL' : main?.kind === 'IMAGE' ? 'IMAGE' : platform === 'FACEBOOK' ? 'TEXT' : null);
      if (!format) {
        errors.push(`${platform}: attach an image or video to the content item first`);
        continue;
      }
      const lang = item.captionLanguage ?? defaultLanguage(platform);

      let caption = item.baseCaption;
      let hashtags = item.hashtags;

      // Optionally generate a platform-specific caption via AI
      if (dto.generateCaptions && campaign) {
        try {
          const res = await this.ai.captions({ campaign, platform, format, language: lang });
          caption = res.variants[0]?.caption ?? caption;
          hashtags = res.variants[0]?.hashtags ?? hashtags;
        } catch {
          // fall back to baseCaption
        }
      }

      try {
        const post = await this.posts.create(
          {
            contentItemId: id,
            platform,
            format,
            caption,
            hashtags,
            captionLanguage: lang,
            assetId: format === 'TEXT' ? undefined : main?.id,
            scheduledAt: dto.scheduledAt,
          },
          user,
        );
        created.push(post);
      } catch (e) {
        errors.push(`${platform}: ${(e as Error).message}`);
      }
    }

    await this.audit.log(user.id, 'content.generatePosts', 'ContentItem', id, {
      platforms: dto.platforms,
      created: created.length,
      errors,
    });
    if (!created.length && errors.length) throw new BadRequestException(errors);
    return created;
  }

  async remove(id: string, user: AuthUser) {
    const item = await this.get(id);
    const activePosts = await this.prisma.post.count({
      where: {
        contentItemId: id,
        status: { in: ['PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'PUBLISHING'] },
      },
    });
    if (activePosts > 0)
      throw new ConflictException('Content item has active posts — cancel them first');
    await this.prisma.contentItem.delete({ where: { id } });
    await this.audit.log(user.id, 'content.delete', 'ContentItem', id);
    return { ok: true };
  }
}