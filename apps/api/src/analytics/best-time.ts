import { localParts, WEEKDAY_NAMES } from '../common/time';

export interface PostPoint {
  publishedAt: Date;
  rate: number; // engagement rate, 0..1+
}

export interface Slot {
  label: string;
  n: number;
  score: number; // shrunk mean engagement rate
  reliable: boolean; // enough posts in this slot to be ranked ahead of thin ones
}

export interface BestTime {
  provisional: boolean;
  sampleSize: number;
  hourBlocks: Slot[];
  weekdays: Slot[];
  suggestion: string;
}

export const MIN_SAMPLE = 8;
const SHRINK_K = 2; // pseudo-observations pulling small groups toward the overall mean
const MIN_SLOT_N = 2; // a slot with a single post can never be ranked as 'best'

const BLOCKS: Array<[number, number, string]> = [
  [0, 6, '00h-06h'],
  [6, 10, '06h-10h'],
  [10, 14, '10h-14h'],
  [14, 18, '14h-18h'],
  [18, 21, '18h-21h'],
  [21, 24, '21h-00h'],
];

/** Generic evening/lunch heuristics, used only until there is enough data. NOT derived from this account. */
const PROVISIONAL: Record<string, string> = {
  INSTAGRAM: 'Provisional (generic, not from your data): try 18h-21h and 10h-14h, then compare.',
  FACEBOOK: 'Provisional (generic, not from your data): try 18h-21h and 10h-14h, then compare.',
  TIKTOK: 'Provisional (generic, not from your data): try 18h-21h and 21h-00h, then compare.',
};

function shrink(groups: Map<string, number[]>, mean: number): Slot[] {
  return [...groups.entries()]
    .map(([label, rates]) => {
      const sum = rates.reduce((a, b) => a + b, 0);
      return {
        label,
        n: rates.length,
        score: (sum + SHRINK_K * mean) / (rates.length + SHRINK_K),
        reliable: rates.length >= MIN_SLOT_N,
      };
    })
    .sort((a, b) => Number(b.reliable) - Number(a.reliable) || b.score - a.score);
}

export function computeBestTime(platform: string, points: PostPoint[], timeZone?: string): BestTime {
  if (points.length < MIN_SAMPLE) {
    return {
      provisional: true,
      sampleSize: points.length,
      hourBlocks: [],
      weekdays: [],
      suggestion: `${PROVISIONAL[platform] ?? PROVISIONAL.INSTAGRAM} (${points.length}/${MIN_SAMPLE} posts with metrics so far)`,
    };
  }

  const mean = points.reduce((a, p) => a + p.rate, 0) / points.length;
  const byBlock = new Map<string, number[]>();
  const byDay = new Map<string, number[]>();

  for (const p of points) {
    const { weekday, hour } = localParts(p.publishedAt, timeZone);
    const block = BLOCKS.find(([from, to]) => hour >= from && hour < to)![2];
    byBlock.set(block, [...(byBlock.get(block) ?? []), p.rate]);
    const day = WEEKDAY_NAMES[weekday];
    byDay.set(day, [...(byDay.get(day) ?? []), p.rate]);
  }

  const hourBlocks = shrink(byBlock, mean);
  const weekdays = shrink(byDay, mean);
  const lowConfidence = points.length < 20;
  return {
    provisional: false,
    sampleSize: points.length,
    hourBlocks,
    weekdays,
    suggestion:
      `Best so far: ${hourBlocks[0].label} (${hourBlocks[0].n} posts)` +
      (weekdays[0] ? `, strongest day ${weekdays[0].label} (${weekdays[0].n} posts)` : '') +
      (lowConfidence ? '. Small sample: treat as a hint, not a rule.' : '.'),
  };
}
