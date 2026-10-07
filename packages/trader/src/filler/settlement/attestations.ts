/**
 * Attestor signatures over a `FillProof`, checked the way `settle` checks
 * them (attestors.md §4.8; `AttestorSet._verifyAttestations`), before anything
 * is sent: one bad signature among the ones submitted reverts the whole call.
 *
 * Pure functions over data the caller read itself — the proof, the signatures,
 * and the set of `attestationSetFor(orderHash)` from the source router. No
 * transport, no protocol client, no store: whoever holds signatures (the
 * filler's settlement, a relayer) can use them.
 */
import type { AttestationEvm, FillProofJson, Hex } from '@cancore/contracts';
import { SignatureContractError } from '../errors';
import { hashFillProof, type SourceRouter } from '../chain/hashes';
import { recoverAddress } from '../signer';

/** The attestor set a proof is verified against: `getAttestorSet(attestationSetFor(orderHash))` and its revocations. */
export interface AttestorSetView {
  setId: number;
  /** Members, any order. */
  members: readonly Hex[];
  /** k: `settle` needs at least this many signatures. */
  threshold: number;
  /** Members whose key the router owner revoked: revocation beats membership. */
  revoked: readonly Hex[];
}

export type RejectedReason =
  /** Not 65 bytes `r ‖ s ‖ v` with `v ∈ {27, 28}`, or `r`/`s` out of range. */
  | 'malformed'
  /** `s` in the upper half of the curve order: `ECDSA.recover` reverts on it. */
  | 'high-s'
  /** Recovers to another address than the `signer` it came with: signed another digest, or by another key. */
  | 'signer-mismatch'
  | 'not-member'
  | 'revoked'
  /** A second signature of a signer already kept. */
  | 'duplicate';

export interface RejectedSignature {
  signer: Hex;
  reason: RejectedReason;
}

export interface AttestationVerification {
  /** `hashFillProof(proof)` in the source router's domain. */
  digest: Hex;
  /** Every signature that recovers to a non-revoked member over `digest`, strictly ascending by signer. */
  valid: AttestationEvm[];
  /** The lowest `threshold` of `valid`: what `settle` gets. Empty when there are fewer. */
  selected: AttestationEvm[];
  rejected: RejectedSignature[];
  /** Whether `selected` holds `threshold` signatures. */
  enough: boolean;
}

const lower = (value: string): Hex => value.toLowerCase() as Hex;

/** The proof as the router hashes it. */
export const fillProofOf = (proof: FillProofJson) => ({ ...proof, amountDelivered: BigInt(proof.amountDelivered), filledAt: BigInt(proof.filledAt) });

/**
 * Keeps the signatures `settle` would accept for `proof` under `set` and
 * picks the `threshold` lowest signers, strictly ascending.
 */
export function verifyAttestations(input: { proof: FillProofJson; source: SourceRouter; signatures: readonly AttestationEvm[]; set: AttestorSetView }): AttestationVerification {
  const digest = hashFillProof(fillProofOf(input.proof), input.source);
  const members = new Set(input.set.members.map(lower));
  const revoked = new Set(input.set.revoked.map(lower));
  const kept = new Map<Hex, AttestationEvm>();
  const rejected: RejectedSignature[] = [];
  for (const entry of input.signatures) {
    const signer = lower(String(entry.signer));
    let recovered: Hex;
    try {
      recovered = recoverAddress(digest, entry.signature);
    } catch (error) {
      rejected.push({ signer, reason: error instanceof SignatureContractError && error.violation === 'high-s' ? 'high-s' : 'malformed' });
      continue;
    }
    if (recovered !== signer) rejected.push({ signer, reason: 'signer-mismatch' });
    else if (!members.has(signer)) rejected.push({ signer, reason: 'not-member' });
    else if (revoked.has(signer)) rejected.push({ signer, reason: 'revoked' });
    else if (kept.has(signer)) rejected.push({ signer, reason: 'duplicate' });
    else kept.set(signer, { signer, signature: lower(entry.signature) });
  }
  const valid = [...kept.values()].sort((a, b) => (a.signer < b.signer ? -1 : 1));
  const enough = input.set.threshold > 0 && valid.length >= input.set.threshold;
  return { digest, valid, selected: enough ? valid.slice(0, input.set.threshold) : [], rejected, enough };
}

/** One answer: a proof and the signatures that came with it. */
export interface AttestationAnswer {
  proof: FillProofJson;
  signatures: readonly AttestationEvm[];
}

export interface CollectedAttestations extends Omit<AttestationVerification, 'digest'> {
  /** The digest the signatures were kept over; undefined when the answers disagree. */
  digest?: Hex;
  proof?: FillProofJson;
  /**
   * The answers carry more than one digest, or one other than `expected`: the
   * attestors (or whoever relayed them) do not agree on the delivery. Nothing
   * is kept, nothing may be sent — an alert.
   */
  divergent: boolean;
  /** Every digest seen, for the alert. */
  digests: Hex[];
}

/**
 * Groups answers by `hashFillProof` and verifies the signatures of the one
 * digest they agree on — which must be `expected`'s when it is given (the
 * filler's own proof of its own fill). Answers over different digests are a
 * divergence: no signature is kept.
 */
export function collectAttestations(input: { answers: readonly AttestationAnswer[]; source: SourceRouter; set: AttestorSetView; expected?: FillProofJson }): CollectedAttestations {
  const empty = { valid: [], selected: [], rejected: [], enough: false };
  const byDigest = new Map<Hex, AttestationAnswer[]>();
  for (const answer of input.answers) {
    const digest = hashFillProof(fillProofOf(answer.proof), input.source);
    byDigest.set(digest, [...(byDigest.get(digest) ?? []), answer]);
  }
  const digests = [...byDigest.keys()];
  const expected = input.expected ? hashFillProof(fillProofOf(input.expected), input.source) : undefined;
  if (digests.length === 0) return { ...empty, divergent: false, digests };
  if (digests.length > 1 || (expected !== undefined && digests[0] !== expected)) return { ...empty, divergent: true, digests: expected && !digests.includes(expected) ? [...digests, expected] : digests };
  const answers = byDigest.get(digests[0]!)!;
  const verified = verifyAttestations({ proof: answers[0]!.proof, source: input.source, signatures: answers.flatMap((a) => a.signatures), set: input.set });
  return { ...verified, proof: answers[0]!.proof, divergent: false, digests };
}
