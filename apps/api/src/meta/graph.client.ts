import { getEnv } from '../env';

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

/** Minimal Graph API client using Node's global fetch. */
export async function graph<T = any>(
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

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
      body: method === 'POST' ? qs : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    // Network/timeout: transient, let the queue retry.
    throw new MetaApiError(`Network error calling Meta: ${(e as Error).message}`, 0);
  }

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const err = json.error ?? {};
    throw new MetaApiError(err.message ?? `Meta API HTTP ${res.status}`, res.status, err.code, err.error_subcode);
  }
  return json as T;
}
