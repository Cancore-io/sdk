import { keccak256, toUtf8Bytes } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatewayBodyHash, jcs, requestIdHash } from './hash';

const dir = join(__dirname, '..', '..', 'spec', 'protocol');
const load = <T>(...p: string[]): T => JSON.parse(readFileSync(join(dir, ...p), 'utf8')) as T;

type JcsCase = { note: string; texts: string[]; canonical: string; keccak256: string };
const { cases } = load<{ cases: JcsCase[] }>('vectors', 'jcs.json');

describe('JCS (RFC 8785) golden cases', () => {
  test.each(cases.map((c) => [c.note, c] as const))('%s', (_n, c) => {
    expect(c.texts.length).toBeGreaterThanOrEqual(2);
    for (const text of c.texts) expect(jcs(JSON.parse(text))).toBe(c.canonical);
    expect(keccak256(toUtf8Bytes(c.canonical))).toBe(c.keccak256);
  });

  test('the cases cover arrays, null, non-BMP keys and 2^53 − 1', () => {
    const all = cases.map((c) => c.canonical).join('');
    for (const needle of ['[', 'null', '😀', '9007199254740991']) expect(all).toContain(needle);
  });

  test.each([
    ['a fraction', { a: 1.5 }],
    ['an unsafe integer', { a: 2 ** 53 }],
    ['NaN', { a: Number.NaN }],
    ['a bigint', { a: 1n }],
    ['undefined', { a: undefined }],
    ['a function', { a: () => 1 }],
  ])('refuses %s: no canonical form the gateway and a taker would agree on', (_n, value) => {
    expect(() => jcs(value)).toThrow();
  });

  test('a lone surrogate is refused too', () => {
    expect(() => jcs({ a: '\ud800' })).toThrow();
  });
});

type GatewayVector = { note: string; body: Record<string, unknown>; jcs: string; message: { bodyHash: string } };
const gateway = load<{ vectors: GatewayVector[] }>('typed-data', 'GatewayMessage.json').vectors;

describe('gatewayBodyHash', () => {
  test.each(gateway.map((v) => [v.note, v] as const))('%s: canonical text and bodyHash of the vector', (_n, v) => {
    const { sig: _sig, ...unsigned } = v.body;
    expect(jcs(unsigned)).toBe(v.jcs);
    expect(gatewayBodyHash(v.body)).toBe(v.message.bodyHash);
  });

  // A5: key order and whitespace do not change what the gateway signed.
  test('A5: two texts of one ticket.offer, keys and spacing permuted, hash alike', () => {
    const offer = gateway[0]!.body;
    const permuted = Object.fromEntries(Object.entries(offer).reverse());
    const text1 = JSON.stringify(offer);
    const text2 = JSON.stringify(permuted, null, 3);
    expect(text1).not.toBe(text2);
    expect(gatewayBodyHash(JSON.parse(text2))).toBe(gatewayBodyHash(JSON.parse(text1)));
    expect(gatewayBodyHash(JSON.parse(text1))).toBe(gateway[0]!.message.bodyHash);
  });

  test('sig is outside the body; every other field is inside it', () => {
    const offer = gateway[0]!.body;
    expect(gatewayBodyHash({ ...offer, sig: `0x${'22'.repeat(65)}` })).toBe(gatewayBodyHash(offer));
    expect(gatewayBodyHash({ ...offer, x: 1 })).not.toBe(gatewayBodyHash(offer));
  });
});

describe('requestIdHash', () => {
  type QuoteVector = { requestIdString: string; message: { requestId: string } };
  const quotes = load<{ vectors: QuoteVector[] }>('typed-data', 'FillerQuote.json').vectors;

  test('keccak256(utf8(requestId)) of every FillerQuote vector', () => {
    for (const v of quotes) expect(requestIdHash(v.requestIdString)).toBe(v.message.requestId);
  });
  test.each([[''], ['x'.repeat(65)], ['has space'], ['non-ascii-é'], ['tab\t']])('refuses %j: not 1..64 printable ASCII', (id) => {
    expect(() => requestIdHash(id)).toThrow();
  });
});
