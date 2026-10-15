import { mkdtempSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'upl-'));
process.env.DATABASE_URL = 'postgresql://x';
process.env.JWT_SECRET = 'x'.repeat(32);
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.UPLOAD_TMP_DIR = tmp;
process.env.MEDIA_MAX_UPLOAD_BYTES = String(36 * 1024 * 1024);

import { PART_SIZE_BYTES, UploadSessionService } from './upload-session.service';

const MB8 = PART_SIZE_BYTES;
const user = { id: 'u1', email: 'a@b.c', name: 'A', role: 'EDITOR' } as any;
const other = { id: 'u2', email: 'x@y.z', name: 'B', role: 'EDITOR' } as any;
const approver = { id: 'u3', email: 'p@q.r', name: 'C', role: 'APPROVER' } as any;

/** Minimal in-memory stand-in for prisma.mediaUpload. */
function fakePrisma() {
  const rows = new Map<string, any>();
  let n = 0;
  return {
    rows,
    mediaUpload: {
      create: async ({ data }: any) => {
        const row = { id: `s${++n}`, receivedBytes: 0n, partCount: 0, status: 'OPEN', assetId: null, ...data };
        rows.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: any) => rows.get(where.id) ?? null,
      update: async ({ where, data }: any) => {
        const r = rows.get(where.id);
        for (const [k, v] of Object.entries<any>(data)) {
          if (v && typeof v === 'object' && 'increment' in v) r[k] = r[k] + (typeof r[k] === 'bigint' ? v.increment : v.increment);
          else if (v && typeof v === 'object' && 'decrement' in v) r[k] = r[k] - v.decrement;
          else r[k] = v;
        }
        return { ...r };
      },
    },
  };
}

function setup() {
  const prisma = fakePrisma();
  const finalized: any[] = [];
  const assets = { finalize: async (i: any) => { finalized.push(i); return { id: 'asset1' }; } };
  const svc = new UploadSessionService(prisma as any, assets as any);
  return { svc, prisma, finalized };
}
const buf = (n: number, fill = 1) => Buffer.alloc(n, fill);

describe('UploadSessionService', () => {
  it('assembles in order and verifies the declared size', async () => {
    const { svc, finalized } = setup();
    const total = MB8 + 1000;
    const { id } = await svc.init({ name: 'v.mp4', kind: 'VIDEO', totalBytes: total } as any, user);
    await svc.putPart(id, 1, buf(1000, 2), user);
    await svc.putPart(id, 0, buf(MB8, 1), user);
    const asset = await svc.complete(id, {}, user);
    expect(asset.id).toBe('asset1');
    expect(finalized[0].size).toBe(total);
  });

  it('a retried part is not double counted', async () => {
    const { svc } = setup();
    const total = 3000;
    const { id } = await svc.init({ name: 'a.jpg', kind: 'IMAGE', totalBytes: total } as any, user);
    await svc.putPart(id, 0, buf(3000), user);
    const again = await svc.putPart(id, 0, buf(3000), user); // client retry
    expect(again.receivedBytes).toBe(3000);
    expect(again.partCount).toBe(1);
  });

  it('refuses more data than declared, and than the global maximum when nothing was declared', async () => {
    const { svc } = setup();
    const a = await svc.init({ name: 'a.jpg', kind: 'IMAGE', totalBytes: 1000 } as any, user);
    await expect(svc.putPart(a.id, 0, buf(1001), user)).rejects.toThrow(/more data than the declared/);
    const b = await svc.init({ name: 'b.mp4', kind: 'VIDEO' } as any, user); // no totalBytes
    for (let i = 0; i < 4; i++) await svc.putPart(b.id, i, buf(MB8), user); // 32 MB, limit is 36 MB
    await expect(svc.putPart(b.id, 4, buf(MB8), user)).rejects.toThrow(/exceeds the 36 MB/);
  });

  it('refuses a missing middle part', async () => {
    const { svc } = setup();
    const { id } = await svc.init({ name: 'v.mp4', kind: 'VIDEO' } as any, user);
    await svc.putPart(id, 0, buf(MB8), user);
    await svc.putPart(id, 2, buf(500), user);
    await expect(svc.complete(id, {}, user)).rejects.toThrow(/Part 1 is missing/);
  });

  it('refuses a wrong-size non-final part and a checksum mismatch', async () => {
    const { svc } = setup();
    const a = await svc.init({ name: 'v.mp4', kind: 'VIDEO' } as any, user);
    await svc.putPart(a.id, 0, buf(1000), user);
    await svc.putPart(a.id, 1, buf(500), user);
    await expect(svc.complete(a.id, {}, user)).rejects.toThrow(/wrong size/);
    const b = await svc.init({ name: 'a.jpg', kind: 'IMAGE', totalBytes: 10 } as any, user);
    await svc.putPart(b.id, 0, buf(10), user);
    await expect(svc.complete(b.id, { checksumSha256: '0'.repeat(64) }, user)).rejects.toThrow(/Checksum mismatch/);
  });

  it('only the owner or an approver can use a session', async () => {
    const { svc } = setup();
    const { id } = await svc.init({ name: 'a.jpg', kind: 'IMAGE' } as any, user);
    await expect(svc.putPart(id, 0, buf(10), other)).rejects.toThrow(/another user/);
    await expect(svc.cancel(id, other)).rejects.toThrow(/another user/);
    await expect(svc.putPart(id, 0, buf(10), approver)).resolves.toBeDefined();
  });

  it('never leaves the assembled file behind, even when finalize fails', async () => {
    const prisma = fakePrisma();
    const svc = new UploadSessionService(prisma as any, { finalize: async () => { throw new Error('bad type'); } } as any);
    const { id } = await svc.init({ name: 'a.jpg', kind: 'IMAGE', totalBytes: 10 } as any, user);
    await svc.putPart(id, 0, buf(10), user);
    await expect(svc.complete(id, {}, user)).rejects.toThrow('bad type');
    expect(readdirSync(tmp).filter((n) => n.endsWith('-assembled'))).toHaveLength(0);
  });
});
