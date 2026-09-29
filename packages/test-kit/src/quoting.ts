/**
 * The quote round (protocol §3.5 Quotes): `quote.request` to the takers,
 * signed quotes acked with the gateway's `receivedAt` (S-12), and at
 * `windowCloseAt` the draw among the counted quotes — whose winner gets the
 * order at the best price of the window (auction-and-draw A-5).
 */
import { DESTINATION, FIXTURE_ORDER, orderAt, SOURCE } from './fixtures';
import type { Body, MockGateway } from './gateway';
import { fillerQuoteDigest } from './protocol';
import { fail } from './quotes';
import type { QuoteInput } from './quotes';
import { signer } from './session';
import { candidateOf, offerOrder } from './ticketing';
import type { Outcome } from './ticketing';

export interface RfqOptions {
  /** Default: every registered taker. Only connected ones receive the request. */
  fillerIds?: string[];
  /** Default `windowMs` after now. */
  windowCloseAt?: number;
  quoteTtlMs?: number;
}

let requests = 0;

export function rfq(gw: MockGateway, opts: RfqOptions = {}) {
  const requestId = `req-${++requests}-${gw.now()}`;
  const windowCloseAt = opts.windowCloseAt ?? gw.now() + gw.cfg.windowMs;
  const quoteTtlMs = opts.quoteTtlMs ?? gw.cfg.quoteTtlMs;
  const fillerIds = opts.fillerIds ?? [...gw.fillers.keys()];
  gw.quotes.open({ requestId, fillerIds, windowCloseAt, quoteTtlMs });
  const body: Body = {
    type: 'quote.request',
    requestId,
    route: { src: SOURCE.caip2, dst: DESTINATION.caip2 },
    inputToken: FIXTURE_ORDER.inputToken,
    inputAmount: FIXTURE_ORDER.inputAmount,
    outputAsset: DESTINATION.token,
    feeBps: Number(FIXTURE_ORDER.feeBps),
    fillDeadlineHint: String(gw.nowS() + 600),
    windowCloseAt,
    quoteTtlMs,
  };
  for (const fillerId of fillerIds) if (gw.live.has(fillerId)) gw.emit({ fillerId }, body);
  gw.clock.schedule(windowCloseAt + 1, () => closeWindow(gw, requestId));
  return { requestId, windowCloseAt, quoteTtlMs };
}

export function onQuote(gw: MockGateway, fillerId: string, msg: Record<string, unknown>): Outcome {
  const q = msg as unknown as QuoteInput;
  const quote: QuoteInput = { requestId: q.requestId, filler: q.filler, amountOut: q.amountOut, validUntil: q.validUntil, nonce: q.nonce };
  const quoteHash = fillerQuoteDigest(quote);
  if (signer(quoteHash, msg.sig) !== gw.fillers.get(fillerId)?.quoteKey) return fail('BAD_SIGNATURE', 'FillerQuote does not recover to the quote key');
  const res = gw.quotes.submit(fillerId, quote, gw.now(), quoteHash);
  if (!res.ok) return res;
  const { status, receivedAt } = res.record;
  const ack = gw.emit({ fillerId }, { type: 'quote.ack', requestId: quote.requestId, quoteHash, receivedAt, status, ...(typeof msg.id === 'string' ? { re: msg.id } : {}) });
  gw.quoteEvidence.set(quoteHash, { quote: msg, ack });
  return { ok: true };
}

function closeWindow(gw: MockGateway, requestId: string): void {
  const counted = gw.quotes.candidates(requestId);
  if (counted.length === 0) return gw.quotes.close(requestId);
  const best = counted.reduce((m, q) => (BigInt(q.amountOut) > m ? BigInt(q.amountOut) : m), 0n);
  const t0 = gw.nowS();
  const order = orderAt(t0, { minReceived: best.toString(), canton: gw.mode === 'CANTON_DESTINATION' });
  const offer = offerOrder(gw, { order, t0, candidates: counted.map((q) => candidateOf(gw, q.fillerId)) });
  gw.quotes.close(requestId, String(offer.fillerId));
}
