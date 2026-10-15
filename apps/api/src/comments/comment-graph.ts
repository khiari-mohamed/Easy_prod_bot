// Adjust the env var name if your .env uses another one.
const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION ?? 'v26.0'}`;

export type CommentPlatform = 'FACEBOOK' | 'INSTAGRAM';

export class GraphError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
  }
}

/** The write left our side and its outcome is unknown (timeout, network error, 5xx). Never retry blindly. */
export class AmbiguousError extends Error {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(method: 'GET' | 'POST' | 'DELETE', path: string, token: string, params: Record<string, string> = {}): Promise<Json> {
  const url = new URL(`${GRAPH}/${path}`);
  const init: RequestInit = { method, signal: AbortSignal.timeout(20_000) };
  if (method === 'POST') {
    init.body = new URLSearchParams({ ...params, access_token: token }); // token in the body, not the URL
  } else {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', token);
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (method === 'GET') throw e;
    throw new AmbiguousError(`Réponse inconnue (${(e as Error).message})`);
  }
  const json = await res.json().catch(() => null) as { error?: { message?: string; code?: number } } | null;
  if (!res.ok) {
    const msg = json?.error?.message ?? `HTTP ${res.status}`;
    if (method !== 'GET' && res.status >= 500) throw new AmbiguousError(msg);
    throw new GraphError(msg, res.status, json?.error?.code);
  }
  return json ?? {};
}

export interface RemoteComment {
  id: string;
  text: string;
  author: string | null;
  createdAt: Date;
  hidden: boolean;
  own: boolean; // written by our own account
  repliedByUs: boolean;
}

/** Top-level comments of one of our own posts, newest first. */
export async function listComments(
  platform: CommentPlatform,
  mediaId: string,
  token: string,
  own: { id: string; username: string | null },
  limit = 50,
): Promise<RemoteComment[]> {
  const me = own.username?.toLowerCase() ?? null;
  if (platform === 'INSTAGRAM') {
    const j = await call('GET', `${mediaId}/comments`, token, {
      fields: 'id,text,username,timestamp,hidden,replies{username}',
      limit: String(limit),
    });
    return (j.data ?? []).map((c: Json) => ({
      id: c.id,
      text: c.text ?? '',
      author: c.username ?? null,
      createdAt: new Date(c.timestamp),
      hidden: !!c.hidden,
      own: !!me && String(c.username ?? '').toLowerCase() === me,
      repliedByUs: !!me && (c.replies?.data ?? []).some((r: Json) => String(r.username ?? '').toLowerCase() === me),
    }));
  }
  const j = await call('GET', `${mediaId}/comments`, token, {
    fields: 'id,message,from{id,name},created_time,is_hidden,comments.limit(10){from{id}}',
    filter: 'toplevel',
    order: 'reverse_chronological',
    limit: String(limit),
  });
  return (j.data ?? []).map((c: Json) => ({
    id: c.id,
    text: c.message ?? '',
    author: c.from?.name ?? null,
    createdAt: new Date(c.created_time),
    hidden: !!c.is_hidden,
    own: c.from?.id === own.id,
    repliedByUs: (c.comments?.data ?? []).some((r: Json) => r.from?.id === own.id),
  }));
}

/** New top-level comment on one of our posts. */
export async function postComment(platform: CommentPlatform, mediaId: string, message: string, token: string): Promise<string | null> {
  const j = await call('POST', `${mediaId}/comments`, token, { message });
  return j.id ?? null;
}

export async function replyToComment(platform: CommentPlatform, commentId: string, message: string, token: string): Promise<string | null> {
  const j = await call('POST', platform === 'INSTAGRAM' ? `${commentId}/replies` : `${commentId}/comments`, token, { message });
  return j.id ?? null;
}

export async function hideComment(platform: CommentPlatform, commentId: string, token: string): Promise<void> {
  await call('POST', commentId, token, platform === 'INSTAGRAM' ? { hide: 'true' } : { is_hidden: 'true' });
}

export async function deleteComment(_platform: CommentPlatform, commentId: string, token: string): Promise<void> {
  await call('DELETE', commentId, token);
}