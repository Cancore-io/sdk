import type { z } from 'zod';
import { dec, fmt } from '../decimal';
import type { gridConfig } from '../riskgate';
import type { StrategyOrder } from '../types';

export type GridConfig = z.infer<typeof gridConfig>;

/** Slots are `level:side`; every level starts with one order on the configured side. */
export const gridSlots = (c: GridConfig): string[] => Array.from({ length: c.levels }, (_, i) => `${i}:${c.side}`);

/** Evenly spaced from lowerPrice (level 0) to upperPrice (the last level). */
export function gridPrice(c: GridConfig, level: number): string {
  if (c.levels === 1) return fmt(dec(c.lowerPrice));
  const lo = dec(c.lowerPrice);
  return fmt(lo + ((dec(c.upperPrice) - lo) * BigInt(level)) / BigInt(c.levels - 1));
}

/** Classic grid: a filled buy is sold one level up, a filled sell bought back one level down; none past an edge. */
export function gridRefill(c: GridConfig, slot: string): string | undefined {
  const [level, side] = slot.split(':');
  const next = side === 'buy' ? Number(level) + 1 : Number(level) - 1;
  if (next < 0 || next >= c.levels) return undefined;
  return `${next}:${side === 'buy' ? 'sell' : 'buy'}`;
}

/** The first wanted slot with no open order, or nothing to do. */
export function gridNext(c: GridConfig, want: string[], open: string[]): StrategyOrder | undefined {
  const slot = want.find((s) => !open.includes(s));
  if (slot === undefined) return undefined;
  const [level, side] = slot.split(':') as [string, 'buy' | 'sell'];
  return { slot, side, amount: c.amountPerLevel, price: gridPrice(c, Number(level)) };
}
