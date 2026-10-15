import { join } from 'path';

export interface Env {
  PORT: number;
  DATABASE_URL: string;
  REDIS_URL: string;
  WEB_ORIGIN: string;
  APP_TIMEZONE: string;
  JWT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  COOKIE_SECURE: boolean;
  ADMIN_EMAIL: string;
  ADMIN_PASSWORD: string;
  UPLOAD_DIR: string;
  UPLOAD_TMP_DIR: string;
  PUBLIC_BASE_URL: string;
  MEDIA_URL_TTL_SECONDS: number;
  MEDIA_MAX_UPLOAD_BYTES: number;
  STORAGE_PROVIDER: 'local' | 's3';
  S3_BUCKET: string;
  S3_REGION: string;
  S3_ENDPOINT: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_FORCE_PATH_STYLE: boolean;
  S3_PUBLIC_BASE_URL: string;
  META_GRAPH_VERSION: string;
  META_APP_ID: string;
  META_APP_SECRET: string;
  TIKTOK_CLIENT_KEY: string;
  TIKTOK_CLIENT_SECRET: string;
  TIKTOK_REDIRECT_URI: string;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
}

let cached: Env | undefined;

/** Reads and validates the environment once. Call only after dotenv has loaded. */
export function getEnv(): Env {
  if (cached) return cached;
  const e = process.env;

  const missing = ['DATABASE_URL', 'JWT_SECRET', 'TOKEN_ENCRYPTION_KEY'].filter((k) => !e[k]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if (e.JWT_SECRET!.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  if (!/^[0-9a-fA-F]{64}$/.test(e.TOKEN_ENCRYPTION_KEY!)) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (openssl rand -hex 32)');
  }

  cached = {
    PORT: Number(e.PORT ?? 4000),
    DATABASE_URL: e.DATABASE_URL!,
    REDIS_URL: e.REDIS_URL ?? 'redis://localhost:6379',
    WEB_ORIGIN: e.WEB_ORIGIN ?? 'http://localhost:3000',
    APP_TIMEZONE: e.APP_TIMEZONE ?? 'Africa/Tunis',
    JWT_SECRET: e.JWT_SECRET!,
    TOKEN_ENCRYPTION_KEY: e.TOKEN_ENCRYPTION_KEY!,
    COOKIE_SECURE: e.COOKIE_SECURE === 'true',
    ADMIN_EMAIL: e.ADMIN_EMAIL ?? '',
    ADMIN_PASSWORD: e.ADMIN_PASSWORD ?? '',
    UPLOAD_DIR: e.UPLOAD_DIR ?? './uploads',
    UPLOAD_TMP_DIR: e.UPLOAD_TMP_DIR ?? join(e.UPLOAD_DIR ?? './uploads', 'tmp'),
    PUBLIC_BASE_URL: (e.PUBLIC_BASE_URL ?? 'http://localhost:4000').replace(/\/$/, ''),
    MEDIA_URL_TTL_SECONDS: Number(e.MEDIA_URL_TTL_SECONDS ?? 86_400),
    MEDIA_MAX_UPLOAD_BYTES: Number(e.MEDIA_MAX_UPLOAD_BYTES ?? 2 * 1024 * 1024 * 1024),
    STORAGE_PROVIDER: (e.STORAGE_PROVIDER ?? 'local').toLowerCase() === 's3' ? 's3' : 'local',
    S3_BUCKET: e.S3_BUCKET ?? '',
    S3_REGION: e.S3_REGION ?? 'us-east-1',
    S3_ENDPOINT: e.S3_ENDPOINT ?? '',
    S3_ACCESS_KEY_ID: e.S3_ACCESS_KEY_ID ?? '',
    S3_SECRET_ACCESS_KEY: e.S3_SECRET_ACCESS_KEY ?? '',
    S3_FORCE_PATH_STYLE: e.S3_FORCE_PATH_STYLE === 'true',
    S3_PUBLIC_BASE_URL: (e.S3_PUBLIC_BASE_URL ?? '').replace(/\/$/, ''),
    META_GRAPH_VERSION: e.META_GRAPH_VERSION ?? 'v21.0',
    META_APP_ID: e.META_APP_ID ?? '',
    META_APP_SECRET: e.META_APP_SECRET ?? '',
    TIKTOK_CLIENT_KEY: e.TIKTOK_CLIENT_KEY ?? '',
    TIKTOK_CLIENT_SECRET: e.TIKTOK_CLIENT_SECRET ?? '',
    TIKTOK_REDIRECT_URI: e.TIKTOK_REDIRECT_URI ?? '',
    ANTHROPIC_API_KEY: e.ANTHROPIC_API_KEY ?? '',
    ANTHROPIC_MODEL: e.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
    GEMINI_API_KEY: e.GEMINI_API_KEY ?? '',
    GEMINI_MODEL: e.GEMINI_MODEL ?? 'gemini-3.8-flash',
  };
  return cached;
}

export function redisOptions() {
  const u = new URL(getEnv().REDIS_URL);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null as null,
  };
}
