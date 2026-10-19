/**
 * Delivery of a Canton-form ticket: an EVM source, a Canton destination
 * (fillers.md T-28, T-29, T-32; protocol §3.19; CAN-1867).
 *
 * ```
 * receipted ──► pending ──► confirmed   (DeliveryOrder_Fill committed: ticket → filled, `filled` event)
 *                  │  └───► sent        (outcome unknown: the order is gone and no update id is known)
 *                  └──────► failed      (refused before anything was signed, or the ticket closed)
 * ```
 *
 * - **No fill without a receipt** (T-22), and only the node's own ticket:
 *   the issued `repayTo` must be the node's payee; everything else is held to
 *   the ticket, the offered order and the node's identity in the decoded
 *   transaction (`canton/delivery-check.ts`) before the party key signs.
 * - **sendGuard** (T-29): no prepare when less than `canton.destination.sendGuardSec`
 *   is left to `validUntil`. A transient refusal (`CANTON_NOT_READY`,
 *   `CANTON_UNAVAILABLE`, `OPERATION_EXPIRED`, a transport failure) is tried
 *   again while the guard allows.
 * - **One delivery per ticket.** `DeliveryOrder_Fill` consumes the order, so
 *   the ledger never fills it twice; the store's `pending` claim keeps
 *   replicas from preparing it at once. A committed fill is `confirmed` with
 *   the update id as `txRef` (the proof's `fillRef` is `keccak256(utf8(updateId))`).
 * - **Unknown outcome.** A replica that died between submit and record finds
 *   the order gone on its next try: the fill is `sent` with no `txRef`, and the
 *   settlement adopts the attested `fillRef` once a proof that is otherwise
 *   exactly its own arrives — attestors sign only a committed
 *   `DeliveryOrder_Fill` of this order.
 */
import { type Hex, type TicketIssuedCanton } from '@cancore/contracts';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { CantonRefusal } from '../canton/legs';
import type { CantonOperations } from '../canton/operations';
import { GatewayError } from '../errors';
import type { EventSink, FillerEvent } from '../events';
import type { Clock, Logger } from '../runtime';
import type { FillerStore, TicketRecord } from '../store';
import { chainsOf, identityFor, type TicketKeys } from '../tickets/terms';
import type { DeliveryResult, FillRefusal } from './executor';

/** `FillProof.fillRef` of a Canton delivery: `keccak256(utf8(updateId))` (attestors.md, protocol §3.13). */
export const cantonFillRef = (updateId: string): Hex => `0x${bytesToHex(keccak_256(utf8ToBytes(updateId)))}` as Hex;

/** Refusals after which the same ticket can still be delivered. */
const TRANSIENT = new Set(['CANTON_NOT_READY', 'CANTON_UNAVAILABLE', 'OPERATION_EXPIRED', 'INTERNAL', 'RATE_LIMITED']);
/** Refusals that say the ticket is no longer deliverable — or was delivered by an earlier try whose answer was lost. */
const CLOSED = new Set(['TICKET_CLOSED', 'UNKNOWN_TICKET']);
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface CantonDeliveryOptions extends TicketKeys {
  store: FillerStore;
  operations: Pick<CantonOperations, 'fill'>;
  /** `canton.destination.sendGuardSec`. */
  sendGuardSec: number;
  instanceId: string;
  /** How long a `pending` claim holds, and the retry interval of a transient refusal, ms. */
  leaseMs: number;
  retryMs: number;
  clock: Clock;
  logger: Logger;
  events: EventSink;
  onFilled?: (orderHash: Hex, attempt: number) => void;
}

export class CantonDelivery {
  private stopped = false;

  constructor(private readonly options: CantonDeliveryOptions) {}

  stop(): void {
    this.stopped = true;
  }

  /** Delivers one receipted Canton-form ticket; `again` re-enters through the executor's single worker per attempt. */
  async deliver(ticket: TicketRecord, again: () => void): Promise<DeliveryResult> {
    const { store, clock, instanceId } = this.options;
    const { orderHash, attempt } = ticket;
    const issued = ticket.issued as TicketIssuedCanton;
    const offer = ticket.offer;
    if (!offer || issued?.form !== 'canton' || !chainsOf(offer.order)?.canton) return this.refuse(orderHash, attempt, 'not-deliverable', 'not a Canton-form ticket for a Canton destination');
    const identity = identityFor(offer.order, this.options);
    if (!identity || issued.repayTo?.toLowerCase() !== identity.repayTo.toLowerCase()) return this.refuse(orderHash, attempt, 'ticket-mismatch', 'the issued repayTo is not this filler’s payee');

    const now = await store.now();
    const existing = await store.withOrder(orderHash, (tx) => tx.getFill(attempt));
    if (existing && existing.state !== 'pending') return { status: 'tracking', ...(existing.txRef ? { detail: existing.txRef } : {}) };
    if (existing && existing.owner !== instanceId && (existing.leaseUntilMs ?? 0) > now) return { status: 'tracking', detail: 'another replica is delivering it' };

    const validUntilMs = Number(issued.validUntil) * 1000;
    if (clock.now() + this.options.sendGuardSec * 1000 > validUntilMs) {
      return this.refuse(orderHash, attempt, 'send-guard', `less than sendGuard (${this.options.sendGuardSec} s) left to validUntil`, existing ? 'failed' : undefined);
    }
    const retried = existing !== undefined;
    const claimed = await store.withOrder(orderHash, async (tx) => {
      const fill = await tx.getFill(attempt);
      const at = await store.now();
      if (fill && (fill.state !== 'pending' || (fill.owner !== instanceId && (fill.leaseUntilMs ?? 0) > at))) return false;
      // `amount` is the most this delivery can move until the checked amount is known: an unknown outcome is bounded by it at settle.
      await tx.putFill({ orderHash, attempt, chain: `canton:${chainsOf(offer.order)!.canton!}`, txRef: '', amount: String(offer.amountOut), state: 'pending', owner: instanceId, leaseUntilMs: at + this.options.leaseMs, updatedAtMs: at, ...(fill?.sentAtMs ? { sentAtMs: fill.sentAtMs } : {}) });
      return true;
    });
    if (!claimed) return { status: 'tracking', detail: 'another replica is delivering it' };

    const sentAtMs = clock.now();
    let submitted: Awaited<ReturnType<CantonOperations['fill']>>;
    try {
      submitted = await this.options.operations.fill({
        fillerId: this.options.fillerId,
        orderHash,
        attempt,
        deliveryOrderCid: issued.deliveryOrderCid,
        validUntil: issued.validUntil,
        repayTo: identity.repayTo,
        order: { recipient: offer.order.recipient, outputAsset: offer.order.outputAsset, minReceived: offer.order.minReceived, fillDeadline: offer.order.fillDeadline },
        amountOut: offer.amountOut,
      });
    } catch (error) {
      return this.failed(ticket, error, retried, validUntilMs, again);
    }

    const updateId = submitted.updateId;
    const amount = submitted.delivered;
    await this.recordFilled(orderHash, attempt, updateId, amount);
    this.stage('fill.sent', orderHash, attempt, { chain: 'canton', ...(updateId ? { updateId } : {}), receiptCid: submitted.result.receiptCid, latencyMs: clock.now() - sentAtMs });
    if (!updateId) {
      // Committed, but without its update id the proof's fillRef is the attestors' to name: adopted at settle.
      this.options.logger.error('delivery: Canton fill committed without an update id', { orderHash, attempt, receiptCid: submitted.result.receiptCid });
      return { status: 'sent', detail: 'committed; no update id' };
    }
    const fillRef = cantonFillRef(updateId);
    this.options.logger.info('delivery: Canton fill committed', { orderHash, attempt, updateId });
    this.emit({ type: 'filled', orderHash, attempt, txHash: fillRef, amount });
    this.options.onFilled?.(orderHash, attempt);
    return { status: 'sent', txHash: fillRef };
  }

  /** The committed fill: `confirmed` with its update id, or `sent` (outcome adopted at settle) without one; the ticket is filled. */
  private async recordFilled(orderHash: Hex, attempt: number, updateId: string | undefined, amount: string): Promise<void> {
    const { store } = this.options;
    return store.withOrder(orderHash, async (tx) => {
      const at = await store.now();
      const ticket = await tx.getTicket(attempt);
      const fill = await tx.getFill(attempt);
      const { owner: _o, leaseUntilMs: _l, ...rest } = fill ?? ({} as Record<string, never>);
      await tx.putFill({
        ...rest,
        orderHash,
        attempt,
        chain: fill?.chain ?? 'canton:devnet',
        txRef: updateId ?? '',
        amount,
        received: amount,
        state: updateId ? 'confirmed' : 'sent',
        sentAtMs: this.options.clock.now(),
        updatedAtMs: at,
      });
      if (updateId && ticket?.state === 'receipted') await tx.putTicket({ ...ticket, state: 'filled', updatedAtMs: at });
    });
  }

  private async failed(ticket: TicketRecord, error: unknown, retried: boolean, validUntilMs: number, again: () => void): Promise<DeliveryResult> {
    const { orderHash, attempt } = ticket;
    const code = error instanceof GatewayError ? error.code : error instanceof CantonRefusal ? 'REFUSED' : 'transport';
    if (error instanceof CantonRefusal) {
      // The backend prepared something else than the ticket's delivery: nothing was signed, and nothing ever will be for it.
      this.stage('fill.refused', orderHash, attempt, { reason: 'ticket-mismatch', detail: error.detail.slice(0, 256) });
      return this.refuse(orderHash, attempt, 'ticket-mismatch', error.detail, 'failed');
    }
    if (CLOSED.has(code)) {
      if (retried) {
        // An earlier try of this replica or another may have committed and lost its answer: unknown, not failed.
        await this.close(orderHash, attempt, 'sent', `outcome unknown: ${code} on a repeated delivery`);
        this.options.logger.warn('delivery: Canton fill outcome unknown; settlement adopts the attested fill', { orderHash, attempt, code });
        return { status: 'tracking', detail: `outcome unknown (${code})` };
      }
      return this.refuse(orderHash, attempt, 'not-deliverable', `${code}: ${reasonOf(error)}`, 'failed');
    }
    if (TRANSIENT.has(code) || code === 'transport') {
      const at = this.options.clock.now() + this.options.retryMs;
      if (at + this.options.sendGuardSec * 1000 > validUntilMs) return this.refuse(orderHash, attempt, 'send-guard', `no time left to try again after ${code}: ${reasonOf(error)}`, 'failed');
      await this.release(orderHash, attempt);
      if (!this.stopped) this.options.clock.schedule(this.options.retryMs, again);
      this.options.logger.warn('delivery: Canton fill not done yet, retrying', { orderHash, attempt, code, error: reasonOf(error) });
      return { status: 'waiting', detail: `${code}: ${reasonOf(error)}` };
    }
    return this.refuse(orderHash, attempt, 'reverted', `${code}: ${reasonOf(error)}`, 'failed');
  }

  private async refuse(orderHash: Hex, attempt: number, reason: FillRefusal, detail: string, record?: 'failed'): Promise<DeliveryResult> {
    if (record) await this.close(orderHash, attempt, 'failed', `${reason}: ${detail}`);
    this.options.logger.warn('delivery: not sent', { orderHash, attempt, reason, detail });
    this.stage('fill.refused', orderHash, attempt, { reason, detail: detail.slice(0, 256) });
    return { status: 'refused', reason, detail };
  }

  /** Ends the claim of this replica: `failed`, or `sent` with the outcome unknown. */
  private async close(orderHash: Hex, attempt: number, state: 'failed' | 'sent', reason: string): Promise<void> {
    const { store, instanceId } = this.options;
    await store.withOrder(orderHash, async (tx) => {
      const fill = await tx.getFill(attempt);
      if (!fill || fill.state !== 'pending' || fill.owner !== instanceId) return;
      const { owner: _o, leaseUntilMs: _l, ...rest } = fill;
      await tx.putFill({ ...rest, state, reason, updatedAtMs: await store.now() });
    });
  }

  private async release(orderHash: Hex, attempt: number): Promise<void> {
    const { store, instanceId } = this.options;
    await store.withOrder(orderHash, async (tx) => {
      const fill = await tx.getFill(attempt);
      if (fill?.state === 'pending' && fill.owner === instanceId) await tx.putFill({ ...fill, leaseUntilMs: 0, updatedAtMs: await store.now() });
    });
  }

  private stage(stage: 'fill.sent' | 'fill.refused', orderHash: Hex, attempt: number, detail: Readonly<Record<string, string | number | boolean>>): void {
    this.emit({ type: 'stage', stage, atMs: this.options.clock.now(), orderHash, attempt, detail });
  }

  private emit(event: FillerEvent): void {
    try {
      const result = this.options.events.emit(event);
      if (result instanceof Promise) result.catch((error: unknown) => this.options.logger.warn('event sink failed', { error: String(error) }));
    } catch (error) {
      this.options.logger.warn('event sink failed', { error: String(error) });
    }
  }
}

