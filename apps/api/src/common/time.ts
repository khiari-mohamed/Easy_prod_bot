import { getEnv } from '../env';

export interface LocalParts {
  weekday: number; // 0 = Sunday
  hour: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Weekday and hour of a date in the campaign timezone (default Africa/Tunis). */
export function localParts(date: Date, timeZone = getEnv().APP_TIMEZONE): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const weekday = WEEKDAYS[parts.find((p) => p.type === 'weekday')!.value];
  const hour = Number(parts.find((p) => p.type === 'hour')!.value);
  return { weekday, hour };
}

export const WEEKDAY_NAMES = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
