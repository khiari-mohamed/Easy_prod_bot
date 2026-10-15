process.env.DATABASE_URL = 'postgresql://x';
process.env.JWT_SECRET = 'x'.repeat(32);
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.META_APP_ID = '123';
process.env.META_APP_SECRET = 'secret';

jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { AccountsService } from './accounts.service';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

/** Meta stand-in: routes by URL path. */
function mockMeta(routes: Record<string, any>) {
  global.fetch = (async (url: any) => {
    const u = new URL(String(url));
    const key = Object.keys(routes).find((k) => u.pathname.endsWith(k));
    const body = key ? routes[key] : { error: { message: 'not mocked', code: 1 } };
    const isErr = body && body.error;
    return { ok: !isErr, status: isErr ? 400 : 200, json: async () => body } as any;
  }) as any;
}

function svc(rows: any[] = []) {
  const upserts: any[] = [];
  const prisma: any = {
    socialAccount: {
      upsert: async (a: any) => { upserts.push(a); return { id: 'a1', encryptedToken: 'x', ...a.create }; },
      findMany: async () => rows,
    },
  };
  return { s: new AccountsService(prisma), upserts };
}

const pages = (n: number) => ({ data: Array.from({ length: n }, (_, i) => ({ id: `${1000 + i}0000`, name: `P${i}`, access_token: 'pt' })) });

describe('connectMeta scope', () => {
  it('refuses to guess when the token reaches several Pages', async () => {
    mockMeta({ '/oauth/access_token': { access_token: 'ext' }, '/me/accounts': pages(2) });
    await expect(svc().s.connectMeta('t'.repeat(30))).rejects.toThrow(/reaches 2 Pages/);
  });

  it('connects only the chosen Page and stores real permissions', async () => {
    mockMeta({
      '/oauth/access_token': { access_token: 'ext' },
      '/me/accounts': pages(2),
      '/10000000': { id: '10000000' },
      '/debug_token': { data: { is_valid: true, scopes: ['pages_manage_posts'], expires_at: 0 } },
    });
    const { s, upserts } = svc();
    const out = await s.connectMeta('t'.repeat(30), '10000000');
    expect(out).toHaveLength(1);
    expect(upserts[0].create.canPublish).toBe(true);
    expect(upserts[0].create.canReadInsights).toBe(false);
    expect(upserts[0].create.lastError).toMatch(/pages_read_engagement/);
    expect(upserts[0].create.tokenExpiresAt).toBeNull();
  });

  it('rejects a Page the token cannot reach', async () => {
    mockMeta({ '/oauth/access_token': { access_token: 'ext' }, '/me/accounts': pages(1) });
    await expect(svc().s.connectMeta('t'.repeat(30), '999999')).rejects.toThrow(/not reachable/);
  });
});

describe('soleActiveFor', () => {
  const acc = (o: any = {}) => ({ platform: 'FACEBOOK', status: 'ACTIVE', canPublish: true, tokenExpiresAt: null, ...o });
  it('returns the only usable account', async () => {
    expect(await svc([acc({ id: 1 })]).s.soleActiveFor('FACEBOOK' as any)).toMatchObject({ id: 1 });
  });
  it('returns null when ambiguous, or when the only account cannot publish / is expired', async () => {
    expect(await svc([acc({ id: 1 }), acc({ id: 2 })]).s.soleActiveFor('FACEBOOK' as any)).toBeNull();
    expect(await svc([acc({ canPublish: false })]).s.soleActiveFor('FACEBOOK' as any)).toBeNull();
    expect(await svc([acc({ tokenExpiresAt: new Date(Date.now() - 1000) })]).s.soleActiveFor('FACEBOOK' as any)).toBeNull();
  });
});
