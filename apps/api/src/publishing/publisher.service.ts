import { Injectable, Logger } from '@nestjs/common';
import { Asset, Post, SocialAccount } from '@prisma/client';
import { graph, MetaApiError } from '../meta/graph.client';
import { fullCaption } from '../posts/post.rules';
import { MediaService } from '../media/media.service';

export interface PublishResult {
  externalId: string;
  externalUrl?: string;
}

/** Callbacks so the caller can persist progress the moment the platform confirms it. */
export interface PublishHooks {
  /** The platform accepted a container; recording it prevents duplicate posts on retry. */
  onContainer?: (containerId: string) => Promise<void>;
  /** The platform confirms the post is live. Must be called before any later step fails. */
  onPublished: (externalId: string) => Promise<void>;
}

type PostWithAsset = Post & { asset: Asset | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Publishes to Facebook Pages and Instagram professional accounts through the Graph API. */
@Injectable()
export class PublisherService {
  private readonly log = new Logger(PublisherService.name);

  constructor(private readonly media: MediaService) {}

  async publish(
    post: PostWithAsset,
    account: SocialAccount,
    token: string,
    hooks: PublishHooks,
  ): Promise<PublishResult> {
    if (account.platform === 'FACEBOOK') return this.facebook(post, account, token, hooks);
    if (account.platform === 'INSTAGRAM') return this.instagram(post, account, token, hooks);
    throw new Error(`Automatic publishing is not supported for ${account.platform}`);
  }

  private async facebook(post: PostWithAsset, account: SocialAccount, token: string, hooks: PublishHooks) {
    const message = fullCaption(post.caption, post.hashtags);
    const page = account.externalId;
    let id: string;

    if (post.format === 'TEXT') {
      id = (await graph<{ id: string }>('POST', `${page}/feed`, { message }, token)).id;
    } else if (post.format === 'IMAGE') {
      const url = this.requirePublicHttps(await this.media.publishUrl(this.requireAsset(post)));
      const r = await graph<{ id: string; post_id?: string }>(
        'POST',
        `${page}/photos`,
        { url, caption: message, published: true },
        token,
      );
      id = r.post_id ?? r.id;
    } else {
      // VIDEO and REEL are published as a regular Page video.
      const url = this.requirePublicHttps(await this.media.publishUrl(this.requireAsset(post)));
      id = (await graph<{ id: string }>('POST', `${page}/videos`, { file_url: url, description: message }, token)).id;
    }

    await hooks.onPublished(id);
    return { externalId: id, externalUrl: `https://www.facebook.com/${id}` };
  }

  private async instagram(post: PostWithAsset, account: SocialAccount, token: string, hooks: PublishHooks) {
    const ig = account.externalId;
    const asset = this.requireAsset(post);
    const url = this.requirePublicHttps(await this.media.publishUrl(asset));
    const caption = fullCaption(post.caption, post.hashtags);

    const params: Record<string, string | boolean> = {};
    let isVideo = false;
    if (post.format === 'IMAGE') {
      params.image_url = url;
      params.caption = caption;
    } else if (post.format === 'STORY') {
      params.media_type = 'STORIES';
      if (asset.kind === 'VIDEO') {
        params.video_url = url;
        isVideo = true;
      } else params.image_url = url;
    } else {
      params.media_type = 'REELS';
      params.video_url = url;
      params.caption = caption;
      params.share_to_feed = true;
      isVideo = true;
    }

    const container = await graph<{ id: string }>('POST', `${ig}/media`, params, token);
    // Record the container before publishing: a retry can reuse it instead of
    // making a second container (and a second post).
    await hooks.onContainer?.(container.id);
    if (isVideo) await this.waitForContainer(container.id, token);

    const published = await graph<{ id: string }>('POST', `${ig}/media_publish`, { creation_id: container.id }, token);
    await hooks.onPublished(published.id);

    let externalUrl: string | undefined;
    try {
      externalUrl = (await graph<{ permalink?: string }>('GET', published.id, { fields: 'permalink' }, token)).permalink;
    } catch (e) {
      this.log.warn(`Published ${published.id} but could not fetch its permalink: ${(e as Error).message}`);
    }
    return { externalId: published.id, externalUrl };
  }

  /**
   * Publishes an already-created Instagram container. Used when a previous
   * attempt recorded the container id but did not confirm publication: we can
   * finish the job instead of creating a duplicate container.
   */
  async publishExistingContainer(
    igUserId: string,
    containerId: string,
    token: string,
    hooks: PublishHooks,
  ): Promise<PublishResult> {
    // The container may still be processing (a previous attempt timed out while waiting): wait first.
    await this.waitForContainer(containerId, token);
    const published = await graph<{ id: string }>(
      'POST',
      `${igUserId}/media_publish`,
      { creation_id: containerId },
      token,
    );
    await hooks.onPublished(published.id);
    let externalUrl: string | undefined;
    try {
      externalUrl = (await graph<{ permalink?: string }>('GET', published.id, { fields: 'permalink' }, token)).permalink;
    } catch {
      /* permalink is best-effort */
    }
    return { externalId: published.id, externalUrl };
  }

  /** Video containers are processed asynchronously by Instagram. */
  private async waitForContainer(containerId: string, token: string) {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const s = await graph<{ status_code?: string; status?: string }>(
        'GET',
        containerId,
        { fields: 'status_code,status' },
        token,
      );
      if (s.status_code === 'FINISHED') return;
      if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
        throw new MetaApiError(`Instagram could not process the media (${s.status ?? s.status_code})`, 400, 100);
      }
      await sleep(5_000);
    }
    // Nothing was published yet (media_publish was not called): a normal, retryable error, NOT an ambiguous one.
    throw new MetaApiError('Timed out waiting for Instagram to process the video', 408);
  }

  private requireAsset(post: PostWithAsset): Asset {
    if (!post.asset) throw new MetaApiError('Post has no media asset', 400, 100);
    return post.asset;
  }

  /** Meta downloads the media itself, so the URL must be a public HTTPS address. Fails fast (fatal code 100, no retries). */
  private requirePublicHttps(raw: string): string {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new MetaApiError('The media URL is invalid.', 400, 100);
    }
    const host = u.hostname.toLowerCase();
    const privateHost =
      host === 'localhost' ||
      host === '0.0.0.0' ||
      host === '[::1]' ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
    if (u.protocol !== 'https:' || privateHost) {
      throw new MetaApiError(
        'The media URL is not a public HTTPS address, so Meta cannot fetch it. Check PUBLIC_BASE_URL.',
        400,
        100,
      );
    }
    return raw;
  }
}
