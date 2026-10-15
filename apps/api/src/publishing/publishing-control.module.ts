import { Controller, Get, Module, Post, Body, Param } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.module';
import { AuditService } from '../common/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';

class SetCampaignAutoPublishDto {
  @IsBoolean() enabled: boolean;
}

class PauseCampaignDto {
  @IsBoolean() paused: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

@Controller('publishing')
export class PublishingControlController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** Overview: queue state, recent failures, recent publications. */
  @Get('overview')
  async overview() {
    const [queued, publishing, failed, manualRequired, recentPublished, needsCheck] = await Promise.all([
      this.prisma.post.findMany({
        where: { status: 'QUEUED' },
        select: { id: true, platform: true, format: true, caption: true, scheduledAt: true, publishMode: true },
        orderBy: { scheduledAt: 'asc' },
        take: 50,
      }),
      this.prisma.post.findMany({
        where: { status: 'PUBLISHING' },
        select: { id: true, platform: true, format: true, caption: true, scheduledAt: true, updatedAt: true },
        orderBy: { updatedAt: 'asc' },
        take: 20,
      }),
      this.prisma.post.findMany({
        where: { status: 'FAILED' },
        select: { id: true, platform: true, format: true, caption: true, scheduledAt: true, statusNote: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 30,
      }),
      this.prisma.post.findMany({
        where: { status: 'MANUAL_REQUIRED' },
        select: { id: true, platform: true, format: true, caption: true, scheduledAt: true, statusNote: true, publishMode: true },
        orderBy: { scheduledAt: 'asc' },
        take: 50,
      }),
      this.prisma.post.findMany({
        where: { status: 'PUBLISHED' },
        select: { id: true, platform: true, format: true, caption: true, publishedAt: true, externalUrl: true, publishMode: true, manualConfirmedAt: true },
        orderBy: { publishedAt: 'desc' },
        take: 50,
      }),
      // Meta may or may not have published these: a human must look at the platform.
      this.prisma.post.findMany({
        where: { status: 'NEEDS_RECONCILIATION' },
        select: { id: true, platform: true, format: true, caption: true, scheduledAt: true, statusNote: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      }),
    ]);

    const pauseState = await this.settings.pauseState();
    const campaign = await this.prisma.campaign.findFirst({
      select: { id: true, autoPublishEnabled: true, publishingPaused: true, timezone: true },
    });

    return { pauseState, campaign, queued, publishing, failed, manualRequired, recentPublished, needsCheck };
  }

  /** Toggle campaign-level auto-publish. Posts only auto-publish when this AND post.publishMode=AUTO. */
  @Post('campaign/auto-publish')
  @Roles(Role.APPROVER)
  async setCampaignAutoPublish(@Body() dto: SetCampaignAutoPublishDto, @CurrentUser() user: AuthUser) {
    const campaign = await this.prisma.campaign.findFirst();
    if (!campaign) return { ok: false };
    await this.prisma.campaign.update({
      where: { id: campaign.id },
      data: { autoPublishEnabled: dto.enabled },
    });
    await this.audit.log(user.id, dto.enabled ? 'campaign.autoPublish.enable' : 'campaign.autoPublish.disable', 'Campaign', campaign.id);
    return { ok: true, autoPublishEnabled: dto.enabled };
  }

  /** Pause/resume publishing for the whole campaign (separate from global pause). */
  @Post('campaign/pause')
  @Roles(Role.APPROVER)
  async pauseCampaign(@Body() dto: PauseCampaignDto, @CurrentUser() user: AuthUser) {
    const campaign = await this.prisma.campaign.findFirst();
    if (!campaign) return { ok: false };
    await this.prisma.campaign.update({
      where: { id: campaign.id },
      data: { publishingPaused: dto.paused },
    });
    await this.audit.log(
      user.id,
      dto.paused ? 'campaign.publishing.pause' : 'campaign.publishing.resume',
      'Campaign',
      campaign.id,
      { reason: dto.reason },
    );
    return { ok: true, publishingPaused: dto.paused };
  }
}

@Module({ controllers: [PublishingControlController] })
export class PublishingControlModule {}
