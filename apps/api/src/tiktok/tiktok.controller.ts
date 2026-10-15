import { createHmac, timingSafeEqual } from 'crypto';
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
import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { encrypt } from '../common/crypto';
import { getEnv } from '../env';

const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_USER_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url';

@Controller('auth/tiktok')
export class TikTokController {
  constructor(private readonly prisma: PrismaService) {}

  /** Step 1: redirect the browser to TikTok's authorization page.
   * State is a signed HMAC of a timestamp so we can verify it without a cookie
   * (Next.js rewrites strip Set-Cookie from proxied responses).
   */
  @Get('connect')
  connect(@Res() res: Response) {
    const env = getEnv();
    if (!env.TIKTOK_CLIENT_KEY) throw new BadRequestException('TIKTOK_CLIENT_KEY not configured');
    const ts = Date.now().toString();
    const sig = createHmac('sha256', env.JWT_SECRET).update(ts).digest('hex').slice(0, 16);
    const state = `${ts}.${sig}`;
    const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
    url.searchParams.set('client_key', env.TIKTOK_CLIENT_KEY);
    url.searchParams.set('scope', 'user.info.basic,video.upload');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', env.TIKTOK_REDIRECT_URI);
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  }

  /** Step 2: TikTok redirects here with ?code=… after the user authorizes. */
  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('error') error: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const env = getEnv();
    const webOrigin = env.WEB_ORIGIN;

    if (error) {
      return res.redirect(`${webOrigin}/accounts?tiktok_error=${encodeURIComponent(error)}`);
    }
    if (!code) throw new BadRequestException('Missing code');
    // Verify the HMAC-signed timestamp state (max 10 min old).
    if (!this.verifyState(state, env.JWT_SECRET)) {
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
    const tokenJson = await tokenRes.json() as {
      data?: { access_token?: string; open_id?: string; expires_in?: number };
      error?: { code?: string; message?: string };
    };

    if (!tokenRes.ok || tokenJson.error?.code !== 'ok') {
      const msg = tokenJson.error?.message ?? 'Token exchange failed';
      return res.redirect(`${webOrigin}/accounts?tiktok_error=${encodeURIComponent(msg)}`);
    }

    const { access_token, open_id, expires_in } = tokenJson.data!;
    if (!access_token || !open_id) {
      return res.redirect(`${webOrigin}/accounts?tiktok_error=missing_token`);
    }

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
        canPublish: true,
        tokenExpiresAt: expiresAt,
        tokenIssuedAt: new Date(),
        lastVerifiedAt: new Date(),
        grantedScopes: ['user.info.basic', 'video.upload'],
      },
      update: {
        name: displayName,
        username: displayName,
        encryptedToken: encrypt(access_token),
        status: 'ACTIVE',
        canPublish: true,
        tokenExpiresAt: expiresAt,
        tokenIssuedAt: new Date(),
        lastVerifiedAt: new Date(),
        grantedScopes: ['user.info.basic', 'video.upload'],
      },
    });

    res.redirect(`${webOrigin}/accounts?tiktok_connected=1`);
  }

  private verifyState(state: string, secret: string): boolean {
    const parts = state?.split('.');
    if (parts?.length !== 2) return false;
    const [ts, sig] = parts;
    const age = Date.now() - Number(ts);
    if (Number.isNaN(age) || age < 0 || age > 600_000) return false;
    const expected = createHmac('sha256', secret).update(ts).digest('hex').slice(0, 16);
    try {
      return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
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
