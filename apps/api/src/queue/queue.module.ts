import { Module } from '@nestjs/common';
import { PublishingModule } from '../publishing/publishing.module';
import { PublishWorker } from './publish.worker';
import { QueueService } from './queue.service';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [PublishingModule],
  providers: [QueueService, PublishWorker, SchedulerService],
  exports: [QueueService],
})
export class QueueModule {}
