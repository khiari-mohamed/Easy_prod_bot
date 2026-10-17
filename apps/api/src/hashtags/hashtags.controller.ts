import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { FeaturePolicyService } from '../features/feature-policy.service';
import { HashtagRankingService } from './hashtag-ranking.service';
import { HashtagsService } from './hashtags.service';
import { CreateHashtagsDto, ListHashtagsQuery, RecommendQuery, UpdateHashtagDto } from './hashtags.dto';

@Controller('hashtags')
export class HashtagsController {
  constructor(
    private readonly hashtags: HashtagsService,
    private readonly ranking: HashtagRankingService,
    private readonly prisma: PrismaService,
    private readonly policy: FeaturePolicyService,
  ) {}

  @Get()
  list(@Query() q: ListHashtagsQuery) {
    return this.hashtags.list(q);
  }

  /** Declared BEFORE ':id' so "recommendations" is not read as an id. */
  @Get('recommendations')
  async recommendations(@Query() q: RecommendQuery) {
    const item = q.contentItemId
      ? await this.prisma.contentItem.findUnique({
          where: { id: q.contentItemId },
          include: { planEntry: true },
        })
      : null;
    if (q.contentItemId && !item) throw new NotFoundException('Contenu introuvable');
    const campaignId =
      q.campaignId ?? item?.campaignId ?? (await this.prisma.campaign.findFirst({ orderBy: { createdAt: 'asc' } }))?.id;

    await this.policy.assertHttp({ feature: 'ai.hashtags', campaignId, platform: q.platform, action: 'RECOMMEND' });

    const context = [
      q.q,
      item?.title,
      item?.baseCaption,
      item?.planEntry?.label,
      item?.planEntry?.content,
      item?.planEntry?.objective,
    ]
      .filter(Boolean)
      .join('\n');

    const { items, flags } = await this.ranking.recommendFor({
      platform: q.platform,
      language: q.language ?? item?.captionLanguage ?? null,
      campaignId,
      context,
      limit: q.limit ?? 12,
    });
    return { items, signals: flags };
  }

  @Get(':id/stats')
  stats(@Param('id') id: string) {
    return this.hashtags.stats(id);
  }

  @Post()
  create(@Body() dto: CreateHashtagsDto, @CurrentUser() user: AuthUser) {
    return this.hashtags.createManual(dto, user);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateHashtagDto, @CurrentUser() user: AuthUser) {
    return this.hashtags.update(id, dto, user);
  }
}