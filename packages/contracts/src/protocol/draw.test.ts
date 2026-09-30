import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DRAND_QUICKNET, drawValue, drawWinner, firstRoundAtOrAfter } from './draw';

type DrawVector = {
  note: string; round: number; time: number; t0?: string; deltaDrand?: number; randomness: string; orderHash: `0x${string}`; attempt: number;
  candidates: { fillerId: string; weight: string }[]; h: string; totalWeight: string; r: string; winnerFillerId: string;
};
const { vectors } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'spec', 'protocol', 'vectors', 'draw.json'), 'utf8')) as { vectors: DrawVector[] };

test.each(vectors.map((v) => [v.note, v] as const))('%s: h, r and the winner', (_n, v) => {
  const h = drawValue(v.randomness, v.orderHash, v.attempt);
  expect(`0x${h.toString(16).padStart(64, '0')}`).toBe(v.h);
  expect(drawWinner(h, v.candidates)).toEqual({ r: BigInt(v.r), winnerFillerId: v.winnerFillerId });
  expect(firstRoundAtOrAfter(v.time)).toBe(BigInt(v.round));
});

// A8, hash part: the numbers auction-and-draw §3.7 publishes.
test('A8: the worked example gives r = 417828 and acme-markets', () => {
  const v = vectors[0]!;
  expect(v.h).toBe('0x33d5eb9f347a11be3454ba1631ef7e62cbecebffc588e5ffbc3c6a6028574664');
  expect(drawWinner(drawValue(v.randomness, v.orderHash, 0), v.candidates)).toEqual({ r: 417828n, winnerFillerId: 'acme-markets' });
});

test('the fixture round is the first at or after t0 + deltaDrand (A-20)', () => {
  const v = vectors[1]!;
  expect(firstRoundAtOrAfter(BigInt(v.t0!) + BigInt(v.deltaDrand!))).toBe(BigInt(v.round));
  expect(firstRoundAtOrAfter(v.time - 1)).toBe(BigInt(v.round));
  expect(firstRoundAtOrAfter(v.time + 1)).toBe(BigInt(v.round + 1));
});

test('rounds before and at genesis are round 1', () => {
  expect(firstRoundAtOrAfter(0)).toBe(1n);
  expect(firstRoundAtOrAfter(DRAND_QUICKNET.genesisTime)).toBe(1n);
  expect(firstRoundAtOrAfter(DRAND_QUICKNET.genesisTime + 1)).toBe(2n);
});

describe('drawWinner', () => {
  const cands = [
    { fillerId: 'b', weight: '1' },
    { fillerId: 'a', weight: '1' },
  ];
  test('sorts candidates by the UTF-8 bytes of fillerId before walking the weights (A-22)', () => {
    expect(drawWinner(0n, cands).winnerFillerId).toBe('a');
    expect(drawWinner(1n, cands).winnerFillerId).toBe('b');
    // UTF-8 byte order differs from UTF-16 order above the BMP
    expect(drawWinner(0n, [{ fillerId: 'דּ', weight: 1n }, { fillerId: '😀', weight: 1n }]).winnerFillerId).toBe('דּ');
  });
  test('the first cumulative weight strictly above r wins', () => {
    expect(drawWinner(2n, [{ fillerId: 'a', weight: '2' }, { fillerId: 'b', weight: '1' }])).toEqual({ r: 2n, winnerFillerId: 'b' });
  });
  test.each([
    ['no candidates', []],
    ['zero total weight', [{ fillerId: 'a', weight: '0' }]],
    ['a negative weight', [{ fillerId: 'a', weight: '-1' }, { fillerId: 'b', weight: '3' }]],
    ['a malformed weight', [{ fillerId: 'a', weight: '1.5' }]],
    ['a duplicated fillerId', [{ fillerId: 'a', weight: '1' }, { fillerId: 'a', weight: '1' }]],
  ])('throws on %s', (_n, c) => {
    expect(() => drawWinner(1n, c)).toThrow();
  });
});

test('drawValue refuses inputs that are not the 68-byte preimage', () => {
  const v = vectors[0]!;
  expect(() => drawValue('0x1234', v.orderHash, 0)).toThrow();
  expect(() => drawValue(v.randomness, '0x1234', 0)).toThrow();
  expect(() => drawValue(v.randomness, v.orderHash, -1)).toThrow();
  expect(() => drawValue(v.randomness, v.orderHash, 2 ** 32)).toThrow();
  expect(drawValue(v.randomness.slice(2), v.orderHash, 0)).toBe(drawValue(v.randomness, v.orderHash, 0));
});
