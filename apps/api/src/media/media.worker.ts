import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { redisOptions } from '../env';
import { MEDIA_QUEUE } from './media-queue.service';
import { MediaProcessorService } from './media-processor.service';

@Injectable()
export class MediaWorker implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;
  private readonly log = new Logger(MediaWorker.name);

  constructor(private readonly processor: MediaProcessorService) {}

  onModuleInit() {
    this.worker = new Worker(MEDIA_QUEUE, (job) => this.process(job), {
      connection: redisOptions(),
      concurrency: 2,
    });
    this.worker.on('error', (e) => this.log.error(`Media worker error: ${e.message}`));
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async process(job: Job<{ assetId: string }>): Promise<void> {
    await this.processor.process(job.data.assetId);
  }
}
