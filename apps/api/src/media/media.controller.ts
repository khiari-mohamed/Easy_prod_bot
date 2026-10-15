import { pipeline } from 'stream';
import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { verifyMediaToken } from './media-token';
import { MediaService } from './media.service';
import { ByteRange } from './storage.service';

/** Parses a single-range "bytes=start-end" header, clamped to the object size. */
export function parseRange(header: string | undefined, size: number): ByteRange | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, startRaw, endRaw] = m;
  let start = startRaw ? Number(startRaw) : 0;
  let end = endRaw ? Number(endRaw) : size - 1;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (startRaw === '' && endRaw) {
    // suffix range: last N bytes
    start = Math.max(0, size - end);
    end = size - 1;
  }
  start = Math.max(0, Math.min(start, size - 1));
  end = Math.max(start, Math.min(end, size - 1));
  return { start, end };
}

/**
 * Signed, expiring media endpoint. Platforms (Meta) and browsers fetch media
 * from here without a session cookie: the HMAC signature in the query string is
 * the credential and it expires.
 */
@Controller('media')
export class MediaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  @Public()
  @Get('access')
  async access(
    @Query('assetId') assetId: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const verified = verifyMediaToken(assetId, exp, sig);
    if (!verified) throw new ForbiddenException('This media link is invalid or has expired');

    const asset = await this.prisma.asset.findUnique({ where: { id: verified } });
    if (!asset || asset.deletedAt) throw new NotFoundException('Media not found');
    const key = asset.storageKey ?? asset.storedAs;
    if (!key) throw new NotFoundException('Media not found');

    const info = await this.media.head(key);
    if (!info) throw new NotFoundException('Media not found');

    res.setHeader('Content-Type', asset.mime ?? 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(asset.name)}"`);

    const range = parseRange(req.headers.range, info.size);
    if (range) {
      const length = range.end - range.start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
      res.setHeader('Content-Length', String(length));
      pipeline(await this.media.stream(key, range), res, () => undefined);
      return;
    }

    res.status(200);
    res.setHeader('Content-Length', String(info.size));
    pipeline(await this.media.stream(key), res, () => undefined);
  }
}
