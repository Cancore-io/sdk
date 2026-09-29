import { DEFAULT_CONFIG, MockGateway } from './gateway';
import type { Conn } from './gateway';
import { sign, TEST_KEYS } from './keys';
import { fillerAuthDigest, fillerQuoteDigest } from './protocol';
import { onFrame } from './wire';

type Frame = Record<string, unknown>;

function connect(gw: MockGateway) {
  const sent: Frame[] = [];
  const conn: Conn = { closed: false, send: (t) => void sent.push(JSON.parse(t) as Frame), close: () => void (conn.closed = true) };
  conn.challenge = { nonce: `0x${'11'.repeat(32)}`, expiresAt: String(gw.nowS() + 60) };
  return { conn, sent, frame: (msg: Frame) => onFrame(gw, conn, JSON.stringify(msg)) };
}

function loggedIn(gw: MockGateway) {
  const c = connect(gw);
  const digest = fillerAuthDigest({ fillerId: 'acme-markets', nonce: c.conn.challenge!.nonce, expiresAt: c.conn.challenge!.expiresAt });
  c.frame({ type: 'auth.response', id: 'a', fillerId: 'acme-markets', keyAddress: TEST_KEYS.acmeQuote.address, protocolVersion: '1', sig: sign(digest, TEST_KEYS.acmeQuote.privateKey) });
  expect(c.sent.map((f) => f.type)).toEqual(['auth.ok', 'epoch.weights']);
  c.sent.length = 0;
  return c;
}

const ZERO_R = `0x${'00'.repeat(64)}1b`;
const errorOf = (sent: Frame[]) => sent.find((f) => f.type === 'error');

describe('one malformed frame never escapes the frame handler', () => {
  test('auth.response with r = 0 is BAD_SIGNATURE, not a throw', () => {
    const gw = new MockGateway({ ...DEFAULT_CONFIG });
    const c = connect(gw);
    expect(() => c.frame({ type: 'auth.response', id: 'a', fillerId: 'acme-markets', keyAddress: TEST_KEYS.acmeQuote.address, protocolVersion: '1', sig: ZERO_R })).not.toThrow();
    expect(errorOf(c.sent)).toMatchObject({ code: 'BAD_SIGNATURE', re: 'a' });
    expect(c.conn.closed).toBe(true);
  });

  test('a uint64 field past 2^64 − 1 is BAD_REQUEST, and the socket keeps serving', () => {
    const gw = new MockGateway({ ...DEFAULT_CONFIG });
    const c = loggedIn(gw);
    const intent = { type: 'ticket.intent', id: 'i', orderHash: `0x${'22'.repeat(32)}`, attempt: 0, validFrom: '1', validUntil: '9'.repeat(20), sig: ZERO_R };
    expect(() => c.frame(intent)).not.toThrow();
    expect(errorOf(c.sent)).toMatchObject({ code: 'BAD_REQUEST', re: 'i' });
    expect(c.conn.closed).toBe(false);
    c.frame({ type: 'ping', id: 'p' });
    expect(c.sent.at(-1)).toMatchObject({ type: 'pong', re: 'p' });
  });

  test('an unexpected failure is INTERNAL, answered on the socket', () => {
    const gw = new MockGateway({ ...DEFAULT_CONFIG });
    const c = loggedIn(gw);
    gw.quotes.submit = () => {
      throw new Error('boom');
    };
    gw.quotes.open({ requestId: 'r', fillerIds: ['acme-markets'], windowCloseAt: gw.now() + 1000, quoteTtlMs: 0 });
    const body = { requestId: 'r', filler: TEST_KEYS.acmeFiller.address, amountOut: '1', validUntil: String(gw.nowS() + 100), nonce: '1' };
    expect(() => c.frame({ type: 'quote', id: 'q', ...body, sig: sign(fillerQuoteDigest(body), TEST_KEYS.acmeQuote.privateKey) })).not.toThrow();
    expect(errorOf(c.sent)).toMatchObject({ code: 'INTERNAL', re: 'q' });
  });
});
