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
 *   node key is its only signing key at threshold 1 (legacy mappings or a
 *   self-signed PartyToParticipant), and it is hosted on the
 *   Cancore participant alone, with Confirmation permission. The backend checks
 *   only its own participant's hosting; everything else is checked here alone.
 * - Any other leg kind is refused.
 */
import type { CantonLeg, CantonLegTopology, CantonLegTransaction, Hex } from '@cancore/contracts';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { cantonHash, decodePreparedTransaction, fromBase64, hashPreparedTransactionV2, multiHashInput } from './hashing';
import { type CantonTransaction, transactionView } from './transaction';
import { TopologyRefusal, verifyPartyTopology } from '@cancore/wallet/canton/proto';

/** The only hashing scheme a transaction leg may name. */
export const HASHING_SCHEME_V2 = 'HASHING_SCHEME_VERSION_V2';
/** Canton `HashPurpose` ids (`HashPurpose.scala`). */
export const HASH_PURPOSE = { topologyTransaction: 11, publicKeyFingerprint: 12, multiTopologyTransaction: 55 } as const;

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

/**
 * The registry's transfer under a delivery does what the node's check of the pinned registry refuses (BUG-1528). It
 * does not depend on the order: every delivery of the instrument through this registry is refused the same way until
 * the registry or the SDK pin changes. What the backend asked of the transfer (receiver, amount, instrument,
 * executeBefore, the stated input holdings) is checked apart from it, as a refusal of the order.
 */
export class RegistryTransferRefusal extends CantonRefusal {}

/** The input holdings the backend stated for one transfer are not what it spends: a refusal of that order alone. */
export class StatedInputRefusal extends CantonRefusal {}

/** Runs the check of a registry transfer; a refusal of it, other than of the stated inputs, is a `RegistryTransferRefusal`. */
export function registryTransferChecked(check: () => void): void {
  try {
    check();
  } catch (error) {
    throw error instanceof CantonRefusal && !(error instanceof StatedInputRefusal) ? new RegistryTransferRefusal(error.legId, error.detail) : error;
  }
}

export { decodeTopology, participantId } from '@cancore/wallet/canton/proto';
const strip0x = (hex: string): string => (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();

/** Fingerprint of an Ed25519 public key as a party id carries it after `::`: `1220` ‖ sha256(int32BE(12) ‖ key). */
export function cantonFingerprint(publicKey: string | Uint8Array): string {
  const key = typeof publicKey === 'string' ? hexToBytes(strip0x(publicKey)) : publicKey;
  if (key.length !== 32) throw new TypeError('an Ed25519 public key is 32 bytes');
  const input = new Uint8Array(4 + key.length);
  new DataView(input.buffer).setInt32(0, HASH_PURPOSE.publicKeyFingerprint, false);
  input.set(key, 4);
  return `1220${bytesToHex(sha256(input))}`;
}



/** Recomputes the hash of a transaction leg; returns the decoded transaction, as plain data, for the op's checks. */
export async function verifyTransactionLeg(leg: CantonLegTransaction): Promise<CantonTransaction> {
  if (leg.hashingSchemeVersion !== HASHING_SCHEME_V2) {
    throw new CantonRefusal(leg.legId, `hashing scheme ${String(leg.hashingSchemeVersion)} is not ${HASHING_SCHEME_V2}`);
  }
  if (typeof leg.preparedTransaction !== 'string' || leg.preparedTransaction.length === 0) {
    throw new CantonRefusal(leg.legId, 'no prepared transaction to check');
  }
  let view: CantonTransaction;
  let hash: string;
  try {
    const decoded = decodePreparedTransaction(leg.preparedTransaction);
    hash = bytesToHex(hashPreparedTransactionV2(decoded));
    view = transactionView(decoded);
  } catch {
    throw new CantonRefusal(leg.legId, 'the prepared transaction does not decode');
  }
  if (strip0x(hash) !== strip0x(leg.hash)) throw new CantonRefusal(leg.legId, 'the hash is not the hash of the prepared transaction');
  return view;
}

export interface PartyExpectation {
  /** The party the summary names. */
  partyId: string;
  /** The node's own party key, 32 bytes hex: the only key the party may have. */
  publicKey: Hex;
  /** The Cancore participant (`CANTON_PARTICIPANTS`, release data), never taken from the backend; `PAR::` optional. */
  participantUid: string;
}

/** Recomputes the multihash of a topology leg and holds its transactions to the party the node expects (`@cancore/wallet`, CAN-2414). */
export async function verifyTopologyLeg(leg: CantonLegTopology, expect: PartyExpectation): Promise<void> {
  try {
    verifyPartyTopology(leg.topologyTransactions, leg.hash, expect);
  } catch (error) {
    throw error instanceof TopologyRefusal ? new CantonRefusal(leg.legId, error.detail) : error;
  }
}

/** The leg kind is closed: anything but `transaction` and `topology` is refused, never signed. */
export function legKind(leg: CantonLeg): 'transaction' | 'topology' {
  const kind = (leg as { kind?: unknown }).kind;
  if (kind === 'transaction' || kind === 'topology') return kind;
  throw new CantonRefusal(String((leg as { legId?: unknown }).legId), `unknown leg kind ${String(kind)}`);
}
