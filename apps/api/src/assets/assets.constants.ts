import { AssetKind } from '@prisma/client';
import { open } from 'fs/promises';

/** Canonical extension for each MIME type we accept. */
export const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};

export const ALLOWED_EXTENSIONS = Object.values(ALLOWED_MIME);

/** Single-request (multipart) upload ceiling; larger files use resumable uploads. */
export const MAX_DIRECT_BYTES = 200 * 1024 * 1024;

export function extensionFor(mime: string | undefined, filename: string): string | null {
  const fromMime = mime ? ALLOWED_MIME[mime.split(';')[0].trim().toLowerCase()] : undefined;
  if (fromMime) return fromMime;
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = filename.slice(dot).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext) ? ext : null;
}

export function kindForMime(mime: string | null | undefined, fallbackExt: string): AssetKind {
  if (mime?.startsWith('video/')) return 'VIDEO';
  return ['.mp4', '.mov', '.webm'].includes(fallbackExt) ? 'VIDEO' : 'IMAGE';
}

/** MIME guess from an extension, used when a remote URL sends none. */
export function mimeForExtension(ext: string): string | null {
  const entry = Object.entries(ALLOWED_MIME).find(([, e]) => e === ext);
  return entry ? entry[0] : null;
}

export interface SniffedMedia {
  mime: string;
  ext: string;
  kind: AssetKind;
}

/** ISO-BMFF "brands" used by images/audio, which must NOT be accepted as video. */
const NON_VIDEO_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif', 'avis', 'M4A ', 'M4B ', 'M4P ']);

/**
 * Detects the REAL media type from the first bytes of a file. The browser's MIME type and the
 * file extension are only claims; this is what the file actually is. Null = not an accepted type.
 */
export function sniffMedia(head: Buffer): SniffedMedia | null {
  const ascii = (off: number, text: string) =>
    head.length >= off + text.length && head.toString('latin1', off, off + text.length) === text;

  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg', kind: 'IMAGE' };
  }
  if (head.length >= 8 && head[0] === 0x89 && ascii(1, 'PNG\r\n\x1a\n')) {
    return { mime: 'image/png', ext: '.png', kind: 'IMAGE' };
  }
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { mime: 'image/gif', ext: '.gif', kind: 'IMAGE' };
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { mime: 'image/webp', ext: '.webp', kind: 'IMAGE' };
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return { mime: 'video/webm', ext: '.webm', kind: 'VIDEO' };
  }
  if (ascii(4, 'ftyp') && head.length >= 12) {
    const brand = head.toString('latin1', 8, 12);
    if (NON_VIDEO_BRANDS.has(brand)) return null;
    return brand === 'qt  '
      ? { mime: 'video/quicktime', ext: '.mov', kind: 'VIDEO' }
      : { mime: 'video/mp4', ext: '.mp4', kind: 'VIDEO' };
  }
  return null;
}

/** Reads the first bytes of a file on disk and detects its real type. */
export async function sniffFile(path: string): Promise<SniffedMedia | null> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    return sniffMedia(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}