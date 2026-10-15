import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { redisOptions } from '../env';

export const PUBLISH_QUEUE = 'publish';
export const PUBLISH_ATTEMPTS = 3;

/**
 * One job per post. A deterministic id lets us find and remove the job later
 * (cancel, unschedule, reschedule, edit). BullMQ ids must not contain ':'.
 */
export const publishJobId = (postId: string) => `publish-${postId}`;

type ClearResult = 'none' | 'removed' | 'active';

/**
 * The shared Redis options use maxRetriesPerRequest: null (required by the Worker), which makes a
 * producer call WAIT while Redis is down instead of failing. Every queue operation is therefore
 * bounded, so callers (scheduler tick, "publish now", cancel...) fail fast and can roll back.
 */
const QUEUE_OP_TIMEOUT_MS = 10_000;

function bounded<T>(op: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Publishing queue timeout during ${what} (is Redis reachable?)`)),
      QUEUE_OP_TIMEOUT_MS,
    );
  });
  // Promise.race keeps a handler on `op`, so a late rejection is not "unhandled".
  return Promise.race([op, timeout]).finally(() => clearTimeout(timer));
}

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queue = new Queue(PUBLISH_QUEUE, { connection: redisOptions() });

  constructor() {
    // Without a listener a Redis error would be an unhandled 'error' event.
    this.queue.on('error', (err) => this.logger.error(`Publish queue error: ${err.message}`));
  }

  /**
   * Queue a publication, optionally delayed until `runAt`.
   * Any stale job for the same post is removed first, otherwise BullMQ would silently ignore the new
   * job with the same id. Throws if the job could not be queued (including a Redis timeout), so
   * callers can roll back. A job that completes late after a timeout is harmless: the worker only
   * publishes posts whose DB status is QUEUED, and the caller has already rolled that back.
   *
   * Duplicate protection for actual publishing lives in the database (atomic status transition in
   * the worker), not in the job id.
   */
  enqueue(postId: string, runAt?: Date): Promise<void> {
    return bounded(this.doEnqueue(postId, runAt), 'enqueue');
  }

  private async doEnqueue(postId: string, runAt?: Date): Promise<void> {
    const jobId = publishJobId(postId);

    if ((await this.clear(jobId)) === 'active') {
      // A worker is running this post right now; its DB claim is the guard.
      this.logger.warn(`Post ${postId} is already being processed; not queueing a second job`);
      return;
    }

    const delay = runAt ? Math.max(0, runAt.getTime() - Date.now()) : undefined;
    await this.queue.add(
      'publish',
      { postId },
      {
        jobId,
        delay,
        attempts: PUBLISH_ATTEMPTS,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 500,
        removeOnFail: 500,
      },
    );
  }

  /**
   * Remove the waiting/delayed/finished job of a post (cancel, unschedule, reschedule, edit, delete).
   * Returns true if a job was removed. A job that is already running cannot be removed: the worker's
   * final status check in the database must stop it.
   */
  dequeue(postId: string): Promise<boolean> {
    return bounded(this.doDequeue(postId), 'dequeue');
  }

  private async doDequeue(postId: string): Promise<boolean> {
    const jobId = publishJobId(postId);
    const result = await this.clear(jobId);
    if (result === 'active') {
      this.logger.warn(`Job ${jobId} is running and cannot be removed; the worker status check must stop it`);
    }
    return result === 'removed';
  }

  private async clear(jobId: string): Promise<ClearResult> {
    const job = await this.queue.getJob(jobId);
    if (!job) return 'none';
    if ((await job.getState()) === 'active') return 'active';
    try {
      await job.remove();
      return 'removed';
    } catch (err) {
      // The job may have become active, or been removed by someone else, between the check and the removal.
      const again = await this.queue.getJob(jobId);
      if (!again) return 'removed';
      if ((await again.getState()) === 'active') return 'active';
      throw err;
    }
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}