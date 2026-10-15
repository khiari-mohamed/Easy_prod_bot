import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  OnApplicationBootstrap,
  Logger,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CaptionLanguage, Platform, PostFormat, Role } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AiService } from '../ai/ai.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { getEnv } from '../env';
import { CAMPAIGN_DAYS, CAMPAIGN_SEED } from './campaign.seed';

class UpdateCampaignDto {
  @IsOptional() @IsString() @MaxLength(200) titleLatin?: string;
  @IsOptional() @IsString() @MaxLength(200) titleArabic?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(60, { each: true }) hashtags?: string[];
  @IsOptional() @IsString() @MaxLength(8000) brief?: string;
}

class UpdateDayDto {
  @IsOptional() @IsArray() @IsEnum(Platform, { each: true }) platforms?: Platform[];
  @IsOptional() @IsEnum(PostFormat) format?: PostFormat;
}

class GenerateDraftsDto {
  @IsOptional() @IsArray() @IsEnum(Platform, { each: true }) platforms?: Platform[];
  @IsOptional() @IsEnum(CaptionLanguage) language?: CaptionLanguage;
}

function formatFor(platform: Platform, dayFormat: PostFormat): PostFormat {
  return platform === 'TIKTOK' ? 'REEL' : dayFormat;
}

@Injectable()
export class CampaignService implements OnApplicationBootstrap {
  private readonly log = new Logger(CampaignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap() {
    const env = getEnv();
    if ((await this.prisma.user.count()) === 0) {
      if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD.length >= 12) {
        await this.prisma.user.create({
          data: {
            email: env.ADMIN_EMAIL.toLowerCase(),
            name: 'Admin',
            role: 'ADMIN',
            passwordHash: await bcrypt.hash(env.ADMIN_PASSWORD, 12),
          },
        });
        this.log.log(`Created admin user ${env.ADMIN_EMAIL}`);
      } else {
        this.log.warn(
          'No users exist. Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters, then restart.',
        );
      }
    }

    if ((await this.prisma.campaign.count()) === 0) {
      const campaign = await this.prisma.campaign.create({
        data: {
          ...CAMPAIGN_SEED,
          days: { create: CAMPAIGN_DAYS.map((d) => ({ ...d, date: new Date(d.date) })) },
        },
      });

      // Also create PlanEntry records for each seeded day so the new pipeline has data
      for (const d of CAMPAIGN_DAYS) {
        const day = await this.prisma.campaignDay.findFirst({
          where: { campaignId: campaign.id, date: new Date(d.date) },
        });
        if (day) {
          await this.prisma.planEntry.upsert({
            where: { legacyDayId: day.id },
            create: {
              campaignId: campaign.id,
              legacyDayId: day.id,
              date: new Date(d.date),
              phase: d.phase,
              label: d.label,
              content: d.content,
              execution: d.execution,
              objective: d.objective,
              platforms: d.platforms,
              format: d.format,
            },
            update: {},
          });
        }
      }

      this.log.log('Seeded the campaign plan (3-14 October) with PlanEntry records');
    }
  }

  async get() {
    const campaign = await this.prisma.campaign.findFirst({
      include: {
        days: {
          orderBy: { date: 'asc' },
          include: {
            posts: {
              select: {
                id: true,
                platform: true,
                format: true,
                status: true,
                scheduledAt: true,
                caption: true,
                publishMode: true,
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });
    if (!campaign) throw new NotFoundException('No campaign configured');
    return campaign;
  }

  async update(dto: UpdateCampaignDto, user: AuthUser) {
    const campaign = await this.prisma.campaign.findFirst();
    if (!campaign) throw new NotFoundException();
    const updated = await this.prisma.campaign.update({ where: { id: campaign.id }, data: dto });
    await this.audit.log(user.id, 'campaign.update', 'Campaign', campaign.id);
    return updated;
  }

  async updateDay(id: string, dto: UpdateDayDto) {
    return this.prisma.campaignDay.update({ where: { id }, data: dto });
  }

  async generateDrafts(dayId: string, dto: GenerateDraftsDto, user: AuthUser) {
    const day = await this.prisma.campaignDay.findUnique({
      where: { id: dayId },
      include: { campaign: true },
    });
    if (!day) throw new NotFoundException('Day not found');

    const wanted = dto.platforms?.length ? dto.platforms : day.platforms;
    const existing = await this.prisma.post.findMany({
      where: { dayId, status: { not: 'CANCELLED' } },
      select: { platform: true },
    });
    const have = new Set(existing.map((p) => p.platform));

    const created = [];
    for (const platform of wanted) {
      if (have.has(platform)) continue;
      const format = formatFor(platform, day.format);
      const lang = dto.language ?? (platform === 'TIKTOK' ? 'DARIJA' : 'DARIJA_FRENCH');
      const res = await this.ai.captions({
        campaign: day.campaign,
        day,
        platform,
        format,
        language: lang,
      });
      const v = res.variants[0];
      created.push(
        await this.prisma.post.create({
          data: {
            campaignId: day.campaignId,
            dayId,
            platform,
            format,
            caption: v.caption,
            hashtags: v.hashtags,
            captionLanguage: lang,
            publishMode: 'MANUAL',
            createdById: user.id,
            statusNote:
              res.source === 'ai' ? 'AI draft: review before submitting' : 'Template draft (AI is off): rewrite',
          },
        }),
      );
    }
    await this.audit.log(user.id, 'campaign.generateDrafts', 'CampaignDay', dayId, {
      created: created.length,
    });
    return created;
  }
}

@Controller('campaign')
export class CampaignController {
  constructor(private readonly campaign: CampaignService) {}

  @Get()
  get() {
    return this.campaign.get();
  }

  @Patch()
  @Roles(Role.APPROVER)
  update(@Body() dto: UpdateCampaignDto, @CurrentUser() u: AuthUser) {
    return this.campaign.update(dto, u);
  }

  @Patch('days/:id')
  @Roles(Role.APPROVER)
  updateDay(@Param('id') id: string, @Body() dto: UpdateDayDto) {
    return this.campaign.updateDay(id, dto);
  }

  @Post('days/:id/generate-drafts')
  generateDrafts(@Param('id') id: string, @Body() dto: GenerateDraftsDto, @CurrentUser() u: AuthUser) {
    return this.campaign.generateDrafts(id, dto, u);
  }
}

@Module({ controllers: [CampaignController], providers: [CampaignService] })
export class CampaignModule {}
