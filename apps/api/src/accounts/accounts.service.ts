import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Platform, SocialAccount } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt, encrypt } from '../common/crypto';
import { getEnv } from '../env';
import { graph, MetaApiError } from '../meta/graph.client';
import { capabilitiesFromScopes, expiryFromDebug, MetaPlatform } from './capabilities';

interface PageRow {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
}

/** What we learned about a token by asking Meta (not by guessing). */
interface Inspection {
  scopes: string[];
  canPublish: boolean | null; // null = could not be verified
  canReadInsights: boolean | null;
  tokenExpiresAt: Date | null;
  error: string | null;
}

/** Never return the encrypted token to API clients. */
export function toPublic(a: SocialAccount) {
  const { encryptedToken: _t, ...rest } = a;
  return rest;
}

const usable = (a: SocialAccount) =>
  a.status === 'ACTIVE' &&
  a.canPublish !== false &&
  (!a.tokenExpiresAt || a.tokenExpiresAt.getTime() > Date.now());

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.socialAccount.findMany({ orderBy: [{ platform: 'asc' }, { name: 'asc' }] });
    return rows.map(toPublic);
  }

  /** First usable account of a platform (ACTIVE, not known to lack publish permission, token not expired). */
  async activeFor(platform: Platform): Promise<SocialAccount | null> {
    const rows = await this.prisma.socialAccount.findMany({
      where: { platform, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.find(usable) ?? null;
  }

  /**
   * The account to publish to when a post has none assigned: only when there is EXACTLY ONE usable
   * account on that platform. With several we refuse (null) so a human picks the destination.
   */
  async soleActiveFor(platform: Platform): Promise<SocialAccount | null> {
    const rows = await this.prisma.socialAccount.findMany({ where: { platform, status: 'ACTIVE' } });
    const ok = rows.filter(usable);
    return ok.length === 1 ? ok[0] : null;
  }

  token(account: SocialAccount): string {
    return decrypt(account.encryptedToken);
  }

  /**
   * Ask Meta what this token is allowed to do. Needs META_APP_ID + META_APP_SECRET (debug_token);
   * without them only reachability can be checked and publish capability stays "unknown" (null).
   */
  private async inspect(platform: MetaPlatform, externalId: string, token: string): Promise<Inspection> {
    const env = getEnv();
    // 1. The object itself must be reachable with this token.
    try {
      await graph('GET', externalId, { fields: 'id' }, token);
    } catch (e) {
      return { scopes: [], canPublish: false, canReadInsights: false, tokenExpiresAt: null, error: (e as Error).message };
    }
    // 2. Granted permissions (and the real expiry) come from debug_token.
    if (!env.META_APP_ID || !env.META_APP_SECRET) {
      return {
        scopes: [],
        canPublish: null,
        canReadInsights: null,
        tokenExpiresAt: null,
        error: 'Permissions cannot be verified: META_APP_ID / META_APP_SECRET are not set',
      };
    }
    try {
      const r = await graph<{ data: { is_valid?: boolean; scopes?: string[]; expires_at?: number } }>(
        'GET',
        'debug_token',
        { input_token: token },
        `${env.META_APP_ID}|${env.META_APP_SECRET}`,
      );
      if (r.data?.is_valid === false) {
        return { scopes: [], canPublish: false, canReadInsights: false, tokenExpiresAt: null, error: 'Meta says this token is no longer valid' };
      }
      const scopes = r.data?.scopes ?? [];
      const c = capabilitiesFromScopes(platform, scopes);
      return {
        scopes,
        canPublish: c.canPublish,
        canReadInsights: c.canReadInsights,
        tokenExpiresAt: expiryFromDebug(r.data?.expires_at),
        error: c.missing.length ? `Missing permissions: ${c.missing.join(', ')}` : null,
      };
    } catch (e) {
      return { scopes: [], canPublish: null, canReadInsights: null, tokenExpiresAt: null, error: `Could not read the token's permissions: ${(e as Error).message}` };
    }
  }

  /**
   * Connect Facebook Pages (and their linked Instagram professional accounts) from a Meta user
   * access token. If the token reaches SEVERAL Pages, `pageId` is required: we never connect (and
   * later publish to) a Page the client did not choose.
   */
  async connectMeta(userToken: string, pageId?: string) {
    const env = getEnv();
    let token = userToken.trim();

    if (env.META_APP_ID && env.META_APP_SECRET) {
      try {
        const ex = await graph<{ access_token: string }>('GET', 'oauth/access_token', {
          grant_type: 'fb_exchange_token',
          client_id: env.META_APP_ID,
          client_secret: env.META_APP_SECRET,
          fb_exchange_token: token,
        });
        token = ex.access_token;
      } catch (e) {
        throw new BadRequestException(`Could not extend the token: ${(e as Error).message}`);
      }
    }

    let pages: PageRow[];
    try {
      const res = await graph<{ data: PageRow[] }>(
        'GET',
        'me/accounts',
        { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 100 },
        token,
      );
      pages = res.data;
    } catch (e) {
      const msg = e instanceof MetaApiError ? e.message : (e as Error).message;
      throw new BadRequestException(`Meta rejected the token: ${msg}`);
    }
    if (!pages.length) {
      throw new BadRequestException(
        'The token has no Pages. The Page admin must grant this app access to the Page (pages_show_list).',
      );
    }

    if (pageId) {
      pages = pages.filter((p) => p.id === pageId);
      if (!pages.length) throw new BadRequestException(`Page ${pageId} is not reachable with this token`);
    } else if (pages.length > 1) {
      throw new BadRequestException(
        `This token reaches ${pages.length} Pages. Enter the Page ID to connect: ` +
          pages.map((p) => `${p.name} (${p.id})`).join(', '),
      );
    }

    const warnExtend = env.META_APP_ID && env.META_APP_SECRET ? null : 'Token not extended (META_APP_SECRET missing): it may expire within hours';
    const connected: unknown[] = [];
    for (const p of pages) {
      const fb = await this.upsert('FACEBOOK', p.id, p.name, undefined, p.access_token, warnExtend);
      connected.push(toPublic(fb));
      if (p.instagram_business_account) {
        const ig = await this.upsert(
          'INSTAGRAM',
          p.instagram_business_account.id,
          p.instagram_business_account.username ?? p.name,
          p.instagram_business_account.username,
          p.access_token,
          warnExtend,
        );
        connected.push(toPublic(ig));
      }
    }
    return connected;
  }

  private async upsert(
    platform: MetaPlatform,
    externalId: string,
    name: string,
    username: string | undefined,
    token: string,
    extraNote: string | null,
  ) {
    const i = await this.inspect(platform, externalId, token);
    const meta = {
      grantedScopes: i.scopes,
      canPublish: i.canPublish,
      canReadInsights: i.canReadInsights,
      tokenExpiresAt: i.tokenExpiresAt,
      tokenIssuedAt: new Date(),
      lastVerifiedAt: new Date(),
      lastError: i.error ?? extraNote,
    };
    return this.prisma.socialAccount.upsert({
      where: { platform_externalId: { platform, externalId } },
      create: { platform, externalId, name, username, encryptedToken: encrypt(token), status: 'ACTIVE', ...meta },
      update: { name, username, encryptedToken: encrypt(token), status: 'ACTIVE', ...meta },
    });
  }

  /**
   * Re-check the stored token: reachable AND allowed to publish/read insights.
   * Only a rejected token (Meta code 190) marks the account EXPIRED; a network error or Meta outage
   * must NOT disable a healthy account.
   */
  async verify(id: string) {
    const account = await this.prisma.socialAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException();
    if (account.status === 'DISCONNECTED') {
      throw new BadRequestException('This account is disconnected: reconnect it with a new token');
    }
    const token = this.token(account);

    try {
      await graph('GET', account.externalId, { fields: 'id' }, token);
    } catch (e) {
      const rejected = e instanceof MetaApiError && (e.code === 190 || e.code === 102);
      const updated = await this.prisma.socialAccount.update({
        where: { id },
        data: {
          ...(rejected ? { status: 'EXPIRED' as const, canPublish: false, canReadInsights: false } : {}),
          lastVerifiedAt: new Date(),
          lastError: (e as Error).message,
        },
      });
      return { ...toPublic(updated), ok: false, error: (e as Error).message, transient: !rejected };
    }

    const i = await this.inspect(account.platform as MetaPlatform, account.externalId, token);
    const updated = await this.prisma.socialAccount.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        grantedScopes: i.scopes,
        canPublish: i.canPublish,
        canReadInsights: i.canReadInsights,
        tokenExpiresAt: i.tokenExpiresAt,
        lastVerifiedAt: new Date(),
        lastError: i.error,
      },
    });
    // ok = it can really publish (unknown counts as not proven).
    return { ...toPublic(updated), ok: i.canPublish === true, error: i.error };
  }

  async disconnect(id: string) {
    const account = await this.prisma.socialAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException();
    const updated = await this.prisma.socialAccount.update({
      where: { id },
      data: {
        status: 'DISCONNECTED',
        encryptedToken: encrypt('revoked'),
        canPublish: false,
        canReadInsights: false,
        grantedScopes: [],
        lastError: 'Disconnected by an admin',
      },
    });
    return toPublic(updated);
  }
}