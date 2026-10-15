import { Global, Module } from '@nestjs/common';
import { MediaCleanupService } from './media-cleanup.service';
import { MediaController } from './media.controller';
import { MediaProcessorService } from './media-processor.service';
import { MediaQueueService } from './media-queue.service';
import { MediaService } from './media.service';
import { MediaWorker } from './media.worker';
import { StorageService } from './storage.service';

/**
 * Media pipeline: storage abstraction (local / S3), the processing worker that
 * inspects uploads, the signed access endpoint and the cleanup scheduler.
 * Global so assets and publishing can inject the storage facade directly.
 */
@Global()
@Module({
  controllers: [MediaController],
  providers: [
    StorageService,
    MediaService,
    MediaProcessorService,
    MediaQueueService,
    MediaWorker,
    MediaCleanupService,
  ],
  exports: [StorageService, MediaService, MediaProcessorService, MediaQueueService],
})
export class MediaModule {}
