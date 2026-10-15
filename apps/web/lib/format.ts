const TZ = 'Africa/Tunis';

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-TN', {
    timeZone: TZ,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-TN', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
}

export const fmtNum = (n: number) => new Intl.NumberFormat('fr-TN').format(n);
export const fmtPct = (r: number) => `${(r * 100).toFixed(1)}%`;

/** ISO string -> value for <input type="datetime-local"> in the Tunis timezone. */
export function toInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
  return parts.replace(' ', 'T');
}

/** <input type="datetime-local"> value (Tunis wall clock, UTC+1 all year) -> ISO string. */
export function fromInputValue(value: string): string | null {
  if (!value) return null;
  return new Date(`${value}:00+01:00`).toISOString();
}

export const PLATFORM_LABEL = { FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', TIKTOK: 'TikTok' } as const;
