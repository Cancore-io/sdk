/**
 * Quotes: `quote.request` → `onQuoteRequest` → signed `FillerQuote`, and
 * `quote.reconfirm` → `onReconfirm` → `quote.reconfirm.reply` (protocol §3.5
 * «Quotes», fillers.md T-16, T-18, T-20).
 *
 * The SDK prices nothing; it hands the hook the payout the source will pay
 * for the request (fee included, §3.11: the router formula on an EVM source,
 * the ledger formula on a Canton source, T-12), then holds the hook's answer to
 * the wire rules before it signs:
 *
 * - not after `windowCloseAt` (checked before and after the hook, and after signing);
 * - `validUntil × 1000 ≥ windowCloseAt + quoteTtlMs` (the boundary counts);
 * - not below the source router's `minInput` (T-16);
 * - `nonce` strictly greater than any nonce of this quote key for the
 *   `requestId`, on any replica and across restarts (the store allocates it);
 * - a reconfirm is accepted only at `order.minReceived` — the price does not
 *   change (T-20) — and only before `replyBy`.
 *
 * A sent quote is stored before it goes out, so its `quote.ack` (attached by
 * the protocol client) has a quote to land on, and it stays in the store as
 * the firm price until its `validUntil` (T-4).
 */
import {
  FILLER_PROTOCOL_DOMAIN,
  FILLER_QUOTE_TYPES,
  hashTypedData,
  requestIdHash,
  type DecString,
  type Hex,
  type OrderJson,
  type QuoteMessage,
  type QuoteReconfirm,
  type QuoteReconfirmReply,
  type QuoteRequest,
  type TypedDataInput,
} from '@cancore/contracts';
import { isEvmChainId, type EvmChainId } from './chains';
import type { EventSink, FillerStage } from './events';
import type { Delivery, FillerProtocolClient } from './protocol/client';
import type { Clock, Logger } from './runtime';
import { signTypedDataChecked, type FillSigner, type QuoteSigner } from './signer';
import type { FillerStore, StoredQuote } from './store';

// ---------------------------------------------------------------------------
// The payout
// ---------------------------------------------------------------------------

const BPS = 10_000n;
const UINT64 = 1n << 64n;
const UINT256 = 1n << 256n;

function checkPayoutInput(fn: string, total: bigint, feeBps: number): void {
  if (total < 0n) throw new RangeError(`${fn}: total must be non-negative`);
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > 0xffff) throw new RangeError(`${fn}: feeBps must be a uint16`);
}

/**
 * What an EVM source router pays the filler for a deposited total `T`
 * (protocol §3.11, `CancoreRouter.sol:664-665`): `⌊T × 10 000 / (10 000 + feeBps)⌋`.
 * Rounding dust goes to the fee. `T = 105`, `feeBps = 500` → 100.
 */
export function evmFillerPayout(total: bigint, feeBps: number): bigint {
  checkPayoutInput('evmFillerPayout', total, feeBps);
  return (total * BPS) / (BPS + BigInt(feeBps));
}

/**
 * What a Canton-source `SwapIntent_Settle` pays the filler (protocol §3.11,
 * T-12; `SwapIntent.daml:207-208`, `:598-601`). The ledger computes
 * `amount − (amount − amount / (1.0 + feeRate))` in Daml `Numeric 10`, where
 * only the division rounds — to nearest, ties to even. In the EVM-form units
 * of §3.7 (`T = amount × 10¹⁰`, `feeBps = feeRate × 10 000`) that is
 * `roundHalfEven(T × 10 000 / (10 000 + feeBps))`. It equals the EVM formula
 * or exceeds it by one unit. `T = 1000.0`, `feeRate 0.003` → `997.0089730808`.
 */
export function cantonFillerPayout(total: bigint, feeBps: number): bigint {
  checkPayoutInput('cantonFillerPayout', total, feeBps);
  const divisor = BPS + BigInt(feeBps);
  const numerator = total * BPS;
  const quotient = numerator / divisor;
  const twiceRemainder = 2n * (numerator % divisor);
  return twiceRemainder > divisor || (twiceRemainder === divisor && quotient % 2n === 1n) ? quotient + 1n : quotient;
}

// ---------------------------------------------------------------------------
// What the hooks see
// ---------------------------------------------------------------------------

/** A `quote.request` with the payout it implies. */
export interface FillerQuoteRequest extends QuoteRequest {
  /** What the source pays the filler for `inputAmount`, source input base units (§3.11; Canton source: T-12). */
  payout: bigint;
  /** `inputAmount − payout`. */
  fee: bigint;
}

/** A `quote.reconfirm` with the payout of its opened order. */
export interface FillerReconfirm extends QuoteReconfirm {
  /** What the source pays the filler for `order.inputAmount`, source input base units (§3.11; Canton source: T-12). */
  payout: bigint;
  /** `order.inputAmount − payout`. */
  fee: bigint;
}

// ---------------------------------------------------------------------------
// Why a quote was not sent
// ---------------------------------------------------------------------------

export type QuoteSkipReason =
  /** A byte-identical `quote.request` was handled already (another session or replica). */
  | 'redelivered'
  /** The kill-switch is on (N-13). */
  | 'paused'
  /** Malformed request: `requestId`, amounts, `feeBps`, times. */
  | 'malformed'
  /** No fill key for the chain whose address the quote must name. */
  | 'no-fill-key'
  /** `inputAmount` below the source router's `minInput` (T-16). */
  | 'below-min-input'
  /** The source router's `minInput` could not be read: no quote on a floor the filler did not see. */
  | 'chain-unavailable'
  /** `windowCloseAt` passed (before or after the hook, or after signing). */
  | 'late'
  /** The hook returned null. */
  | 'declined'
  /** The hook threw. */
  | 'hook-failed'
  /** The hook returned an amount or time that is not a uint256 / uint64, or a zero amount. */
  | 'invalid-decision'
  /** `validUntil × 1000 < windowCloseAt + quoteTtlMs`. */
  | 'short-ttl'
  /** No live session: a quote has no REST route. */
  | 'disconnected';

/** The decline reasons of a `quote.reconfirm`. */
export type ReconfirmDeclineReason = 'paused' | 'malformed' | 'no-fill-key' | 'price-changed' | 'declined' | 'hook-failed';

// ---------------------------------------------------------------------------
// The desk
// ---------------------------------------------------------------------------

export interface QuoteDecisionInput {
  amountOut: bigint | DecString;
  validUntil: bigint | DecString;
}

/** The minimum `inputAmount` the source router of `chain` accepts for `token`; undefined when there is none to read; rejects when the read failed. */
export type MinInputSource = (chain: string, token: unknown) => Promise<bigint | undefined>;

export interface QuoteDeskOptions {
  quoteSigner: QuoteSigner;
  fillSigners: { readonly [chain: EvmChainId]: FillSigner };
  store: FillerStore;
  protocol: FillerProtocolClient;
  clock: Clock;
  logger: Logger;
  events: EventSink;
  nextId: () => string;
  onQuoteRequest: () => ((request: FillerQuoteRequest) => Promise<QuoteDecisionInput | null>) | undefined;
  onReconfirm: () => ((reconfirm: FillerReconfirm) => Promise<boolean>) | undefined;
  minInput: MinInputSource;
  /** Seconds a reconfirmed price stays firm beyond `replyBy + ticketTtl`. */
  reconfirmMarginS: number;
  /** How far back `GET /v1/filler/quotes?since=` reaches after a login. */
  reconcileLookbackMs: number;
}

/** `validUntil` of a reconfirm reply covers `replyBy + ticketTtl` plus this margin (s). */
export const DEFAULT_RECONFIRM_MARGIN_S = 30;
/** Reconciliation after a login looks this far back. */
export const DEFAULT_RECONCILE_LOOKBACK_MS = 15 * 60_000;

/** Lower bound of the Canton origin ids (`CANTON_ORIGIN_ID` = 2⁶³ + n, protocol §3.8). */
const CANTON_ORIGIN_FLOOR = 1n << 63n;
const DEC = /^(0|[1-9][0-9]*)$/;

const decimal = (value: unknown): bigint | undefined => (typeof value === 'string' && DEC.test(value) ? BigInt(value) : undefined);
const millis = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

function uintOf(value: unknown, bound: bigint): bigint | undefined {
  const n = typeof value === 'bigint' ? value : decimal(value);
  return n !== undefined && n >= 0n && n < bound ? n : undefined;
}

export interface ReconcileReport {
  /** Items returned by `GET /v1/filler/quotes`. */
  seen: number;
  /** Acks attached now that the store had missed. */
  acksRecovered: number;
  /** Quotes filler-gateway holds that this store does not. */
  unknownToStore: number;
}

export class QuoteDesk {
  constructor(private readonly options: QuoteDeskOptions) {}

  /** Wires the desk to the protocol client. */
  register(): void {
    this.options.protocol.on('quote.request', async (delivery) => void (await this.onRequest(delivery)));
    this.options.protocol.on('quote.reconfirm', async (delivery) => void (await this.onReconfirm(delivery)));
    this.options.protocol.onLogin(() => {
      void this.reconcile(this.options.clock.now() - this.options.reconcileLookbackMs).catch((error: unknown) =>
        this.options.logger.warn('quotes: reconciliation failed', { error: String(error) }),
      );
    });
  }

  // -- quote.request ---------------------------------------------------------

  /** Handles one `quote.request`; resolves to what was sent, or why nothing was. */
  async onRequest(delivery: Delivery): Promise<{ sent: StoredQuote } | { skipped: QuoteSkipReason }> {
    const request = delivery.frame as unknown as QuoteRequest;
    const requestId = typeof request.requestId === 'string' ? request.requestId : '';
    const skip = (reason: QuoteSkipReason, fields: Record<string, string | number | boolean> = {}) => {
      this.stage('quote.skipped', requestId, { reason, ...fields });
      if (reason !== 'declined' && reason !== 'redelivered') this.options.logger.info('quotes: request not quoted', { requestId, reason, ...fields });
      return { skipped: reason };
    };
    this.stage('quote.requested', requestId, { channel: delivery.channel });
    if (!delivery.firstSeen) return skip('redelivered');

    const parsed = this.parseRequest(request);
    if (typeof parsed === 'string') return skip(parsed === 'malformed' ? 'malformed' : parsed);
    const { total, windowCloseAt, quoteTtlMs, filler, payoutOf } = parsed;

    if (this.options.clock.now() >= windowCloseAt) return skip('late');
    if ((await this.options.store.getOverrides()).paused) return skip('paused');

    let minInput: bigint | undefined;
    try {
      minInput = await this.options.minInput(request.route.src, request.inputToken);
    } catch (error) {
      return skip('chain-unavailable', { error: String(error) });
    }
    if (minInput !== undefined && total < minInput) return skip('below-min-input', { minInput: minInput.toString() });

    const hook = this.options.onQuoteRequest();
    if (!hook) return skip('hook-failed');
    const payout = payoutOf(total, request.feeBps);
    let decision: QuoteDecisionInput | null;
    try {
      decision = await hook({ ...request, payout, fee: total - payout });
    } catch (error) {
      this.options.logger.error('quotes: onQuoteRequest threw', { requestId, error: String(error) });
      return skip('hook-failed');
    }
    if (decision === null) return skip('declined');
    const amountOut = uintOf(decision?.amountOut, UINT256);
    const validUntil = uintOf(decision?.validUntil, UINT64);
    if (amountOut === undefined || amountOut === 0n || validUntil === undefined) return skip('invalid-decision');
    if (validUntil * 1000n < BigInt(windowCloseAt) + BigInt(quoteTtlMs)) return skip('short-ttl', { validUntil: validUntil.toString() });
    if (this.options.clock.now() >= windowCloseAt) return skip('late', { after: 'hook' });
    if (!this.options.protocol.connected) return skip('disconnected');

    const nonce = await this.options.store.quotes.nextNonce(requestId, this.options.quoteSigner.address.toLowerCase() as Hex);
    const { message, quoteHash } = await this.sign(requestId, filler, amountOut, validUntil, nonce);
    if (this.options.clock.now() >= windowCloseAt) return skip('late', { after: 'signing' });

    const quote: QuoteMessage = {
      type: 'quote',
      id: this.options.nextId(),
      requestId,
      filler,
      amountOut: amountOut.toString(),
      validUntil: validUntil.toString(),
      nonce: nonce.toString(),
      sig: message.sig,
    };
    const stored: StoredQuote = { requestId, quoteHash, quote, sentAtMs: this.options.clock.now() };
    await this.options.store.quotes.recordQuote(stored);
    if (!this.options.protocol.send(quote)) return skip('disconnected', { stored: true });
    this.stage('quote.sent', requestId, { nonce: Number(nonce) });
    return { sent: stored };
  }

  /** The quote of `requestId` that is firm at `atMs` (unix ms): the newest one sent whose `validUntil` has not passed (T-4). */
  async firmQuote(requestId: string, atMs: number = this.options.clock.now()): Promise<StoredQuote | undefined> {
    const quotes = await this.options.store.quotes.listQuotes(requestId);
    const live = quotes.filter((q) => BigInt(q.quote.validUntil) * 1000n > BigInt(atMs));
    return live.sort((a, b) => (BigInt(a.quote.nonce) < BigInt(b.quote.nonce) ? -1 : 1)).at(-1);
  }

  // -- quote.reconfirm -------------------------------------------------------

  /**
   * Handles one `quote.reconfirm`: accepts at `order.minReceived` with a
   * signed `FillerQuote` and a fresh nonce, or declines — always before
   * `replyBy`; after it, nothing is sent.
   */
  async onReconfirm(delivery: Delivery): Promise<{ reply: QuoteReconfirmReply } | { skipped: 'redelivered' | 'late' | 'malformed' | 'disconnected' }> {
    const reconfirm = delivery.frame as unknown as QuoteReconfirm;
    if (!delivery.firstSeen) return { skipped: 'redelivered' };
    const replyBy = millis(reconfirm.replyBy);
    const ticketTtl = millis(reconfirm.ticketTtl);
    const orderHash = typeof reconfirm.orderHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(reconfirm.orderHash) ? (reconfirm.orderHash.toLowerCase() as Hex) : undefined;
    const requestId = typeof reconfirm.requestId === 'string' ? reconfirm.requestId : undefined;
    if (replyBy === undefined || ticketTtl === undefined || !orderHash || !requestId) {
      this.options.logger.warn('quotes: malformed quote.reconfirm ignored');
      return { skipped: 'malformed' };
    }
    if (this.options.clock.now() >= replyBy) return { skipped: 'late' };

    const decline = (reason: ReconfirmDeclineReason) => {
      this.options.logger.info('quotes: reconfirm declined', { orderHash, reason });
      return this.reply({ type: 'quote.reconfirm.reply', id: this.options.nextId(), orderHash, accept: false }, replyBy, reason);
    };

    const order = reconfirm.order as OrderJson | undefined;
    const minReceived = decimal(order?.minReceived);
    const amountOut = decimal(reconfirm.amountOut);
    const total = decimal(order?.inputAmount);
    const feeBps = Number(order?.feeBps);
    const origin = decimal(order?.originChainId);
    if (!order || minReceived === undefined || amountOut === undefined || total === undefined || origin === undefined || !Number.isSafeInteger(feeBps)) {
      return decline('malformed');
    }
    if (amountOut !== minReceived) return decline('price-changed');
    // T-12: a Canton source pays by the ledger formula, never the EVM one.
    const payoutOf = origin >= CANTON_ORIGIN_FLOOR ? cantonFillerPayout : evmFillerPayout;
    const filler = this.fillerForOrder(origin, order.destination);
    if (!filler) return decline('no-fill-key');
    if ((await this.options.store.getOverrides()).paused) return decline('paused');

    const hook = this.options.onReconfirm();
    if (!hook) return decline('hook-failed');
    let accept: boolean;
    try {
      const payout = payoutOf(total, feeBps);
      accept = (await hook({ ...reconfirm, payout, fee: total - payout })) === true;
    } catch (error) {
      this.options.logger.error('quotes: onReconfirm threw', { orderHash, error: String(error) });
      return decline('hook-failed');
    }
    if (!accept) return decline('declined');
    if (this.options.clock.now() >= replyBy) return { skipped: 'late' };

    const validUntil = BigInt(Math.ceil(replyBy / 1000) + ticketTtl + this.options.reconfirmMarginS);
    const nonce = await this.options.store.quotes.nextNonce(requestId, this.options.quoteSigner.address.toLowerCase() as Hex);
    const { message, quoteHash } = await this.sign(requestId, filler, minReceived, validUntil, nonce);
    const reply: QuoteReconfirmReply = {
      type: 'quote.reconfirm.reply',
      id: this.options.nextId(),
      orderHash,
      accept: true,
      validUntil: validUntil.toString(),
      nonce: nonce.toString(),
      sig: message.sig,
    };
    // The reconfirmed price is a quote like any other: firm until validUntil (T-4).
    await this.options.store.quotes.recordQuote({
      requestId,
      quoteHash,
      quote: { type: 'quote', id: reply.id, requestId, filler, amountOut: minReceived.toString(), validUntil: reply.validUntil!, nonce: reply.nonce!, sig: message.sig },
      sentAtMs: this.options.clock.now(),
    });
    return this.reply(reply, replyBy, 'accepted');
  }

  // -- reconciliation ---------------------------------------------------------

  /**
   * `GET /v1/filler/quotes?since=`: attaches every verified ack the store
   * missed (sent while this replica was away) and counts quotes filler-gateway
   * holds that the store does not.
   */
  async reconcile(sinceMs: number): Promise<ReconcileReport> {
    const items = await this.options.protocol.listQuotes(sinceMs);
    const report: ReconcileReport = { seen: items.length, acksRecovered: 0, unknownToStore: 0 };
    for (const item of items) {
      const quoteHash = String(item.ack.frame.quoteHash).toLowerCase() as Hex;
      const mine = (await this.options.store.quotes.listQuotes(item.quote.requestId)).find((q) => q.quoteHash.toLowerCase() === quoteHash);
      if (!mine) {
        report.unknownToStore++;
        this.options.logger.warn('quotes: filler-gateway holds a quote the store does not', { requestId: item.quote.requestId, quoteHash, status: item.status });
        continue;
      }
      if (mine.ack) continue;
      // Through the client, so the ack is journalled and attached like a WebSocket frame.
      await this.options.protocol.ingest(item.ack, 'rest');
      const after = (await this.options.store.quotes.listQuotes(item.quote.requestId)).find((q) => q.quoteHash.toLowerCase() === quoteHash);
      if (after?.ack) report.acksRecovered++;
    }
    return report;
  }

  // -------------------------------------------------------------------------

  private parseRequest(
    request: QuoteRequest,
  ): { total: bigint; windowCloseAt: number; quoteTtlMs: number; filler: Hex; payoutOf: (total: bigint, feeBps: number) => bigint } | QuoteSkipReason {
    try {
      requestIdHash(request.requestId);
    } catch {
      return 'malformed';
    }
    const total = decimal(request.inputAmount);
    const windowCloseAt = millis(request.windowCloseAt);
    const quoteTtlMs = millis(request.quoteTtlMs);
    const route = request.route as { src?: unknown; dst?: unknown } | undefined;
    if (total === undefined || windowCloseAt === undefined || quoteTtlMs === undefined || typeof route?.src !== 'string' || typeof route.dst !== 'string') return 'malformed';
    if (!Number.isSafeInteger(request.feeBps) || request.feeBps < 0 || request.feeBps > 0xffff) return 'malformed';
    const cantonSource = route.src.startsWith('canton:');
    if (!cantonSource && !isEvmChainId(route.src)) return 'malformed';
    // The filler address the ticket would name (§3.2): the fill key of an EVM
    // destination; for a Canton destination, the address registered on the (EVM) source router.
    const chain = isEvmChainId(route.dst) ? route.dst : isEvmChainId(route.src) ? route.src : undefined;
    const signer = chain ? this.options.fillSigners[chain] : undefined;
    if (!signer) return 'no-fill-key';
    // T-12: a Canton source pays by the ledger formula, never the EVM one.
    const payoutOf = cantonSource ? cantonFillerPayout : evmFillerPayout;
    return { total, windowCloseAt, quoteTtlMs, filler: signer.address.toLowerCase() as Hex, payoutOf };
  }

  /** The filler address for an opened EVM-source order: by `destination` (`bytes32(chainId)` for EVM, §3.7). */
  private fillerForOrder(origin: bigint, destination: unknown): Hex | undefined {
    const dst = typeof destination === 'string' && /^0x[0-9a-fA-F]{64}$/.test(destination) ? BigInt(destination) : undefined;
    const chain: EvmChainId = dst !== undefined && dst > 0n && dst < CANTON_ORIGIN_FLOOR ? `eip155:${dst}` : `eip155:${origin}`;
    return this.options.fillSigners[chain]?.address.toLowerCase() as Hex | undefined;
  }

  private async sign(requestId: string, filler: Hex, amountOut: bigint, validUntil: bigint, nonce: bigint): Promise<{ message: { sig: Hex }; quoteHash: Hex }> {
    const input: TypedDataInput = {
      domain: FILLER_PROTOCOL_DOMAIN,
      types: FILLER_QUOTE_TYPES,
      primaryType: 'FillerQuote',
      message: { requestId: requestIdHash(requestId), filler, amountOut, validUntil, nonce },
    };
    const sig = await signTypedDataChecked(this.options.quoteSigner, input);
    return { message: { sig }, quoteHash: hashTypedData(input) };
  }

  private reply(reply: QuoteReconfirmReply, replyBy: number, outcome: string): { reply: QuoteReconfirmReply } | { skipped: 'late' | 'disconnected' } {
    if (this.options.clock.now() >= replyBy) return { skipped: 'late' };
    if (!this.options.protocol.send(reply)) return { skipped: 'disconnected' };
    this.stage('reconfirm.answered', undefined, { orderHash: reply.orderHash, accept: reply.accept, outcome });
    return { reply };
  }

  private stage(stage: FillerStage, requestId: string | undefined, detail: Readonly<Record<string, string | number | boolean>>): void {
    try {
      const result = this.options.events.emit({ type: 'stage', stage, atMs: this.options.clock.now(), ...(requestId ? { requestId } : {}), detail });
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      // A broken sink never stops the protocol.
    }
  }
}
