import { z } from 'zod';
import { RISK_CLASS, type DenyReason, type Params } from './protocol/index';
import { dec, SCALE } from './decimal';
import type { BotState, Command, Decision, Limits, RiskGate } from './types';

/**
 * Default-deny risk gate. All money math is exact 1e-10 fixed point.
 *
 * Daily volume uses the rolling 24h window in `state.dailyVolume`, which the daemon
 * maintains; the gate only adds the new command to it. Volume, order size and
 * position are capped per base instrument; notional per quote instrument.
 */

const ALLOW: Decision = { allow: true };
const deny = (reason: DenyReason): Decision => ({ allow: false, reason });

/** One order the gate is asked about, whatever command produced it. */
interface Leg {
  base: string;
  quote: string;
  side: 'buy' | 'sell';
  /** 1e-10 units. */
  amount: bigint;
  price: bigint;
}

const abs = (v: bigint) => (v < 0n ? -v : v);
const capOf = (m: Record<string, string>, k: string) => (Object.hasOwn(m, k) ? dec(m[k]!) : undefined);

/** Checks a batch of orders placed now, together, against every trade limit. */
function checkLegs(legs: Leg[], state: BotState, limits: Limits, now: number): Decision {
  if (state.locked) return deny('locked');
  if (state.paused) return deny('paused');
  if (state.recentCommands.filter((t) => t > now - 60_000 && t <= now).length >= limits.maxCommandsPerMinute)
    return deny('rate_limited');
  if (legs.length === 0) return deny('no_rule');
  const { base, quote } = legs[0]!;
  const pair = `${base}/${quote}`;
  if (!limits.allowedPairs.includes(pair)) return deny('instrument_not_allowed');

  const ref = Object.hasOwn(state.referencePrices, pair) ? dec(state.referencePrices[pair]!) : 0n;
  if (ref <= 0n) return deny('price_deviation_exceeded');
  const maxAmount = capOf(limits.maxOrderAmount, base);
  const maxNotional = capOf(limits.maxOrderNotional, quote);
  const maxDaily = capOf(limits.maxDailyVolume, base);
  const maxPos = capOf(limits.maxPosition, base);

  let total = 0n;
  let delta = 0n;
  for (const leg of legs) {
    if (leg.amount <= 0n || leg.price <= 0n) return deny('no_rule');
    // |price - ref| / ref <= bps / 10000
    if (abs(leg.price - ref) * 10_000n > BigInt(limits.maxPriceDeviationBps) * ref) return deny('price_deviation_exceeded');
    if (maxAmount === undefined || leg.amount > maxAmount) return deny('order_size_exceeded');
    // amount * price carries 20 decimals; the cap is lifted to the same scale.
    if (maxNotional === undefined || leg.amount * leg.price > maxNotional * SCALE) return deny('notional_exceeded');
    total += leg.amount;
    delta += leg.side === 'buy' ? leg.amount : -leg.amount;
  }

  // Worst case: every open order on this base fills too, inside the same 24h window.
  let daily = Object.hasOwn(state.dailyVolume, base) ? dec(state.dailyVolume[base]!) : 0n;
  let pos = Object.hasOwn(state.positions, base) ? dec(state.positions[base]!) : 0n;
  for (const o of state.openOrders) {
    if (o.pair.split('/')[0] !== base) continue;
    daily += dec(o.amount);
    pos += o.side === 'buy' ? dec(o.amount) : -dec(o.amount);
  }
  if (maxDaily === undefined || daily + total > maxDaily) return deny('daily_volume_exceeded');
  if (maxPos === undefined || abs(pos + delta) > maxPos) return deny('position_exceeded');

  if (state.openOrders.length + legs.length > limits.maxOpenOrders) return deny('open_orders_exceeded');
  return ALLOW;
}

const amt = z.string().regex(/^\d{1,20}(\.\d{1,10})?$/);

/** Grid: `levels` orders of `amountPerLevel`, evenly spaced from lowerPrice to upperPrice. */
export const gridConfig = z
  .object({
    side: z.enum(['buy', 'sell']),
    levels: z.number().int().min(1).max(100),
    amountPerLevel: amt,
    lowerPrice: amt,
    upperPrice: amt,
  })
  .strict();

/** DCA: one order of `amountPerOrder` every `intervalSeconds`, at most `maxOrders` in total. */
export const dcaConfig = z
  .object({
    side: z.enum(['buy', 'sell']),
    amountPerOrder: amt,
    intervalSeconds: z.number().int().min(60).max(30 * 86_400),
    maxOrders: z.number().int().min(1).max(10_000),
  })
  .strict();

/** The orders a strategy could place within 24h at its worst; undefined if the config is invalid. */
function strategyLegs(p: Params<'strategy.start'>, ref: bigint): Leg[] | undefined {
  const { base, quote } = p;
  if (p.kind === 'grid') {
    const c = gridConfig.safeParse(p.config);
    if (!c.success) return undefined;
    const lo = dec(c.data.lowerPrice);
    const hi = dec(c.data.upperPrice);
    if (lo <= 0n || hi < lo) return undefined;
    // Only the two extremes matter for every price check; the rest are copies at the upper (costliest) price.
    const n = c.data.levels;
    return Array.from({ length: n }, (_, i) => ({
      base, quote, side: c.data.side, amount: dec(c.data.amountPerLevel), price: i === 0 ? lo : hi,
    }));
  }
  const c = dcaConfig.safeParse(p.config);
  if (!c.success || ref <= 0n) return undefined;
  const perDay = Math.min(c.data.maxOrders, Math.ceil(86_400 / c.data.intervalSeconds));
  // shortcut: DCA orders are priced at today's reference; the daemon re-checks each one through `check`.
  return Array.from({ length: perDay }, () => ({ base, quote, side: c.data.side, amount: dec(c.data.amountPerOrder), price: ref }));
}

/**
 * `order.take` on someone else's order: the daemon looks the order up and passes its
 * pair, side and the price the taker really pays (the maker's), held to the reference price.
 */
export function checkTake(
  take: Params<'order.take'>,
  order: { base: string; quote: string; side: 'buy' | 'sell'; price: string },
  state: BotState,
  limits: Limits,
  now: number,
): Decision {
  try {
    return checkLegs([{ base: order.base, quote: order.quote, side: order.side, amount: dec(take.amount), price: dec(order.price) }], state, limits, now);
  } catch {
    return deny('no_rule');
  }
}

export const check: RiskGate = (cmd, state, limits, now) => {
  const cls = Object.hasOwn(RISK_CLASS, cmd.method) ? RISK_CLASS[cmd.method] : undefined;
  if (cls === 'read' || cls === 'reduce') return ALLOW;
  if (cls !== 'trade') return deny('no_rule');
  try {
    if (cmd.method === 'order.make') {
      const p = cmd.params as Params<'order.make'>;
      return checkLegs([{ base: p.base, quote: p.quote, side: p.side, amount: dec(p.amount), price: dec(p.price) }], state, limits, now);
    }
    if (cmd.method === 'strategy.start') {
      const p = cmd.params as Params<'strategy.start'>;
      const pair = `${p.base}/${p.quote}`;
      const ref = Object.hasOwn(state.referencePrices, pair) ? dec(state.referencePrices[pair]!) : 0n;
      const legs = strategyLegs(p, ref);
      if (!legs) return state.locked ? deny('locked') : state.paused ? deny('paused') : deny('no_rule');
      return checkLegs(legs, state, limits, now);
    }
    // order.take needs the taken order's pair: see checkTake.
    return state.locked ? deny('locked') : state.paused ? deny('paused') : deny('no_rule');
  } catch {
    // Malformed decimals anywhere in the command or state.
    return deny('no_rule');
  }
};
