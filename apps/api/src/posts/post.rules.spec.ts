import { fullCaption, supportsAutoPublish, validateForSubmit } from './post.rules';

const video: any = { id: 'a1', kind: 'VIDEO', url: 'https://x/v.mp4' };
const image: any = { id: 'a2', kind: 'IMAGE', url: 'https://x/i.jpg' };
const base = { platform: 'INSTAGRAM' as const, format: 'REEL' as const, caption: 'Demain au cinéma', hashtags: ['WhatElse'] };

describe('validateForSubmit', () => {
  it('accepts a complete reel', () => {
    expect(validateForSubmit(base, video)).toEqual([]);
  });

  it('blocks unfilled placeholders so they can never be published', () => {
    const problems = validateForSubmit({ ...base, caption: 'Avant-première à [LIEU] à [HEURE]' }, video);
    expect(problems.join(' ')).toMatch(/PLACEHOLDER/);
  });

  it('blocks placeholders hidden in hashtags too', () => {
    const problems = validateForSubmit({ ...base, hashtags: ['[LIEN BILLETS]'] }, video);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('requires matching media', () => {
    expect(validateForSubmit(base, null).join(' ')).toMatch(/asset/);
    expect(validateForSubmit(base, image).join(' ')).toMatch(/video/);
    expect(validateForSubmit({ ...base, format: 'IMAGE' }, video).join(' ')).toMatch(/image/);
  });

  it('rejects empty captions and over-long Instagram captions', () => {
    expect(validateForSubmit({ ...base, caption: '   ' }, video).join(' ')).toMatch(/empty/);
    expect(validateForSubmit({ ...base, caption: 'x'.repeat(2300) }, video).join(' ')).toMatch(/2200/);
  });

  it('allows text-only posts on Facebook only', () => {
    expect(validateForSubmit({ platform: 'FACEBOOK', format: 'TEXT', caption: 'Salut', hashtags: [] }, null)).toEqual([]);
    expect(validateForSubmit({ platform: 'INSTAGRAM', format: 'TEXT', caption: 'Salut', hashtags: [] }, null).length).toBeGreaterThan(0);
  });
});

describe('supportsAutoPublish', () => {
  it('never auto-publishes TikTok', () => {
    expect(supportsAutoPublish('TIKTOK', 'REEL')).toBe(false);
  });
  it('handles Instagram and Facebook formats', () => {
    expect(supportsAutoPublish('INSTAGRAM', 'REEL')).toBe(true);
    expect(supportsAutoPublish('INSTAGRAM', 'STORY')).toBe(true);
    expect(supportsAutoPublish('FACEBOOK', 'STORY')).toBe(false);
  });
});

describe('fullCaption', () => {
  it('appends normalised hashtags', () => {
    expect(fullCaption('Hello', ['WhatElse', '#Cinema'])).toBe('Hello\n\n#WhatElse #Cinema');
  });
});
