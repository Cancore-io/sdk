/**
 * The quote window of one request (protocol §3.5 Quotes, auction-and-draw
 * A-2): a quote counts iff `receivedAt ≤ windowCloseAt` and
 * `validUntil × 1000 ≥ windowCloseAt + quoteTtlMs`; a later quote with a
 * higher nonce replaces the earlier one inside the window. Every well-formed,
 * correctly signed quote is acked (S-12) — LATE and SHORT_TTL included — but
 * only COUNTED ones are candidates. Signatures are checked by the caller.
 */
export type QuoteStatus = 'COUNTED' | 'LATE' | 'SHORT_TTL' | 'REPLACED' | 'WON' | 'LOST';

export interface QuoteRequestTerms {
  requestId: string;
  fillerIds: string[];
  windowCloseAt: number;
  quoteTtlMs: number;
}

export interface QuoteInput {
  requestId: string;
  filler: string;
  amountOut: string;
  validUntil: string;
  nonce: string;
}

export interface QuoteRecord extends QuoteInput {
  fillerId: string;
  quoteHash: string;
  receivedAt: number;
  status: QuoteStatus;
}

export type Failure = { ok: false; code: string; message: string };
export type Result<T> = { ok: true; value: T } | Failure;
export type SubmitResult = { ok: true; record: QuoteRecord } | Failure;

export const fail = (code: string, message: string): Failure => ({ ok: false, code, message });

export class QuoteBook {
  private requests = new Map<string, QuoteRequestTerms>();
  private quotes: QuoteRecord[] = [];

  open(req: QuoteRequestTerms): void {
    this.requests.set(req.requestId, req);
  }

  request(requestId: string): QuoteRequestTerms | undefined {
    return this.requests.get(requestId);
  }

  submit(fillerId: string, q: QuoteInput, receivedAt: number, quoteHash: string): SubmitResult {
    const req = this.requests.get(q.requestId);
    if (!req || !req.fillerIds.includes(fillerId)) return fail('UNKNOWN_REQUEST', `no request ${q.requestId} for ${fillerId}`);
    const mine = this.quotes.filter((r) => r.requestId === q.requestId && r.fillerId === fillerId);
    if (mine.some((r) => BigInt(r.nonce) >= BigInt(q.nonce))) return fail('BAD_REQUEST', `nonce: must exceed every nonce used for ${q.requestId}`);
    const status = statusOf(req, q, receivedAt);
    if (status === 'COUNTED') for (const r of mine) if (r.status === 'COUNTED') r.status = 'REPLACED';
    const record: QuoteRecord = { ...q, fillerId, quoteHash, receivedAt, status };
    this.quotes.push(record);
    return { ok: true, record };
  }

  /** The current COUNTED quote of each taker, in arrival order. */
  candidates(requestId: string): QuoteRecord[] {
    return this.quotes.filter((r) => r.requestId === requestId && r.status === 'COUNTED');
  }

  /** The draw ran: the winner's candidate is WON, every other candidate LOST. */
  close(requestId: string, winnerFillerId?: string): void {
    for (const r of this.candidates(requestId)) r.status = r.fillerId === winnerFillerId ? 'WON' : 'LOST';
  }

  list(fillerId: string, since = 0): QuoteRecord[] {
    return this.quotes.filter((r) => r.fillerId === fillerId && r.receivedAt >= since);
  }
}

function statusOf(req: QuoteRequestTerms, q: QuoteInput, receivedAt: number): QuoteStatus {
  if (receivedAt > req.windowCloseAt) return 'LATE';
  if (BigInt(q.validUntil) * 1000n < BigInt(req.windowCloseAt + req.quoteTtlMs)) return 'SHORT_TTL';
  return 'COUNTED';
}
