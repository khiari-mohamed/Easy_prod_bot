import { Injectable, Logger } from '@nestjs/common';
import { Platform, PostFormat } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { METRIC_FIELDS, MetricField } from '../common/engagement';

// Adjust the env var name if your .env uses another one.
const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION ?? 'v26.0'}`;

type Values = Partial<Record<MetricField, number>>;

interface Item {
  externalId: string;
  caption: string;
  publishedAt: Date;
  url: string | null;
  format: PostFormat;
  values: Values;
}

async function graph(pathOrUrl: string, token: string, params: Record<string, string> = {}): Promise<any> {
  const isUrl = pathOrUrl.startsWith('http');
  const url = new URL(isUrl ? pathOrUrl : `${GRAPH}/${pathOrUrl}`);
  if (!isUrl) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', token);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const json: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  return json;
}

/** One metric at a time: an unsupported metric must not fail the others. null = unavailable. */
async function insight(id: string, metric: string, token: string): Promise<number | null> {
  try {
    const j = await graph(`${id}/insights`, token, { metric });
    const d = j?.data?.[0];
    const v = d?.values?.[0]?.value ?? d?.total_value?.value;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

@Injectable()
export class BackfillService {
  private readonly log = new Logger(BackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
  ) {}

  async run(limit = 30) {
    const cap = Math.min(Math.max(limit, 1), 100);
    const out: Record<string, { fetched: number; created: number; updated: number; error?: string }> = {};
    for (const platform of ['INSTAGRAM', 'FACEBOOK'] as Platform[]) {
      try {
        const account = await this.accounts.activeFor(platform);
        if (!account) { out[platform] = { fetched: 0, created: 0, updated: 0, error: 'Aucun compte actif' }; continue; }
        const token = this.accounts.token(account);
        const items = platform === 'INSTAGRAM'
          ? await this.instagram(account.externalId, token, cap)
          : await this.facebook(account.externalId, token, cap);
        out[platform] = { fetched: items.length, ...(await this.store(platform, items)) };
      } catch (e) {
        this.log.error(`Backfill ${platform}: ${(e as Error).message}`);
        out[platform] = { fetched: 0, created: 0, updated: 0, error: (e as Error).message };
      }
    }
    return out;
  }

  private async instagram(igId: string, token: string, cap: number): Promise<Item[]> {
    const items: Item[] = [];
    let page = await graph(`${igId}/media`, token, {
      fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count',
      limit: '50',
    });
    while (page) {
      for (const m of page.data ?? []) {
        if (items.length >= cap) break;
        const values: Values = {};
        if (typeof m.like_count === 'number') values.likes = m.like_count;
        if (typeof m.comments_count === 'number') values.comments = m.comments_count;
        const [views, reach, saves, shares] = [
          await insight(m.id, 'views', token),
          await insight(m.id, 'reach', token),
          await insight(m.id, 'saved', token),
          await insight(m.id, 'shares', token),
        ];
        if (views !== null) values.views = views;
        if (reach !== null) values.reach = reach;
        if (saves !== null) values.saves = saves;
        if (shares !== null) values.shares = shares;
        items.push({
          externalId: m.id,
          caption: m.caption ?? '(sans l\u00e9gende)',
          publishedAt: new Date(m.timestamp),
          url: m.permalink ?? null,
          format: m.media_product_type === 'REELS' ? 'REEL' : m.media_product_type === 'STORY' ? 'STORY' : m.media_type === 'VIDEO' ? 'VIDEO' : 'IMAGE',
          values,
        });
      }
      if (items.length >= cap || !page.paging?.next) break;
      page = await graph(page.paging.next, token);
    }
    return items;
  }

  private async facebook(pageId: string, token: string, cap: number): Promise<Item[]> {
    const items: Item[] = [];
    let page = await graph(`${pageId}/published_posts`, token, {
      fields: 'id,message,created_time,permalink_url,shares,attachments{media_type},reactions.summary(true).limit(0),comments.summary(true).limit(0)',
      limit: '50',
    });
    while (page) {
      for (const p of page.data ?? []) {
        if (items.length >= cap) break;
        const values: Values = {};
        const reactions = p.reactions?.summary?.total_count;
        const comments = p.comments?.summary?.total_count;
        if (typeof reactions === 'number') values.likes = reactions;
        if (typeof comments === 'number') values.comments = comments;
        values.shares = p.shares?.count ?? 0; // Meta omits the field when there are no shares
        // Metric names change often on Facebook: verify them in the current docs.
        const views = await insight(p.id, 'post_media_view', token);
        const reach = await insight(p.id, 'post_total_media_view_unique', token);
        if (views !== null) values.views = views;
        if (reach !== null) values.reach = reach;
        const media = p.attachments?.data?.[0]?.media_type as string | undefined;
        items.push({
          externalId: p.id,
          caption: p.message ?? '(sans l\u00e9gende)',
          publishedAt: new Date(p.created_time),
          url: p.permalink_url ?? null,
          format: media === 'video' ? 'VIDEO' : media === 'photo' ? 'IMAGE' : 'TEXT',
          values,
        });
      }
      if (items.length >= cap || !page.paging?.next) break;
      page = await graph(page.paging.next, token);
    }
    return items;
  }

  private async store(platform: Platform, items: Item[]) {
    let created = 0;
    let updated = 0;
    for (const it of items) {
      const metrics = {
        ...it.values,
        // Anything the API did not return is unavailable, never 0.
        unavailable: METRIC_FIELDS.filter((f) => it.values[f] === undefined) as string[],
      };
      const existing = await this.prisma.post.findFirst({ where: { platform, externalId: it.externalId } });
      if (existing) {
        await this.prisma.metricSnapshot.create({ data: { postId: existing.id, source: 'API', ...metrics } });
        updated++;
      } else {
        await this.prisma.post.create({
          data: {
            platform,
            format: it.format,
            caption: it.caption,
            hashtags: [],
            status: 'PUBLISHED',
            publishState: 'PUBLISHED',
            isExternal: true,
            externalId: it.externalId,
            externalUrl: it.url,
            publishedAt: it.publishedAt,
            statusNote: 'Import\u00e9 depuis l\u2019API Meta',
            metrics: { create: { source: 'API', ...metrics } },
          },
        });
        created++;
      }
    }
    return { created, updated };
  }
}
