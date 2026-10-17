import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccountsModule } from './accounts/accounts.module';
import { AiModule } from './ai/ai.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AssetsModule } from './assets/assets.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './common/audit.service';
import { CampaignModule } from './campaign/campaign.module';
import { ContentModule } from './content/content.module';
import { HealthController } from './health.controller';
import { MediaModule } from './media/media.module';
import { MetaGuardModule } from './meta/meta-guard.module';
import { PlanningModule } from './planning/planning.module';
import { PostsModule } from './posts/posts.module';
import { PrismaModule } from './prisma/prisma.service';
import { PublishingModule } from './publishing/publishing.module';
import { PublishingControlModule } from './publishing/publishing-control.module';
import { QueueModule } from './queue/queue.module';
import { CommentsModule } from './comments/comments.module';
import { SettingsModule } from './settings/settings.module';
import { FeaturesModule } from './features/features.controller';
import { UsersModule } from './users/users.module';
import { TikTokModule } from './tiktok/tiktok.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    MetaGuardModule,
    MediaModule,
    AuditModule,
    SettingsModule,
    FeaturesModule,
    AccountsModule,
    AiModule,
    AuthModule,
    UsersModule,
    AssetsModule,
    CampaignModule,
    ContentModule,
    PlanningModule,
    PostsModule,
    PublishingModule,
    PublishingControlModule,
    QueueModule,
    AnalyticsModule,
    CommentsModule,
    TikTokModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
