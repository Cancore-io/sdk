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
 *   is signed once: a message that did not go out is sent again — the same
 *   bytes — on a retry timer and after every login, while its deadline lasts:
 *   `acceptBy` for an intent or an offer-stage decline, `validUntil` for an
 *   issued-stage decline, and `validUntil − sendGuard` for a receipt. A
 *   receipt that can no longer leave in time is turned into a decline
 *   (`TICKET_TTL_TOO_SHORT`): a filler is never bound to a delivery it can
 *   no longer make.
 * - **One writer per move.** A move is a compare-and-set under the lock: it
 *   happens only from the state it was decided in, so two replicas (or a
 *   handler and a resume) never both send a different answer for one attempt.
 * - **One worker per attempt in a process.** Work on an attempt is serialised;
 *   a request that arrives while it runs is not dropped — the worker reads the
 *   state again when it is done and takes the next step.
 * - **Receipt only after the checks** (T-22). The receipt is signed only from
 *   `checking`, after `TicketVerifier` passed; any failed or unverifiable
 *   check declines with its code instead (T-23). `receipted()` is the only
 *   way the delivery learns it may fill.
 * - **Silence costs more than a decline** (T-21): a hook that does not answer
 *   before `acceptBy − offerReplyMarginMs`, or throws, declines `OTHER`; so does
 *   a signer that fails. The kill-switch declines `PAUSED` without the hook.
 * - **Restart.** After every login the open attempts are resumed from the store.
 */
import type { DeclineReason, Hex, OrderSettled, PenaltyApplied, TicketDecline, TicketExpired, TicketIntentMessage, TicketIssued, TicketOffer, TicketReceiptMessage } from '@cancore/contracts';
import { EXPIRED_RESULTS } from '@cancore/contracts';
import type { FillerChains } from '../chain';
import type { EvmChainId } from '../chains';
import type { EventSink, FillerEvent, FillerStage } from '../events';
import type { Delivery, FillerProtocolClient } from '../protocol/client';
import type { TicketAction } from '../protocol/rest';
import type { Clock, Logger } from '../runtime';
import type { FillSigner, QuoteSigner } from '../signer';
import type { FillerStore, TicketRecord, TicketState } from '../store';
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
/** A message filler-gateway did not take is tried again after this long, while its deadline lasts. */
export const SEND_RETRY_MS = 1_000;

export interface TicketDeskOptions {
  store: FillerStore;
  protocol: FillerProtocolClient;
  verifier: TicketVerifier;
  /** For each destination's `sendGuardSec`. */
  chains: FillerChains;
  fillSigners: { readonly [chain: EvmChainId]: FillSigner };
  fillerId: string;
  /** The filler's Canton party, the payee of a Canton source. */
  cantonParty?: string;
  /** The message key: signs the consent and the receipt (protocol T-3). */
  messageSigner: QuoteSigner;
  clock: Clock;
  logger: Logger;
  events: EventSink;
  nextId: () => string;
  onTicketOffer: () => TicketOfferHook | undefined;
  offerReplyMarginMs: number;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const isAttempt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const TERMINAL: ReadonlySet<TicketState> = new Set(['expired', 'filled']);
const key = (orderHash: string, attempt: number) => `${orderHash.toLowerCase()}:${attempt}`;

type Outgoing = { action: 'intent' | 'receipt' | 'decline'; message: TicketAction['message']; deadlineMs: number };

/** `validUntil` of an issued ticket, unix ms; 0 when it does not parse (then nothing is sent). */
function validUntilMs(issued: TicketIssued | undefined): number {
  const raw = issued?.form === 'evm' ? issued.ticket?.validUntil : (issued as { validUntil?: unknown } | undefined)?.validUntil;
  const ms = Number(raw) * 1000;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : 0;
}

export class TicketDesk {
  /** The worker of each attempt this process is moving; `again` asks it for one more step. */
  private readonly busy = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();

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
    return record?.state === 'receipted' && record.sentAtMs !== undefined && !record.unsent && record.receipt ? record : undefined;
  }

  // -- frames ------------------------------------------------------------------

  /** Stores the offer and hands the attempt to its worker; returns without waiting for the hook. */
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
    void this.work(orderHash, offer.attempt);
  }

  /** Stores the issued ticket (moving the attempt to `checking`) and hands it to its worker. */
  async onIssued(delivery: Delivery): Promise<void> {
    const issued = delivery.frame as unknown as TicketIssued;
    if (!HEX32.test(String(issued.orderHash)) || !isAttempt(issued.attempt)) {
      this.options.logger.warn('tickets: malformed ticket.issued ignored');
      return;
    }
    const orderHash = issued.orderHash.toLowerCase() as Hex;
    const issuedAtMs = this.options.clock.now();
    const taken = await this.options.store.withOrder(orderHash, async (tx) => {
      const record = await tx.getTicket(issued.attempt);
      const now = await this.options.store.now();
      if (!record) {
        // No offer to hold the ticket to: it is checked (and refused) all the same, never receipted.
        await tx.putTicket({ orderHash, attempt: issued.attempt, state: 'checking', issued, issuedAtMs, updatedAtMs: now });
        return true;
      }
      if (record.issued || (record.state !== 'intent-sent' && record.state !== 'intent-acked' && record.state !== 'offered')) return false;
      // The protocol client wrote the arrival time when the frame came in (V-T4); keep it.
      await tx.putTicket({ ...record, state: 'checking', issued, issuedAtMs: record.issuedAtMs ?? issuedAtMs, updatedAtMs: now });
      return true;
    });
    if (!taken) return;
    this.stage('ticket.issued', orderHash, issued.attempt, { form: String(issued.form), channel: delivery.channel });
    void this.work(orderHash, issued.attempt);
  }

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
   * Hands every open attempt in the store to its worker: an unanswered offer is
   * decided, a stored message that never went out is sent (while its deadline
   * lasts), an interrupted check is run again. Called after every login.
   */
  async resume(): Promise<void> {
    for (const orderHash of await this.options.store.listOpenOrders()) {
      const tickets = await this.options.store.withOrder(orderHash, (tx) => tx.listTickets());
      for (const record of tickets) if (!TERMINAL.has(record.state)) void this.work(orderHash, record.attempt);
    }
  }

  // -- the worker -------------------------------------------------------------------

  /**
   * Runs the next step of an attempt, one worker per attempt: while one runs,
   * a further call only asks it to read the state again and step once more.
   * Resolves when the worker is done.
   */
  work(orderHash: Hex, attempt: number): Promise<void> {
    const k = key(orderHash, attempt);
    const running = this.busy.get(k);
    if (running) {
      this.again.add(k);
      return running;
    }
    const worker = (async () => {
      try {
        do {
          this.again.delete(k);
          await this.step(orderHash, attempt);
        } while (this.again.has(k));
      } catch (error) {
        this.options.logger.error('tickets: step failed', { orderHash, attempt, error: String(error) });
      } finally {
        this.busy.delete(k);
      }
    })();
    this.busy.set(k, worker);
    return worker;
  }

  /** One step, from the state the store holds now. */
  private async step(orderHash: Hex, attempt: number): Promise<void> {
    const record = await this.options.store.withOrder(orderHash, (tx) => tx.getTicket(attempt));
    if (!record) return;
    switch (record.state) {
      case 'offered':
        if (record.offer) await this.decide(orderHash, record.offer);
        return;
      case 'intent-sent':
        if (record.intent && record.offer && record.sentAtMs === undefined) {
          await this.send(orderHash, attempt, { action: 'intent', message: record.intent, deadlineMs: record.offer.acceptBy }, 'ticket.intent.sent');
        }
        return;
      case 'issued':
      case 'checking':
        await this.check(orderHash, record);
        return;
      case 'receipted':
        if (record.sentAtMs === undefined) await this.deliverReceipt(orderHash, record);
        return;
      case 'declined':
        if (record.sentAtMs === undefined && record.decline) {
          const deadlineMs = record.issued ? validUntilMs(record.issued) : (record.offer?.acceptBy ?? 0);
          await this.send(orderHash, attempt, { action: 'decline', message: record.decline, deadlineMs }, 'ticket.declined');
        }
        return;
      default:
        return;
    }
  }

  // -- the offer --------------------------------------------------------------------

  /** Asks the hook (or declines without it) and answers before `acceptBy`. */
  private async decide(orderHash: Hex, offer: TicketOffer): Promise<void> {
    const { clock, logger } = this.options;
    const attempt = offer.attempt;
    const decline = (reason: OfferDeclineReason, detail: string) => this.decline(orderHash, attempt, ['offered'], reason, detail);
    if (clock.now() > offer.acceptBy) return this.giveUp(orderHash, attempt, 'acceptBy passed before an answer');
    if ((await this.options.store.getOverrides()).paused) return decline('PAUSED', 'the kill-switch is on');
    const identity = identityFor(offer.order, this.options);
    if (!identity) return decline('OTHER', 'no fill key or payee of this filler for the order');

    const decision = await this.askHook(offer);
    if (clock.now() > offer.acceptBy) return this.giveUp(orderHash, attempt, 'the hook answered after acceptBy');
    if (decision !== 'accept') return decline(decision.reason, decision.detail);

    let intent;
    try {
      intent = await this.options.protocol.seal<TicketIntentMessage>(await signTicketIntent(offer, identity, this.options.messageSigner, this.options.nextId()));
    } catch (error) {
      logger.error('tickets: the intent could not be signed', { orderHash, attempt, error: String(error) });
      return decline('OTHER', 'the consent could not be signed');
    }
    const moved = await this.move(orderHash, attempt, ['offered'], (record) => ({ ...record, state: 'intent-sent', intent }));
    if (!moved) return;
    logger.info('tickets: intent', { orderHash, attempt });
    await this.send(orderHash, attempt, { action: 'intent', message: intent, deadlineMs: offer.acceptBy }, 'ticket.intent.sent');
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

  /** No answer can reach filler-gateway in time: the attempt ends here, nothing is sent. */
  private async giveUp(orderHash: Hex, attempt: number, why: string): Promise<void> {
    const decline = await this.options.protocol.seal<TicketDecline>({ type: 'ticket.decline', id: this.options.nextId(), orderHash, attempt, reason: 'OTHER', detail: why });
    const moved = await this.move(orderHash, attempt, ['offered'], (record) => ({ ...record, state: 'declined', decline, sentAtMs: this.options.clock.now(), unsent: true }));
    if (moved) this.options.logger.warn('tickets: offer left unanswered', { orderHash, attempt, why });
  }

  // -- the issued ticket --------------------------------------------------------------

  /** Runs the checks for a `checking` attempt and answers: a receipt only when every check passed. */
  private async check(orderHash: Hex, record: TicketRecord): Promise<void> {
    const attempt = record.attempt;
    if (!record.issued) return;
    if (!record.offer) return this.decline(orderHash, attempt, ['checking', 'issued'], 'OTHER', 'no ticket.offer for this attempt');
    if (!record.intent) return this.decline(orderHash, attempt, ['checking', 'issued'], 'OTHER', 'no ticket.intent was sent for this attempt');
    let verdict: Awaited<ReturnType<TicketVerifier['verify']>>;
    try {
      verdict =
        record.issuedAtMs === undefined
          ? { ok: false, reason: 'TICKET_ISSUED_LATE', detail: 'V-T4: unverifiable: the arrival of ticket.issued is not recorded', checks: [] }
          : await this.options.verifier.verify({ offer: record.offer, issued: record.issued, issuedAtMs: record.issuedAtMs, intent: record.intent });
    } catch (error) {
      this.options.logger.error('tickets: the checks failed to run', { orderHash, attempt, error: String(error) });
      verdict = { ok: false, reason: 'OTHER', detail: 'the checks failed to run', checks: [] };
    }
    const identity = identityFor(record.offer.order, this.options);
    if (!verdict.ok || record.issued.form !== 'evm' || !identity) {
      return this.decline(orderHash, attempt, ['checking', 'issued'], verdict.reason ?? 'OTHER', verdict.detail ?? 'refused');
    }
    if (this.options.clock.now() > this.receiptDeadline(record)) {
      return this.decline(orderHash, attempt, ['checking', 'issued'], 'TICKET_TTL_TOO_SHORT', 'send-guard: no time left to deliver after the checks');
    }
    let receipt;
    try {
      receipt = await this.options.protocol.seal<TicketReceiptMessage>(await signTicketReceipt(record.issued.ticket, record.issued.ticketSig, this.options.messageSigner, this.options.nextId()));
    } catch (error) {
      this.options.logger.error('tickets: the receipt could not be signed', { orderHash, attempt, error: String(error) });
      return this.decline(orderHash, attempt, ['checking', 'issued'], 'OTHER', 'the receipt could not be signed');
    }
    const moved = await this.move(orderHash, attempt, ['checking', 'issued'], (r) => ({ ...r, state: 'receipted', receipt }));
    if (!moved) return;
    this.options.logger.info('tickets: receipt', { orderHash, attempt });
    const stored = await this.options.store.withOrder(orderHash, (tx) => tx.getTicket(attempt));
    if (stored) await this.deliverReceipt(orderHash, stored);
  }

  /** `validUntil − sendGuard`: the last moment a receipt may bind the filler (V-T3, T-29). */
  private receiptDeadline(record: TicketRecord): number {
    const identity = record.offer ? identityFor(record.offer.order, this.options) : undefined;
    const guardSec = identity ? this.options.chains.get(identity.chain)?.config.sendGuardSec : undefined;
    if (guardSec === undefined) return 0;
    return validUntilMs(record.issued) - guardSec * 1000;
  }

  /**
   * Sends a stored receipt while `validUntil − sendGuard` lasts. Past it the
   * receipt never goes out: the attempt is declined `TICKET_TTL_TOO_SHORT`
   * while the decline can still reach filler-gateway.
   */
  private async deliverReceipt(orderHash: Hex, record: TicketRecord): Promise<void> {
    if (!record.receipt) return;
    const deadlineMs = this.receiptDeadline(record);
    if (this.options.clock.now() <= deadlineMs) {
      await this.send(orderHash, record.attempt, { action: 'receipt', message: record.receipt, deadlineMs }, 'ticket.receipted');
      return;
    }
    await this.decline(orderHash, record.attempt, ['receipted'], 'TICKET_TTL_TOO_SHORT', 'send-guard: the receipt could not leave in time', (r) => r.sentAtMs === undefined);
  }

  // -- moves and sending ----------------------------------------------------------------

  /** Moves the attempt to `declined` from one of `from`, then sends the decline. */
  private async decline(orderHash: Hex, attempt: number, from: readonly TicketState[], reason: DeclineReason, detail: string, when?: (record: TicketRecord) => boolean): Promise<void> {
    const decline = await this.options.protocol.seal<TicketDecline>({ type: 'ticket.decline', id: this.options.nextId(), orderHash, attempt, reason, detail: detail.slice(0, 256) });
    let deadlineMs = 0;
    const moved = await this.move(
      orderHash,
      attempt,
      from,
      (record) => {
        deadlineMs = record.issued ? validUntilMs(record.issued) : (record.offer?.acceptBy ?? 0);
        return { ...record, state: 'declined', decline };
      },
      when,
    );
    if (!moved) return;
    this.options.logger.info('tickets: declined', { orderHash, attempt, reason, detail });
    this.emit({ type: 'declined', orderHash, attempt, reason });
    await this.send(orderHash, attempt, { action: 'decline', message: decline, deadlineMs }, 'ticket.declined');
  }

  /** A compare-and-set under the order lock: writes `next(record)` only from one of `from` (and when `when` holds). */
  private async move(orderHash: Hex, attempt: number, from: readonly TicketState[], next: (record: TicketRecord) => TicketRecord, when?: (record: TicketRecord) => boolean): Promise<boolean> {
    return this.options.store.withOrder(orderHash, async (tx) => {
      const record = await tx.getTicket(attempt);
      if (!record || !from.includes(record.state) || (when && !when(record))) return false;
      const { sentAtMs: _sent, unsent: _unsent, ...rest } = record;
      await tx.putTicket({ ...next(rest as TicketRecord), updatedAtMs: await this.options.store.now() });
      return true;
    });
  }

  /**
   * Sends the stored message of the current state and records that it went.
   * Past its deadline it is marked `unsent` and never sent; refused by
   * filler-gateway or the network, it is tried again after `SEND_RETRY_MS`.
   */
  private async send(orderHash: Hex, attempt: number, out: Outgoing, stage: FillerStage): Promise<void> {
    if (this.options.clock.now() > out.deadlineMs) {
      this.options.logger.warn('tickets: deadline passed, not sent', { orderHash, attempt, action: out.action });
      await this.markSent(orderHash, attempt, out, true);
      return;
    }
    try {
      await this.options.protocol.submitTicket({ action: out.action, message: out.message } as TicketAction);
    } catch (error) {
      this.options.logger.warn('tickets: not delivered to filler-gateway', { orderHash, attempt, action: out.action, error: String(error) });
      if (this.options.clock.now() + SEND_RETRY_MS <= out.deadlineMs) this.options.clock.schedule(SEND_RETRY_MS, () => void this.work(orderHash, attempt));
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
