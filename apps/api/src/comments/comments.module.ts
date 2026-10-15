import { Body, Controller, Get, Module, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators';
import { CommentsService } from './comments.service';

type Req_ = { user?: { id?: string } }; // adjust if your auth guard puts the user elsewhere
const uid = (r: Req_) => r.user?.id;

@Controller('comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get('status')
  @Roles(Role.APPROVER)
  status() {
    return this.comments.status();
  }

  @Patch('config')
  @Roles(Role.ADMIN)
  setConfig(@Body() body: Record<string, unknown>, @Req() req: Req_) {
    return this.comments.setConfig(body ?? {}, uid(req));
  }

  @Get('jobs')
  @Roles(Role.APPROVER)
  jobs(@Query('status') status?: string, @Query('kind') kind?: string, @Query('limit') limit?: string) {
    return this.comments.listJobs(status, kind, limit ? Number(limit) : 50);
  }

  @Patch('jobs/:id')
  @Roles(Role.APPROVER)
  edit(@Param('id') id: string, @Body() body: { text?: string }, @Req() req: Req_) {
    return this.comments.editText(id, body?.text ?? '', uid(req));
  }

  @Post('jobs/:id/approve')
  @Roles(Role.APPROVER)
  approve(@Param('id') id: string, @Req() req: Req_) {
    return this.comments.approve(id, uid(req));
  }

  @Post('jobs/:id/reject')
  @Roles(Role.APPROVER)
  reject(@Param('id') id: string, @Req() req: Req_) {
    return this.comments.reject(id, uid(req));
  }

  @Post('jobs/:id/retry')
  @Roles(Role.APPROVER)
  retry(@Param('id') id: string, @Req() req: Req_) {
    return this.comments.retry(id, uid(req));
  }

  @Post('jobs/:id/resolve')
  @Roles(Role.APPROVER)
  resolve(@Param('id') id: string, @Body() body: { sent?: boolean }, @Req() req: Req_) {
    return this.comments.resolve(id, body?.sent === true, uid(req));
  }

  @Post('poll')
  @Roles(Role.APPROVER)
  poll() {
    return this.comments.poll();
  }
}

@Module({
  controllers: [CommentsController],
  providers: [CommentsService],
})
export class CommentsModule {}