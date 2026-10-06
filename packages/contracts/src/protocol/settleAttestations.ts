/**
 * filler-gateway → filler `settle.attestations` and its REST twin
 * `GET /v1/filler/attestations/{orderHash}` (protocol §3.5, §3.6, §10 D-N):
 * ≥ k attestor signatures over the filler's `FillProof`, which the filler node
 * submits itself — `settle` on an EVM source, `SwapIntent_SettleWithProof` on
 * a Canton source. Both channels carry the same payload; the SDK takes the
 * first and deduplicates by `(orderHash, attempt)`.
 *
 * No secp256k1 here: `settleAttestationsErrors` checks what the schema cannot
 * express, and recovering each signer and checking it against
 * `attestationSetFor(orderHash)` stays with the consumer (T-7).
 */
import { utf8ToBytes } from '@noble/hashes/utils';
import { keccak, toHex } from './bytes';
import { jcs } from './hash';
import type { DecString, S2FBase } from './messages';
import type { Hex } from './typedData';

/**
 * `FillProof` on the wire (§3.1), field for field the struct the source router
 * hashes (`FILL_PROOF_TYPES`, the twelve variant A fields of protocol §3.3).
 */
export interface FillProofJson {
  kind: number;
  orderHash: Hex;
  destination: Hex;
  fillRef: Hex;
  recipient: Hex;
  outputAsset: Hex;
  amountDelivered: DecString;
  filledAt: DecString;
  /** `fillerIdHash(fillerId)` of the filler that delivered. */
  fillerId: Hex;
  /** The payee of `settle`, encoded for the source chain: the `repayTo` of the filler's ticket. */
  repayTo: Hex;
  attempt: number;
  setId: number;
}

/** EVM source: 65-byte `r ‖ s ‖ v`; in payload order the `signature` values are the `sigs` of `settle`. */
export interface AttestationEvm {
  signer: Hex;
  signature: Hex;
}

/**
 * Canton source: a `SigEntry` of `SwapIntent_SettleWithProof` with `0x`
 * (strip it for Daml) — the 88-byte DER SubjectPublicKeyInfo of the signer's
 * uncompressed key and a minimal DER signature — plus the address Daml derives
 * from the key.
 */
export interface AttestationCanton {
  signer: Hex;
  pubKey: Hex;
  signature: Hex;
}

export interface SettleAttestations extends S2FBase {
  type: 'settle.attestations';
  fillerId: string;
  orderHash: Hex;
  /** Equals `proof.attempt`. */
  attempt: number;
  /** CAIP-2 of the chain `settle` is submitted on: `eip155:<id>` or `canton:<network>`. */
  sourceChainId: string;
  proof: FillProofJson;
  /** At least `threshold`, strictly ascending by `signer`. */
  signatures: AttestationEvm[] | AttestationCanton[];
  /** Equals `proof.setId`; EVM: `attestationSetFor(orderHash)`. */
  setId: number;
  threshold: number;
  /** Unix seconds: `settle` must be included before it. */
  refundAfter: DecString;
}

/** What `settle.attestations` carries apart from its envelope: identical on WebSocket and REST. */
export type SettleAttestationsPayload = Omit<SettleAttestations, 'type' | 'id' | 'fillerId' | 'sentAt' | 'sig' | 're'>;

const ENVELOPE = new Set(['type', 'id', 'fillerId', 'sentAt', 'sig', 're']);

/** The payload of a `settle.attestations` frame or REST body: everything but `type`, `id`, `fillerId`, `sentAt`, `sig`, `re`. */
export function settleAttestationsPayload(frame: object): SettleAttestationsPayload {
  return Object.fromEntries(Object.entries(frame).filter(([k]) => !ENVELOPE.has(k))) as unknown as SettleAttestationsPayload;
}

/**
 * `keccak256(utf8(JCS(payload)))`: equal for the pushed frame and the pulled
 * body of the same delivery, whatever their `id`, `sentAt` and `sig`.
 */
export function settleAttestationsPayloadHash(frame: object): Hex {
  return toHex(keccak(utf8ToBytes(jcs(settleAttestationsPayload(frame)))));
}

/** Whether `settle` for this payload goes to Daml (`SwapIntent_SettleWithProof`) rather than an EVM router. */
export const isCantonSource = (sourceChainId: string): boolean => sourceChainId.startsWith('canton:');

/**
 * The rules of a schema-valid `settle.attestations` that JSON Schema cannot
 * state: `attempt`, `setId` and `orderHash` equal the proof's, at least
 * `threshold` signatures, signers strictly ascending (no duplicates).
 * Returns one message per broken rule, empty when none is.
 */
export function settleAttestationsErrors(payload: SettleAttestationsPayload): string[] {
  const errors: string[] = [];
  if (payload.attempt !== payload.proof.attempt) errors.push(`attempt ${payload.attempt} differs from proof.attempt ${payload.proof.attempt}`);
  if (payload.setId !== payload.proof.setId) errors.push(`setId ${payload.setId} differs from proof.setId ${payload.proof.setId}`);
  if (payload.orderHash.toLowerCase() !== payload.proof.orderHash.toLowerCase()) errors.push('orderHash differs from proof.orderHash');
  if (payload.signatures.length < payload.threshold) errors.push(`${payload.signatures.length} signatures, fewer than threshold ${payload.threshold}`);
  const signers = payload.signatures.map((s) => s.signer.toLowerCase());
  for (let i = 1; i < signers.length; i++) {
    if (signers[i]! <= signers[i - 1]!) {
      errors.push(`signers not strictly ascending at index ${i}`);
      break;
    }
  }
  return errors;
}

/** EVM source: the `sigs` argument of `CancoreRouter.settle(order, proof, sigs)`, in payload order. */
export function settleSigs(payload: SettleAttestationsPayload): Hex[] {
  if (isCantonSource(payload.sourceChainId)) throw new TypeError(`${payload.sourceChainId} is a Canton source: use cantonSigEntries`);
  return (payload.signatures as AttestationEvm[]).map((s) => s.signature);
}

/** Canton source: the `bundle : [SigEntry]` of `SwapIntent_SettleWithProof` — lowercase hex without `0x`, in payload order. */
export function cantonSigEntries(payload: SettleAttestationsPayload): { pubKey: string; sig: string }[] {
  if (!isCantonSource(payload.sourceChainId)) throw new TypeError(`${payload.sourceChainId} is not a Canton source: use settleSigs`);
  return (payload.signatures as AttestationCanton[]).map((s) => ({ pubKey: s.pubKey.slice(2).toLowerCase(), sig: s.signature.slice(2).toLowerCase() }));
}
