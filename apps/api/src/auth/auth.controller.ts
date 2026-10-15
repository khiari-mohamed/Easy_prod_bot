import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { getEnv } from '../env';
import { COOKIE_NAME } from './auth.guard';
import { CurrentUser, Public } from './decorators';
import { AuthUser } from './auth.types';
import { UnauthorizedException } from '@nestjs/common';

class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(1) password: string;
}

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

@Controller('auth')
export class AuthController {
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService) {}

  @Public()
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    // Same error for unknown user / wrong password / inactive to avoid account probing.
    const ok = user && user.active && (await bcrypt.compare(dto.password, user.passwordHash));
    if (!user || !ok) throw new UnauthorizedException('Invalid credentials');

    const token = await this.jwt.signAsync({ sub: user.id, role: user.role });
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: getEnv().COOKIE_SECURE,
      maxAge: TWELVE_HOURS_MS,
      path: '/',
    });
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
