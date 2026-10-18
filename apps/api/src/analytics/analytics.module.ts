import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators';
import { ImportDto } from './analytics.dto';
import { AnalyticsService, Filter } from './analytics.service';
import { BackfillService } from './backfill.service';
import { InsightsService } from './insights.service';
import { parsePlatforms, parseRange } from './analytics-range';

function filterOf(from?: string, to?: string, platforms?: string): Filter {
  return { range: parseRange(from, to), platforms: parsePlatforms(platforms) };
}

@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly backfill: BackfillService,
  ) {}

  @Get('overview')
  overview(@Query('from') from?: string, @Query('to') to?: string, @Query('platforms') platforms?: string) {
    return this.analytics.overview(filterOf(from, to, platforms));
  }

  @Get('timeseries')
  timeseries(@Query('from') from?: string, @Query('to') to?: string, @Query('platforms') platforms?: string) {
    return this.analytics.timeseries(filterOf(from, to, platforms));
  }

  @Get('posts')
  posts(@Query('from') from?: string, @Query('to') to?: string, @Query('platforms') platforms?: string) {
    return this.analytics.postsTable(filterOf(from, to, platforms));
  }

  @Get('best-times')
  bestTimes() {
    return this.analytics.bestTimes();
  }

  @Post('sync')
  @Roles(Role.APPROVER)
  sync() {
    return this.analytics.sync();
  }

  /** Pull existing posts + metrics from Meta (Instagram + Facebook). */
  @Post('backfill')
  @Roles(Role.APPROVER)
  runBackfill(@Query('limit') limit?: string) {
    return this.backfill.run(limit ? Number(limit) : 30);
  }

  @Post('import')
  @Roles(Role.APPROVER)
  import(@Body() dto: ImportDto) {
    return this.analytics.importRows(dto.rows);
  }
}

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, InsightsService, BackfillService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}