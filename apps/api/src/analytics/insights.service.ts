import { Injectable, Logger } from '@nestjs/common';
import { Post, SocialAccount } from '@prisma/client';
import { graph } from '../meta/graph.client';
import { METRIC_FIELDS, MetricField } from '../common/engagement';

/** What Meta actually returned. Every metric not in `values` is listed in `unavailable` (never a fake 0). */
export interface FetchedMetrics {
  values: Partial<Record<MetricField, number>>;
  unavailable: MetricField[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function build(raw: Partial<Record<MetricField, number | null>>): FetchedMetrics {
  const values: Partial<Record<MetricField, number>> = {};
  const unavailable: MetricField[] = [];
  for (const f of METRIC_FIELDS) {
    const v = raw[f];
    if (v === null || v === undefined) unavailable.push(f);
    else values[f] = v;
  }
  return { values, unavailable };
}

/**
 * Best-effort reads from the Meta insights endpoints. Meta renames and retires metrics often, and which
 * metrics exist depends on the media type, so each metric is requested on its own and failures are
 * tolerated: whatever Meta returns is stored, everything else is recorded as UNAVAILABLE (not 0).
 */
@Injectable()
export class InsightsService {
  private readonly log = new Logger(InsightsService.name);

  async fetch(post: Post, account: SocialAccount, token: string): Promise<FetchedMetrics | null> {
    if (!post.externalId) return null;
    try {
      return account.platform === 'INSTAGRAM'
        ? await this.instagram(post.externalId, token)
        : await this.facebook(post.externalId, token);
    } catch (e) {
      this.log.warn(`Insights failed for ${post.id}: ${(e as Error).message}`);
      return null;
    }
  }

  /** The metric value, or null when Meta did not return it (unsupported, retired, no permission...). */
  private async metric(id: string, name: string, token: string): Promise<number | null> {
    try {
      const r = await graph<{ data: any[] }>('GET', `${id}/insights`, { metric: name }, token);
      const item = r.data?.[0];
      return num(item?.values?.[0]?.value ?? item?.total_value?.value);
    } catch {
      return null;
    }
  }

  private async instagram(mediaId: string, token: string): Promise<FetchedMetrics> {
    const base = await graph<{ like_count?: number; comments_count?: number }>(
      'GET',
      mediaId,
      { fields: 'like_count,comments_count' },
      token,
    );
    const [reach, saves, shares, views] = await Promise.all(
      ['reach', 'saved', 'shares', 'views'].map((m) => this.metric(mediaId, m, token)),
    );
    return build({
      likes: num(base.like_count),
      comments: num(base.comments_count),
      reach,
      saves,
      shares,
      views,
      // clicks: not provided by this endpoint -> unavailable
    });
  }

  private async facebook(postId: string, token: string): Promise<FetchedMetrics> {
    let likes: number | null = null;
    let comments: number | null = null;
    let shares: number | null = null;
    try {
      const r = await graph<any>(
        'GET',
        postId,
        { fields: 'reactions.summary(true).limit(0),comments.summary(true).limit(0),shares' },
        token,
      );
      likes = num(r.reactions?.summary?.total_count);
      comments = num(r.comments?.summary?.total_count);
      // Graph omits `shares` when nobody shared the post: with a successful read that is a real 0.
      shares = num(r.shares?.count) ?? 0;
    } catch {
      /* some node types (e.g. videos) don't expose all fields: they stay unavailable */
    }
    const [reach, views] = await Promise.all(
      ['post_impressions_unique', 'post_media_view'].map((m) => this.metric(postId, m, token)),
    );
    // Facebook has no "saves" metric and no clicks here: unavailable.
    return build({ likes, comments, shares, reach, views });
  }

  /** Average followers online per local hour (Instagram). Null when unavailable (e.g. under 100 followers). */
  async instagramOnlineFollowers(account: SocialAccount, token: string): Promise<number[] | null> {
    try {
      const r = await graph<{ data: Array<{ values: Array<{ value: Record<string, number> }> }> }>(
        'GET',
        `${account.externalId}/insights`,
        { metric: 'online_followers', period: 'lifetime' },
        token,
      );
      const values = r.data?.[0]?.values ?? [];
      if (!values.length) return null;
      const hours = Array(24).fill(0);
      for (const v of values) for (let h = 0; h < 24; h++) hours[h] += num(v.value?.[String(h)]) ?? 0;
      return hours.map((h) => Math.round(h / values.length));
    } catch {
      return null;
    }
  }
}