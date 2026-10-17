import { Module } from '@nestjs/common';
import { HashtagsModule } from '../hashtags/hashtags.module';
import { ManualTrendsProvider } from './providers/manual-trends.provider';
import { MetaInsightsTrendsProvider } from './providers/meta-insights-trends.provider';
import { TrendsController } from './trends.controller';
import { TrendsService } from './trends.service';

@Module({
  imports: [HashtagsModule],
  controllers: [TrendsController],
  providers: [TrendsService, ManualTrendsProvider, MetaInsightsTrendsProvider],
  exports: [TrendsService],
})
export class TrendsModule {}