import { QuoteBook } from './quotes';

const W = 1_790_000_000_000; // windowCloseAt, ms
const TTL = 30_000; // quoteTtlMs
const B = W + TTL; // validUntil × 1000 must reach it
const filler = '0x00000000000000000000000000000000000000aa';

function book() {
  const b = new QuoteBook();
  b.open({ requestId: 'req-1', fillerIds: ['acme-markets', 'zeta-liquidity'], windowCloseAt: W, quoteTtlMs: TTL });
  return b;
}
const quote = (nonce: string, amountOut: string, validUntil = String(B / 1000)) => ({ requestId: 'req-1', filler, amountOut, validUntil, nonce });
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

test('a quote inside the window with enough TTL is COUNTED and becomes a candidate', () => {
  const b = book();
  const res = b.submit('acme-markets', quote('1', '100'), W - 500, hash(1));
  expect(res).toMatchObject({ ok: true, record: { status: 'COUNTED', receivedAt: W - 500, quoteHash: hash(1) } });
  expect(b.candidates('req-1').map((q) => q.quoteHash)).toEqual([hash(1)]);
});

test('B11: nonce 2 replaces nonce 1 inside the window; the candidate is nonce 2, nonce 1 is REPLACED', () => {
  const b = book();
  b.submit('acme-markets', quote('1', '100'), W - 900, hash(1));
  const second = b.submit('acme-markets', quote('2', '90'), W - 100, hash(2));
  expect(second).toMatchObject({ ok: true, record: { status: 'COUNTED', nonce: '2' } });
  expect(b.candidates('req-1').map((q) => q.nonce)).toEqual(['2']);
  expect(b.list('acme-markets').map((q) => [q.nonce, q.status])).toEqual([
    ['1', 'REPLACED'],
    ['2', 'COUNTED'],
  ]);
});

test('a nonce that does not increase is refused', () => {
  const b = book();
  b.submit('acme-markets', quote('5', '100'), W - 900, hash(1));
  expect(b.submit('acme-markets', quote('5', '101'), W - 800, hash(2))).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
  expect(b.submit('acme-markets', quote('4', '101'), W - 800, hash(3))).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
});

test('nonces are per filler: two takers may both use nonce 1', () => {
  const b = book();
  b.submit('acme-markets', quote('1', '100'), W - 900, hash(1));
  expect(b.submit('zeta-liquidity', quote('1', '99'), W - 800, hash(2))).toMatchObject({ ok: true });
  expect(b.candidates('req-1').map((q) => q.fillerId)).toEqual(['acme-markets', 'zeta-liquidity']);
});

describe('B12 / B13 window boundary: receivedAt ≤ windowCloseAt counts', () => {
  test('at windowCloseAt the quote counts', () => {
    expect(book().submit('acme-markets', quote('1', '100'), W, hash(1))).toMatchObject({ ok: true, record: { status: 'COUNTED' } });
  });

  test('one millisecond later it is LATE: acked, never a candidate, never a replacement', () => {
    const b = book();
    b.submit('acme-markets', quote('1', '100'), W - 1, hash(1));
    const late = b.submit('acme-markets', quote('2', '101'), W + 1, hash(2));
    expect(late).toMatchObject({ ok: true, record: { status: 'LATE', receivedAt: W + 1 } });
    expect(b.candidates('req-1').map((q) => q.nonce)).toEqual(['1']);
  });
});

describe('B13 rows 5–6: validUntil × 1000 ≥ windowCloseAt + quoteTtlMs', () => {
  test('validUntil × 1000 = B → COUNTED', () => {
    expect(book().submit('acme-markets', quote('1', '100', String(B / 1000)), W, hash(1))).toMatchObject({ ok: true, record: { status: 'COUNTED' } });
  });

  test('validUntil × 1000 = B − 1 ms → SHORT_TTL, acked but not a candidate', () => {
    const b = new QuoteBook();
    // windowCloseAt one millisecond later, so B lands one millisecond after a whole second.
    b.open({ requestId: 'req-1', fillerIds: ['acme-markets'], windowCloseAt: W + 1, quoteTtlMs: TTL });
    const res = b.submit('acme-markets', quote('1', '100', String(B / 1000)), W, hash(1));
    expect(res).toMatchObject({ ok: true, record: { status: 'SHORT_TTL' } });
    expect(b.candidates('req-1')).toEqual([]);
  });
});

test('an unknown request, or a taker the request was not sent to, is UNKNOWN_REQUEST', () => {
  const b = book();
  expect(b.submit('acme-markets', { ...quote('1', '100'), requestId: 'req-x' }, W, hash(1))).toMatchObject({ ok: false, code: 'UNKNOWN_REQUEST' });
  expect(b.submit('omega', quote('1', '100'), W, hash(1))).toMatchObject({ ok: false, code: 'UNKNOWN_REQUEST' });
});

test('closing the window marks the winner WON and the other candidates LOST', () => {
  const b = book();
  b.submit('acme-markets', quote('1', '100'), W - 900, hash(1));
  b.submit('zeta-liquidity', quote('1', '99'), W - 800, hash(2));
  b.close('req-1', 'zeta-liquidity');
  expect(b.list('acme-markets')[0]?.status).toBe('LOST');
  expect(b.list('zeta-liquidity')[0]?.status).toBe('WON');
  expect(b.request('req-1')).toMatchObject({ windowCloseAt: W, quoteTtlMs: TTL });
});

test('list filters by receivedAt ≥ since, and never shows another taker', () => {
  const b = book();
  b.submit('acme-markets', quote('1', '100'), W - 900, hash(1));
  b.submit('acme-markets', quote('2', '100'), W - 100, hash(2));
  b.submit('zeta-liquidity', quote('1', '100'), W - 100, hash(3));
  expect(b.list('acme-markets', W - 500).map((q) => q.nonce)).toEqual(['2']);
  expect(b.list('nobody')).toEqual([]);
});
