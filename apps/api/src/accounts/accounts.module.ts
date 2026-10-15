import { Body, Controller, Delete, Get, Global, Module, Param, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { Roles, CurrentUser } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../common/audit.service';
import { AccountsService } from './accounts.service';

class ConnectMetaDto {
  @IsString() @MinLength(20) accessToken: string;

  /** Required when the token reaches several Pages: the one Page to connect. */
  @IsOptional() @IsString() @Matches(/^\d{5,30}$/, { message: 'pageId must be the numeric Page ID' }) pageId?: string;
}

@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService, private readonly audit: AuditService) {}

  @Get()
  list() {
    return this.accounts.list();
  }

  @Post('meta/connect')
  @Roles(Role.ADMIN)
  async connectMeta(@Body() dto: ConnectMetaDto, @CurrentUser() me: AuthUser) {
    const connected = await this.accounts.connectMeta(dto.accessToken, dto.pageId);
    await this.audit.log(me.id, 'account.connect', 'SocialAccount', undefined, { count: connected.length, pageId: dto.pageId ?? null });
    return connected;
  }

  @Post(':id/verify')
  @Roles(Role.ADMIN, Role.APPROVER)
  async verify(@Param('id') id: string, @CurrentUser() me: AuthUser) {
    const res = await this.accounts.verify(id);
    await this.audit.log(me.id, 'account.verify', 'SocialAccount', id, { ok: res.ok, canPublish: res.canPublish });
    return res;
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  async disconnect(@Param('id') id: string, @CurrentUser() me: AuthUser) {
    const res = await this.accounts.disconnect(id);
    await this.audit.log(me.id, 'account.disconnect', 'SocialAccount', id);
    return res;
  }
}

@Global()
@Module({ controllers: [AccountsController], providers: [AccountsService], exports: [AccountsService] })
export class AccountsModule {}