import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/decorators';
import { PostsModule } from '../posts/posts.module';
import { QueueModule } from '../queue/queue.module';
import { AuthUser } from '../auth/auth.types';
import {
  CreateContentItemDto,
  GeneratePostsDto,
  ListContentQuery,
  RejectContentDto,
  UpdateContentItemDto,
} from './content.dto';
import { ContentService } from './content.service';

@Controller('content')
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get()
  list(@Query() q: ListContentQuery) {
    return this.content.list(q);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.content.get(id);
  }

  @Post()
  create(@Body() dto: CreateContentItemDto, @CurrentUser() u: AuthUser) {
    return this.content.create(dto, u);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateContentItemDto, @CurrentUser() u: AuthUser) {
    return this.content.update(id, dto, u);
  }

  @Post(':id/submit')
  submit(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.content.submit(id, u);
  }

  @Post(':id/approve')
  @Roles(Role.APPROVER)
  approve(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.content.approve(id, u);
  }

  @Post(':id/reject')
  @Roles(Role.APPROVER)
  reject(@Param('id') id: string, @Body() dto: RejectContentDto, @CurrentUser() u: AuthUser) {
    return this.content.reject(id, dto, u);
  }

  @Post(':id/generate-posts')
  generatePosts(@Param('id') id: string, @Body() dto: GeneratePostsDto, @CurrentUser() u: AuthUser) {
    return this.content.generatePosts(id, dto, u);
  }

  @Delete(':id')
  @Roles(Role.APPROVER)
  remove(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.content.remove(id, u);
  }
}

@Module({
  imports: [PostsModule, QueueModule],
  controllers: [ContentController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}