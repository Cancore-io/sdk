/**
 * What the SDK reports to the filler node: the public events of sdk.md §3.6
 * and the internal stages for analytics and metrics. Delivered through an
 * injected `EventSink`, so the node routes them wherever it wants (its
 * journal, Prometheus, a webhook). Payloads never carry signatures or keys.
 */
import type { DeclineReason, DecString, Hex, PenaltyStep } from '@cancore/contracts';
import type { EvmChainId } from './chains';
import type { InFlightKind } from './store';

/** Own `fill` confirmed on the destination. */
export interface FilledEvent {
  type: 'filled';
  orderHash: Hex;
  attempt: number;
  txHash: Hex;
  /** Delivered amount, destination base units. */
  amount: DecString;
}

/** A verified attestation set arrived (either channel; deduplicated by `orderHash` + `attempt`). */
export interface AttestedEvent {
  type: 'attested';
  orderHash: Hex;
  attempt: number;
  setId: number;
  threshold: number;
  signers: readonly Hex[];
  /** Unix seconds; `settle` must land before it. */
  refundAfter: DecString;
}

/** `order.settled` from filler-gateway, after the chain event is final. */
export interface SettledEvent {
  type: 'settled';
  orderHash: Hex;
  payout: DecString;
  penaltyWithheld: DecString;
  txRef: string;
}

/** `penalty.applied` from filler-gateway. */
export interface PenaltyEvent {
  type: 'penalty';
  violationId: string;
  code: string;
  step: PenaltyStep;
}

/** The SDK refused a ticket itself (escrow, TTL). No penalty follows. */
export interface DeclinedEvent {
  type: 'declined';
  orderHash: Hex;
  attempt: number;
  reason: DeclineReason;
}

/**
 * What one own EVM transaction cost, once its nonce is done — its block as deep
 * as the chain's `fillConfirmations` (BUG-1589): a fill, confirmed or reverted;
 * a cancel (of an expired fill, or of a nonce gap); a `settle`; an `approve`.
 * Gas is spent whether or not the call succeeded, so a reverted one is reported
 * too. `blockHash` and the price are final only at that depth, which is why
 * nothing is reported before it. At least once: a replica that crashes, or
 * loses the store's reply, after reporting and before the nonce is marked
 * mined reports it again — key it by `txHash`.
 */
export interface GasSpentEvent {
  type: 'gas';
  /**
   * The trade the cost is charged to: the fill's or the settle's own, and for
   * the cancel of an expired fill, that fill's. Absent for an `approve`, which
   * serves every order of its token, and for a cancel that filled a nonce gap.
   */
  orderHash?: Hex;
  attempt?: number;
  kind: InFlightKind;
  chain: EvmChainId;
  txHash: Hex;
  blockNumber: DecString;
  blockHash: Hex;
  /** Mined and reverted: the gas was still spent. */
  reverted: boolean;
  gasUsed: DecString;
  /**
   * Wei per gas unit: the receipt's; from an RPC that omits it,
   * `min(maxFeePerGas, baseFeePerGas + maxPriorityFeePerGas)` of the
   * transaction as sent, in its block.
   */
  effectiveGasPrice: DecString;
  /** OP-stack chains only: the L1 data fee the receipt names, wei. */
  l1Fee?: DecString;
  /** `gasUsed × effectiveGasPrice + l1Fee`: wei of the chain's native asset. */
  feeWei: DecString;
}

/** Internal stages, for analytics; not part of the protocol. */
export type FillerStage =
  | 'connected'
  | 'authenticated'
  | 'disconnected'
  | 'quote.requested'
  | 'quote.sent'
  | 'quote.skipped'
  | 'quote.acked'
  | 'reconfirm.answered'
  | 'ticket.offered'
  | 'ticket.intent.sent'
  | 'ticket.issued'
  /** One check before the receipt: `detail.check`, `detail.status` (`passed` | `failed` | `skipped`), `detail.reason`. */
  | 'ticket.checked'
  | 'ticket.receipted'
  | 'ticket.declined'
  /**
   * Operator alert: filler-gateway answered a decline `TICKET_CLOSED` (`detail.reason`: the decline's). It is not
   * sent again; but the closed ticket may be one the gateway holds receipted — a receipt POST given up after its
   * timeout that landed — and then it expects a fill this node will not make (a NO_SHOW).
   */
  | 'ticket.decline.closed'
  | 'ticket.expired'
  /** Delivery (`detail.reason`, `detail.detail`): not sent — no receipt, `sendGuard`, below `minReceived`, already filled, a revert in `eth_estimateGas`. */
  | 'fill.refused'
  /**
   * Operator alert: an RPC answered a `pending` transaction count above
   * `latest` + the key's open nonces (`detail.chain`, `detail.address`,
   * `detail.pending`, `detail.latest`, `detail.open`); the allocation used
   * `detail.used` instead. A real jump means another sender uses the key.
   */
  | 'nonce.suspect'
  /** Broadcast: `detail.nonce`, `detail.gasLimit`, `detail.maxFeePerGas`, `detail.maxPriorityFeePerGas`. */
  | 'fill.sent'
  /** Replaced by fee on the same nonce: `detail.from`, `detail.txHash` and the new fees. */
  | 'fill.replaced'
  /** In a block, not yet `fillConfirmations` deep: `detail.block`. */
  | 'fill.included'
  /** An inclusion seen before is gone; the fill is resent while the ticket is live. */
  | 'fill.reorged'
  /** Mined and reverted (`TicketExpired`, `AlreadyFilled`, …): only gas was spent. */
  | 'fill.reverted'
  /** `validUntil` passed with the fill pending: its nonce was freed by a transfer to self. */
  | 'fill.cancelled'
  /** Deep enough: `detail.gasUsed`, `detail.effectiveGasPrice`, `detail.latencyMs` (first broadcast → inclusion seen), `detail.replacements`. */
  | 'fill.confirmed'
  /** Router allowance for an output asset: `detail.token`, `detail.amount`, `detail.txHash`. */
  | 'approve.sent'
  | 'approve.confirmed'
  /** Any other own transaction (`detail.kind`): replaced, or included. */
  | 'tx.replaced'
  | 'tx.confirmed'
  /**
   * A replacement was not sent (`detail.kind`, `detail.txHash`): `detail.reason`
   * `relative-cap` (3× the first fee on the nonce; `fill`, `approve`, `cancel`)
   * or `ceiling` (`maxFeePerGasWei`). The last transaction stays and is resent
   * as is if a node drops it. Once per transaction.
   */
  | 'tx.capped'
  /** A `settle.attestations` kept for an attempt (`detail.channel`: `ws` or `rest`). */
  | 'attestations.received'
  /** Nothing sent: `detail.reason` (`SettleRefusal`), the revert or the mismatch in `detail.error` / `detail.detail`. */
  | 'settle.refused'
  /** Operator alert (`detail.kind`): `half-window`, `refund-near`, `refunded`, `settle-reverted`, `escrow-gone`, `divergent`, `insufficient-signatures`, `set-not-active`, `mismatch`. */
  | 'settle.alert'
  /** Own `settle` mined and reverted. */
  | 'settle.reverted'
  | 'settle.sent'
  | 'settle.confirmed'
  /**
   * Operator alert: a nonce looked spent with no receipt of any of its own transactions and was given up, so
   * their gas is unknown (`detail.chain`, `detail.nonce`, `detail.kinds`, `detail.txHashes` for reconciliation).
   */
  | 'gas.unpriced';

export interface StageEvent {
  type: 'stage';
  stage: FillerStage;
  /** Unix milliseconds, process clock. */
  atMs: number;
  orderHash?: Hex;
  attempt?: number;
  requestId?: string;
  detail?: Readonly<Record<string, string | number | boolean>>;
}

export type FillerEvent = FilledEvent | AttestedEvent | SettledEvent | PenaltyEvent | DeclinedEvent | GasSpentEvent | StageEvent;

/**
 * Receives every event. A rejected promise or a throw is logged and dropped:
 * a broken sink never stops the protocol.
 */
export interface EventSink {
  emit(event: FillerEvent): void | Promise<void>;
}

export const noopEventSink: EventSink = { emit: () => undefined };
