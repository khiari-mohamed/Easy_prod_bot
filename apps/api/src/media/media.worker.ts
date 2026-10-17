import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { redisOptions } from '../env';
import { MEDIA_QUEUE } from './media-queue.service';
import { MediaProcessorService } from './media-processor.service';
import { PrismaService } from '../prisma/prisma.service';
import { FeaturePolicyService } from '../features/feature-policy.service';

@Injectable()
export class MediaWorker implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;
  private readonly log = new Logger(MediaWorker.name);

  constructor(
    private readonly processor: MediaProcessorService,
    private readonly policy: FeaturePolicyService,
    private readonly prisma: PrismaService,
  ) {}

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
    // Administration Center: with automatic processing off, the file stays in PROCESSING (so it cannot be
    // attached to a post) with an explanation. Re-run it with "reprocess" once the feature is back on.
    const gate = await this.policy.evaluate({ feature: 'media.processing', fresh: true, action: 'EXECUTE' });
    if (!gate.allowed) {
      await this.prisma.asset.updateMany({
        where: { id: job.data.assetId, processingStatus: 'PROCESSING' },
        data: { processingError: `Traitement automatique désactivé (${gate.reason}). Relancez-le une fois réactivé.` },
      });
      return;
    }
    await this.processor.process(job.data.assetId);
  }
}