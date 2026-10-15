/**
 * What the node checks on every leg of a Canton operation before its party key
 * signs it (protocol §3.19; operator decision T-1: the backend prepares and
 * submits, the node signs). The node never signs blind:
 *
 * - **Transaction leg.** The hashing scheme is named and is V2; the hash is
 *   recomputed from the prepared transaction and must equal the one to sign.
 *   The decoded transaction is returned for the op's own economic checks.
 * - **Topology leg** (`party.allocate` only). The multihash is recomputed from
 *   the topology transactions — each hashed with purpose 11
 *   (TopologyTransactionSignature), the set with purpose 55
 *   (MultiTopologyTransaction) — and the transactions must create exactly the
 *   party of the summary: its namespace is the fingerprint of the node key, the
 *   node key is its only signing key at threshold 1, and it is hosted on the
 *   Cancore participant alone, with Confirmation permission. The backend checks
 *   only its own participant's hosting; everything else is checked here alone.
 * - Any other leg kind is refused.
 */
import type { CantonLeg, CantonLegTopology, CantonLegTransaction, Hex } from '@cancore/contracts';
import {
  Enums_ParticipantPermission,
  Enums_TopologyChangeOp,
  type PreparedTransaction,
  type SigningPublicKey,
  TopologyTransaction,
} from '@canton-network/core-ledger-proto';
import {
  computeMultiHashForTopology,
  computeSha256CantonHash,
  decodePreparedTransaction,
  hashPreparedTransaction,
} from '@canton-network/core-tx-visualizer';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

/** The only hashing scheme a transaction leg may name. */
export const HASHING_SCHEME_V2 = 'HASHING_SCHEME_VERSION_V2';
/** Canton `HashPurpose` ids (`HashPurpose.scala`). */
export const HASH_PURPOSE = { topologyTransaction: 11, publicKeyFingerprint: 12, multiTopologyTransaction: 55 } as const;
/** DER `SubjectPublicKeyInfo` prefix of an Ed25519 key; 32 raw key bytes follow. */
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';

/** A leg the node will not sign; `detail` is safe to log (no transaction bytes). */
export class CantonRefusal extends Error {
  override readonly name = 'CantonRefusal';
  constructor(
    readonly legId: string,
    readonly detail: string,
  ) {
    super(`leg ${legId}: ${detail}`);
  }
}

const strip0x = (hex: string): string => (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();
const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(Buffer.from(b64, 'base64'));

/** Fingerprint of an Ed25519 public key as a party id carries it after `::`: `1220` ‖ sha256(int32BE(12) ‖ key). */
export function cantonFingerprint(publicKey: string | Uint8Array): string {
  const key = typeof publicKey === 'string' ? hexToBytes(strip0x(publicKey)) : publicKey;
  if (key.length !== 32) throw new TypeError('an Ed25519 public key is 32 bytes');
  const input = new Uint8Array(4 + key.length);
  new DataView(input.buffer).setInt32(0, HASH_PURPOSE.publicKeyFingerprint, false);
  input.set(key, 4);
  return `1220${bytesToHex(sha256(input))}`;
}

/** The 32 raw bytes of an Ed25519 signing key in either form Canton writes (raw or DER SPKI), else undefined. */
function rawEd25519(key: SigningPublicKey | undefined): string | undefined {
  if (!key) return undefined;
  const hex = bytesToHex(key.publicKey);
  if (hex.length === 64) return hex;
  if (hex.length === ED25519_SPKI_PREFIX.length + 64 && hex.startsWith(ED25519_SPKI_PREFIX)) return hex.slice(ED25519_SPKI_PREFIX.length);
  return undefined;
}

/**
 * A topology transaction as the backend relays it: the bare `TopologyTransaction`,
 * or wrapped in Canton's `UntypedVersionedMessage { bytes data = 1; int32 version = 2 }`.
 * The bare message starts with field 1 as a varint (tag 0x08); the wrapper with
 * field 1 as bytes (tag 0x0a).
 */
export function decodeTopology(bytes: Uint8Array): TopologyTransaction {
  if (bytes[0] !== 0x0a) return TopologyTransaction.fromBinary(bytes);
  let length = 0;
  let shift = 0;
  let i = 1;
  for (; i < bytes.length && i < 6; i++) {
    const b = bytes[i] as number;
    length |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  const start = i + 1;
  if (start + length > bytes.length) throw new TypeError('truncated versioned topology transaction');
  return TopologyTransaction.fromBinary(bytes.subarray(start, start + length));
}

/** Recomputes the hash of a transaction leg; returns the decoded transaction for the op's checks. */
export async function verifyTransactionLeg(leg: CantonLegTransaction): Promise<PreparedTransaction> {
  if (leg.hashingSchemeVersion !== HASHING_SCHEME_V2) {
    throw new CantonRefusal(leg.legId, `hashing scheme ${String(leg.hashingSchemeVersion)} is not ${HASHING_SCHEME_V2}`);
  }
  if (typeof leg.preparedTransaction !== 'string' || leg.preparedTransaction.length === 0) {
    throw new CantonRefusal(leg.legId, 'no prepared transaction to check');
  }
  let decoded: PreparedTransaction;
  let hash: string;
  try {
    decoded = decodePreparedTransaction(leg.preparedTransaction);
    hash = await hashPreparedTransaction(decoded, 'hex');
  } catch {
    throw new CantonRefusal(leg.legId, 'the prepared transaction does not decode');
  }
  if (strip0x(hash) !== strip0x(leg.hash)) throw new CantonRefusal(leg.legId, 'the hash is not the hash of the prepared transaction');
  return decoded;
}

export interface PartyExpectation {
  /** The party the summary names. */
  partyId: string;
  /** The node's own party key, 32 bytes hex: the only key the party may have. */
  publicKey: Hex;
  /** The Cancore participant, pinned by the node (never taken from the backend). */
  participantUid: string;
}

/** Recomputes the multihash of a topology leg and holds its transactions to the party the node expects. */
export async function verifyTopologyLeg(leg: CantonLegTopology, expect: PartyExpectation): Promise<void> {
  const refuse = (detail: string): never => {
    throw new CantonRefusal(leg.legId, detail);
  };
  if (!Array.isArray(leg.topologyTransactions) || leg.topologyTransactions.length === 0) refuse('no topology transactions to check');
  const key = strip0x(expect.publicKey);
  const fingerprint = cantonFingerprint(key);
  if (expect.partyId.split('::').length !== 2 || expect.partyId.split('::')[1] !== fingerprint) {
    refuse('the party is not in the namespace of the node key');
  }

  const raw = leg.topologyTransactions.map((tx) => fromBase64(tx));
  const hashes = await Promise.all(raw.map((bytes) => computeSha256CantonHash(HASH_PURPOSE.topologyTransaction, bytes)));
  const multi = await computeSha256CantonHash(HASH_PURPOSE.multiTopologyTransaction, await computeMultiHashForTopology(hashes));
  if (bytesToHex(multi) !== strip0x(leg.hash)) refuse('the hash is not the multihash of the topology transactions');

  const seen = new Set<string>();
  for (const bytes of raw) {
    let tx: TopologyTransaction;
    try {
      tx = decodeTopology(bytes);
    } catch {
      return refuse('a topology transaction does not decode');
    }
    if (tx.operation !== Enums_TopologyChangeOp.ADD_REPLACE) refuse('a topology transaction is not ADD_REPLACE');
    const mapping = tx.mapping?.mapping;
    if (!mapping) return refuse('a topology transaction has no mapping');
    if (seen.has(mapping.oneofKind ?? '')) refuse(`two ${mapping.oneofKind} mappings`);
    seen.add(mapping.oneofKind ?? '');
    switch (mapping.oneofKind) {
      case 'namespaceDelegation': {
        const d = mapping.namespaceDelegation;
        if (d.namespace !== fingerprint) refuse('the namespace is not the fingerprint of the node key');
        if (rawEd25519(d.targetKey) !== key) refuse('the namespace delegates to another key than the node key');
        break;
      }
      case 'partyToKeyMapping': {
        const m = mapping.partyToKeyMapping;
        if (m.party !== expect.partyId) refuse('the key mapping is for another party');
        if (m.threshold !== 1) refuse(`the key threshold is ${m.threshold}, not 1`);
        if (m.signingKeys.length !== 1 || rawEd25519(m.signingKeys[0]) !== key) refuse('the party has another signing key than the node key alone');
        break;
      }
      case 'partyToParticipant': {
        const p = mapping.partyToParticipant;
        if (p.party !== expect.partyId) refuse('the hosting is for another party');
        if (p.threshold !== 1) refuse(`the hosting threshold is ${p.threshold}, not 1`);
        const [only, ...more] = p.participants;
        if (!only || more.length > 0 || only.participantUid !== expect.participantUid) refuse('the party is hosted elsewhere than on the Cancore participant alone');
        if (only?.permission !== Enums_ParticipantPermission.CONFIRMATION) refuse('the hosting permission is not Confirmation');
        break;
      }
      default:
        refuse(`a ${String(mapping.oneofKind)} mapping is not part of a party allocation`);
    }
  }
  for (const needed of ['namespaceDelegation', 'partyToKeyMapping', 'partyToParticipant']) {
    if (!seen.has(needed)) refuse(`no ${needed} mapping`);
  }
}

/** The leg kind is closed: anything but `transaction` and `topology` is refused, never signed. */
export function legKind(leg: CantonLeg): 'transaction' | 'topology' {
  const kind = (leg as { kind?: unknown }).kind;
  if (kind === 'transaction' || kind === 'topology') return kind;
  throw new CantonRefusal(String((leg as { legId?: unknown }).legId), `unknown leg kind ${String(kind)}`);
}
