import { AssetKind } from '@prisma/client';

/**
 * Per-platform media compatibility. Keys are `${PLATFORM}_${FORMAT}` so the post
 * validator can look up exactly the target of a post and refuse an incompatible
 * asset before it is ever submitted.
 */
export interface PlatformReadiness {
  ok: boolean;
  reason?: string;
}

export type PlatformReadyMap = Record<string, PlatformReadiness>;

export const PLATFORM_LIMITS = {
  IG_REEL_MAX_SECONDS: 90,
  IG_REEL_MIN_WIDTH: 500,
  IG_STORY_MAX_SECONDS: 60,
  IG_IMAGE_MIN_WIDTH: 320,
  IG_IMAGE_MAX_WIDTH: 1440,
  IG_ASPECT_MIN: 0.8,
  IG_ASPECT_MAX: 1.91,
  FB_VIDEO_MAX_SECONDS: 240 * 60,
  FB_VIDEO_MIN_WIDTH: 120,
  FB_REEL_MAX_SECONDS: 90,
  FB_IMAGE_MIN_WIDTH: 200,
} as const;

function aspect(width: number | null, height: number | null): number | null {
  if (!width || !height || height <= 0) return null;
  return width / height;
}

/** Compatibility of a media asset with each platform/format we can publish to. */
export function platformReadyFor(
  kind: AssetKind,
  width: number | null,
  height: number | null,
  durationSecs: number | null,
  mime?: string | null,
): PlatformReadyMap {
  const result: PlatformReadyMap = {};
  const w = width ?? 0;
  const dur = durationSecs ?? 0;
  const ratio = aspect(width, height);

  if (kind === 'VIDEO') {
    const reelOk = dur <= PLATFORM_LIMITS.IG_REEL_MAX_SECONDS && w >= PLATFORM_LIMITS.IG_REEL_MIN_WIDTH;
    result.INSTAGRAM_REEL = reelOk
      ? { ok: true }
      : {
          ok: false,
          reason:
            dur > PLATFORM_LIMITS.IG_REEL_MAX_SECONDS
              ? `Video longer than ${PLATFORM_LIMITS.IG_REEL_MAX_SECONDS}s`
              : 'Video narrower than 500px',
        };
    result.INSTAGRAM_VIDEO = result.INSTAGRAM_REEL;

    result.INSTAGRAM_STORY =
      dur <= PLATFORM_LIMITS.IG_STORY_MAX_SECONDS
        ? { ok: true }
        : { ok: false, reason: `Story video longer than ${PLATFORM_LIMITS.IG_STORY_MAX_SECONDS}s` };

    const fbVideoOk = dur <= PLATFORM_LIMITS.FB_VIDEO_MAX_SECONDS && w >= PLATFORM_LIMITS.FB_VIDEO_MIN_WIDTH;
    result.FACEBOOK_VIDEO = fbVideoOk
      ? { ok: true }
      : {
          ok: false,
          reason:
            dur > PLATFORM_LIMITS.FB_VIDEO_MAX_SECONDS ? 'Video longer than 4h' : 'Video narrower than 120px',
        };

    result.FACEBOOK_REEL =
      dur <= PLATFORM_LIMITS.FB_REEL_MAX_SECONDS
        ? { ok: true }
        : { ok: false, reason: `Reel longer than ${PLATFORM_LIMITS.FB_REEL_MAX_SECONDS}s` };
    return result;
  }

  const isJpeg = !mime || /^image\/jpe?g$/i.test(mime);
  let igImage: PlatformReadiness = { ok: true };
  if (!isJpeg) {
    igImage = { ok: false, reason: 'Instagram feed photos must be JPEG: export the image as JPEG' };
  } else if (ratio === null || ratio < PLATFORM_LIMITS.IG_ASPECT_MIN || ratio > PLATFORM_LIMITS.IG_ASPECT_MAX) {
    igImage = { ok: false, reason: 'Aspect ratio outside Instagram limits (4:5 to 1.91:1): crop the image' };
  } else if (w < PLATFORM_LIMITS.IG_IMAGE_MIN_WIDTH) {
    igImage = { ok: false, reason: `Image narrower than ${PLATFORM_LIMITS.IG_IMAGE_MIN_WIDTH}px` };
  } else if (w > PLATFORM_LIMITS.IG_IMAGE_MAX_WIDTH) {
    // Not blocking: Instagram is expected to downscale. If the test post is refused, resize to this width.
    igImage = { ok: true, reason: `Wider than ${PLATFORM_LIMITS.IG_IMAGE_MAX_WIDTH}px: Instagram may downscale it` };
  }
  result.INSTAGRAM_IMAGE = igImage;
  result.INSTAGRAM_STORY = { ok: true };

  result.FACEBOOK_IMAGE =
    w >= PLATFORM_LIMITS.FB_IMAGE_MIN_WIDTH
      ? { ok: true }
      : { ok: false, reason: 'Image narrower than 200px' };

  return result;
}
