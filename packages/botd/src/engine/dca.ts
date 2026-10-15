import type { z } from 'zod';
import type { dcaConfig } from '../riskgate';
import type { StrategyOrder } from '../types';

export type DcaConfig = z.infer<typeof dcaConfig>;

/**
 * The next order once `intervalSeconds` passed since the last one, at the reference price (the gate holds it
 * within maxPriceDeviationBps). The slot is the order's seq, so a resumed strategy never places one twice.
 */
export function dcaNext(c: DcaConfig, placed: number[], now: number, ref: string): StrategyOrder | undefined {
  if (placed.length >= c.maxOrders) return undefined;
  const last = placed.at(-1);
  if (last !== undefined && now < last + c.intervalSeconds * 1000) return undefined;
  return { slot: String(placed.length), side: c.side, amount: c.amountPerOrder, price: ref };
}
