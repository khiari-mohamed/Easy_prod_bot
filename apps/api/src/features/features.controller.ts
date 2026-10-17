import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Global,
  Module,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { FeatureMode, Platform, Role, SettingScope } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { FeaturePolicyService, PolicyChangeError } from './feature-policy.service';
import { isFeatureKey } from './feature-registry';

class SetFeatureDto {
  @IsEnum(SettingScope) scope: SettingScope;
  @IsOptional() @IsString() @MaxLength(100) scopeId?: string;
  @IsEnum(FeatureMode) mode: FeatureMode;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

class EmergencyDto {
  @IsBoolean() active: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

class EvaluateQuery {
  @IsOptional() @IsString() campaignId?: string;
  @IsOptional() @IsString() accountId?: string;
  @IsOptional() @IsEnum(Platform) platform?: Platform;
}

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof PolicyChangeError) throw new ConflictException(e.message);
    throw e;
  });
}

@Controller('administration')
export class FeaturesController {
  constructor(
    private readonly policy: FeaturePolicyService,
    private readonly prisma: PrismaService,
  ) {}

  /** Effective on/off state for the web app (hide or disable buttons). Any signed-in user. */
  @Get('effective')
  async effective(@Query() q: EvaluateQuery) {
    const all = await this.policy.effectiveAll(q);
    return Object.fromEntries(all.map((e) => [e.feature, { mode: e.mode, restrictions: e.restrictions }]));
  }

  /** Full control-room view: every feature, its effective mode, restrictions and overrides. */
  @Get('overview')
  @Roles(Role.APPROVER)
  async overview() {
    const [base, campaigns, accounts] = await Promise.all([
      this.policy.overview(),
      this.prisma.campaign.findMany({
        select: { id: true, titleLatin: true, autoPublishEnabled: true, publishingPaused: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.socialAccount.findMany({
        select: { id: true, platform: true, name: true, status: true },
        orderBy: [{ platform: 'asc' }, { name: 'asc' }],
      }),
    ]);
    return { ...base, campaigns, accounts };
  }

  @Put('features/:key')
  @Roles(Role.ADMIN)
  set(@Param('key') key: string, @Body() dto: SetFeatureDto, @CurrentUser() me: AuthUser) {
    if (!isFeatureKey(key)) throw new BadRequestException('Fonctionnalité inconnue');
    return wrap(
      this.policy.setMode({ featureKey: key, scope: dto.scope, scopeId: dto.scopeId ?? '', mode: dto.mode }, me.id, dto.reason),
    );
  }

  /** Remove a campaign / platform / account override (it inherits the global setting again). */
  @Delete('features/:key')
  @Roles(Role.ADMIN)
  clear(
    @Param('key') key: string,
    @Query('scope') scope: SettingScope,
    @Query('scopeId') scopeId: string,
    @CurrentUser() me: AuthUser,
  ) {
    if (!isFeatureKey(key)) throw new BadRequestException('Fonctionnalité inconnue');
    if (!Object.values(SettingScope).includes(scope)) throw new BadRequestException('Portée invalide');
    return wrap(this.policy.clearOverride(key, scope, scopeId ?? '', me.id));
  }

  @Get('history')
  @Roles(Role.ADMIN)
  history(@Query('feature') feature?: string, @Query('limit') limit?: string) {
    return this.policy.history(feature, limit ? Number(limit) : 100);
  }

  /**
   * Emergency stop. Any approver can STOP automation immediately; only an admin can RESUME it,
   * so a stop cannot be silently undone by the person who is least informed.
   */
  @Post('emergency-stop')
  @Roles(Role.APPROVER)
  async emergency(@Body() dto: EmergencyDto, @CurrentUser() me: AuthUser) {
    if (!dto.active && me.role !== Role.ADMIN) {
      throw new ForbiddenException('Seul un administrateur peut lever l’arrêt d’urgence.');
    }
    return this.policy.setEmergency(dto.active, me.id, dto.reason);
  }
}

@Global()
@Module({
  controllers: [FeaturesController],
  providers: [FeaturePolicyService],
  exports: [FeaturePolicyService],
})
export class FeaturesModule {}