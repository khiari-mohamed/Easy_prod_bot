import { BadRequestException } from '@nestjs/common';
import { Platform } from '@prisma/client';

export interface Range {
  from?: Date;
  to?: Date;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TN_OFFSET = '+01:00'; // Tunisie : UTC+1, sans changement d'heure

/** "2026-10-03" => début/fin de journée à Tunis. Un ISO complet est accepté tel quel. */
export function parseBound(v: string | undefined, endOfDay: boolean): Date | undefined {
  if (!v) return undefined;
  const iso = DAY.test(v) ? `${v}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}${TN_OFFSET}` : v;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Date invalide : ${v}`);
  return d;
}

export function parseRange(from?: string, to?: string): Range {
  const range = { from: parseBound(from, false), to: parseBound(to, true) };
  if (range.from && range.to && range.from > range.to) {
    throw new BadRequestException('La date de début doit précéder la date de fin');
  }
  return range;
}

export function parsePlatforms(v?: string): Platform[] | undefined {
  if (!v) return undefined;
  const valid: string[] = ['FACEBOOK', 'INSTAGRAM', 'TIKTOK'];
  const list = v.split(',').map((x) => x.trim().toUpperCase()).filter((x) => valid.includes(x));
  return list.length ? (list as Platform[]) : undefined;
}

/** Période immédiatement précédente, de même durée. Seulement si les deux bornes existent. */
export function previousRange(r: Range): Range | undefined {
  if (!r.from || !r.to) return undefined;
  const len = r.to.getTime() - r.from.getTime() + 1;
  return { from: new Date(r.from.getTime() - len), to: new Date(r.from.getTime() - 1) };
}

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Tunis',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYY-MM-DD dans le fuseau de Tunis. */
export function dayKey(d: Date): string {
  return dayFmt.format(d);
}
