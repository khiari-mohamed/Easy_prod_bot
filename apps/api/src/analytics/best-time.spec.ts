import { computeBestTime, MIN_SAMPLE } from './best-time';

// Africa/Tunis is UTC+1 all year (no DST).
const at = (iso: string) => new Date(iso);

describe('computeBestTime', () => {
  it('stays provisional when there is too little data', () => {
    const r = computeBestTime('INSTAGRAM', [{ publishedAt: at('2026-10-05T18:00:00Z'), rate: 0.1 }], 'Africa/Tunis');
    expect(r.provisional).toBe(true);
    expect(r.hourBlocks).toHaveLength(0);
    expect(r.suggestion).toContain('Provisional');
  });

  it('ranks the better hour block first using local time', () => {
    const points = [];
    // 19:30 local (18:30Z) posts perform well, 11:00 local (10:00Z) posts perform poorly.
    for (let i = 0; i < MIN_SAMPLE; i++) points.push({ publishedAt: at(`2026-10-0${(i % 7) + 1}T18:30:00Z`), rate: 0.2 });
    for (let i = 0; i < MIN_SAMPLE; i++) points.push({ publishedAt: at(`2026-10-0${(i % 7) + 1}T10:00:00Z`), rate: 0.02 });
    const r = computeBestTime('INSTAGRAM', points, 'Africa/Tunis');
    expect(r.provisional).toBe(false);
    expect(r.hourBlocks[0].label).toBe('18h-21h');
  });

  it('does not let a single outlier win', () => {
    const points = [];
    for (let i = 0; i < 10; i++) points.push({ publishedAt: at('2026-10-05T18:30:00Z'), rate: 0.1 });
    points.push({ publishedAt: at('2026-10-05T02:00:00Z'), rate: 0.5 }); // one lucky 03h post
    const r = computeBestTime('TIKTOK', points, 'Africa/Tunis');
    expect(r.hourBlocks[0].label).toBe('18h-21h');
  });
});
