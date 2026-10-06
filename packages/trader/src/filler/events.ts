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
  /** One check before the receipt ran: `detail.check`, `detail.ok`, `detail.reason`. */
  | 'ticket.checked'
  | 'ticket.receipted'
  | 'ticket.expired'
  | 'fill.sent'
  | 'fill.confirmed'
  | 'attestations.received'
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
