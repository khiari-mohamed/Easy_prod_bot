import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { redisOptions } from '../env';

export const MEDIA_QUEUE = 'media';
export const MEDIA_ATTEMPTS = 2;

/**
 * Queue that offloads media inspection (dimensions, duration, platform
 * compatibility) from the upload request. Uploads return immediately with the
 * asset in PROCESSING and the worker flips it to READY/INVALID.
 */
@Injectable()
export class MediaQueueService implements OnModuleDestroy {
  private readonly queue = new Queue(MEDIA_QUEUE, { connection: redisOptions() });

  async enqueue(assetId: string): Promise<void> {
    await this.queue.add(
      'process',
      { assetId },
      {
        attempts: MEDIA_ATTEMPTS,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 500,
        removeOnFail: 500,
      },
    );
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
