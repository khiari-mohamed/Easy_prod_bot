import { audience, engagementRate, interactions, mergeSnapshots } from './engagement';
import type { SnapshotLike } from './engagement';

const snap = (o: Partial<SnapshotLike> = {}): SnapshotLike => ({
  views: 0, reach: 0, likes: 0, comments: 0, shares: 0, saves: 0, clicks: 0, unavailable: [], ...o,
});

describe('metrics: unavailable is never 0', () => {
  it('returns null for a metric that was never available', () => {
    const m = mergeSnapshots([snap({ views: 500, unavailable: ['reach', 'saves', 'clicks'] })]);
    expect(m.views).toBe(500);
    expect(m.reach).toBeNull();
    expect(m.saves).toBeNull();
  });

  it('a later snapshot lacking a metric cannot hide an earlier real value', () => {
    const newest = snap({ likes: 10, unavailable: ['views'] });
    const older = snap({ views: 900, likes: 5 });
    const m = mergeSnapshots([newest, older]);
    expect(m.views).toBe(900);
    expect(m.likes).toBe(10);
  });

  it('a real 0 stays 0', () => {
    expect(mergeSnapshots([snap({ shares: 0 })]).shares).toBe(0);
  });

  it('engagement is null when likes or the audience are unavailable', () => {
    expect(engagementRate(mergeSnapshots([snap({ views: 1000, unavailable: ['likes'] })]))).toBeNull();
    expect(engagementRate(mergeSnapshots([snap({ likes: 50, unavailable: ['views', 'reach'] })]))).toBeNull();
  });

  it('engagement uses reach first, then views, over the available interactions', () => {
    const m = mergeSnapshots([snap({ reach: 1000, views: 5000, likes: 80, comments: 20, unavailable: ['shares', 'saves'] })]);
    expect(audience(m)).toBe(1000);
    expect(interactions(m)).toBe(100);
    expect(engagementRate(m)).toBeCloseTo(0.1);
  });
});
