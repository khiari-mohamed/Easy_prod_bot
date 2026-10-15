import { getEnv } from '../env';
import { MetaBlockedError, metaGuard } from './meta-guard';

export { MetaBlockedError };

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
  }

  /** Errors that retrying cannot fix (bad token, missing permission, invalid parameter). */
  get fatal(): boolean {
    if (this.code === undefined) return false;
    // 190 invalid/expired token, 10 permission denied, 100 invalid parameter, 102 session invalid
    if ([190, 10, 100, 102].includes(this.code)) return true;
    return this.code >= 200 && this.code < 300; // 200-299 permission errors
  }
}

type Params = Record<string, string | number | boolean | undefined>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Transient Meta/network trouble: worth one more polite try, but ONLY for reads. */
function isTransient(e: MetaApiError): boolean {
  return e.httpStatus === 0 || e.httpStatus >= 500 || e.code === 1 || e.code === 2;
}

async function graphOnce<T>(
  method: 'GET' | 'POST',
  path: string,
  params: Params,
  accessToken?: string,
): Promise<T> {
  const base = `https://graph.facebook.com/${getEnv().META_GRAPH_VERSION}`;
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined) clean[k] = String(v);
  if (accessToken) clean.access_token = accessToken;

  const qs = new URLSearchParams(clean).toString();
  const url = method === 'GET' ? `${base}/${path}?${qs}` : `${base}/${path}`;

  // The gate: spacing, daily caps, circuit breaker. Throws MetaBlockedError BEFORE anything is sent.
  await metaGuard.acquire(method === 'GET' ? 'read' : 'write', accessToken);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
      body: method === 'POST' ? qs : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    // Network/timeout: transient for reads; for writes the caller treats it as "result unknown".
    throw new MetaApiError(`Network error calling Meta: ${(e as Error).message}`, 0);
  }

  const json: any = await res.json().catch(() => ({}));
  // Read Meta's usage headers and error code after EVERY call (opens the breaker when needed).
  metaGuard.observe(res.headers, json?.error, accessToken);

  if (!res.ok || json.error) {
    const err = json.error ?? {};
    throw new MetaApiError(err.message ?? `Meta API HTTP ${res.status}`, res.status, err.code, err.error_subcode);
  }
  return json as T;
}

/**
 * Graph API client. Reads get up to 3 tries with exponential backoff + jitter (2 s, 4 s) on transient errors.
 * Writes (POST) are NEVER retried here: a repeated write could publish twice.
 * Rate-limit, auth and permission errors are never retried: they open the breaker or need a human.
 */
export async function graph<T = any>(
  method: 'GET' | 'POST',
  path: string,
  params: Params,
  accessToken?: string,
): Promise<T> {
  const attempts = method === 'GET' ? 3 : 1;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(2_000 * 2 ** (i - 1) + Math.floor(Math.random() * 1_000));
    try {
      return await graphOnce<T>(method, path, params, accessToken);
    } catch (e) {
      last = e;
      if (!(e instanceof MetaApiError) || !isTransient(e)) throw e;
    }
  }
  throw last;
}
