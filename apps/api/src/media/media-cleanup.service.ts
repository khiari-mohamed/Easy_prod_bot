import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { rm, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { getEnv } from '../env';
import { StorageService } from './storage.service';

const SOFT_DELETE_GRACE_MS = 7 * 24 * 3600_000;
const TEMP_MAX_AGE_MS = 6 * 3600_000;

/** Removes expired upload sessions, stale temp files and unreferenced soft-deleted media. */
@Injectable()
export class MediaCleanupService {
  private readonly log = new Logger(MediaCleanupService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    if (this.running) return;
    this.running = true;
    try {
      await this.run();
    } catch (e) {
      this.log.error(`Media cleanup failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async run() {
    const expired = await this.expireUploads();
    const tempFiles = await this.cleanTempDirs();
    const purged = await this.purgeDeletedAssets();
    if (expired || tempFiles || purged) {
      this.log.log(`Cleanup: ${expired} upload session(s), ${tempFiles} temp item(s), ${purged} asset(s) purged`);
    }
    return { expired, tempFiles, purged };
  }

  private tmpRoot(): string {
    return getEnv().UPLOAD_TMP_DIR;
  }

  private async expireUploads(): Promise<number> {
    const stale = await this.prisma.mediaUpload.findMany({
      where: { status: 'OPEN', expiresAt: { lt: new Date() } },
      take: 200,
    });
    for (const session of stale) {
      await rm(join(this.tmpRoot(), session.tempKey), { recursive: true, force: true }).catch(() => undefined);
      await this.prisma.mediaUpload
        .update({ where: { id: session.id }, data: { status: 'EXPIRED' } })
        .catch(() => undefined);
    }
    return stale.length;
  }

  /** Removes files in the upload temp root that are older than the grace period. */
  private async cleanTempDirs(): Promise<number> {
    const root = this.tmpRoot();
    let removed = 0;
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - TEMP_MAX_AGE_MS;
    // A paused (still valid) resumable upload must keep its parts: only expired sessions are removed.
    const open = await this.prisma.mediaUpload.findMany({
      where: { status: 'OPEN', expiresAt: { gt: new Date() } },
      select: { tempKey: true },
    });
    const keep = new Set(open.flatMap((u) => [u.tempKey, `${u.tempKey}-assembled`]));
    for (const name of entries) {
      if (name === 'probe' || keep.has(name)) continue;
      const full = join(root, name);
      try {
        const s = await stat(full);
        if (s.mtimeMs < cutoff) {
          await rm(full, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* ignore */
      }
    }
    // Probe scratch files can be reclaimed sooner than whole sessions.
    const probe = join(root, 'probe');
    try {
      const files = await readdir(probe);
      for (const f of files) {
        const full = join(probe, f);
        const s = await stat(full).catch(() => null);
        if (s && s.mtimeMs < Date.now() - TEMP_MAX_AGE_MS) {
          await rm(full, { force: true });
          removed++;
        }
      }
    } catch {
      /* no probe dir */
    }
    return removed;
  }

  /**
   * Physically removes media that was soft-deleted more than a week ago and is
   * no longer referenced by any post or content item.
   */
  private async purgeDeletedAssets(): Promise<number> {
    const cutoff = new Date(Date.now() - SOFT_DELETE_GRACE_MS);
    const candidates = await this.prisma.asset.findMany({
      where: { deletedAt: { lt: cutoff } },
      include: {
        contentLinks: { select: { id: true } },
        posts: { select: { id: true } },
      },
      take: 200,
    });

    let purged = 0;
    for (const asset of candidates) {
      if (asset.contentLinks.length > 0 || asset.posts.length > 0) continue;
      const key = asset.storageKey ?? asset.storedAs;
      if (key) await this.storage.remove(key).catch(() => undefined);
      await this.prisma.asset.delete({ where: { id: asset.id } }).catch(() => undefined);
      purged++;
    }
    return purged;
  }
}
