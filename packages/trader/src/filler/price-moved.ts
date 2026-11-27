/**
 * The price claim of a `PRICE_MOVED` decline (protocol §3.5 «Price-moved
 * declines», T-19): the filler's mid at the decline and how far `amountOut`
 * lies above the payout's value at that mid. It rides on a declining
 * `quote.reconfirm.reply` and on a `ticket.decline` at stage «offer»; Cancore
 * checks it against its own price and does not count a confirmed one toward
 * the ban (S-28, penalties P-31).
 */

const BPS = 10_000n;
const E18 = 10n ** 18n;
const UINT256_BOUND = 1n << 256n;
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
const INT32_MIN_N = BigInt(INT32_MIN);
const INT32_MAX_N = BigInt(INT32_MAX);

export interface PriceMovedHookClaim {
  /** Output per input in whole units × 10¹⁸ at the decline. */
  midE18: bigint;
  /** `trunc((amountOut − atMid) × 10 000 / atMid)`; positive: the delivery costs more than the payout is worth at `midE18`. */
  shiftBps: number;
}

/** A hook's `PRICE_MOVED` decline with its claim. */
export interface PriceMovedDecline extends PriceMovedHookClaim {
  decline: 'PRICE_MOVED';
}

/** The `onReconfirm` hook's answer: accept, decline, or decline `PRICE_MOVED` with the price claim. */
export type ReconfirmDecision = boolean | PriceMovedDecline;

export interface PriceShiftInput {
  /** What the filler is asked to deliver: `amountOut` of the reconfirm or the offer, output base units. */
  amountOut: bigint;
  /** What the source pays the filler for the order (§3.11; T-12 on a Canton source), input base units. */
  payout: bigint;
  midE18: bigint;
  fromDecimals: number;
  toDecimals: number;
}

/**
 * `shiftBps` of §3.5; undefined when the payout is worth nothing at the mid or the decimals are no catalog decimals.
 * A shift beyond int32 is clamped to it: a smaller claimed loss is a weaker claim Cancore still confirms, while no
 * claim at all would leave the sharpest moves counted toward the ban.
 */
export function priceShiftBps(input: PriceShiftInput): number | undefined {
  if (!isDecimals(input.fromDecimals) || !isDecimals(input.toDecimals)) return undefined;
  const atMid = (input.payout * input.midE18 * 10n ** BigInt(input.toDecimals)) / (10n ** BigInt(input.fromDecimals) * E18);
  if (atMid <= 0n) return undefined;
  // BigInt division truncates toward zero, as the protocol defines the shift.
  const shift = ((input.amountOut - atMid) * BPS) / atMid;
  return Number(shift < INT32_MIN_N ? INT32_MIN_N : shift > INT32_MAX_N ? INT32_MAX_N : shift);
}

const isDecimals = (d: number): boolean => Number.isSafeInteger(d) && d >= 0 && d <= 77;

export type WirePriceClaim = { midE18: string; shiftBps: number };

/** The claim as it goes on the wire, or undefined when it is not one the protocol accepts. */
export function wirePriceClaim(claim: Partial<PriceMovedHookClaim>): WirePriceClaim | undefined {
  const { midE18, shiftBps } = claim;
  if (typeof midE18 !== 'bigint' || midE18 <= 0n || midE18 >= UINT256_BOUND) return undefined;
  if (typeof shiftBps !== 'number' || !Number.isInteger(shiftBps) || shiftBps < INT32_MIN || shiftBps > INT32_MAX) return undefined;
  return { midE18: midE18.toString(), shiftBps };
}

/** The wire claim of a `PRICE_MOVED` answer that carries one; `onDropped` when it carries one the protocol does not accept. */
export function claimOfDecline(answer: { decline: string } & Partial<PriceMovedHookClaim>, onDropped: () => void): WirePriceClaim | undefined {
  if (answer.decline !== 'PRICE_MOVED' || (answer.midE18 === undefined && answer.shiftBps === undefined)) return undefined;
  const claim = wirePriceClaim(answer);
  if (!claim) onDropped();
  return claim;
}

/** A `PRICE_MOVED` answer; its claim may be missing or malformed — `claimOfDecline` decides what goes on the wire. */
function isPriceMovedAnswer(value: unknown): value is { decline: 'PRICE_MOVED' } & Partial<PriceMovedHookClaim> {
  return typeof value === 'object' && value !== null && (value as { decline?: unknown }).decline === 'PRICE_MOVED';
}

/** A reconfirm hook's answer as the reply it makes: accept, a plain decline, or `PRICE_MOVED` with the claim it carries. */
export function reconfirmOutcome(
  decision: ReconfirmDecision,
  onDropped: () => void,
): true | { reason: 'price-moved' | 'declined'; priceMoved?: { reason: 'PRICE_MOVED' } & Partial<WirePriceClaim> } {
  if (isPriceMovedAnswer(decision)) return { reason: 'price-moved', priceMoved: { reason: 'PRICE_MOVED', ...claimOfDecline(decision, onDropped) } };
  return decision === true ? true : { reason: 'declined' };
}
