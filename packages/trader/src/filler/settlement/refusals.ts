/**
 * The refusals of a settlement and the checks both settle paths share: `selfSettle`
 * sends, `checkSettle` only answers, and each refuses with the same `SettleError`.
 */
import { settleAttestationsPayload, type Hex, type OrderJson, type SettleAttestationsPayload } from '@cancore/contracts';
import { INTENT_STATUS } from '../chain';
import type { FillRecord, SettlementRecord, TicketRecord } from '../store';

/** Why `selfSettle` sent nothing. */
export type SettleRefusal =
  /** No confirmed fill of this filler for the order. */
  | 'no-fill'
  /** A Canton source settles with `SwapIntent_SettleWithProof`, not here. */
  | 'canton-source'
  /** No fill key (delivery key) or router for the source chain. */
  | 'no-delivery-key'
  /** filler-gateway holds no attestation set for the fill yet. */
  | 'not-ready'
  /** The payload does not describe the filler's own fill, ticket or set. */
  | 'mismatch'
  /** The signatures are over a proof other than the filler's own. */
  | 'divergent'
  /** Fewer than `threshold` signatures recover to non-revoked members of the set. */
  | 'insufficient-signatures'
  /** The set of `attestationSetFor(orderHash)` no longer verifies (the intent outlived its grace). */
  | 'set-not-active'
  /** The intent is settled already (by this filler or anyone). */
  | 'already-settled'
  /** The maker refunded first (R-5). */
  | 'refunded'
  /** `eth_call` of `settle` reverted: `detail` names the error. */
  | 'reverted'
  /** Priced above `maxFeePerGasWei`. */
  | 'fee-ceiling'
  /** A source chain read failed; try again. */
  | 'unavailable'
  /** Canton source: `refundAfter` has come; `SwapIntent_SettleWithProof` is refused from then on (T-37). */
  | 'deadline-passed';

export class SettleError extends Error {
  override readonly name = 'SettleError';
  constructor(
    readonly reason: SettleRefusal,
    readonly detail: string,
  ) {
    super(`settle: ${reason}: ${detail}`);
  }
}

/** What `checkSettle` found: `settle` would go through, at this gas, paying `repayTo` this much before any withheld penalty. */
export interface SettleCheck {
  gas: bigint;
  repayTo: Hex;
  payout: bigint;
}

/** `settle` records its verdicts, stages and alerts; `check` only answers. */
export type VerifyEffects = 'settle' | 'check';

/** What one order's settlement works from. */
export interface Settleable {
  orderHash: Hex;
  fill: FillRecord;
  ticket: TicketRecord;
  order: OrderJson;
  settlement?: SettlementRecord;
  payload?: SettleAttestationsPayload;
  channel?: 'ws' | 'rest';
  /** Why the set held for the fill failed verification (`<SettleRefusal>: <detail>`). */
  rejected?: string;
}

/** A settlement already closed: settled, or lost to the maker's refund. */
export function refuseClosed(settled: SettlementRecord | undefined): void {
  if (settled?.state === 'settled') throw new SettleError('already-settled', 'the intent is settled');
  if (settled?.state === 'failed' && settled.reason?.startsWith('refunded')) throw new SettleError('refunded', settled.reason);
}

/** `IntentNotOpen` explained by the intent's status: settled by someone, or refunded. */
export function refuseFinal(status: number): void {
  if (status === INTENT_STATUS.Settled) throw new SettleError('already-settled', 'the intent was settled by another transaction');
  if (status === INTENT_STATUS.Refunded) throw new SettleError('refunded', 'the maker refunded before settle');
}

export function payloadFrom(value: object): SettleAttestationsPayload {
  const parsed = settleAttestationsPayload(value);
  // Valid JSON is not yet a frame: without a proof object and a signature list every later rule throws a TypeError.
  if (typeof parsed.proof !== 'object' || parsed.proof === null || !Array.isArray(parsed.signatures)) throw new TypeError('no proof or no signatures');
  return parsed;
}

/** The set held for the fill, or why there is none to settle with. */
export function payloadOf(s: Settleable): SettleAttestationsPayload {
  if (s.payload) return s.payload;
  const [reason, ...detail] = (s.rejected ?? '').split(': ');
  if (s.rejected) throw new SettleError(reason as SettleRefusal, detail.join(': '));
  throw new SettleError('not-ready', 'filler-gateway holds no attestation set for the fill yet');
}
