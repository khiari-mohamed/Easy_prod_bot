import { randomBytes } from 'crypto';
import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Role } from '@prisma/client';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { encrypt } from '../common/crypto';
import { getEnv } from '../env';

const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_USER_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url';

@Controller('auth/tiktok')
export class TikTokController {
  constructor(private readonly prisma: PrismaService) {}

  /** Step 1: redirect the browser to TikTok's authorization page.
   * State is a random token stored in the DB so it is single-use and bound to the requesting user.
   */
  @Get('connect')
  @Roles(Role.ADMIN)
  async connect(@CurrentUser() user: AuthUser, @Res() res: Response) {
    const env = getEnv();
    if (!env.TIKTOK_CLIENT_KEY) throw new BadRequestException('TIKTOK_CLIENT_KEY not configured');
    const state = randomBytes(24).toString('base64url');
    await this.prisma.setting.create({
      data: { key: `tiktok:state:${state}`, value: { userId: user.id, exp: Date.now() + 600_000 } },
    });
    const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
    url.searchParams.set('client_key', env.TIKTOK_CLIENT_KEY);
    url.searchParams.set('scope', 'user.info.basic,video.upload');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', env.TIKTOK_REDIRECT_URI);
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  }

  /** Step 2: TikTok redirects here with ?code=… after the user authorizes. */
  @Roles(Role.ADMIN)
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('error') error: string,
    @Query('state') state: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const env = getEnv();
    const webOrigin = env.WEB_ORIGIN;

    if (error) {
      return res.redirect(`${webOrigin}/accounts?tiktok_error=${encodeURIComponent(error)}`);
    }
    if (!code) throw new BadRequestException('Missing code');

    // Verify state: single-use, expires in 10 min, bound to the requesting user.
    const key = `tiktok:state:${state}`;
    const row = state ? await this.prisma.setting.findUnique({ where: { key } }) : null;
    const used = row ? await this.prisma.setting.deleteMany({ where: { key } }) : { count: 0 };
    const v = row?.value as { userId?: string; exp?: number } | null;
    if (used.count !== 1 || !v || v.userId !== user.id || (v.exp ?? 0) < Date.now()) {
      return res.redirect(`${webOrigin}/accounts?tiktok_error=invalid_state`);
    }

    const tokenRes = await fetch(TIKTOK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: env.TIKTOK_CLIENT_KEY,
        client_secret: env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: env.TIKTOK_REDIRECT_URI,
      }),
    });
    const tokenJson = (await tokenRes.json()) as {
      access_token?: string; open_id?: string; expires_in?: number; scope?: string;
      error?: string; error_description?: string;
    };
    if (!tokenRes.ok || tokenJson.error || !tokenJson.access_token) {
      const msg = tokenJson.error_description ?? tokenJson.error ?? 'Token exchange failed';
      return res.redirect(`${webOrigin}/accounts?tiktok_error=${encodeURIComponent(msg)}`);
    }
    const { access_token, open_id, expires_in } = tokenJson;
    if (!open_id) return res.redirect(`${webOrigin}/accounts?tiktok_error=missing_token`);
    const granted = (tokenJson.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean);

    let displayName = open_id;
    try {
      const userRes = await fetch(TIKTOK_USER_URL, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const userJson = await userRes.json() as { data?: { user?: { display_name?: string } } };
      displayName = userJson.data?.user?.display_name ?? open_id;
    } catch { /* best-effort */ }

    const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : null;

    await this.prisma.socialAccount.upsert({
      where: { platform_externalId: { platform: 'TIKTOK', externalId: open_id } },
      create: {
        platform: 'TIKTOK',
        externalId: open_id,
        name: displayName,
        username: displayName,
        encryptedToken: encrypt(access_token),
        status: 'ACTIVE',
        canPublish: false,
        tokenExpiresAt: expiresAt,
        tokenIssuedAt: new Date(),
        lastVerifiedAt: new Date(),
        grantedScopes: granted,
      },
      update: {
        name: displayName,
        username: displayName,
        encryptedToken: encrypt(access_token),
        status: 'ACTIVE',
        canPublish: false,
        tokenExpiresAt: expiresAt,
        tokenIssuedAt: new Date(),
        lastVerifiedAt: new Date(),
        grantedScopes: granted,
      },
    });

    res.redirect(`${webOrigin}/accounts?tiktok_connected=1`);
  }

  /** TikTok webhook endpoint (required by the portal). */
  @Public()
  @Post('webhook')
  webhook(@Req() req: Request, @Res() res: Response) {
    // TikTok sends a challenge on registration — echo it back.
    const body = req.body as { challenge?: string };
    if (body?.challenge) return res.json({ challenge: body.challenge });
    // Real events: acknowledge immediately, process nothing until needed.
    return res.json({ message: 'ok' });
  }
}
