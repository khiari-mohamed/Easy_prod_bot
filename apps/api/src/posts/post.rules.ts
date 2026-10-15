import { Asset, CaptionLanguage, Platform, PostFormat } from '@prisma/client';

export const PLACEHOLDER_RE = /\[[A-ZÀ-Ý][A-ZÀ-Ý0-9 _''-]{2,}\]/;

export function supportsAutoPublish(platform: Platform, format: PostFormat): boolean {
  switch (platform) {
    case 'FACEBOOK':
      return format === 'IMAGE' || format === 'VIDEO' || format === 'REEL' || format === 'TEXT';
    case 'INSTAGRAM':
      return format === 'IMAGE' || format === 'REEL' || format === 'VIDEO' || format === 'STORY';
    case 'TIKTOK':
      return false;
    default:
      return false;
  }
}

export function fullCaption(caption: string, hashtags: string[]): string {
  const tags = hashtags.map((h) => (h.startsWith('#') ? h : `#${h.replace(/\s+/g, '')}`)).join(' ');
  return tags ? `${caption.trim()}\n\n${tags}` : caption.trim();
}

export function validateForSubmit(
  post: {
    platform: Platform;
    format: PostFormat;
    caption: string;
    hashtags: string[];
    captionLanguage?: CaptionLanguage | null;
  },
  asset: Asset | null,
): string[] {
  const problems: string[] = [];
  const text = fullCaption(post.caption, post.hashtags);

  if (!post.caption.trim()) problems.push('Caption is empty');
  if (PLACEHOLDER_RE.test(text))
    problems.push('Caption still contains a [PLACEHOLDER] to fill in (venue, time, link...)');

  if (
    post.captionLanguage &&
    !(['DARIJA', 'FRENCH', 'DARIJA_FRENCH'] as CaptionLanguage[]).includes(post.captionLanguage)
  ) {
    problems.push('Caption language must be Darija, French, or Darija+French');
  }

  if (post.platform === 'INSTAGRAM') {
    if (text.length > 2200) problems.push('Instagram captions are limited to 2200 characters');
    if (post.hashtags.length > 30) problems.push('Instagram allows at most 30 hashtags');
  }

  if (post.format !== 'TEXT') {
    if (!asset) problems.push('This format needs an image or video asset');
    else {
      if (asset.processingStatus === 'PENDING' || (asset.processingStatus as string) === 'PROCESSING')
        problems.push('Media is still being processed — wait for it to become Ready before submitting');
      if (asset.processingStatus === 'INVALID')
        problems.push('Media was rejected during processing — upload a replacement');
      const needsVideo = post.format === 'VIDEO' || post.format === 'REEL';
      if (needsVideo && asset.kind !== 'VIDEO') problems.push('This format needs a video asset');
      if (post.format === 'IMAGE' && asset.kind !== 'IMAGE') problems.push('This format needs an image asset');
    }
  }
  if (post.format === 'TEXT' && post.platform !== 'FACEBOOK')
    problems.push('Text-only posts are only possible on Facebook');
  return problems;
}
