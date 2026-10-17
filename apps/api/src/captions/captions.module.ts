import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module';
import { HashtagsModule } from '../hashtags/hashtags.module';
import { PostsModule } from '../posts/posts.module';
import { TrendsModule } from '../trends/trends.module';
import { CaptionsController } from './captions.controller';
import { CaptionsService } from './captions.service';

@Module({
  imports: [ContentModule, PostsModule, HashtagsModule, TrendsModule],
  controllers: [CaptionsController],
  providers: [CaptionsService],
  exports: [CaptionsService],
})
export class CaptionsModule {}