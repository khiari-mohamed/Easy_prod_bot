import { Injectable, NotFoundException } from '@nestjs/common';
import { getEnv } from '../env';
import { StorageService } from './storage.service';
import { signedMediaUrl } from './media-token';

export interface StorableAsset {
  id: string;
  storageKey: string | null;
  storedAs: string | null;
  url?: string | null;
}

/** Turns a stored key into a URL. Display URLs are stable; publish URLs expire. */
@Injectable()
export class MediaService {
  constructor(private readonly storage: StorageService) {}

  private keyOf(asset: StorableAsset): string | null {
    return asset.storageKey ?? asset.storedAs ?? null;
  }

  /** Stable URL for the dashboard (<img>, <video>, downloads). */
  displayUrl(asset: StorableAsset): string {
    const key = this.keyOf(asset);
    if (!key) return asset.url ?? '';
    // For local storage there is no public file server — use the signed access endpoint.
    if (this.storage.provider === 'LOCAL') return signedMediaUrl(asset.id);
    return this.storage.publicUrl(key) ?? signedMediaUrl(asset.id);
  }

  /**
   * URL handed to a platform (Meta) to fetch media. Prefers a public or
   * presigned object URL; falls back to our signed, expiring access endpoint.
   */
  async publishUrl(asset: StorableAsset, ttlSeconds?: number): Promise<string> {
    const key = this.keyOf(asset);
    if (!key) {
      if (asset.url) return asset.url;
      throw new NotFoundException('The asset has no stored file');
    }
    const ttl = ttlSeconds ?? getEnv().MEDIA_URL_TTL_SECONDS;
    // For local storage there is no public file server — use the signed access endpoint.
    if (this.storage.provider === 'LOCAL') return signedMediaUrl(asset.id, ttl);
    const pub = this.storage.publicUrl(key);
    if (pub) return pub;
    const signed = await this.storage.signedUrl(key, ttl);
    if (signed) return signed;
    return signedMediaUrl(asset.id, ttl);
  }

  /** Stream used by the signed access endpoint. */
  stream(key: string, range?: { start: number; end: number }) {
    return this.storage.getStream(key, range);
  }

  head(key: string) {
    return this.storage.head(key);
  }
}
