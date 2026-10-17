import { FeaturePolicyService } from './feature-policy.service';

function make(over: { prisma?: any; settings?: any } = {}) {
  const prisma = {
    featureConfig: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn() },
    campaign: { findMany: jest.fn().mockResolvedValue([]) },
    commentJob: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    featureConfigAudit: { create: jest.fn() },
    setting: { findUnique: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
    ...over.prisma,
  };
  const settings = {
    pauseState: jest.fn().mockResolvedValue({ paused: false }),
    emergencyState: jest.fn().mockResolvedValue({ active: false }),
    setEmergency: jest.fn().mockResolvedValue({ active: true }),
    ...over.settings,
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  return { svc: new FeaturePolicyService(prisma as any, settings as any, audit as any), prisma, settings };
}

describe('FeaturePolicyService', () => {
  it('fails closed: if the policy cannot be read, nothing is allowed', async () => {
    const { svc } = make({ prisma: { featureConfig: { findMany: jest.fn().mockRejectedValue(new Error('db down')) } } });
    const d = await svc.evaluate({ feature: 'publishing.scheduled', fresh: true });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('POLICY_UNAVAILABLE');
  });

  it('assert() throws when the feature is stopped by the emergency stop', async () => {
    const { svc } = make({ settings: { emergencyState: jest.fn().mockResolvedValue({ active: true }) } });
    await expect(svc.assert({ feature: 'comments.reply', fresh: true })).rejects.toThrow(/Arrêt d’urgence/);
  });

  it('reads fresh state when asked, so a worker sees a stop issued after the job was queued', async () => {
    const emergencyState = jest.fn().mockResolvedValueOnce({ active: false }).mockResolvedValueOnce({ active: true });
    const { svc } = make({ settings: { emergencyState } });
    expect((await svc.evaluate({ feature: 'publishing.auto', need: 'AUTO', fresh: true })).allowed).toBe(true);
    expect((await svc.evaluate({ feature: 'publishing.auto', need: 'AUTO', fresh: true })).allowed).toBe(false);
  });

  it('emergency stop sends approved replies back to human approval and cancels first comments', async () => {
    const { svc, prisma } = make();
    await svc.setEmergency(true, 'admin1', 'test');
    const calls = prisma.commentJob.updateMany.mock.calls.map((c: any[]) => c[0]);
    const reply = calls.find((c: any) => c.where.kind === 'REPLY');
    const first = calls.find((c: any) => c.where.kind === 'FIRST_COMMENT');
    expect(reply.data.status).toBe('PENDING_APPROVAL');
    expect(reply.data.auto).toBe(false);
    expect(first.data.status).toBe('SKIPPED');
  });

  it('does not touch queued comments when the emergency stop is released', async () => {
    const { svc, prisma } = make();
    await svc.setEmergency(false, 'admin1');
    expect(prisma.commentJob.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an unsafe change and writes nothing', async () => {
    const { svc, prisma } = make();
    await expect(
      svc.setMode({ featureKey: 'ai.captions', scope: 'GLOBAL', scopeId: '', mode: 'AUTO' }, 'admin1'),
    ).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});