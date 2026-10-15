import { Body, Controller, Global, Logger, Module, NotFoundException, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CaptionLanguage, Platform, PostFormat } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { AiService } from './ai.service';
import { GeminiService } from './gemini.service';
import { PageContext, PageContextService } from './page-context.service';

class CaptionsDto {
  @IsEnum(Platform) platform: Platform;
  @IsEnum(PostFormat) format: PostFormat;
  @IsOptional() @IsString() dayId?: string;
  @IsOptional() @IsString() @MaxLength(1000) brief?: string;
  @IsOptional() @IsEnum(CaptionLanguage) language?: CaptionLanguage;
  @IsOptional() @IsInt() @Min(1) @Max(3) variants?: number;
  @IsOptional() @IsString() contentItemId?: string;
}

class HashtagsDto {
  @IsString() @MaxLength(2200) caption: string;
  @IsOptional() @IsEnum(Platform) platform?: Platform;
  @IsOptional() @IsEnum(CaptionLanguage) language?: CaptionLanguage;
}

@Controller('ai')
export class AiController {
  private readonly log = new Logger(AiController.name);

  constructor(
    private readonly ai: AiService,
    private readonly gemini: GeminiService,
    private readonly pageCtx: PageContextService,
    private readonly accounts: AccountsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Live page data for a platform, or null (plus a note) when no account is connected / readable. */
  private async loadPageContext(platform: Platform): Promise<{ ctx: PageContext | null; note?: string }> {
    const account = await this.accounts.activeFor(platform);
    if (!account) return { ctx: null, note: `Aucun compte ${platform} connecté : légendes sans données de la page.` };
    const ctx = await this.pageCtx.fetch(account, this.accounts.token(account));
    return ctx ? { ctx } : { ctx: null, note: 'Les données de la page n’ont pas pu être lues (permissions ou jeton).' };
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('captions')
  async captions(@Body() dto: CaptionsDto) {
    const campaign = await this.prisma.campaign.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!campaign) throw new NotFoundException('No campaign configured');

    const [day, item] = await Promise.all([
      dto.dayId ? this.prisma.campaignDay.findUnique({ where: { id: dto.dayId } }) : Promise.resolve(null),
      dto.contentItemId
        ? this.prisma.contentItem.findUnique({ where: { id: dto.contentItemId }, include: { planEntry: true } })
        : Promise.resolve(null),
    ]);
    // Plan context: the legacy campaign day, or the plan entry linked to the content item.
    const plan = day ?? item?.planEntry ?? null;
    const language: CaptionLanguage = dto.language ?? item?.captionLanguage ?? 'DARIJA_FRENCH';

    let fallbackReason: string | undefined;
    if (!this.gemini.enabled) {
      fallbackReason = 'GEMINI_API_KEY manquante';
    } else {
      try {
        const { ctx, note } = await this.loadPageContext(dto.platform);
        const variants = await this.gemini.smartCaption({
          platform: dto.platform,
          format: dto.format,
          language,
          campaignTitle: campaign.titleLatin,
          campaignTitleArabic: campaign.titleArabic ?? undefined,
          campaignBrief: campaign.brief,
          officialHashtags: campaign.hashtags,
          releaseDate: campaign.releaseDate.toISOString().slice(0, 10),
          dayLabel: plan?.label,
          dayContent: plan?.content,
          dayExecution: plan?.execution,
          dayObjective: plan?.objective,
          dayPhase: plan?.phase,
          baseCaption: item?.baseCaption || undefined,
          extraBrief: dto.brief,
          pageContext: ctx,
          variants: dto.variants ?? 3,
        });
        return {
          source: 'gemini',
          variants,
          // What the model was given, so the team can verify it.
          context: {
            planUsed: !!plan,
            baseCaptionUsed: !!item?.baseCaption,
            page: ctx
              ? {
                  name: ctx.pageName,
                  postsAnalyzed: ctx.recentPosts.length,
                  topHashtags: ctx.topHashtags.slice(0, 8),
                  hasAudienceHours: !!ctx.audienceHours,
                }
              : null,
            note,
          },
        };
      } catch (e) {
        fallbackReason = (e as Error).message;
        this.log.warn(`Gemini captions failed, falling back: ${fallbackReason}`);
      }
    }

    const fallback = await this.ai.captions({
      campaign,
      day,
      platform: dto.platform,
      format: dto.format,
      extraBrief: dto.brief,
      language: dto.language,
      variants: dto.variants,
    });
    return { ...fallback, fallbackReason };
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('hashtags')
  async hashtags(@Body() dto: HashtagsDto) {
    const campaign = await this.prisma.campaign.findFirst({ orderBy: { createdAt: 'asc' } });
    const officialTags = campaign?.hashtags ?? [];
    if (!this.gemini.enabled) {
      return { hashtags: officialTags, source: 'fallback', reason: 'GEMINI_API_KEY manquante' };
    }

    const pageContext = dto.platform ? (await this.loadPageContext(dto.platform)).ctx : null;
    return this.gemini.suggestHashtags({
      caption: dto.caption,
      officialTags,
      pageContext,
      language: dto.language,
      campaignTitle: campaign?.titleLatin,
      platform: dto.platform,
    });
  }
}

@Global()
@Module({
  controllers: [AiController],
  providers: [AiService, GeminiService, PageContextService],
  exports: [AiService, GeminiService, PageContextService],
})
export class AiModule {}