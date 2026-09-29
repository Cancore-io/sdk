import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { beacon, drawAttempt, firstRoundAtOrAfter, weightOf, weightsRoot } from './draws';
import type { EpochLeaf } from './draws';
import { drawOutcome } from './protocol';

const acme: EpochLeaf = { fillerId: 'acme-markets', base: '100', tier: 1, reliabilityBps: 10000 };
const reserve: EpochLeaf = { fillerId: 'cancore-reserve', base: '100', tier: 0, reliabilityBps: 9000 };
const zeta: EpochLeaf = { fillerId: 'zeta-liquidity', base: '100', tier: 0, reliabilityBps: 10000 };
const steps = [
  { tier: 0, minStake: '0', step: '0' },
  { tier: 1, minStake: '1000000000000000000000', step: '50' },
];

describe('weightsRoot — OpenZeppelin StandardMerkleTree ["string","uint256","uint8","uint16"]', () => {
  // Reference roots computed with @openzeppelin/merkle-tree 1.x StandardMerkleTree.of(...).root.
  test.each([
    ['one leaf', [acme], '0xb6f152c50d1e18a8970100703df21df925fe1fecf2e4bbe997138d2b79c7495c'],
    ['two leaves', [zeta, acme], '0xb1f59bb4a52e929f2d889a062f5fbe84413fb69f9f0058323224e1a5c011d039'],
    ['three leaves', [acme, reserve, zeta], '0xa1c24765b55b34e0c206f808d2fac2e448d9db6f154d89f898921a80bad76e92'],
  ])('%s', (_name, leaves, root) => {
    expect(weightsRoot(leaves)).toBe(root);
  });

  test('an empty epoch has no root', () => {
    expect(() => weightsRoot([])).toThrow(/no leaves/);
  });
});

test('A-11: w = (base + stakeStep(tier)) × reliabilityBps (auction-and-draw §3.7 weights)', () => {
  expect(weightOf(acme, steps)).toBe(1_500_000n);
  expect(weightOf(reserve, steps)).toBe(900_000n);
  expect(weightOf(zeta, steps)).toBe(1_000_000n);
  expect(() => weightOf({ ...acme, tier: 7 }, steps)).toThrow(/tier 7/);
});

test('firstRoundAtOrAfter follows the quicknet genesis and period', () => {
  expect(firstRoundAtOrAfter(1692806364)).toBe(1000n);
  expect(firstRoundAtOrAfter(1692806362)).toBe(1000n);
  expect(firstRoundAtOrAfter(1692806365)).toBe(1001n);
  expect(firstRoundAtOrAfter(0)).toBe(1n);
});

describe('beacon', () => {
  test('a round of the fixture window is the real drand round: randomness = sha256(signature)', () => {
    const b = beacon(firstRoundAtOrAfter(1789999400 + 6));
    expect(b.real).toBe(true);
    expect(b.randomness).toBe(`0x${bytesToHex(sha256(hexToBytes(b.signature.slice(2))))}`);
    expect(b.signature).toMatch(/^0x[0-9a-f]{96}$/);
  });

  test('a round outside it is synthetic, but still randomness = sha256(signature)', () => {
    const b = beacon(5n);
    expect(b.real).toBe(false);
    expect(b.randomness).toBe(`0x${bytesToHex(sha256(hexToBytes(b.signature.slice(2))))}`);
  });
});

test('A8 hash part: the worked example of auction-and-draw §3.7 gives r = 417828, winner acme-markets', () => {
  const outcome = drawOutcome(
    '0xfe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd',
    '0xe61e980d40d1a666a509d2296c0d2658a40ff681e290c7646a75a550629ce1ad',
    0,
    [
      { fillerId: 'zeta-liquidity', weight: '1000000' },
      { fillerId: 'acme-markets', weight: '1500000' },
      { fillerId: 'cancore-reserve', weight: '900000' },
    ],
  );
  expect(outcome).toEqual({ r: '417828', winnerFillerId: 'acme-markets' });
});

test('drawAttempt records round, randomness, sorted candidates, r and winner consistently', () => {
  const orderHash = `0x${'ab'.repeat(32)}` as const;
  const a = drawAttempt({ orderHash, attempt: 0, tBase: 1789999400, deltaDrand: 6, candidates: [{ fillerId: 'zeta-liquidity', weight: '1000000' }, { fillerId: 'acme-markets', weight: '1500000' }] });
  expect(a.drandRound).toBe(String(firstRoundAtOrAfter(1789999406)));
  expect(a.candidates.map((c) => c.fillerId)).toEqual(['acme-markets', 'zeta-liquidity']);
  expect(a).toMatchObject({ attempt: 0, tBase: '1789999400', closedBy: null, fallbackReason: null });
  expect(drawOutcome(a.drandRandomness, orderHash, 0, a.candidates)).toEqual({ r: a.r, winnerFillerId: a.winnerFillerId });
});
