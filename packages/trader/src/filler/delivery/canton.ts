/**
 * Delivery of a Canton-form ticket: an EVM source, a Canton destination
 * (fillers.md T-28, T-29, T-32; protocol §3.19; CAN-1867).
 *
 * ```
 * receipted ──► pending ──► confirmed   (DeliveryOrder_Fill committed: ticket → filled, `filled` event)
 *                  │  └───► sent        (signed, outcome unknown: settled from the attested proof)
 *                  └──────► failed      (never signed: refused, the ticket closed, no time left)
 * ```
 *
 * A pending fill carries `sentAtMs` from the moment its legs are signed —
 * before the first `canton.submit` — and from then on it is never closed as
 * `failed`: every failure after the signature (a lost answer, an answer for
 * another operation, `TICKET_CLOSED` on a repeated submit or prepare, no time
 * left to try again, a replica that died) ends `sent`, outcome unknown. The
 * node has no Ledger API (operator decision T-1) to look the commit up; the
 * attested proof is what settles it (`settlement/settler.ts`).
 *
 * - **No fill without a receipt** (T-22), and only the node's own ticket:
 *   the issued `repayTo` must be the node's payee; everything else is held to
 *   the ticket, the offered order and the node's identity in the decoded
 *   transaction (`canton/delivery-check.ts`) before the party key signs.
 * - **validFrom** (CAN-3026): `DeliveryOrder_Fill` refuses before the order's
 *   `validFrom` — the EVM source repays only a fill not before its `openedAt`.
 *   No prepare until the process clock is `LEDGER_CLOCK_SLACK_MS` past it
 *   (`ticket.issued.validFrom`, else the offer's). The node reads no ledger
 *   time (T-1); trading refuses an earlier prepare with `CANTON_NOT_READY`,
 *   which is retried like any transient refusal, before anything is signed.
 * - **sendGuard** (T-29): no prepare when less than `canton.destination.sendGuardSec`
 *   is left to `validUntil`. A transient refusal (`CANTON_NOT_READY`,
 *   `CANTON_UNAVAILABLE`, `OPERATION_EXPIRED`, `INTERNAL`, `RATE_LIMITED`, a
 *   transport failure) is tried again while the guard allows; a repeat after
 *   a submit that did commit meets `TICKET_CLOSED` and ends `sent`.
 * - **One delivery per ticket.** `DeliveryOrder_Fill` consumes the order, so
 *   the ledger never fills it twice; the store's `pending` claim keeps
 *   replicas from preparing it at once. A committed fill is `confirmed` with
 *   the update id as `txRef` (the proof's `fillRef` is `keccak256(utf8(updateId))`).
 * - **Unknown outcome.** A fill `sent` with no `txRef` is settled from the
 *   attested `fillRef` of a proof that is otherwise exactly its own —
 *   attestors sign only a committed `DeliveryOrder_Fill` of this order. A
 *   replica takes over another's pending fill once its lease has expired.
 */
import { type Hex, type TicketIssuedCanton } from '@cancore/contracts';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { CantonRefusal } from '../canton/legs';
import { CantonSubmitUnknown, type CantonOperations } from '../canton/operations';
import { GatewayError } from '../errors';
import type { EventSink, FillerEvent } from '../events';
import type { Clock, Logger } from '../runtime';
import type { FillerStore, TicketRecord } from '../store';
import { chainsOf, identityFor, type TicketKeys } from '../tickets/terms';
import type { DeliveryResult, FillRefusal } from './executor';
import { awaitClock, LEDGER_CLOCK_SLACK_MS } from './validFrom';

/** `FillProof.fillRef` of a Canton delivery: `keccak256(utf8(updateId))` (attestors.md, protocol §3.13). */
export const cantonFillRef = (updateId: string): Hex => `0x${bytesToHex(keccak_256(utf8ToBytes(updateId)))}` as Hex;

/** Refusals after which the same ticket can still be delivered. */
const TRANSIENT = new Set(['CANTON_NOT_READY', 'CANTON_UNAVAILABLE', 'OPERATION_EXPIRED', 'INTERNAL', 'RATE_LIMITED']);
/** Refusals that say the ticket is no longer deliverable — or was delivered by an earlier try whose answer was lost. */
const CLOSED = new Set(['TICKET_CLOSED', 'UNKNOWN_TICKET']);
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const codeOf = (error: unknown): string => (error instanceof GatewayError ? error.code : error instanceof CantonRefusal ? 'REFUSED' : 'transport');

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
    if (existing && existing.owner !== instanceId && (existing.leaseUntilMs ?? 0) > now) {
      // Looked at again once the lease runs out: a replica that died mid-delivery is taken over, never left pending.
      if (!this.stopped) clock.schedule((existing.leaseUntilMs ?? now) - now + 1, again);
      return { status: 'tracking', detail: 'another replica is delivering it' };
    }

    const validUntilMs = Number(issued.validUntil) * 1000;
    // Signed by an earlier try — this replica's or a dead one's: it may have committed.
    const signedBefore = existing?.sentAtMs !== undefined;
    const held = await this.outsideWindow(ticket, issued.validFrom ?? offer.validFrom, validUntilMs, signedBefore, existing !== undefined, again);
    if (held) return held;
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
    let signedNow = false;
    const onSigned = async () => {
      signedNow = true;
      await store.withOrder(orderHash, async (tx) => {
        const fill = await tx.getFill(attempt);
        if (fill?.state === 'pending' && fill.owner === instanceId && fill.sentAtMs === undefined) await tx.putFill({ ...fill, sentAtMs, updatedAtMs: await store.now() });
      });
    };
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
      }, { onSigned });
    } catch (error) {
      return this.failed(ticket, error, signedNow || signedBefore, validUntilMs, again);
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

  /**
   * Not now: past sendGuard (T-29), or before the order's `validFrom` (CAN-3026) — a try already signed is
   * never held back by `validFrom`, it ends by the ledger's answer.
   */
  private async outsideWindow(ticket: TicketRecord, validFrom: string, validUntilMs: number, signedBefore: boolean, claimedBefore: boolean, again: () => void): Promise<DeliveryResult | undefined> {
    const { orderHash, attempt } = ticket;
    if (this.options.clock.now() + this.options.sendGuardSec * 1000 > validUntilMs) {
      const detail = `less than sendGuard (${this.options.sendGuardSec} s) left to validUntil`;
      if (signedBefore) return this.unknown(orderHash, attempt, `send-guard after a signed try: ${detail}`);
      return this.refuse(orderHash, attempt, 'send-guard', detail, claimedBefore ? 'failed' : undefined);
    }
    if (signedBefore) return undefined;
    const wake = () => {
      if (!this.stopped) again();
    };
    return awaitClock(this.options.clock, Number(validFrom) * 1000 + LEDGER_CLOCK_SLACK_MS, wake, `validFrom not reached: the order opens at ${validFrom}`);
  }

  /** The committed fill: `confirmed` with its update id, or `sent` (outcome adopted at settle) without one; the ticket is filled. */
  private async recordFilled(orderHash: Hex, attempt: number, updateId: string | undefined, amount: string): Promise<void> {
    const { store } = this.options;
    return store.withOrder(orderHash, async (tx) => {
      const at = await store.now();
      const ticket = await tx.getTicket(attempt);
      const fill = await tx.getFill(attempt);
      // The claim is written before anything is prepared: a committed fill without it is a bug, never a guessed network.
      if (!fill) throw new Error(`delivery: no claim for the committed Canton fill of ${orderHash} attempt ${attempt}`);
      const { owner: _o, leaseUntilMs: _l, ...rest } = fill;
      await tx.putFill({
        ...rest,
        orderHash,
        attempt,
        chain: fill.chain,
        txRef: updateId ?? '',
        amount,
        received: amount,
        state: updateId ? 'confirmed' : 'sent',
        sentAtMs: fill.sentAtMs ?? this.options.clock.now(),
        updatedAtMs: at,
      });
      if (updateId && ticket?.state === 'receipted') await tx.putTicket({ ...ticket, state: 'filled', updatedAtMs: at });
    });
  }

  /**
   * A try that did not commit as far as this replica knows. `mayHaveCommitted`:
   * the legs were signed (now or by an earlier try), so a submit may have
   * reached the ledger — then nothing ends `failed`.
   */
  private async failed(ticket: TicketRecord, error: unknown, mayHaveCommitted: boolean, validUntilMs: number, again: () => void): Promise<DeliveryResult> {
    const { orderHash, attempt } = ticket;
    const cause = error instanceof CantonSubmitUnknown ? error.cause : error;
    const code = codeOf(cause);
    const why = `${code}: ${reasonOf(cause)}`;
    if (error instanceof CantonRefusal && !mayHaveCommitted) {
      // The backend prepared something else than the ticket's delivery: nothing was signed for it.
      return this.refuse(orderHash, attempt, 'ticket-mismatch', error.detail, 'failed');
    }
    if (TRANSIENT.has(code) || code === 'transport') {
      if (this.options.clock.now() + this.options.retryMs + this.options.sendGuardSec * 1000 <= validUntilMs) {
        await this.release(orderHash, attempt);
        if (!this.stopped) this.options.clock.schedule(this.options.retryMs, again);
        this.options.logger.warn('delivery: Canton fill not done yet, retrying', { orderHash, attempt, code, error: reasonOf(cause) });
        return { status: 'waiting', detail: why };
      }
      if (!mayHaveCommitted) return this.refuse(orderHash, attempt, 'send-guard', `no time left to try again after ${why}`, 'failed');
    }
    if (mayHaveCommitted) return this.unknown(orderHash, attempt, why);
    if (CLOSED.has(code)) return this.refuse(orderHash, attempt, 'not-deliverable', why, 'failed');
    return this.refuse(orderHash, attempt, 'reverted', why, 'failed');
  }

  /** A signed fill whose outcome is unknown: `sent`, settled from the attested proof. */
  private async unknown(orderHash: Hex, attempt: number, why: string): Promise<DeliveryResult> {
    await this.close(orderHash, attempt, 'sent', `outcome unknown: ${why}`);
    this.options.logger.warn('delivery: Canton fill outcome unknown; settlement adopts the attested fill', { orderHash, attempt, why });
    this.stage('fill.sent', orderHash, attempt, { chain: 'canton', outcome: 'unknown', detail: why.slice(0, 256) });
    return { status: 'tracking', detail: `outcome unknown (${why})` };
  }

  private async refuse(orderHash: Hex, attempt: number, reason: FillRefusal, detail: string, record?: 'failed'): Promise<DeliveryResult> {
    if (record) await this.close(orderHash, attempt, 'failed', `${reason}: ${detail}`);
    this.options.logger.warn('delivery: not sent', { orderHash, attempt, reason, detail });
    this.stage('fill.refused', orderHash, attempt, { reason, detail: detail.slice(0, 256) });
    return { status: 'refused', reason, detail };
  }

  /** Ends a pending claim — this replica's, or another's whose lease expired: `failed`, or `sent` with the outcome unknown. */
  private async close(orderHash: Hex, attempt: number, state: 'failed' | 'sent', reason: string): Promise<void> {
    const { store, instanceId } = this.options;
    await store.withOrder(orderHash, async (tx) => {
      const fill = await tx.getFill(attempt);
      if (!fill || fill.state !== 'pending') return;
      if (fill.owner !== instanceId && (fill.leaseUntilMs ?? 0) > (await store.now())) return;
      // A signed claim never ends failed: it may have committed.
      if (state === 'failed' && fill.sentAtMs !== undefined) state = 'sent';
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

