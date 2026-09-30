/**
 * The draw of auction-and-draw §3.6: who gets attempt k of an order, from a
 * drand quicknet round nobody knew when the order was fixed. Pure arithmetic —
 * fetching the round and checking its BLS signature is the verifier's job
 * (`@cancore/trader/taker` verifyDraw), not this package's.
 */
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { beBytes, hexBytes, keccak, toHex, uint } from './bytes';
import type { Hex } from './typedData';

export interface DrawCandidate {
  fillerId: string;
  /** Decimal string on the wire; the integer weight of auction-and-draw A-11. */
  weight: string | bigint;
}

export interface DrawOutcome {
  r: bigint;
  winnerFillerId: string;
}

/** drand quicknet, the randomness beacon of the draw (auction-and-draw §4). */
export const DRAND_QUICKNET = {
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  scheme: 'bls-unchained-g1-rfc9380',
  genesisTime: 1692803367,
  period: 3,
} as const;

/** The first quicknet round whose time is at or after `unixSeconds` (A-20: `round_k` for `t_k + δ_drand`). */
export function firstRoundAtOrAfter(unixSeconds: bigint | number): bigint {
  const t = BigInt(unixSeconds);
  const genesis = BigInt(DRAND_QUICKNET.genesisTime);
  const period = BigInt(DRAND_QUICKNET.period);
  return t <= genesis ? 1n : (t - genesis + period - 1n) / period + 1n;
}

/** `h = uint256(keccak256(randomness ‖ orderHash ‖ uint32be(attempt)))` — the 68-byte preimage of A-21. */
export function drawValue(randomness: Hex | string, orderHash: Hex, attempt: number): bigint {
  const rand = hexBytes(randomness.startsWith('0x') ? randomness : `0x${randomness}`, 'randomness', 32);
  const preimage = concatBytes(rand, hexBytes(orderHash, 'orderHash', 32), beBytes(uint(attempt, 32, 'attempt'), 4));
  return BigInt(toHex(keccak(preimage)));
}

function compareUtf8(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/**
 * `r = h mod Σw`; the winner is the first candidate, in ascending UTF-8 byte
 * order of `fillerId` (A-22), whose cumulative weight exceeds `r`. Sorts a copy
 * itself, so a verifier compares the outcome, not the order it was served in.
 */
export function drawWinner(h: bigint, candidates: readonly DrawCandidate[]): DrawOutcome {
  const sorted = candidates
    .map((c) => ({ id: c.fillerId, key: utf8ToBytes(c.fillerId), weight: uint(c.weight, 256, `weight of ${c.fillerId}`) }))
    .sort((a, b) => compareUtf8(a.key, b.key));
  if (new Set(sorted.map((c) => c.id)).size !== sorted.length) throw new Error('draw: duplicated fillerId');
  const total = sorted.reduce((sum, c) => sum + c.weight, 0n);
  if (total === 0n) throw new Error('draw: no candidate with a positive weight');
  const r = h % total;
  let acc = 0n;
  const winner = sorted.find((c) => (acc += c.weight) > r)!;
  return { r, winnerFillerId: winner.id };
}
