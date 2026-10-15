import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';

/**
 * One gate for EVERY call this app makes to Meta (Graph API).
 *
 *  - Writes (POST/DELETE: publish, comment, reply, hide) are spaced at least META_MIN_WRITE_GAP_MS apart
 *    per token (default 30 s), and capped per day.
 *  - Reads are spaced at least META_MIN_READ_GAP_MS apart (default 1.5 s) across the whole app, so a
 *    Promise.all() burst becomes a polite queue.
 *  - Meta's own usage headers (x-app-usage, x-page-usage, x-business-use-case-usage) are read after every
 *    call. Above META_USAGE_PAUSE_PCT the breaker opens and NOTHING is sent until it closes.
 *  - Rate-limit / "blocked" error codes open the breaker for longer each time (1 h, 3 h, 12 h).
 *  - A token Meta rejected (code 190) is never used again; a NEW token has a new fingerprint, so it works.
 *
 * It never retries a write. A guard refusal happens BEFORE anything leaves our side, so it is never
 * "ambiguous": callers can safely hand the post back to a human or to the schedule.
 */

export class MetaBlockedError extends Error {
  constructor(
    message: string,
    /** Rough time until a retry makes sense (0 = needs a human, e.g. a new token). */
    readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = 'MetaBlockedError';
  }
}

export type MetaCallKind = 'read' | 'write';

export interface GuardState {
  openUntil: number;
  reason: string;
  trips: number;
  lastTripAt: number;
}

interface MetaErrorBody {
  code?: number;
  error_subcode?: number;
  message?: string;
}

interface HeaderReader {
  get(name: string): string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const numEnv = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const metaConfig = () => ({
  enabled: (process.env.META_API_ENABLED ?? 'true').toLowerCase() !== 'false',
  minWriteGapMs: numEnv('META_MIN_WRITE_GAP_MS', 30_000),
  minReadGapMs: numEnv('META_MIN_READ_GAP_MS', 1_500),
  usagePausePct: numEnv('META_USAGE_PAUSE_PCT', 70),
  dailyWriteCap: numEnv('META_DAILY_WRITE_CAP', 40),
  dailyReadCap: numEnv('META_DAILY_READ_CAP', 1_500),
  maxQueueWaitMs: numEnv('META_MAX_QUEUE_WAIT_MS', 120_000),
});

/** Comment polling, first comments, AI replies and moderation only run when this is explicitly "true". */
export const commentAutomationEnabled = (): boolean => process.env.META_COMMENT_AUTOMATION === 'true';

/** Metric sync (analytics) runs in the background unless this is "false". */
export const backgroundSyncEnabled = (): boolean => (process.env.META_BACKGROUND_SYNC ?? 'true').toLowerCase() !== 'false';

/** Stable, non-reversible fingerprint of a token (never log or store the token itself). */
export function tokenScope(token: string | undefined): string {
  return token ? createHash('sha256').update(token).digest('hex').slice(0, 12) : 'none';
}

/** Meta codes that mean "slow down": app (4, 341), user (17), page (32), custom (613), BUC (80000-80014). */
export function isRateLimitCode(code?: number): boolean {
  if (code === undefined) return false;
  return [4, 17, 32, 341, 613].includes(code) || (code >= 80000 && code <= 80014);
}

/** Meta code 368: "temporarily blocked for policies violations". */
export const isBlockedCode = (code?: number): boolean => code === 368;

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const pctOf = (o: unknown): number => {
  if (!o || typeof o !== 'object') return 0;
  const r = o as Record<string, unknown>;
  return Math.max(0, ...['call_count', 'total_cputime', 'total_time'].map((k) => (typeof r[k] === 'number' ? (r[k] as number) : 0)));
};

/** Highest usage % Meta reports in its headers, and the longest "time to regain access" it asks for. */
export function parseUsage(h: HeaderReader): { pct: number; regainMs: number } {
  let pct = 0;
  let regainMs = 0;
  for (const name of ['x-app-usage', 'x-page-usage', 'x-ad-account-usage']) {
    pct = Math.max(pct, pctOf(parseJson(h.get(name))));
  }
  const buc = parseJson(h.get('x-business-use-case-usage'));
  if (buc && typeof buc === 'object') {
    for (const entries of Object.values(buc as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        pct = Math.max(pct, pctOf(e));
        const mins = (e as Record<string, unknown>)?.estimated_time_to_regain_access;
        if (typeof mins === 'number' && mins > 0) regainMs = Math.max(regainMs, mins * 60_000);
      }
    }
  }
  return { pct, regainMs };
}

export class MetaGuard {
  private readonly log = new Logger('MetaGuard');
  private openUntil = 0;
  private reason = '';
  private trips = 0;
  private lastTripAt = 0;
  private readonly lanes = new Map<string, number>();
  private readonly deadTokens = new Set<string>();
  private day = '';
  private reads = 0;
  private readonly writes = new Map<string, number>();

  /** Set by MetaGuardService to persist the breaker, so a restart cannot "forget" a pause. */
  onChange?: (state: GuardState) => void;

  isOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  state(): GuardState {
    return { openUntil: this.openUntil, reason: this.reason, trips: this.trips, lastTripAt: this.lastTripAt };
  }

  status() {
    const c = metaConfig();
    const now = Date.now();
    this.rollDay();
    return {
      enabled: c.enabled,
      open: this.isOpen(),
      reason: this.isOpen() ? this.reason : null,
      openUntil: this.isOpen() ? new Date(this.openUntil).toISOString() : null,
      retryInMinutes: this.isOpen() ? Math.ceil((this.openUntil - now) / 60_000) : 0,
      trips: this.trips,
      readsToday: this.reads,
      writesToday: Object.fromEntries(this.writes),
      limits: {
        minWriteGapMs: c.minWriteGapMs,
        minReadGapMs: c.minReadGapMs,
        dailyWriteCap: c.dailyWriteCap,
        dailyReadCap: c.dailyReadCap,
        usagePausePct: c.usagePausePct,
      },
      commentAutomation: commentAutomationEnabled(),
      backgroundSync: backgroundSyncEnabled(),
    };
  }

  restore(s: Partial<GuardState> | null | undefined) {
    if (!s) return;
    if (typeof s.openUntil === 'number' && s.openUntil > Date.now()) {
      this.openUntil = s.openUntil;
      this.reason = String(s.reason ?? 'restored after restart');
    }
    if (typeof s.trips === 'number') this.trips = s.trips;
    if (typeof s.lastTripAt === 'number') this.lastTripAt = s.lastTripAt;
  }

  /** Manual all-clear (admin), after checking the Meta dashboard. */
  reset() {
    this.openUntil = 0;
    this.reason = '';
    this.trips = 0;
    this.lanes.clear();
    this.onChange?.(this.state());
  }

  private rollDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.reads = 0;
      this.writes.clear();
    }
  }

  private assertClosed() {
    if (!this.isOpen()) return;
    const ms = this.openUntil - Date.now();
    throw new MetaBlockedError(
      `Meta calls are paused for ${Math.ceil(ms / 60_000)} more minute(s): ${this.reason}`,
      ms,
    );
  }

  /**
   * Ask permission to call Meta. Resolves when it is polite to send, throws MetaBlockedError when it is not.
   * The slot is reserved synchronously, so concurrent callers are served strictly in order.
   */
  async acquire(kind: MetaCallKind, token?: string): Promise<void> {
    const c = metaConfig();
    if (!c.enabled) throw new MetaBlockedError('Meta calls are disabled (META_API_ENABLED=false)', 0);

    const scope = tokenScope(token);
    if (this.deadTokens.has(scope)) {
      throw new MetaBlockedError('Meta rejected this token: reconnect the account with a new token', 0);
    }
    this.assertClosed();
    this.rollDay();

    if (kind === 'write') {
      const used = this.writes.get(scope) ?? 0;
      if (c.dailyWriteCap > 0 && used >= c.dailyWriteCap) {
        throw new MetaBlockedError(`Daily limit of ${c.dailyWriteCap} write calls reached for this account`, 6 * 3600_000);
      }
    } else if (c.dailyReadCap > 0 && this.reads >= c.dailyReadCap) {
      throw new MetaBlockedError(`Daily limit of ${c.dailyReadCap} read calls reached`, 6 * 3600_000);
    }

    const lane = kind === 'write' ? `w:${scope}` : 'r';
    const gap = kind === 'write' ? c.minWriteGapMs : c.minReadGapMs;
    const now = Date.now();
    const start = Math.max(now, this.lanes.get(lane) ?? 0);
    if (start - now > c.maxQueueWaitMs) {
      throw new MetaBlockedError('Too many Meta calls are already waiting: try again in a few minutes', start - now);
    }
    this.lanes.set(lane, start + gap);
    if (kind === 'write') this.writes.set(scope, (this.writes.get(scope) ?? 0) + 1);
    else this.reads++;

    if (start > now) await sleep(start - now);
    this.assertClosed(); // the breaker may have opened while this call was waiting its turn
  }

  /** Read Meta's answer (headers + error) after EVERY call, success or not. */
  observe(headers: HeaderReader | undefined, error: MetaErrorBody | undefined | null, token?: string) {
    const c = metaConfig();
    if (headers) {
      const u = parseUsage(headers);
      if (u.pct >= 90) this.trip(Math.max(u.regainMs, 60 * 60_000), `Meta usage at ${Math.round(u.pct)}%`);
      else if (u.pct >= c.usagePausePct) this.trip(Math.max(u.regainMs, 15 * 60_000), `Meta usage at ${Math.round(u.pct)}%`);
      else if (u.regainMs > 0) this.trip(u.regainMs, 'Meta asked us to wait');
    }
    const code = error?.code;
    if (code === 190) {
      // Invalid / expired / revoked token. Never send anything else with it.
      this.deadTokens.add(tokenScope(token));
    } else if (isBlockedCode(code)) {
      this.trip(24 * 3600_000, 'Meta temporarily blocked this activity (code 368)');
    } else if (isRateLimitCode(code)) {
      this.tripEscalating(`Meta rate limit (code ${code})`);
    }
  }

  private tripEscalating(reason: string) {
    const now = Date.now();
    this.trips = now - this.lastTripAt < 24 * 3600_000 ? this.trips + 1 : 1;
    this.lastTripAt = now;
    const hours = [1, 3, 12][Math.min(this.trips, 3) - 1];
    this.trip(hours * 3600_000, reason);
  }

  private trip(ms: number, reason: string) {
    const until = Date.now() + ms;
    if (until <= this.openUntil) return;
    this.openUntil = until;
    this.reason = reason;
    this.log.error(`Circuit open for ${Math.ceil(ms / 60_000)} min: ${reason}`);
    this.onChange?.(this.state());
  }
}

/** The one instance shared by the whole API process. */
export const metaGuard = new MetaGuard();
