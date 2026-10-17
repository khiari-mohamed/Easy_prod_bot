import { SchedulerService } from './scheduler.service';

type Decision = { allowed: boolean; reason: string; mode: string };
const ok: Decision = { allowed: true, reason: 'OK', mode: 'AUTO' };
const blocked = (reason: string): Decision => ({ allowed: false, reason, mode: 'OFF' });

function setup(policy: (feature: string) => Decision) {
  const post = {
    id: 'p1',
    status: 'APPROVED',
    approvalStatus: 'APPROVED',
    publishMode: 'AUTO',
    platform: 'INSTAGRAM',
    format: 'REEL',
    campaignId: 'c1',
    accountId: 'a1',
    scheduledAt: new Date(Date.now() - 60_000),
  };
  const prisma = {
    post: {
      findMany: jest.fn().mockResolvedValue([post]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    campaign: {
      findMany: jest.fn().mockResolvedValue([{ id: 'c1', autoPublishEnabled: true, publishingPaused: false }]),
    },
  };
  const settings = { isPaused: jest.fn().mockResolvedValue(false) };
  const queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const evaluate = jest.fn(async (i: { feature: string; need?: string }) => policy(i.feature));
  const svc = new SchedulerService(prisma as any, settings as any, queue as any, { evaluate } as any);
  // recoverStuck is unrelated to this test
  (svc as any).recoverStuck = jest.fn().mockResolvedValue(undefined);
  return { svc, prisma, queue, evaluate };
}

describe('scheduler honours the Administration Center', () => {
  it('queues an approved AUTO post when everything is enabled', async () => {
    const { svc, queue } = setup(() => ok);
    await svc.run();
    expect(queue.enqueue).toHaveBeenCalledWith('p1');
  });

  it('does nothing at all when scheduled publishing is off: no queue, no state change', async () => {
    const { svc, queue, prisma } = setup((f) => (f === 'publishing.scheduled' ? blocked('off') : ok));
    await svc.run();
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(prisma.post.updateMany).not.toHaveBeenCalled();
  });

  it('hands the post to a human (never queues it) when automatic publishing is off', async () => {
    const { svc, queue, prisma } = setup((f) => (f === 'publishing.auto' ? blocked('désactivée') : ok));
    await svc.run();
    expect(queue.enqueue).not.toHaveBeenCalled();
    const update = prisma.post.updateMany.mock.calls[0][0];
    expect(update.data.status).toBe('MANUAL_REQUIRED');
  });

  it('asks for AUTO mode, not just "enabled", before queueing unattended work', async () => {
    const { svc, evaluate } = setup(() => ok);
    await svc.run();
    const autoCall = evaluate.mock.calls.find((c: any[]) => c[0].feature === 'publishing.auto');
    expect(autoCall![0].need).toBe('AUTO');
  });
});