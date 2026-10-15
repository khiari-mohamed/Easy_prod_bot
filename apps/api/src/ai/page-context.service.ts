import { Injectable, Logger } from '@nestjs/common';
import { Platform, SocialAccount } from '@prisma/client';
import { graph } from '../meta/graph.client';

export interface PagePost {
  id: string;
  message: string;
  createdTime: string;
  likes: number;
  comments: number;
  shares: number;
  reach: number | null;
}

export interface PageContext {
  platform: Platform;
  pageName: string;
  followers: number | null;
  recentPosts: PagePost[];
  topPosts: PagePost[];
  audienceHours: number[] | null; // 24-slot array of relative activity per hour
  topHashtags: string[]; // extracted from best-performing posts
}

@Injectable()
export class PageContextService {
  private readonly log = new Logger(PageContextService.name);
  private static readonly TTL_MS = 10 * 60_000;
  private readonly cache = new Map<string, { at: number; ctx: PageContext }>();

  async fetch(account: SocialAccount, token: string): Promise<PageContext | null> {
    const key = `${account.platform}:${account.externalId}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < PageContextService.TTL_MS) return hit.ctx;
    try {
      const ctx =
        account.platform === 'INSTAGRAM'
          ? await this.instagram(account, token)
          : await this.facebook(account, token);
      this.cache.set(key, { at: Date.now(), ctx });
      return ctx;
    } catch (e) {
      this.log.warn(`PageContext fetch failed for ${account.platform} ${account.externalId}: ${(e as Error).message}`);
      return null;
    }
  }

  private async facebook(account: SocialAccount, token: string): Promise<PageContext> {
    const id = account.externalId;

    // Page info + follower count
    const page = await graph<{ name: string; fan_count?: number }>(
      'GET', id, { fields: 'name,fan_count' }, token,
    ).catch(() => ({ name: account.name, fan_count: undefined }));

    // Recent posts with engagement
    const feed = await graph<{ data: Array<{ id: string; message?: string; created_time: string; reactions?: { summary: { total_count: number } }; comments?: { summary: { total_count: number } }; shares?: { count: number } }> }>(
      'GET', `${id}/posts`,
      { fields: 'id,message,created_time,reactions.summary(true).limit(0),comments.summary(true).limit(0),shares', limit: 20 },
      token,
    ).catch(() => ({ data: [] }));

    // Fetch reach for each post (best effort)
    const posts: PagePost[] = await Promise.all(
      feed.data.map(async (p) => {
        let reach: number | null = null;
        try {
          const ins = await graph<{ data: Array<{ values: Array<{ value: number }> }> }>(
            'GET', `${p.id}/insights`, { metric: 'post_impressions_unique' }, token,
          );
          reach = ins.data?.[0]?.values?.[0]?.value ?? null;
        } catch { /* unavailable */ }
        return {
          id: p.id,
          message: p.message ?? '',
          createdTime: p.created_time,
          likes: p.reactions?.summary?.total_count ?? 0,
          comments: p.comments?.summary?.total_count ?? 0,
          shares: p.shares?.count ?? 0,
          reach,
        };
      }),
    );

    return {
      platform: 'FACEBOOK',
      pageName: page.name,
      followers: page.fan_count ?? null,
      recentPosts: posts,
      topPosts: this.top(posts),
      audienceHours: null,
      topHashtags: this.extractHashtags(posts),
    };
  }

  private async instagram(account: SocialAccount, token: string): Promise<PageContext> {
    const id = account.externalId;

    // Account info
    const info = await graph<{ name?: string; username?: string; followers_count?: number }>(
      'GET', id, { fields: 'name,username,followers_count' }, token,
    ).catch(() => ({ name: account.name, username: account.username, followers_count: undefined }));

    // Recent media with engagement
    const media = await graph<{ data: Array<{ id: string; caption?: string; timestamp: string; like_count?: number; comments_count?: number; media_type?: string }> }>(
      'GET', `${id}/media`,
      { fields: 'id,caption,timestamp,like_count,comments_count,media_type', limit: 20 },
      token,
    ).catch(() => ({ data: [] }));

    // Fetch reach + saves per post (best effort)
    const posts: PagePost[] = await Promise.all(
      media.data.map(async (m) => {
        let reach: number | null = null;
        let saves: number | null = null;
        try {
          const ins = await graph<{ data: Array<{ name: string; values?: Array<{ value: number }>; total_value?: { value: number } }> }>(
            'GET', `${m.id}/insights`, { metric: 'reach,saved' }, token,
          );
          for (const d of ins.data ?? []) {
            const val = d.total_value?.value ?? d.values?.[0]?.value ?? null;
            if (d.name === 'reach') reach = val;
            if (d.name === 'saved') saves = val;
          }
        } catch { /* unavailable */ }
        return {
          id: m.id,
          message: m.caption ?? '',
          createdTime: m.timestamp,
          likes: m.like_count ?? 0,
          comments: m.comments_count ?? 0,
          shares: saves ?? 0, // saves as proxy for shares on IG
          reach,
        };
      }),
    );

    // Follower online hours
    let audienceHours: number[] | null = null;
    try {
      const r = await graph<{ data: Array<{ values: Array<{ value: Record<string, number> }> }> }>(
        'GET', `${id}/insights`, { metric: 'online_followers', period: 'lifetime' }, token,
      );
      const values = r.data?.[0]?.values ?? [];
      if (values.length) {
        const hours = Array(24).fill(0);
        for (const v of values) for (let h = 0; h < 24; h++) hours[h] += v.value?.[String(h)] ?? 0;
        audienceHours = hours.map((h) => Math.round(h / values.length));
      }
    } catch { /* unavailable */ }

    return {
      platform: 'INSTAGRAM',
      pageName: info.username ?? info.name ?? account.name,
      followers: info.followers_count ?? null,
      recentPosts: posts,
      topPosts: this.top(posts),
      audienceHours,
      topHashtags: this.extractHashtags(posts),
    };
  }

  /** Top 5 posts by engagement score (likes + comments + shares) / reach */
  private top(posts: PagePost[]): PagePost[] {
    return [...posts]
      .sort((a, b) => {
        const scoreA = (a.likes + a.comments + a.shares) / Math.max(a.reach ?? 1, 1);
        const scoreB = (b.likes + b.comments + b.shares) / Math.max(b.reach ?? 1, 1);
        return scoreB - scoreA;
      })
      .slice(0, 5);
  }

  /** Extract hashtags from post captions */
  private extractHashtags(posts: PagePost[]): string[] {
    const counts = new Map<string, number>();
    for (const p of posts) {
      const tags = p.message.match(/#[\w\u0600-\u06FF]+/g) ?? [];
      for (const t of tags) {
        const clean = t.slice(1).toLowerCase();
        counts.set(clean, (counts.get(clean) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([tag]) => tag);
  }
}
