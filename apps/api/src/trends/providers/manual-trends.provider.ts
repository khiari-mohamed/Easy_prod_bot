import { BadRequestException, Injectable } from '@nestjs/common';
import { Platform } from '@prisma/client';
import { isValidTag, normalizeTag } from '../../hashtags/hashtag-utils';
import { TREND_DEFAULT_TTL_HOURS, TREND_MAX_TTL_HOURS, TREND_SOURCES } from '../trend-rules';
import { TrendCandidate } from '../trend-provider';

export interface ManualTrendInput {
  platform: Platform;
  tag: string;
  source?: string;
  region?: string;
  score?: number;
  ttlHours?: number;
  sourceNote: string;
}

/**
 * Human-entered or pasted trends (TikTok Creative Center, Instagram Explore, Facebook insights...).
 * "Verified" means a person vouches for it AND writes down where it was seen.
 */
@Injectable()
export class ManualTrendsProvider {
  toCandidate(row: ManualTrendInput): TrendCandidate {
    const source = row.source ?? 'manual';
    if (!(TREND_SOURCES as readonly string[]).includes(source)) {
      throw new BadRequestException(`Source inconnue : ${source}`);
    }
    if (source === 'meta_insights') {
      throw new BadRequestException('La source meta_insights est réservée à la synchronisation automatique.');
    }
    if (!isValidTag(normalizeTag(row.tag))) throw new BadRequestException(`Hashtag invalide : ${row.tag}`);
    if (!row.sourceNote || row.sourceNote.trim().length < 5) {
      throw new BadRequestException('Indiquez où la tendance a été observée (lien ou description).');
    }
    return {
      platform: row.platform,
      tag: row.tag,
      source,
      region: (row.region ?? 'TN').toUpperCase(),
      score: Math.min(1, Math.max(0, row.score ?? 0.6)),
      ttlHours: Math.min(Math.max(row.ttlHours ?? TREND_DEFAULT_TTL_HOURS, 1), TREND_MAX_TTL_HOURS),
      sourceNote: row.sourceNote.trim().slice(0, 300),
    };
  }
}