import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MediaUpload } from '@prisma/client';
import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { getEnv } from '../env';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { CompleteUploadDto, InitUploadDto } from './assets.dto';
import { AssetsService, FinalizeInput } from './assets.service';

/** 8 MiB parts: small enough to retry cheaply, large enough to stay fast. */
export const PART_SIZE_BYTES = 8 * 1024 * 1024;
const SESSION_TTL_MS = 24 * 3600_000;
const PART_FILE = /^part-(\d{6})$/;

const partName = (index: number) => `part-${String(index).padStart(6, '0')}`;

/**
 * Resumable, chunked uploads for large posters and videos. The browser sends
 * numbered parts (all exactly PART_SIZE_BYTES except the last); we persist each one
 * and assemble the file only on completion, so a dropped connection costs one part
 * instead of the whole upload.
 */
@Injectable()
export class UploadSessionService {
  private readonly log = new Logger(UploadSessionService.name);
  /** Sessions being assembled right now (one API process): a double "complete" must not create two assets. */
  private readonly completing = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: AssetsService,
  ) {}

  private tmpRoot(): string {
    const dir = getEnv().UPLOAD_TMP_DIR;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  private sessionDir(tempKey: string): string {
    return join(this.tmpRoot(), tempKey);
  }

  private maxBytes(): number {
    return getEnv().MEDIA_MAX_UPLOAD_BYTES;
  }

  async init(dto: InitUploadDto, user: AuthUser) {
    const max = this.maxBytes();
    if (dto.totalBytes && dto.totalBytes > max) {
      throw new BadRequestException(`File exceeds the ${Math.round(max / 1024 / 1024)} MB upload limit`);
    }
    const tempKey = `up-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    mkdirSync(this.sessionDir(tempKey), { recursive: true });

    const session = await this.prisma.mediaUpload.create({
      data: {
        name: dto.name,
        mime: dto.mime ?? null,
        kind: dto.kind,
        totalBytes: dto.totalBytes ? BigInt(dto.totalBytes) : null,
        tempKey,
        createdById: user.id,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    return { id: session.id, partSize: PART_SIZE_BYTES, expiresAt: session.expiresAt };
  }

  /**
   * Stores one part. Safe to retry: re-sending the same index REPLACES the part and only the size
   * difference is counted. The total is capped at the declared size (or the global maximum).
   */
  async putPart(id: string, index: number, data: Buffer, user: AuthUser) {
    const session = await this.requireOpen(id, user);
    const maxParts = Math.ceil(this.maxBytes() / PART_SIZE_BYTES);
    if (!Number.isInteger(index) || index < 0 || index >= maxParts) throw new BadRequestException('Invalid part index');
    if (data.length === 0) throw new BadRequestException('Empty part');
    if (data.length > PART_SIZE_BYTES) throw new BadRequestException('Part exceeds the maximum part size');

    const dir = this.sessionDir(session.tempKey);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, partName(index));
    const previous = await stat(file).then((s) => s.size).catch(() => null);
    const delta = data.length - (previous ?? 0);

    // Reserve the bytes atomically first (parallel part uploads cannot overshoot the limit).
    const limit = session.totalBytes !== null && session.totalBytes < BigInt(this.maxBytes())
      ? session.totalBytes
      : BigInt(this.maxBytes());
    const updated = await this.prisma.mediaUpload.update({
      where: { id },
      data: {
        receivedBytes: { increment: BigInt(delta) },
        ...(previous === null ? { partCount: { increment: 1 } } : {}),
      },
    });
    const rollback = () =>
      this.prisma.mediaUpload
        .update({
          where: { id },
          data: {
            receivedBytes: { decrement: BigInt(delta) },
            ...(previous === null ? { partCount: { decrement: 1 } } : {}),
          },
        })
        .catch(() => undefined);

    if (updated.receivedBytes > limit) {
      await rollback();
      throw new BadRequestException(
        session.totalBytes !== null && limit === session.totalBytes
          ? 'Received more data than the declared total size'
          : `The upload exceeds the ${Math.round(this.maxBytes() / 1024 / 1024)} MB limit`,
      );
    }

    // Write to a temp name, then rename: an interrupted write can never leave a half part behind.
    try {
      await writeFile(`${file}.tmp`, data);
      await rename(`${file}.tmp`, file);
    } catch (e) {
      await rm(`${file}.tmp`, { force: true }).catch(() => undefined);
      await rollback();
      throw e;
    }
    return { receivedBytes: Number(updated.receivedBytes), partCount: updated.partCount };
  }

  async complete(id: string, dto: CompleteUploadDto, user: AuthUser) {
    const session = await this.requireOpen(id, user);
    if (this.completing.has(id)) throw new ConflictException('This upload is already being completed');
    this.completing.add(id);
    const dir = this.sessionDir(session.tempKey);
    const assembled = join(this.tmpRoot(), `${session.tempKey}-assembled`);
    try {
      const { size, sha256 } = await this.assemble(dir, assembled);

      if (size > this.maxBytes()) {
        throw new BadRequestException(`File exceeds the ${Math.round(this.maxBytes() / 1024 / 1024)} MB limit`);
      }
      if (session.totalBytes !== null && BigInt(size) !== session.totalBytes) {
        throw new BadRequestException(
          `Uploaded ${size} bytes but ${session.totalBytes} were declared. Retry the missing parts.`,
        );
      }
      if (dto.checksumSha256 && dto.checksumSha256.toLowerCase() !== sha256) {
        throw new BadRequestException('Checksum mismatch: the assembled file is corrupt');
      }

      const input: FinalizeInput = {
        tempPath: assembled,
        name: session.name,
        mime: session.mime,
        kind: session.kind,
        source: 'UPLOAD',
        folder: null,
        size,
        checksumSha256: sha256,
        user,
      };
      const asset = await this.assets.finalize(input);

      await this.prisma.mediaUpload.update({
        where: { id },
        data: { status: 'COMPLETED', assetId: asset.id, receivedBytes: BigInt(size) },
      });
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      return asset;
    } finally {
      // The assembled copy is never left behind, whatever happened (parts stay so the client can retry).
      await rm(assembled, { force: true }).catch(() => undefined);
      this.completing.delete(id);
    }
  }

  async cancel(id: string, user: AuthUser) {
    const session = await this.requireOpen(id, user);
    await rm(this.sessionDir(session.tempKey), { recursive: true, force: true }).catch(() => undefined);
    await this.prisma.mediaUpload.update({ where: { id }, data: { status: 'CANCELLED' } });
    return { ok: true };
  }

  /**
   * Concatenates the numbered parts, computing the SHA-256 as it goes.
   * Refuses gaps (a missing part) and parts of the wrong size: a silently truncated video is worse than an error.
   */
  private async assemble(dir: string, target: string): Promise<{ size: number; sha256: string }> {
    if (!existsSync(dir)) throw new BadRequestException('Upload session has no parts');
    const parts = (await readdir(dir))
      .map((n) => ({ n, m: PART_FILE.exec(n) }))
      .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
      .map((x) => ({ name: x.n, index: Number(x.m[1]) }))
      .sort((a, b) => a.index - b.index);
    if (!parts.length) throw new BadRequestException('No parts were uploaded');

    const missing: number[] = [];
    for (let i = 0; i < parts.length; i++) if (parts[i].index !== i) { missing.push(i); break; }
    if (missing.length) {
      throw new BadRequestException(`Part ${missing[0]} is missing: resend it, then complete the upload again`);
    }
    for (let i = 0; i < parts.length - 1; i++) {
      const s = await stat(join(dir, parts[i].name));
      if (s.size !== PART_SIZE_BYTES) {
        throw new BadRequestException(`Part ${i} has the wrong size: resend it, then complete the upload again`);
      }
    }

    const out = createWriteStream(target);
    const hash = createHash('sha256');
    try {
      for (const part of parts) {
        const buf = await readFile(join(dir, part.name));
        hash.update(buf);
        if (!out.write(buf)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        out.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    }
    const confirmed = await stat(target);
    return { size: confirmed.size, sha256: hash.digest('hex') };
  }

  /** Loads an OPEN, unexpired session that belongs to the caller (approvers/admins may manage any). */
  private async requireOpen(id: string, user: AuthUser): Promise<MediaUpload> {
    const session = await this.prisma.mediaUpload.findUnique({ where: { id } });
    if (!session) throw new NotFoundException('Upload session not found');
    const privileged = user.role === 'ADMIN' || user.role === 'APPROVER';
    if (session.createdById !== user.id && !privileged) {
      throw new ForbiddenException('This upload session belongs to another user');
    }
    if (session.status !== 'OPEN') throw new ConflictException(`Upload session is ${session.status}`);
    if (session.expiresAt.getTime() < Date.now()) throw new ConflictException('Upload session has expired');
    return session;
  }
}