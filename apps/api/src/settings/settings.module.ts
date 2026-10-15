import { Body, Controller, Get, Global, Injectable, Module, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';

const PAUSED_KEY = 'publishingPaused';

export interface PauseState {
  paused: boolean;
  reason?: string;
  at?: string;
}

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async pauseState(): Promise<PauseState> {
    const row = await this.prisma.setting.findUnique({ where: { key: PAUSED_KEY } });
    return (row?.value as unknown as PauseState | undefined) ?? { paused: false };
  }

  async isPaused(): Promise<boolean> {
    return (await this.pauseState()).paused;
  }

  async setPaused(paused: boolean, reason?: string): Promise<PauseState> {
    const value: PauseState = { paused, reason, at: new Date().toISOString() };
    await this.prisma.setting.upsert({
      where: { key: PAUSED_KEY },
      create: { key: PAUSED_KEY, value: value as any },
      update: { value: value as any },
    });
    return value;
  }
}

class PauseDto {
  @IsBoolean() paused: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService, private readonly audit: AuditService) {}

  @Get('pause')
  get() {
    return this.settings.pauseState();
  }

  /** Emergency kill switch: stops the scheduler from publishing anything until resumed. */
  @Post('pause')
  @Roles(Role.APPROVER)
  async set(@Body() dto: PauseDto, @CurrentUser() me: AuthUser) {
    const state = await this.settings.setPaused(dto.paused, dto.reason);
    await this.audit.log(me.id, dto.paused ? 'publishing.pause' : 'publishing.resume', 'Setting', 'publishingPaused', {
      reason: dto.reason,
    });
    return state;
  }
}

@Global()
@Module({ controllers: [SettingsController], providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
