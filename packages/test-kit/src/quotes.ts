export type QuoteStatus = 'COUNTED' | 'LATE' | 'SHORT_TTL' | 'REPLACED' | 'WON' | 'LOST';
export interface QuoteRequestTerms { requestId: string; fillerIds: string[]; windowCloseAt: number; quoteTtlMs: number }
export interface QuoteInput { requestId: string; filler: string; amountOut: string; validUntil: string; nonce: string }
export interface QuoteRecord extends QuoteInput { fillerId: string; quoteHash: string; receivedAt: number; status: QuoteStatus }
export type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
export type SubmitResult = { ok: true; record: QuoteRecord } | { ok: false; code: string; message: string };
export class QuoteBook {
  open(_req: QuoteRequestTerms): void { throw new Error('not implemented'); }
  request(_id: string): QuoteRequestTerms | undefined { throw new Error('not implemented'); }
  submit(_fillerId: string, _q: QuoteInput, _receivedAt: number, _quoteHash: string): SubmitResult { throw new Error('not implemented'); }
  candidates(_id: string): QuoteRecord[] { throw new Error('not implemented'); }
  close(_id: string, _winner?: string): void { throw new Error('not implemented'); }
  list(_fillerId: string, _since?: number): QuoteRecord[] { throw new Error('not implemented'); }
}
