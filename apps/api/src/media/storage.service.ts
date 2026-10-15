import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'stream';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'fs';
import { stat, unlink, writeFile } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import { pipeline } from 'stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getEnv } from '../env';

export type Provider = 'LOCAL' | 'S3';

export interface PutOptions {
  contentType?: string;
  /** Required for streaming bodies on S3 (Content-Length must be known). */
  size?: number;
}

export interface ObjectInfo {
  size: number;
  contentType?: string;
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Storage contract shared by the local-disk and S3 drivers.
 *
 * Keys are opaque, forward-slash separated and never absolute. `localPath`
 * returns a real filesystem path only when the bytes live on this machine, so
 * ffprobe-style tools can run without a download; remote drivers return null
 * and callers fall back to streaming the object into a temporary file.
 */
export interface StorageDriver {
  readonly provider: Provider;
  put(key: string, body: Buffer | Readable, opts?: PutOptions): Promise<void>;
  getStream(key: string, range?: ByteRange): Promise<Readable>;
  head(key: string): Promise<ObjectInfo | null>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** World-readable URL, or null when the object is not public. */
  publicUrl(key: string): string | null;
  /** Time-limited URL the platform can fetch, or null when the API must proxy. */
  signedUrl(key: string, ttlSeconds: number): Promise<string | null>;
  /** Absolute path when the bytes are local, else null. */
  localPath(key: string): string | null;
}

/** Rejects keys that could escape the storage root or address the filesystem directly. */
function assertSafeKey(key: string): void {
  if (!key || key.startsWith('/') || key.includes('..') || key.includes('\0') || /^[a-zA-Z]:/.test(key)) {
    throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`);
  }
}

// ─── Local disk ───────────────────────────────────────────────────────────────

class LocalDriver implements StorageDriver {
  readonly provider: Provider = 'LOCAL';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`Storage key escapes the root: ${key}`);
    }
    return full;
  }

  localPath(key: string): string {
    return this.pathFor(key);
  }

  async put(key: string, body: Buffer | Readable): Promise<void> {
    const full = this.pathFor(key);
    mkdirSync(dirname(full), { recursive: true });
    if (Buffer.isBuffer(body)) await writeFile(full, body);
    else await pipeline(body, createWriteStream(full));
  }

  async getStream(key: string, range?: ByteRange): Promise<Readable> {
    const full = this.pathFor(key);
    if (!existsSync(full)) throw new Error('Object not found');
    return range ? createReadStream(full, { start: range.start, end: range.end }) : createReadStream(full);
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const s = await stat(this.pathFor(key));
      return { size: s.size };
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.pathFor(key));
  }

  async remove(key: string): Promise<void> {
    await unlink(this.pathFor(key)).catch(() => undefined);
  }

  publicUrl(key: string): string {
    return `${getEnv().PUBLIC_BASE_URL}/media/${key}`;
  }

  /** Local objects are served through the signed API endpoint, not presigned URLs. */
  async signedUrl(): Promise<string | null> {
    return null;
  }
}

// ─── S3-compatible object storage ─────────────────────────────────────────────

class S3Driver implements StorageDriver {
  readonly provider: Provider = 'S3';
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBase: string;

  constructor() {
    const env = getEnv();
    this.bucket = env.S3_BUCKET;
    this.publicBase = env.S3_PUBLIC_BASE_URL;
    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials:
        env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }

  async put(key: string, body: Buffer | Readable, opts: PutOptions = {}): Promise<void> {
    assertSafeKey(key);
    if (!Buffer.isBuffer(body) && opts.size === undefined) {
      throw new Error('Streaming uploads to S3 require a known size');
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        ContentLength: opts.size,
      }),
    );
  }

  async getStream(key: string, range?: ByteRange): Promise<Readable> {
    assertSafeKey(key);
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }),
    );
    return res.Body as Readable;
  }

  async head(key: string): Promise<ObjectInfo | null> {
    assertSafeKey(key);
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType };
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async remove(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
      .catch(() => undefined);
  }

  publicUrl(key: string): string | null {
    return this.publicBase ? `${this.publicBase}/${key}` : null;
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    assertSafeKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: Math.max(60, Math.floor(ttlSeconds)),
    });
  }

  localPath(): string | null {
    return null;
  }
}

// ─── Facade ───────────────────────────────────────────────────────────────────

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly log = new Logger(StorageService.name);
  private driver!: StorageDriver;

  onModuleInit(): void {
    const env = getEnv();
    if (env.STORAGE_PROVIDER === 's3') {
      if (!env.S3_BUCKET) {
        throw new ServiceUnavailableException('STORAGE_PROVIDER=s3 requires S3_BUCKET');
      }
      this.driver = new S3Driver();
      this.log.log(`Media storage: S3 (bucket ${env.S3_BUCKET})`);
    } else {
      this.driver = new LocalDriver(env.UPLOAD_DIR);
      this.log.log(`Media storage: local disk (${resolve(env.UPLOAD_DIR)})`);
    }
  }

  get active(): StorageDriver {
    return this.driver;
  }

  get provider(): Provider {
    return this.driver.provider;
  }

  put(key: string, body: Buffer | Readable, opts?: PutOptions) {
    return this.driver.put(key, body, opts);
  }
  getStream(key: string, range?: ByteRange) {
    return this.driver.getStream(key, range);
  }
  head(key: string) {
    return this.driver.head(key);
  }
  exists(key: string) {
    return this.driver.exists(key);
  }
  remove(key: string) {
    return this.driver.remove(key);
  }
  publicUrl(key: string) {
    return this.driver.publicUrl(key);
  }
  signedUrl(key: string, ttlSeconds: number) {
    return this.driver.signedUrl(key, ttlSeconds);
  }
  localPath(key: string) {
    return this.driver.localPath(key);
  }

  /**
   * A real local path to the object, downloading it to `tmpDir` first when the
   * bytes are remote. Used by tools (ffprobe) that need a filesystem file.
   * The caller owns the returned file.
   */
  async materialize(key: string, tmpDir: string): Promise<string> {
    const local = this.driver.localPath(key);
    if (local) return local;
    mkdirSync(tmpDir, { recursive: true });
    const target = join(tmpDir, `probe-${Date.now()}-${key.replace(/[^\w.-]/g, '_')}`);
    await pipeline(await this.driver.getStream(key), createWriteStream(target));
    return target;
  }
}
