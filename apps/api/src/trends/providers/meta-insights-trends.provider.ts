import { Injectable, Logger } from '@nestjs/common';
import { Platform } from '@prisma/client';
import { AccountsService } from '../../accounts/accounts.service';
import { PageContextService } from '../../ai/page-context.service';
import { TrendCandidate, TrendProvider } from '../trend-provider';

/**
 * Own-account signal: the hashtags used on the Page's best-performing posts (Meta APIs, read-only,
 * already cached and rate-guarded by PageContextService). This is what works on OUR audience, not a
 * platform-wide trend, and the note says so. TikTok has no equivalent here: its trends arrive through
 * the manual provider, never through scraping.
 */
@Injectable()
export class MetaInsightsTrendsProvider implements TrendProvider {
  readonly name = 'meta_insights';
  private readonly log = new Logger(MetaInsightsTrendsProvider.name);

  constructor(
    private readonly accounts: AccountsService,
    private readonly pageCtx: PageContextService,
  ) {}

  async collect(): Promise<TrendCandidate[]> {
    const out: TrendCandidate[] = [];
    for (const platform of ['INSTAGRAM', 'FACEBOOK'] as Platform[]) {
      try {
        const account = await this.accounts.activeFor(platform);
        if (!account) continue;
        const ctx = await this.pageCtx.fetch(account, this.accounts.token(account));
        if (!ctx) continue;
        ctx.topHashtags.slice(0, 10).forEach((tag, i) =>
          out.push({
            platform,
            tag,
            source: 'meta_insights',
            region: 'TN',
            score: Math.max(0.3, 1 - i * 0.07),
            ttlHours: 72,
            sourceNote: `Hashtags des meilleurs posts de ${ctx.pageName} (signal du compte, pas une tendance de la plateforme)`,
          }),
        );
      } catch (e) {
        this.log.warn(`${platform} insights unavailable: ${(e as Error).message}`);
      }
    }
    return out;
  }
}