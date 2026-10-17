import { Platform } from '@prisma/client';

export interface TrendCandidate {
  platform: Platform;
  tag: string;
  source: string;
  region: string;
  /** 0..1 */
  score: number;
  ttlHours: number;
  sourceNote: string;
}

export interface TrendProvider {
  readonly name: string;
  collect(): Promise<TrendCandidate[]>;
}