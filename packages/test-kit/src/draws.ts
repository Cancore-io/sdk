/**
 * The public side of the draw (auction-and-draw §3.3–3.4): epoch weights and
 * their Merkle root, drand beacons, one attempt of the draw record.
 */
import { firstRoundAtOrAfter } from '@cancore/contracts';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { DRAND_ROUNDS } from './drandRounds';
import type { Hex } from './keys';
import { drawOutcome } from './protocol';

export { firstRoundAtOrAfter };

export interface EpochLeaf {
  fillerId: string;
  base: string;
  tier: number;
  reliabilityBps: number;
}

export interface StakeStep {
  tier: number;
  minStake: string;
  step: string;
}

export interface Candidate {
  fillerId: string;
  weight: string;
}

export interface DrawAttempt {
  attempt: number;
  tBase: string;
  closedBy: string | null;
  drandRound: string;
  drandRandomness: Hex;
  drandSignature: Hex;
  candidates: Candidate[];
  r: string;
  winnerFillerId: string;
  fallbackReason: null;
}

const hex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`;
const word = (n: bigint) => hexToBytes(n.toString(16).padStart(64, '0'));

/** `abi.encode(string fillerId, uint256 base, uint8 tier, uint16 reliabilityBps)`. */
function encodeLeaf(l: EpochLeaf): Uint8Array {
  const id = utf8ToBytes(l.fillerId);
  const padded = new Uint8Array(Math.ceil(id.length / 32) * 32);
  padded.set(id);
  return concatBytes(word(128n), word(BigInt(l.base)), word(BigInt(l.tier)), word(BigInt(l.reliabilityBps)), word(BigInt(id.length)), padded);
}

const byOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compare = (a: Uint8Array, b: Uint8Array) => byOrder(bytesToHex(a), bytesToHex(b));

/**
 * The root of OpenZeppelin `StandardMerkleTree` with leaf types
 * `["string","uint256","uint8","uint16"]` (auction-and-draw §3.4): leaf =
 * keccak256(keccak256(abi.encode(...))), leaves sorted, pairs hashed sorted,
 * the tree laid out as OZ's `makeMerkleTree` does.
 */
export function weightsRoot(leaves: readonly EpochLeaf[]): Hex {
  if (leaves.length === 0) throw new Error('an epoch with no leaves has no root');
  const hashed = leaves.map((l) => keccak_256(keccak_256(encodeLeaf(l)))).sort(compare);
  const tree: Uint8Array[] = new Array(2 * hashed.length - 1);
  hashed.forEach((h, i) => (tree[tree.length - 1 - i] = h));
  for (let i = tree.length - 1 - hashed.length; i >= 0; i--) {
    const pair = [tree[2 * i + 1]!, tree[2 * i + 2]!].sort(compare);
    tree[i] = keccak_256(concatBytes(pair[0]!, pair[1]!));
  }
  return hex(tree[0]!);
}

/** A-11: `w = (base + stakeStep(tier)) × reliabilityBps`. */
export function weightOf(leaf: EpochLeaf, steps: readonly StakeStep[]): bigint {
  const step = steps.find((s) => s.tier === leaf.tier);
  if (!step) throw new Error(`no stake step for tier ${leaf.tier}`);
  return (BigInt(leaf.base) + BigInt(step.step)) * BigInt(leaf.reliabilityBps);
}

/**
 * A quicknet round: the real one when it is in the embedded fixture window
 * (verifies against any drand relay), a synthetic one otherwise (still
 * `randomness = sha256(signature)`, but no BLS signature behind it).
 */
export function beacon(round: bigint): { signature: Hex; randomness: Hex; real: boolean } {
  const real = DRAND_ROUNDS[round.toString()];
  if (real) return { signature: `0x${real.signature}`, randomness: `0x${real.randomness}`, real: true };
  const seed = keccak_256(utf8ToBytes(`cancore:test-kit:drand:${round}`));
  const signature = concatBytes(seed, keccak_256(seed).subarray(0, 16));
  return { signature: hex(signature), randomness: hex(sha256(signature)), real: false };
}

/** One attempt of a draw record: round of `tBase + δ_drand`, candidates sorted (A-22), r and winner. */
export function drawAttempt(input: { orderHash: Hex; attempt: number; tBase: number; deltaDrand: number; candidates: Candidate[] }): DrawAttempt {
  const round = firstRoundAtOrAfter(input.tBase + input.deltaDrand);
  const b = beacon(round);
  // fillerIds are ASCII (D-H), so string order is UTF-8 byte order.
  const candidates = [...input.candidates].sort((a, c) => byOrder(a.fillerId, c.fillerId));
  const { r, winnerFillerId } = drawOutcome(b.randomness, input.orderHash, input.attempt, candidates);
  return {
    attempt: input.attempt,
    tBase: String(input.tBase),
    closedBy: null,
    drandRound: round.toString(),
    drandRandomness: b.randomness,
    drandSignature: b.signature,
    candidates,
    r,
    winnerFillerId,
    fallbackReason: null,
  };
}
