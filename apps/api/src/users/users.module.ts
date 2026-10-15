import { BadRequestException, Body, Controller, Get, Module, Param, Patch, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean, IsEmail, IsEnum, IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';

class CreateUserDto {
  @IsEmail() email: string;
  @IsString() @MinLength(1) name: string;
  @IsString() @MinLength(12) password: string;
  @IsEnum(Role) role: Role;
}

class SetActiveDto {
  @IsBoolean() active: boolean;
}

const publicUser = { id: true, email: true, name: true, role: true, active: true, createdAt: true };

@Controller('users')
@Roles(Role.ADMIN)
export class UsersController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get()
  list() {
    return this.prisma.user.findMany({ select: publicUser, orderBy: { createdAt: 'asc' } });
  }

  @Post()
  async create(@Body() dto: CreateUserDto, @CurrentUser() me: AuthUser) {
    const email = dto.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new BadRequestException('Email already used');
    const user = await this.prisma.user.create({
      data: { email, name: dto.name, role: dto.role, passwordHash: await bcrypt.hash(dto.password, 12) },
      select: publicUser,
    });
    await this.audit.log(me.id, 'user.create', 'User', user.id, { email, role: dto.role });
    return user;
  }

  @Patch(':id/active')
  async setActive(@Param('id') id: string, @Body() dto: SetActiveDto, @CurrentUser() me: AuthUser) {
    if (id === me.id) throw new BadRequestException('You cannot deactivate yourself');
    const user = await this.prisma.user.update({ where: { id }, data: { active: dto.active }, select: publicUser });
    await this.audit.log(me.id, dto.active ? 'user.activate' : 'user.deactivate', 'User', id);
    return user;
  }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
