'use client';

import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    window.location.href = '/login';
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = Array.isArray(body.message) ? body.message.join(' • ') : body.message;
    throw new ApiError(msg ?? res.statusText, res.status);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  }).then((r) => handle<T>(r));
}

export function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  return fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', body: form }).then((r) => handle<T>(r));
}

/** Files above this size are sent in retryable parts instead of one big request. */
export const RESUMABLE_THRESHOLD = 50 * 1024 * 1024;

/**
 * Chunked upload for big files. Every part is retried (network errors / 5xx) with a growing delay,
 * so a dropped connection costs one part instead of the whole video. Client errors (4xx) are not retried.
 */
export async function uploadResumable<T>(file: File, onProgress?: (percent: number) => void): Promise<T> {
  const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(file.name);
  const init = await api<{ id: string; partSize: number }>('/assets/uploads', {
    method: 'POST',
    body: { name: file.name, mime: file.type || undefined, kind: isVideo ? 'VIDEO' : 'IMAGE', totalBytes: file.size },
  });
  try {
    const parts = Math.ceil(file.size / init.partSize);
    for (let i = 0; i < parts; i++) {
      const chunk = file.slice(i * init.partSize, Math.min(file.size, (i + 1) * init.partSize));
      let failure: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        failure = undefined;
        try {
          const res = await fetch(`/api/assets/uploads/${init.id}/parts/${i}`, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: chunk,
          });
          await handle(res);
          break;
        } catch (e) {
          failure = e;
          if (e instanceof ApiError && e.status >= 400 && e.status < 500) throw e;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
      if (failure) throw failure;
      onProgress?.(Math.round(((i + 1) / parts) * 100));
    }
    return await api<T>(`/assets/uploads/${init.id}/complete`, { method: 'POST', body: {} });
  } catch (e) {
    await api(`/assets/uploads/${init.id}`, { method: 'DELETE' }).catch(() => undefined);
    throw e;
  }
}

/** GET with loading / error state and a reload function. Pass null to skip. */
export function useFetch<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);

  const reload = useCallback(async () => {
    if (path === null) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(path !== null);
    reload();
  }, [path, reload]);

  return { data, error, loading, reload };
}
