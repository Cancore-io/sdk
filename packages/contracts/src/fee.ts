/**
 * The inclusive fee of the intent rail (protocol.md §3.11): the maker hands over
 * the total `T = N + F`, the filler is paid the net, Cancore keeps the rest.
 * `T` and the result are in the input's base units (a Canton source: 10⁻¹⁰ units
 * of the give instrument, its EVM form of §3.7).
 */
import { BPS, MAX_FEE_BPS } from './constants';
import { uint } from './protocol/bytes';
import type { UintLike } from './protocol/typedData';

export interface FeeSplit {
  /** What the filler is paid. */
  payout: bigint;
  /** What Cancore keeps: `total − payout`. */
  fee: bigint;
}

function operands(total: UintLike, feeBps: UintLike): [bigint, bigint] {
  const t = uint(total, 256, 'total');
  const bps = uint(feeBps, 16, 'feeBps');
  if (bps > BigInt(MAX_FEE_BPS)) throw new RangeError(`feeBps: ${bps} exceeds MAX_FEE_BPS (${MAX_FEE_BPS})`);
  return [t, bps];
}

/**
 * EVM source, `CancoreRouter.settle`: `payout = ⌊T × 10 000 / (10 000 + feeBps)⌋`, `fee = T − payout`.
 * The rounding dust goes to the fee; a total below one net unit (`T × 10 000 < 10 000 + feeBps`)
 * pays 0 and is all fee.
 */
export function inclusiveFeeSplit(total: UintLike, feeBps: UintLike): FeeSplit {
  const [t, bps] = operands(total, feeBps);
  const payout = (t * BigInt(BPS)) / (BigInt(BPS) + bps);
  return { payout, fee: t - payout };
}

/**
 * Canton source, Daml `inclusiveFee amount feeRate = amount − amount / (1.0 + feeRate)` in EVM-form
 * units: the same quotient rounded half to even (Daml `Numeric 10` division), so the payout is the
 * EVM one or one unit more. A filler prices a Canton-source order on this, never on the EVM formula (T-12).
 */
export function cantonInclusiveFeeSplit(total: UintLike, feeBps: UintLike): FeeSplit {
  const [t, bps] = operands(total, feeBps);
  const n = t * BigInt(BPS);
  const d = BigInt(BPS) + bps;
  const q = n / d;
  const r = n - q * d;
  const payout = 2n * r > d || (2n * r === d && q % 2n === 1n) ? q + 1n : q;
  return { payout, fee: t - payout };
}
