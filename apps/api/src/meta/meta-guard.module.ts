import { Controller, Get, Global, Injectable, Logger, Module, OnModuleInit, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { GuardState, metaGuard } from './meta-guard';

const KEY = 'meta.guard';

/** Keeps the circuit breaker in the database: restarting the API must not "forget" a Meta pause. */
@Injectable()
export class MetaGuardService implements OnModuleInit {
  private readonly log = new Logger(MetaGuardService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: KEY } });
      metaGuard.restore(row?.value as unknown as Partial<GuardState> | undefined);
    } catch (e) {
      this.log.warn(`Could not restore the Meta guard state: ${(e as Error).message}`);
    }
    metaGuard.onChange = (state) => {
      const value = state as any;
      this.prisma.setting
        .upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } })
        .catch((e) => this.log.warn(`Could not save the Meta guard state: ${(e as Error).message}`));
    };
  }
}

@Controller('meta-guard')
export class MetaGuardController {
  constructor(private readonly audit: AuditService) {}

  /** Is Meta currently paused, why, until when, and how much of today's budget is used. */
  @Get()
  status() {
    return metaGuard.status();
  }

  /** Admin all-clear. Only use it after checking the Meta app dashboard (Alerts / App Rate Limit). */
  @Post('reset')
  @Roles(Role.ADMIN)
  async reset(@CurrentUser() me: AuthUser) {
    metaGuard.reset();
    await this.audit.log(me.id, 'meta.guard.reset', 'Setting', KEY);
    return metaGuard.status();
  }
}

@Global()
@Module({ controllers: [MetaGuardController], providers: [MetaGuardService] })
export class MetaGuardModule {}
