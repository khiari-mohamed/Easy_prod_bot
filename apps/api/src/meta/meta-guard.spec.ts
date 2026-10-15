import { isRateLimitCode, MetaBlockedError, MetaGuard, parseUsage, tokenScope } from './meta-guard';

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe('Meta guard', () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env.META_MIN_WRITE_GAP_MS = '200';
    process.env.META_MIN_READ_GAP_MS = '10';
    process.env.META_USAGE_PAUSE_PCT = '70';
    process.env.META_DAILY_WRITE_CAP = '40';
    process.env.META_DAILY_READ_CAP = '1500';
    process.env.META_MAX_QUEUE_WAIT_MS = '120000';
    delete process.env.META_API_ENABLED;
  });
  afterAll(() => {
    process.env = OLD;
  });

  it('reads the highest usage figure and the wait Meta asks for', () => {
    const u = parseUsage(
      headers({
        'x-app-usage': '{"call_count":12,"total_cputime":9,"total_time":30}',
        'x-business-use-case-usage':
          '{"123":[{"type":"instagram","call_count":5,"total_cputime":80,"total_time":2,"estimated_time_to_regain_access":10}]}',
      }),
    );
    expect(u.pct).toBe(80);
    expect(u.regainMs).toBe(10 * 60_000);
    expect(parseUsage(headers({})).pct).toBe(0);
    expect(parseUsage(headers({ 'x-app-usage': 'not json' })).pct).toBe(0);
  });

  it('knows the rate-limit codes', () => {
    for (const c of [4, 17, 32, 341, 613, 80001, 80014]) expect(isRateLimitCode(c)).toBe(true);
    for (const c of [undefined, 1, 10, 100, 190, 200]) expect(isRateLimitCode(c)).toBe(false);
  });

  it('spaces two writes of the same token apart, but not different tokens', async () => {
    const g = new MetaGuard();
    const t0 = Date.now();
    await g.acquire('write', 'token-A');
    const first = Date.now() - t0;
    await g.acquire('write', 'token-A');
    const second = Date.now() - t0;
    expect(first).toBeLessThan(100);
    expect(second).toBeGreaterThanOrEqual(190);

    const t1 = Date.now();
    await g.acquire('write', 'token-B');
    expect(Date.now() - t1).toBeLessThan(100);
  });

  it('serves concurrent callers one after another (a Promise.all burst becomes a queue)', async () => {
    const g = new MetaGuard();
    const starts: number[] = [];
    const t0 = Date.now();
    await Promise.all([1, 2, 3, 4].map(() => g.acquire('read', 'tok').then(() => starts.push(Date.now() - t0))));
    starts.sort((a, b) => a - b);
    expect(starts[3]).toBeGreaterThanOrEqual(25); // 3 gaps of 10 ms
  });

  it('a rate-limit error opens the breaker, blocks every call, and reset closes it', async () => {
    const g = new MetaGuard();
    g.observe(headers({}), { code: 17, message: 'User request limit reached' }, 'tok');
    expect(g.isOpen()).toBe(true);
    await expect(g.acquire('read', 'tok')).rejects.toBeInstanceOf(MetaBlockedError);
    await expect(g.acquire('write', 'other')).rejects.toBeInstanceOf(MetaBlockedError);
    g.reset();
    await expect(g.acquire('read', 'tok')).resolves.toBeUndefined();
  });

  it('opens at the usage threshold, not below it', () => {
    const below = new MetaGuard();
    below.observe(headers({ 'x-app-usage': '{"call_count":50}' }), null, 't');
    expect(below.isOpen()).toBe(false);

    const above = new MetaGuard();
    above.observe(headers({ 'x-app-usage': '{"call_count":75}' }), null, 't');
    expect(above.isOpen()).toBe(true);
    expect(above.status().retryInMinutes).toBeGreaterThanOrEqual(14);

    const critical = new MetaGuard();
    critical.observe(headers({ 'x-app-usage': '{"total_cputime":95}' }), null, 't');
    expect(critical.status().retryInMinutes).toBeGreaterThanOrEqual(59);
  });

  it('pauses longer each time it trips again within 24 h (1 h, 3 h, 12 h), as time really passes', () => {
    let now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const g = new MetaGuard();
      const mins: number[] = [];
      for (let i = 0; i < 3; i++) {
        g.observe(headers({}), { code: 613 }, 't');
        mins.push(g.status().retryInMinutes);
        now += (mins[i] + 1) * 60_000; // the pause ends, then Meta limits us again
        expect(g.isOpen()).toBe(false);
      }
      expect(mins).toEqual([60, 180, 720]);
    } finally {
      spy.mockRestore();
    }
  });

  it('an admin reset also clears the escalation', () => {
    const g = new MetaGuard();
    g.observe(headers({}), { code: 613 }, 't');
    g.reset();
    g.observe(headers({}), { code: 613 }, 't');
    expect(g.status().retryInMinutes).toBe(60);
  });

  it('code 368 (blocked) pauses for 24 h', () => {
    const g = new MetaGuard();
    g.observe(headers({}), { code: 368 }, 't');
    expect(g.status().retryInMinutes).toBeGreaterThanOrEqual(1439);
  });

  it('a rejected token (190) is never used again, but a new token works', async () => {
    const g = new MetaGuard();
    g.observe(headers({}), { code: 190 }, 'old-token');
    expect(g.isOpen()).toBe(false); // the app is not paused...
    await expect(g.acquire('write', 'old-token')).rejects.toBeInstanceOf(MetaBlockedError);
    await expect(g.acquire('write', 'new-token')).resolves.toBeUndefined(); // ...a NEW token is fine
    expect(tokenScope('old-token')).not.toContain('old-token');
  });

  it('enforces the daily write cap per token', async () => {
    process.env.META_DAILY_WRITE_CAP = '2';
    process.env.META_MIN_WRITE_GAP_MS = '0';
    const g = new MetaGuard();
    await g.acquire('write', 'tok');
    await g.acquire('write', 'tok');
    await expect(g.acquire('write', 'tok')).rejects.toThrow(/Daily limit/);
    await expect(g.acquire('write', 'another')).resolves.toBeUndefined();
  });

  it('refuses instead of waiting forever when the queue is too long', async () => {
    process.env.META_MIN_WRITE_GAP_MS = '60000';
    process.env.META_MAX_QUEUE_WAIT_MS = '100';
    const g = new MetaGuard();
    await g.acquire('write', 'tok');
    await expect(g.acquire('write', 'tok')).rejects.toThrow(/waiting/);
  });

  it('META_API_ENABLED=false is a hard stop', async () => {
    process.env.META_API_ENABLED = 'false';
    await expect(new MetaGuard().acquire('read', 'tok')).rejects.toThrow(/disabled/);
  });

  it('restores an open breaker after a restart, and ignores an expired one', () => {
    const g = new MetaGuard();
    g.restore({ openUntil: Date.now() + 30 * 60_000, reason: 'Meta rate limit (code 4)', trips: 2, lastTripAt: Date.now() });
    expect(g.isOpen()).toBe(true);
    const h = new MetaGuard();
    h.restore({ openUntil: Date.now() - 1000, reason: 'old' });
    expect(h.isOpen()).toBe(false);
  });
});
