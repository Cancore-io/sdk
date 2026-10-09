/**
 * What the SDK reports to the filler node: the public events of sdk.md §3.6
 * and the internal stages for analytics and metrics. Delivered through an
 * injected `EventSink`, so the node routes them wherever it wants (its
 * journal, Prometheus, a webhook). Payloads never carry signatures or keys.
 */
import type { DeclineReason, DecString, Hex, PenaltyStep } from '@cancore/contracts';

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

/** The SDK refused a ticket itself (escrow, TTL; V2 also the draw). No penalty follows. */
export interface DeclinedEvent {
  type: 'declined';
  orderHash: Hex;
  attempt: number;
  reason: DeclineReason;
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
  | 'ticket.expired'
  /** Delivery (`detail.reason`, `detail.detail`): not sent — no receipt, `sendGuard`, below `minReceived`, already filled, a revert in `eth_estimateGas`. */
  | 'fill.refused'
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
  /** A `settle.attestations` kept for an attempt (`detail.channel`: `ws` or `rest`). */
  | 'attestations.received'
  /** Nothing sent: `detail.reason` (`SettleRefusal`), the revert or the mismatch in `detail.error` / `detail.detail`. */
  | 'settle.refused'
  /** Operator alert (`detail.kind`): `half-window`, `refund-near`, `refunded`, `settle-reverted`, `divergent`, `insufficient-signatures`, `set-not-active`, `mismatch`. */
  | 'settle.alert'
  /** Own `settle` mined and reverted. */
  | 'settle.reverted'
  | 'settle.sent'
  | 'settle.confirmed';

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

export type FillerEvent = FilledEvent | AttestedEvent | SettledEvent | PenaltyEvent | DeclinedEvent | StageEvent;

/**
 * Receives every event. A rejected promise or a throw is logged and dropped:
 * a broken sink never stops the protocol.
 */
export interface EventSink {
  emit(event: FillerEvent): void | Promise<void>;
}

export const noopEventSink: EventSink = { emit: () => undefined };
