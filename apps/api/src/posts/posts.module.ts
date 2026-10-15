import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { QueueModule } from '../queue/queue.module';
import {
  ConfirmManualDto,
  CreatePostDto,
  ListPostsQuery,
  MarkPublishedDto,
  MetricsDto,
  PublishNowDto,
  RejectDto,
  RescheduleDto,
  UpdatePostDto,
} from './posts.dto';
import { PostsService } from './posts.service';

@Controller('posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get()
  list(@Query() q: ListPostsQuery) {
    return this.posts.list(q);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.posts.get(id);
  }

  @Post()
  create(@Body() dto: CreatePostDto, @CurrentUser() u: AuthUser) {
    return this.posts.create(dto, u);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePostDto, @CurrentUser() u: AuthUser) {
    return this.posts.update(id, dto, u);
  }

  @Post(':id/submit')
  submit(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.posts.submit(id, u);
  }

  @Post(':id/approve')
  @Roles(Role.APPROVER)
  approve(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.posts.approve(id, u);
  }

  @Post(':id/reject')
  @Roles(Role.APPROVER)
  reject(@Param('id') id: string, @Body() dto: RejectDto, @CurrentUser() u: AuthUser) {
    return this.posts.reject(id, dto.reason, u);
  }

  @Post(':id/unschedule')
  @Roles(Role.APPROVER)
  unschedule(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.posts.unschedule(id, u);
  }

  @Post(':id/publish-now')
  @Roles(Role.APPROVER)
  publishNow(@Param('id') id: string, @Body() dto: PublishNowDto, @CurrentUser() u: AuthUser) {
    return this.posts.publishNow(id, u, dto.confirm === true);
  }

  @Post(':id/reschedule')
  @Roles(Role.APPROVER)
  reschedule(@Param('id') id: string, @Body() dto: RescheduleDto, @CurrentUser() u: AuthUser) {
    return this.posts.reschedule(id, dto.scheduledAt, u);
  }

  @Post(':id/mark-published')
  @Roles(Role.APPROVER)
  markPublished(@Param('id') id: string, @Body() dto: MarkPublishedDto, @CurrentUser() u: AuthUser) {
    return this.posts.markPublished(id, dto, u);
  }

  /** Human confirms they published a manual post themselves. */
  @Post(':id/confirm-manual')
  confirmManual(@Param('id') id: string, @Body() dto: ConfirmManualDto, @CurrentUser() u: AuthUser) {
    return this.posts.confirmManual(id, dto, u);
  }

  @Post(':id/cancel')
  @Roles(Role.APPROVER)
  cancel(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.posts.cancel(id, u);
  }

  @Post(':id/metrics')
  addMetrics(@Param('id') id: string, @Body() dto: MetricsDto, @CurrentUser() u: AuthUser) {
    return this.posts.addMetrics(id, dto, u);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.posts.remove(id, u);
  }
}

@Module({
  imports: [QueueModule],
  controllers: [PostsController],
  providers: [PostsService],
  exports: [PostsService],
})
export class PostsModule {}