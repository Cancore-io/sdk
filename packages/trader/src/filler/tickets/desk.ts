/**
 * The ticket flow of one filler (fillers.md §4.4, protocol §3.5 «Tickets»):
 * `ticket.offer` → `onTicketOffer` → `ticket.intent` or `ticket.decline`;
 * `ticket.issued` → the checks before the receipt → `ticket.receipt` or
 * `ticket.decline`; then `ticket.expired`, `order.settled`, `penalty.applied`.
 *
 * State per attempt `(orderHash, attempt)` lives in the store:
 *
 * ```
 * offered ──► intent-sent ──► intent-acked ──► checking ──► receipted ──► filled
 *    │             │               │               └──────► declined
 *    └─────────────┴───────────────┴──► declined          (any) ──► expired
 * ```
 *
 * - **Write ahead.** Every move is written under the order's lock before the
 *   message it produces goes out; `sentAtMs` is set after it went. A message
 *   is signed once: after a restart the stored one is sent again, while its
 *   deadline lasts (`acceptBy` for an intent or an offer-stage decline,
 *   `validUntil` for a receipt or an issued-stage decline).
 * - **One writer per move.** A move is a compare-and-set under the lock: it
 *   happens only from the state it was decided in, so two replicas (or a
 *   handler and a resume) never both send a different answer for one attempt.
 * - **Receipt only after the checks** (T-22). The receipt is signed only from
 *   `checking`, after `TicketVerifier` passed; any failed or unverifiable
 *   check declines with its code instead (T-23). `receipted()` is the only
 *   way the delivery learns it may fill.
 * - **Silence costs more than a decline** (T-21): a hook that does not answer
 *   before `acceptBy − offerReplyMarginMs`, or throws, declines `OTHER`. The
 *   kill-switch declines `PAUSED` without asking the hook.
 * - **Restart.** After every login the open attempts are resumed from the store.
 */
import type { DeclineReason, Hex, OrderSettled, PenaltyApplied, TicketDecline, TicketExpired, TicketIssued, TicketOffer } from '@cancore/contracts';
import { EXPIRED_RESULTS } from '@cancore/contracts';
import type { EventSink, FillerEvent, FillerStage } from '../events';
import type { Delivery, FillerProtocolClient } from '../protocol/client';
import type { TicketAction } from '../protocol/rest';
import type { Clock, Logger } from '../runtime';
import type { FillSigner } from '../signer';
import type { FillerStore, TicketRecord, TicketState } from '../store';
import type { EvmChainId } from '../chains';
import type { TicketVerifier } from './checks';
import { identityFor, signTicketIntent, signTicketReceipt } from './terms';

/** The reasons a filler may give for not taking an offered ticket (protocol §3.5, stage «offer»). */
export const OFFER_DECLINE_REASONS = ['NO_INVENTORY', 'RISK_LIMIT', 'PRICE_MOVED', 'PAUSED', 'OTHER'] as const;
export type OfferDeclineReason = (typeof OFFER_DECLINE_REASONS)[number];

/** The hook's answer: take it, or decline — plainly (`OTHER`) or with a reason. */
export type TicketOfferDecision = 'accept' | 'decline' | { decline: OfferDeclineReason; detail?: string };
export type TicketOfferHook = (offer: TicketOffer) => Promise<TicketOfferDecision>;

/** Default time kept free before `acceptBy` to send the answer after the hook. */
export const DEFAULT_OFFER_REPLY_MARGIN_MS = 250;

export interface TicketDeskOptions {
  store: FillerStore;
  protocol: FillerProtocolClient;
  verifier: TicketVerifier;
  fillSigners: { readonly [chain: EvmChainId]: FillSigner };
  clock: Clock;
  logger: Logger;
  events: EventSink;
  nextId: () => string;
  onTicketOffer: () => TicketOfferHook | undefined;
  offerReplyMarginMs: number;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const isAttempt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const TERMINAL: ReadonlySet<TicketState> = new Set(['declined', 'expired', 'filled']);
const key = (orderHash: string, attempt: number) => `${orderHash.toLowerCase()}:${attempt}`;

type Outgoing = { action: 'intent' | 'receipt' | 'decline'; message: TicketAction['message']; deadlineMs: number };

export class TicketDesk {
  /** Attempts this process is moving right now; a resume leaves them alone. */
  private readonly busy = new Set<string>();

  constructor(private readonly options: TicketDeskOptions) {}

  register(): void {
    const { protocol } = this.options;
    protocol.on('ticket.offer', (d) => this.onOffer(d));
    protocol.on('ticket.issued', (d) => this.onIssued(d));
    protocol.on('ticket.expired', (d) => this.onExpired(d));
    protocol.on('order.settled', async (d) => this.onSettled(d));
    protocol.on('penalty.applied', async (d) => this.onPenalty(d));
    protocol.onLogin(() => {
      void this.resume().catch((error: unknown) => this.options.logger.warn('tickets: resume failed', { error: String(error) }));
    });
  }

  /**
   * The ticket of `(orderHash, attempt)` when the filler is bound to deliver
   * it: receipted, and the receipt handed to filler-gateway. Undefined in
   * every other state — no fill without a receipt (T-22).
   */
  async receipted(orderHash: Hex, attempt: number): Promise<TicketRecord | undefined> {
    const record = await this.options.store.withOrder(orderHash.toLowerCase() as Hex, (tx) => tx.getTicket(attempt));
    return record?.state === 'receipted' && record.sentAtMs !== undefined && record.receipt ? record : undefined;
  }

  // -- ticket.offer -----------------------------------------------------------

  async onOffer(delivery: Delivery): Promise<void> {
    const offer = delivery.frame as unknown as TicketOffer;
    if (!HEX32.test(String(offer.orderHash)) || !isAttempt(offer.attempt) || !Number.isSafeInteger(offer.acceptBy) || typeof offer.order !== 'object' || offer.order === null) {
      this.options.logger.warn('tickets: malformed ticket.offer ignored');
      return;
    }
    const orderHash = offer.orderHash.toLowerCase() as Hex;
    const created = await this.options.store.withOrder(orderHash, async (tx) => {
      if (await tx.getTicket(offer.attempt)) return false; // a redelivery, or another replica has it
      await tx.putTicket({ orderHash, attempt: offer.attempt, state: 'offered', offer, updatedAtMs: await this.options.store.now() });
      return true;
    });
    if (!created) return;
    this.stage('ticket.offered', orderHash, offer.attempt, { acceptBy: offer.acceptBy, channel: delivery.channel });
    await this.exclusive(orderHash, offer.attempt, () => this.decide(orderHash, offer));
  }

  /** Asks the hook (or declines without it) and answers before `acceptBy`. */
  private async decide(orderHash: Hex, offer: TicketOffer): Promise<void> {
    const { clock, logger } = this.options;
    const decline = (reason: OfferDeclineReason, detail: string) => this.declineOffer(orderHash, offer, reason, detail);
    if (clock.now() > offer.acceptBy) return this.giveUp(orderHash, offer.attempt, 'acceptBy passed before an answer');
    if ((await this.options.store.getOverrides()).paused) return decline('PAUSED', 'the kill-switch is on');
    const identity = identityFor(offer.order, this.options.fillSigners);
    if (!identity) return decline('OTHER', 'no fill key of this filler for the order');

    const decision = await this.askHook(offer);
    if (clock.now() > offer.acceptBy) return this.giveUp(orderHash, offer.attempt, 'the hook answered after acceptBy');
    if (decision !== 'accept') return decline(decision.reason, decision.detail);

    const intent = await signTicketIntent(offer, identity, this.options.nextId());
    const moved = await this.move(orderHash, offer.attempt, ['offered'], (record) => ({ ...record, state: 'intent-sent', intent }));
    if (!moved) return;
    logger.info('tickets: intent', { orderHash, attempt: offer.attempt });
    await this.send(orderHash, offer.attempt, { action: 'intent', message: intent, deadlineMs: offer.acceptBy }, 'ticket.intent.sent');
  }

  private async askHook(offer: TicketOffer): Promise<'accept' | { reason: OfferDeclineReason; detail: string }> {
    const hook = this.options.onTicketOffer();
    if (!hook) return { reason: 'OTHER', detail: 'no onTicketOffer hook' };
    const budget = offer.acceptBy - this.options.offerReplyMarginMs - this.options.clock.now();
    let cancel: (() => void) | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      cancel = this.options.clock.schedule(Math.max(0, budget), () => resolve('timeout'));
    });
    try {
      const answer = await Promise.race([hook(offer), timeout]);
      if (answer === 'timeout') return { reason: 'OTHER', detail: 'the hook did not answer before acceptBy' };
      if (answer === 'accept') return 'accept';
      if (answer === 'decline') return { reason: 'OTHER', detail: 'declined by the hook' };
      if (typeof answer === 'object' && answer !== null && OFFER_DECLINE_REASONS.includes(answer.decline)) {
        return { reason: answer.decline, detail: typeof answer.detail === 'string' ? answer.detail : 'declined by the hook' };
      }
      return { reason: 'OTHER', detail: 'the hook returned no decision' };
    } catch (error) {
      this.options.logger.error('tickets: onTicketOffer threw', { orderHash: offer.orderHash, error: String(error) });
      return { reason: 'OTHER', detail: 'the hook failed' };
    } finally {
      cancel?.();
    }
  }

  private async declineOffer(orderHash: Hex, offer: TicketOffer, reason: OfferDeclineReason, detail: string): Promise<void> {
    const decline: TicketDecline = { type: 'ticket.decline', id: this.options.nextId(), orderHash, attempt: offer.attempt, reason, detail };
    const moved = await this.move(orderHash, offer.attempt, ['offered'], (record) => ({ ...record, state: 'declined', decline }));
    if (!moved) return;
    this.declined(orderHash, offer.attempt, reason, detail);
    await this.send(orderHash, offer.attempt, { action: 'decline', message: decline, deadlineMs: offer.acceptBy }, 'ticket.declined');
  }

  /** No answer can reach filler-gateway in time: the attempt ends here, nothing is sent. */
  private async giveUp(orderHash: Hex, attempt: number, why: string): Promise<void> {
    const decline: TicketDecline = { type: 'ticket.decline', id: this.options.nextId(), orderHash, attempt, reason: 'OTHER', detail: why };
    const moved = await this.move(orderHash, attempt, ['offered'], (record) => ({ ...record, state: 'declined', decline, sentAtMs: this.options.clock.now(), unsent: true }));
    if (moved) this.options.logger.warn('tickets: offer left unanswered', { orderHash, attempt, why });
  }

  // -- ticket.issued ------------------------------------------------------------

  async onIssued(delivery: Delivery): Promise<void> {
    const issued = delivery.frame as unknown as TicketIssued;
    if (!HEX32.test(String(issued.orderHash)) || !isAttempt(issued.attempt)) {
      this.options.logger.warn('tickets: malformed ticket.issued ignored');
      return;
    }
    const orderHash = issued.orderHash.toLowerCase() as Hex;
    const issuedAtMs = this.options.clock.now();
    const next = await this.options.store.withOrder(orderHash, async (tx): Promise<'check' | 'refuse' | 'ignore'> => {
      const record = await tx.getTicket(issued.attempt);
      const now = await this.options.store.now();
      if (!record) {
        // No offer to hold the ticket to: refused, never receipted.
        await tx.putTicket({ orderHash, attempt: issued.attempt, state: 'checking', issued, issuedAtMs, updatedAtMs: now });
        return 'refuse';
      }
      if (record.issued || (record.state !== 'intent-sent' && record.state !== 'intent-acked' && record.state !== 'offered')) return 'ignore';
      await tx.putTicket({ ...record, state: 'checking', issued, issuedAtMs, updatedAtMs: now });
      return record.state === 'offered' ? 'refuse' : 'check';
    });
    if (next === 'ignore') return;
    this.stage('ticket.issued', orderHash, issued.attempt, { form: String(issued.form), channel: delivery.channel });
    if (next === 'refuse') {
      await this.finishChecks(orderHash, issued.attempt, { ok: false, reason: 'OTHER', detail: 'no ticket.intent was sent for this attempt' });
      return;
    }
    await this.exclusive(orderHash, issued.attempt, () => this.check(orderHash, issued.attempt));
  }

  /** Runs the checks for a `checking` attempt and answers. */
  private async check(orderHash: Hex, attempt: number): Promise<void> {
    const record = await this.options.store.withOrder(orderHash, (tx) => tx.getTicket(attempt));
    if (record?.state !== 'checking' || !record.issued || !record.offer) return;
    let verdict: Awaited<ReturnType<TicketVerifier['verify']>>;
    try {
      verdict = await this.options.verifier.verify({ offer: record.offer, issued: record.issued, issuedAtMs: record.issuedAtMs ?? this.options.clock.now(), ...(record.intent ? { intent: record.intent } : {}) });
    } catch (error) {
      this.options.logger.error('tickets: the checks failed to run', { orderHash, attempt, error: String(error) });
      verdict = { ok: false, reason: 'OTHER', detail: 'the checks failed to run', checks: [] };
    }
    await this.finishChecks(orderHash, attempt, verdict);
  }

  private async finishChecks(orderHash: Hex, attempt: number, verdict: { ok: boolean; reason?: DeclineReason; detail?: string }): Promise<void> {
    const record = await this.options.store.withOrder(orderHash, (tx) => tx.getTicket(attempt));
    if (record?.state !== 'checking' || !record.issued) return;
    const issued = record.issued;
    const validUntilMs = issued.form === 'evm' ? Number(issued.ticket?.validUntil) * 1000 : Number((issued as { validUntil?: string }).validUntil) * 1000;
    const deadlineMs = Number.isFinite(validUntilMs) ? validUntilMs : 0;

    if (verdict.ok && issued.form === 'evm' && record.offer) {
      const identity = identityFor(record.offer.order, this.options.fillSigners);
      if (identity) {
        const receipt = await signTicketReceipt(issued.ticket, issued.ticketSig, identity, this.options.nextId());
        const moved = await this.move(orderHash, attempt, ['checking'], (r) => ({ ...r, state: 'receipted', receipt }));
        if (!moved) return;
        this.options.logger.info('tickets: receipt', { orderHash, attempt });
        await this.send(orderHash, attempt, { action: 'receipt', message: receipt, deadlineMs }, 'ticket.receipted');
        return;
      }
      verdict = { ok: false, reason: 'TICKET_MISMATCH', detail: 'no fill key of this filler for the order' };
    }
    const reason: DeclineReason = verdict.reason ?? 'OTHER';
    const decline: TicketDecline = { type: 'ticket.decline', id: this.options.nextId(), orderHash, attempt, reason, ...(verdict.detail ? { detail: verdict.detail.slice(0, 256) } : {}) };
    const moved = await this.move(orderHash, attempt, ['checking'], (r) => ({ ...r, state: 'declined', decline }));
    if (!moved) return;
    this.declined(orderHash, attempt, reason, verdict.detail ?? '');
    await this.send(orderHash, attempt, { action: 'decline', message: decline, deadlineMs }, 'ticket.declined');
  }

  // -- ticket.expired, order.settled, penalty.applied -----------------------------

  async onExpired(delivery: Delivery): Promise<void> {
    const expired = delivery.frame as unknown as TicketExpired;
    if (!HEX32.test(String(expired.orderHash)) || !isAttempt(expired.attempt)) return;
    const orderHash = expired.orderHash.toLowerCase() as Hex;
    const result = (EXPIRED_RESULTS as readonly string[]).includes(expired.result) ? expired.result : 'OTHER';
    const changed = await this.options.store.withOrder(orderHash, async (tx) => {
      const record = await tx.getTicket(expired.attempt);
      if (record?.expired) return false;
      const base: TicketRecord = record ?? { orderHash, attempt: expired.attempt, state: 'expired', updatedAtMs: 0 };
      await tx.putTicket({ ...base, state: 'expired', expired, updatedAtMs: await this.options.store.now() });
      return true;
    });
    if (!changed) return;
    // FILLED is the delivery's own `filled` event (CAN-1855); NO_SHOW is followed by penalty.applied.
    this.stage('ticket.expired', orderHash, expired.attempt, { result, ...(expired.exemptReason ? { exemptReason: String(expired.exemptReason) } : {}) });
  }

  onSettled(delivery: Delivery): void {
    if (!delivery.firstSeen) return;
    const s = delivery.frame as unknown as OrderSettled;
    this.emit({ type: 'settled', orderHash: s.orderHash, payout: s.payout, penaltyWithheld: s.penaltyWithheld, txRef: s.txRef });
  }

  onPenalty(delivery: Delivery): void {
    if (!delivery.firstSeen) return;
    const p = delivery.frame as unknown as PenaltyApplied;
    this.emit({ type: 'penalty', violationId: p.violationId, code: p.code, step: p.step });
  }

  // -- restart --------------------------------------------------------------------

  /**
   * Picks up every open attempt from the store: an unanswered offer is decided,
   * a stored message that never went out is sent (while its deadline lasts),
   * an interrupted check is run again. Called after every login.
   */
  async resume(): Promise<void> {
    for (const orderHash of await this.options.store.listOpenOrders()) {
      const tickets = await this.options.store.withOrder(orderHash, (tx) => tx.listTickets());
      for (const record of tickets) {
        if (this.busy.has(key(orderHash, record.attempt))) continue;
        await this.exclusive(orderHash, record.attempt, () => this.resumeOne(orderHash, record)).catch((error: unknown) =>
          this.options.logger.warn('tickets: resume of an attempt failed', { orderHash, attempt: record.attempt, error: String(error) }),
        );
      }
    }
  }

  private async resumeOne(orderHash: Hex, record: TicketRecord): Promise<void> {
    const attempt = record.attempt;
    switch (record.state) {
      case 'offered':
        if (record.offer) await this.decide(orderHash, record.offer);
        return;
      case 'intent-sent':
        if (record.intent && record.offer && !record.intentAck) await this.send(orderHash, attempt, { action: 'intent', message: record.intent, deadlineMs: record.offer.acceptBy }, 'ticket.intent.sent');
        return;
      case 'issued':
      case 'checking':
        await this.check(orderHash, attempt);
        return;
      case 'receipted':
      case 'declined': {
        if (record.sentAtMs !== undefined) return;
        const message = record.state === 'receipted' ? record.receipt : record.decline;
        if (!message) return;
        const deadlineMs = record.issued ? Number(record.issued.form === 'evm' ? record.issued.ticket.validUntil : (record.issued as { validUntil: string }).validUntil) * 1000 : (record.offer?.acceptBy ?? 0);
        await this.send(orderHash, attempt, { action: record.state === 'receipted' ? 'receipt' : 'decline', message, deadlineMs }, record.state === 'receipted' ? 'ticket.receipted' : 'ticket.declined');
        return;
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------------

  /** A compare-and-set under the order lock: writes `next(record)` only from one of `from`. */
  private async move(orderHash: Hex, attempt: number, from: readonly TicketState[], next: (record: TicketRecord) => TicketRecord): Promise<boolean> {
    return this.options.store.withOrder(orderHash, async (tx) => {
      const record = await tx.getTicket(attempt);
      if (!record || !from.includes(record.state)) return false;
      const { sentAtMs: _sent, unsent: _unsent, ...rest } = record;
      await tx.putTicket({ ...next(rest as TicketRecord), updatedAtMs: await this.options.store.now() });
      return true;
    });
  }

  /** Sends the stored message of the current state, then records that it went. Never after its deadline. */
  private async send(orderHash: Hex, attempt: number, out: Outgoing, stage: FillerStage): Promise<void> {
    if (this.options.clock.now() > out.deadlineMs) {
      this.options.logger.warn('tickets: deadline passed, not sent', { orderHash, attempt, action: out.action });
      await this.markSent(orderHash, attempt, out, true);
      return;
    }
    try {
      await this.options.protocol.submitTicket({ action: out.action, message: out.message } as TicketAction);
    } catch (error) {
      // TICKET_CLOSED and the like: filler-gateway refused; the state stays as written.
      this.options.logger.warn('tickets: filler-gateway refused', { orderHash, attempt, action: out.action, error: String(error) });
      return;
    }
    await this.markSent(orderHash, attempt, out, false);
    this.stage(stage, orderHash, attempt, out.action === 'decline' ? { reason: String((out.message as TicketDecline).reason) } : {});
  }

  /** Records that the message of the current state went out — or, `unsent`, that it never will. */
  private async markSent(orderHash: Hex, attempt: number, out: Outgoing, unsent: boolean): Promise<void> {
    await this.options.store.withOrder(orderHash, async (tx) => {
      const record = await tx.getTicket(attempt);
      const current = out.action === 'intent' ? record?.intent : out.action === 'receipt' ? record?.receipt : record?.decline;
      if (record && current?.id === out.message.id && record.sentAtMs === undefined) {
        await tx.putTicket({ ...record, sentAtMs: this.options.clock.now(), ...(unsent ? { unsent: true as const } : {}), updatedAtMs: await this.options.store.now() });
      }
    });
  }

  private async exclusive(orderHash: Hex, attempt: number, work: () => Promise<void>): Promise<void> {
    const k = key(orderHash, attempt);
    if (this.busy.has(k)) return;
    this.busy.add(k);
    try {
      await work();
    } finally {
      this.busy.delete(k);
    }
  }

  private declined(orderHash: Hex, attempt: number, reason: DeclineReason, detail: string): void {
    this.options.logger.info('tickets: declined', { orderHash, attempt, reason, detail });
    this.emit({ type: 'declined', orderHash, attempt, reason });
  }

  private stage(stage: FillerStage, orderHash: Hex, attempt: number, detail: Readonly<Record<string, string | number | boolean>>): void {
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
