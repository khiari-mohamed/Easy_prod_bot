import { Injectable, Logger } from '@nestjs/common';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { AssetKind } from '@prisma/client';
import { imageSize } from 'image-size';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage.service';
import { platformReadyFor, PlatformReadyMap } from './platform-rules';
import { getEnv } from '../env';

export interface ProbeResult {
  widthPx: number | null;
  heightPx: number | null;
  durationSecs: number | null;
  /** null when the file was fine but no probe tool could read it. */
  unreadable: boolean;
  note: string | null;
}

const FFMPEG_MISSING = 'ffprobe is not installed: install ffmpeg to validate video metadata automatically';

/** Reads dimensions/duration for a media file. Never throws for a missing tool. */
@Injectable()
export class MediaProcessorService {
  private readonly log = new Logger(MediaProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async probe(kind: AssetKind, filePath: string): Promise<ProbeResult> {
    if (kind === 'IMAGE') {
      try {
        const dims = imageSize(await readFile(filePath));
        return {
          widthPx: dims.width ?? null,
          heightPx: dims.height ?? null,
          durationSecs: null,
          unreadable: false,
          note: null,
        };
      } catch (e) {
        return { widthPx: null, heightPx: null, durationSecs: null, unreadable: true, note: `Unreadable image: ${(e as Error).message}` };
      }
    }
    return this.probeVideo(filePath);
  }

  private async probeVideo(filePath: string): Promise<ProbeResult> {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);
    try {
      const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
      const { stdout } = await exec(ffprobe, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        filePath,
      ], { timeout: 30_000 });
      const data = JSON.parse(stdout);
      const video = (data.streams ?? []).find((s: { codec_type?: string }) => s.codec_type === 'video');
      if (!video) {
        return { widthPx: null, heightPx: null, durationSecs: null, unreadable: true, note: 'No video stream found' };
      }
      return {
        widthPx: video.width ? parseInt(String(video.width), 10) : null,
        heightPx: video.height ? parseInt(String(video.height), 10) : null,
        durationSecs: parseFloat(video.duration ?? data.format?.duration ?? '0') || null,
        unreadable: false,
        note: null,
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        // Tool missing is not the file's fault: keep the asset usable and explain.
        return { widthPx: null, heightPx: null, durationSecs: null, unreadable: false, note: FFMPEG_MISSING };
      }
      return { widthPx: null, heightPx: null, durationSecs: null, unreadable: true, note: `Could not read the video: ${err.message}` };
    }
  }

  /**
   * Probe an asset from storage, compute per-platform compatibility and persist
   * the result. Sets READY when the media is usable, INVALID when it cannot be
   * read or its format is rejected outright.
   */
  async process(assetId: string): Promise<void> {
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset || asset.deletedAt) return;
    const key = asset.storageKey ?? asset.storedAs;
    if (!key) {
      await this.fail(assetId, 'The asset has no stored file');
      return;
    }

    let filePath: string;
    let isTemp = false;
    try {
      const local = this.storage.localPath(key);
      if (local) {
        filePath = local;
      } else {
        filePath = await this.storage.materialize(key, join(getEnv().UPLOAD_TMP_DIR, 'probe'));
        isTemp = true;
      }
    } catch (e) {
      await this.fail(assetId, `Could not open the stored file: ${(e as Error).message}`);
      return;
    }

    try {
      const probe = await this.probe(asset.kind, filePath);

      if (probe.unreadable) {
        await this.prisma.asset.update({
          where: { id: assetId },
          data: {
            processingStatus: 'INVALID',
            processingError: probe.note ?? 'Unreadable media',
            platformReady: undefined,
          },
        });
        return;
      }

      const platformReady: PlatformReadyMap = platformReadyFor(
        asset.kind,
        probe.widthPx,
        probe.heightPx,
        probe.durationSecs,
        asset.mime,
      );

      await this.prisma.asset.update({
        where: { id: assetId },
        data: {
          processingStatus: 'READY',
          processingError: null,
          processingNote: probe.note,
          widthPx: probe.widthPx ?? asset.widthPx,
          heightPx: probe.heightPx ?? asset.heightPx,
          durationSecs: probe.durationSecs ?? asset.durationSecs,
          platformReady: platformReady as unknown as object,
        },
      });
    } catch (e) {
      this.log.error(`Processing asset ${assetId} failed: ${(e as Error).message}`);
      await this.fail(assetId, (e as Error).message);
    } finally {
      if (isTemp) await unlink(filePath).catch(() => undefined);
    }
  }

  private async fail(assetId: string, message: string): Promise<void> {
    await this.prisma.asset
      .update({ where: { id: assetId }, data: { processingStatus: 'INVALID', processingError: message } })
      .catch(() => undefined);
  }

  /** Recompute readiness for an existing asset without touching its status. */
  readiness(kind: AssetKind, width: number | null, height: number | null, duration: number | null, mime?: string | null): PlatformReadyMap {
    return platformReadyFor(kind, width, height, duration, mime);
  }
}
