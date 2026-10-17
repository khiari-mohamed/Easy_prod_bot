import { Module } from '@nestjs/common';
import { HashtagRankingService } from './hashtag-ranking.service';
import { HashtagSyncService } from './hashtag-sync.service';
import { HashtagsController } from './hashtags.controller';
import { HashtagsService } from './hashtags.service';

@Module({
  controllers: [HashtagsController],
  providers: [HashtagsService, HashtagRankingService, HashtagSyncService],
  exports: [HashtagsService, HashtagRankingService],
})
export class HashtagsModule {}