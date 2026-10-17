import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { AddTrendDto, ImportTrendsDto, ListTrendsQuery } from './trends.dto';
import { TrendsService } from './trends.service';

@Controller('trends')
export class TrendsController {
  constructor(private readonly trends: TrendsService) {}

  @Get()
  list(@Query() q: ListTrendsQuery) {
    return this.trends.list(q);
  }

  @Post()
  @Roles(Role.APPROVER)
  add(@Body() dto: AddTrendDto, @CurrentUser() user: AuthUser) {
    return this.trends.add(dto, user);
  }

  @Post('import')
  @Roles(Role.APPROVER)
  import(@Body() dto: ImportTrendsDto, @CurrentUser() user: AuthUser) {
    return this.trends.importBatch(dto.rows, user);
  }

  @Post('sync')
  @Roles(Role.APPROVER)
  sync(@CurrentUser() user: AuthUser) {
    return this.trends.syncNow(user);
  }

  @Delete(':id')
  @Roles(Role.APPROVER)
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.trends.remove(id, user);
  }
}