import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Asset, AssetKind, AssetSource } from '@prisma/client';
import { createHash } from 'crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'fs';
import { readFile, rm, stat } from 'fs/promises';
import { join, extname } from 'path';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../auth/auth.types';
import { getEnv } from '../env';
import { MediaService } from '../media/media.service';
import { MediaProcessorService } from '../media/media-processor.service';
import { MediaQueueService } from '../media/media-queue.service';
import { StorageService } from '../media/storage.service';
import { ImportUrlDto, ListAssetsQuery } from './assets.dto';
import { extensionFor, kindForMime, mimeForExtension, sniffFile } from './assets.constants';
import { assertPublicUrl } from './url-guard';

export interface FinalizeInput {
  tempPath: string;
  name: string;
  mime: string | null;
  kind: AssetKind;
  source: AssetSource;
  sourceUrl?: string | null;
  folder?: string | null;
  size?: number;
  checksumSha256?: string;
  user: AuthUser;
}

const LIBRARY_PREFIX = 'library';

@Injectable()
export class AssetsService {
  private readonly log = new Logger(AssetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly media: MediaService,
    private readonly queue: MediaQueueService,
    private readonly processor: MediaProcessorService,
  ) {}

  /** Assets for the library, with a freshly signed display URL each read. */
  async list(q: ListAssetsQuery) {
    const assets = await this.prisma.asset.findMany({
      where: {
        deletedAt: null,
        kind: q.kind,
        folder: q.folder,
        ...(q.search ? { name: { contains: q.search, mode: 'insensitive' as const } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return assets.map((a) => this.withDisplayUrl(a));
  }

  private withDisplayUrl<T extends Asset>(asset: T): T & { url: string } {
    return { ...asset, url: this.media.displayUrl(asset) };
  }

  /**
   * Copies a finished temp file into storage, deduplicates by checksum and
   * registers the asset in PROCESSING so the media worker inspects it.
   */
  async finalize(input: FinalizeInput): Promise<Asset> {
    const size = input.size ?? (await stat(input.tempPath)).size;
    const max = getEnv().MEDIA_MAX_UPLOAD_BYTES;
    if (size > max) {
      await rm(input.tempPath, { force: true }).catch(() => undefined);
      throw new BadRequestException(`File exceeds the ${Math.round(max / 1024 / 1024)} MB limit`);
    }

    // The REAL type comes from the file's own bytes, never from the browser's claim or the extension.
    const sniffed = await sniffFile(input.tempPath);
    if (!sniffed) {
      await rm(input.tempPath, { force: true }).catch(() => undefined);
      throw new BadRequestException('The file content is not a JPEG, PNG, WebP, GIF, MP4, MOV or WebM file');
    }
    const { mime, ext, kind } = sniffed;

    const checksum = input.checksumSha256 ?? (await hashFile(input.tempPath));
    const duplicate = await this.prisma.asset.findFirst({ where: { checksumSha256: checksum, deletedAt: null } });
    if (duplicate) {
      await rm(input.tempPath, { force: true }).catch(() => undefined);
      return this.withDisplayUrl(duplicate);
    }

    const key = `${LIBRARY_PREFIX}/${Date.now()}-${checksum.slice(0, 12)}${ext}`;

    await this.storage.put(key, createReadStream(input.tempPath), {
      contentType: mime,
      size,
    });
    await rm(input.tempPath, { force: true }).catch(() => undefined);

    const asset = await this.prisma.asset.create({
      data: {
        name: input.name,
        kind,
        url: this.storage.publicUrl(key) ?? '',
        mime,
        storedAs: key,
        storageKey: key,
        storageProvider: this.storage.provider,
        checksumSha256: checksum,
        sizeBytes: size <= 2_147_483_647 ? size : null,
        sizeBytesBig: BigInt(size),
        source: input.source,
        sourceUrl: input.sourceUrl ?? null,
        folder: input.folder ?? null,
        processingStatus: 'PROCESSING',
      },
    });

    await this.audit.log(input.user.id, 'asset.create', 'Asset', asset.id, { name: asset.name, kind: asset.kind, source: input.source });
    await this.scheduleProcessing(asset.id);
    return this.withDisplayUrl(asset);
  }

  /** Direct multipart upload: the file has already been written to a temp path. finalize() checks the real content. */
  async uploadDirect(tempPath: string, originalName: string, mime: string, user: AuthUser) {
    const ext = extensionFor(mime, originalName) ?? '';
    return this.finalize({ tempPath, name: originalName, mime, kind: kindForMime(mime, ext), source: 'UPLOAD', user });
  }

  /**
   * Server-side import from a direct URL (Google Drive `uc?export=download`,
   * Dropbox `dl=1`, any HTTPS link). The bytes are validated and copied into our
   * own storage so a later link change cannot break publishing.
   */
  async importUrl(dto: ImportUrlDto, user: AuthUser) {
    const max = getEnv().MEDIA_MAX_UPLOAD_BYTES;
    const res = await this.fetchPublic(dto.url);

    const headerType = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (headerType?.startsWith('text/')) {
      await res.body?.cancel().catch(() => undefined);
      throw new BadRequestException(
        'This link returns a web page, not a file. Google Drive / Dropbox share pages are not direct links: use a direct download link.',
      );
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > max) {
      await res.body?.cancel().catch(() => undefined);
      throw new BadRequestException('File exceeds the maximum upload size');
    }

    const tmpDir = getEnv().UPLOAD_TMP_DIR;
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const tempPath = join(tmpDir, `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);

    // Count bytes while streaming: a server that lies about (or omits) Content-Length cannot fill the disk.
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > max) cb(new Error(`File exceeds the ${Math.round(max / 1024 / 1024)} MB limit`));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as never), limiter, createWriteStream(tempPath));
    } catch (e) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw new BadRequestException(`Failed to save the imported file: ${(e as Error).message}`);
    }

    const source: AssetSource = dto.source
      ? dto.source
      : dto.url.includes('drive.google.com')
        ? 'GOOGLE_DRIVE'
        : dto.url.includes('dropbox.com')
          ? 'DROPBOX'
          : 'UPLOAD';

    return this.finalize({
      tempPath,
      name: dto.name,
      mime: headerType ?? null,
      kind: dto.kind ?? 'IMAGE', // overridden by the real content type in finalize()
      source,
      sourceUrl: dto.url,
      folder: dto.folder ?? null,
      user,
    });
  }

  /**
   * GET with manual redirects: every hop (not only the first URL) must point to the public internet,
   * otherwise a public link could redirect the server to an internal address.
   */
  private async fetchPublic(rawUrl: string): Promise<Response> {
    let url = await assertPublicUrl(rawUrl);
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000), redirect: 'manual' }).catch((e) => {
        throw new BadRequestException(`Could not fetch the URL: ${(e as Error).message}`);
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel().catch(() => undefined);
        url = await assertPublicUrl(new URL(res.headers.get('location')!, url).toString());
        continue;
      }
      if (!res.ok || !res.body) throw new BadRequestException(`The URL returned HTTP ${res.status}`);
      return res;
    }
    throw new BadRequestException('Too many redirects');
  }

  /** Re-run inspection on an existing asset (e.g. after installing ffmpeg). */
  async reprocess(id: string, user: AuthUser) {
    const asset = await this.requireAsset(id);
    await this.prisma.asset.update({ where: { id }, data: { processingStatus: 'PROCESSING', processingError: null } });
    await this.scheduleProcessing(id);
    await this.audit.log(user.id, 'asset.reprocess', 'Asset', id);
    return this.withDisplayUrl(asset);
  }

  async remove(id: string, user: AuthUser) {
    const asset = await this.requireAsset(id);
    const inUse = await this.prisma.post.count({
      where: { assetId: id, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'PUBLISHING'] } },
    });
    const linked = await this.prisma.contentAsset.count({ where: { assetId: id } });
    if (inUse || linked) {
      throw new ConflictException('This media is used by content or scheduled posts — detach it first');
    }
    await this.prisma.asset.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log(user.id, 'asset.delete', 'Asset', id);
    return { ok: true };
  }

  private async requireAsset(id: string): Promise<Asset> {
    const asset = await this.prisma.asset.findUnique({ where: { id } });
    if (!asset || asset.deletedAt) throw new NotFoundException('Asset not found');
    return asset;
  }

  /** Enqueue inspection; fall back to inline processing if Redis is unavailable. */
  private async scheduleProcessing(assetId: string): Promise<void> {
    try {
      await this.queue.enqueue(assetId);
    } catch (e) {
      this.log.warn(`Media queue unavailable for ${assetId}, processing inline: ${(e as Error).message}`);
      await this.processor.process(assetId).catch((err) =>
        this.log.error(`Inline processing failed for ${assetId}: ${(err as Error).message}`),
      );
    }
  }
}

/** Streaming SHA-256 of a file, so large videos never load into memory. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}