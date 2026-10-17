import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import {
  ApplySuggestionDto,
  ApproveSuggestionDto,
  EditSuggestionDto,
  FeedbackDto,
  GenerateCaptionsDto,
  ListSuggestionsQuery,
  RejectSuggestionDto,
} from './captions.dto';
import { CaptionsService } from './captions.service';

/**
 * Nothing here can publish. Generation creates suggestions, review changes their status,
 * apply writes APPROVED text into a draft that still needs its own approval.
 */
@Controller('captions')
export class CaptionsController {
  constructor(private readonly captions: CaptionsService) {}

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('generate')
  generate(@Body() dto: GenerateCaptionsDto, @CurrentUser() user: AuthUser) {
    return this.captions.generate(dto, user);
  }

  /** Declared BEFORE ':id'. */
  @Get('suggestions')
  list(@Query() q: ListSuggestionsQuery) {
    return this.captions.list(q);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.captions.get(id);
  }

  @Patch(':id')
  edit(@Param('id') id: string, @Body() dto: EditSuggestionDto, @CurrentUser() user: AuthUser) {
    return this.captions.edit(id, dto, user);
  }

  @Post(':id/approve')
  @Roles(Role.APPROVER)
  approve(@Param('id') id: string, @Body() dto: ApproveSuggestionDto, @CurrentUser() user: AuthUser) {
    return this.captions.approve(id, dto, user);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() dto: RejectSuggestionDto, @CurrentUser() user: AuthUser) {
    return this.captions.reject(id, dto, user);
  }

  @Post(':id/apply')
  apply(@Param('id') id: string, @Body() dto: ApplySuggestionDto, @CurrentUser() user: AuthUser) {
    return this.captions.apply(id, dto, user);
  }

  @Post(':id/feedback')
  feedback(@Param('id') id: string, @Body() dto: FeedbackDto, @CurrentUser() user: AuthUser) {
    return this.captions.feedback(id, dto, user);
  }
}