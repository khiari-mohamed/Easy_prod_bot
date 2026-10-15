import { createHmac, timingSafeEqual } from 'crypto';
import { getEnv } from '../env';

/**
 * Signed, expiring media links.
 *
 * Meta fetches media over plain HTTPS and cannot send our session cookie, so a
 * media URL it is given must be self-authenticating. We sign "assetId.exp"
 * with an HMAC keyed on JWT_SECRET and expose GET /media/access. The API is the
 * only reader, so the signature proves the link was minted by us and the
 * expiry bounds how long a leaked link stays valid.
 */

export interface MediaTokenParts {
  assetId: string;
  exp: number;
  sig: string;
}

function key(): string {
  return getEnv().JWT_SECRET;
}

function digest(assetId: string, exp: number): string {
  return createHmac('sha256', key()).update(`${assetId}.${exp}`).digest('base64url');
}

/** Mint a token valid for `ttlSeconds` (defaults to MEDIA_URL_TTL_SECONDS). */
export function signMediaToken(assetId: string, ttlSeconds?: number): MediaTokenParts {
  const ttl = ttlSeconds ?? getEnv().MEDIA_URL_TTL_SECONDS;
  const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(ttl));
  return { assetId, exp, sig: digest(assetId, exp) };
}

/** Full absolute URL Meta (or a browser) can fetch. */
export function signedMediaUrl(assetId: string, ttlSeconds?: number): string {
  const t = signMediaToken(assetId, ttlSeconds);
  const qs = new URLSearchParams({ assetId: t.assetId, exp: String(t.exp), sig: t.sig });
  return `${getEnv().PUBLIC_BASE_URL}/media/access?${qs.toString()}`;
}

/** Constant-time verification. Returns the assetId when valid, else null. */
export function verifyMediaToken(assetId: string, exp: string | number, sig: string): string | null {
  const expNum = typeof exp === 'number' ? exp : Number(exp);
  if (!assetId || !sig || !Number.isFinite(expNum)) return null;
  if (expNum * 1000 < Date.now()) return null;

  const expected = Buffer.from(digest(assetId, expNum));
  const provided = Buffer.from(sig);
  if (expected.length !== provided.length) return null;
  return timingSafeEqual(expected, provided) ? assetId : null;
}
