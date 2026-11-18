/**
 * What a key checks before it signs the topology that creates its party
 * (CAN-2414). The multihash is recomputed from the topology transactions — each
 * hashed with purpose 11 (TopologyTransactionSignature), the set with purpose 55
 * (MultiTopologyTransaction) — and the transactions must create exactly the
 * party expected: its namespace is the fingerprint of the signing key, that key
 * is its only signing key at threshold 1 (legacy mappings or a self-signed
 * PartyToParticipant), and it is hosted on the expected participant alone, with
 * Confirmation permission. Anything else is refused, never signed.
 *
 * Moved here from the trader's filler (protocol §3.19), which keeps calling it,
 * so the web wallet and the SDK hold an account's onboarding to the same rules.
 */
import { Enums_ParticipantPermission, Enums_TopologyChangeOp, PartyToParticipant, SigningPublicKey, TopologyTransaction } from '@canton-network/core-ledger-proto';
import { MessageType, RepeatType, ScalarType } from '@protobuf-ts/runtime';
import { bytesToHex } from '../bytes';
import { cantonFingerprint } from '../cantonFingerprint';
import { cantonHash, fromBase64, multiHashInput } from './hashing';

/** Canton `HashPurpose` ids (`HashPurpose.scala`). */
const TOPOLOGY_TRANSACTION_PURPOSE = 11;
const MULTI_TOPOLOGY_TRANSACTION_PURPOSE = 55;
/** DER `SubjectPublicKeyInfo` prefix of an Ed25519 key; 32 raw key bytes follow. */
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';

/** A topology the key will not sign; `detail` is safe to log (no transaction bytes). */
export class TopologyRefusal extends Error {
  override readonly name = 'TopologyRefusal';
  constructor(readonly detail: string) {
    super(`topology refused: ${detail}`);
  }
}

export interface PartyExpectation {
  /** The party the topology must create. */
  partyId: string;
  /** The signing key, 32 bytes hex: the only key the party may have. */
  publicKey: string;
  /** The participant the party may be hosted on, from release data, never from the server; `PAR::` optional. */
  participantUid: string;
}

/** A participant id with or without the `PAR::` member prefix: topology writes it with, the JSON Ledger API without. */
export const participantId = (uid: string): string => (uid.startsWith('PAR::') ? uid.slice(5) : uid);
const strip0x = (hex: string): string => (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();

const refuse = (detail: string): never => {
  throw new TopologyRefusal(detail);
};

type Mapping = NonNullable<TopologyTransaction['mapping']>['mapping'];
interface Expected extends PartyExpectation {
  /** The signing key, lower-case hex without `0x`. */
  key: string;
  fingerprint: string;
}

/**
 * Holds base64 topology transactions and the multihash a key is asked to sign
 * (hex, `0x` optional) to the party it expects; throws {@link TopologyRefusal}.
 */
export function verifyPartyTopology(topologyTransactions: readonly string[] | undefined, multihash: string, expect: PartyExpectation): void {
  const expected = expectedParty(expect);
  const seen = new Set<string>();
  let selfSigned = false;
  for (const bytes of hashedTransactions(topologyTransactions, multihash)) {
    const mapping = newPartyMapping(bytes);
    if (seen.has(mapping.oneofKind ?? '')) refuse(`two ${mapping.oneofKind} mappings`);
    seen.add(mapping.oneofKind ?? '');
    selfSigned = checkMapping(mapping, expected) || selfSigned;
  }
  allMappings(seen, selfSigned);
}

/** A self-signed hosting stands alone; otherwise the namespace, the key mapping and the hosting are all there. */
function allMappings(seen: ReadonlySet<string>, selfSigned: boolean): void {
  if (selfSigned && seen.size !== 1) refuse('the allocation mixes self-signed and legacy key mappings');
  for (const needed of selfSigned ? ['partyToParticipant'] : ['namespaceDelegation', 'partyToKeyMapping', 'partyToParticipant']) {
    if (!seen.has(needed)) refuse(`no ${needed} mapping`);
  }
}

/** The key is an Ed25519 key, and the party is in its namespace. */
function expectedParty(expect: PartyExpectation): Expected {
  const key = strip0x(expect.publicKey);
  if (!/^[0-9a-f]{64}$/.test(key)) refuse('the signing key is not a 32-byte Ed25519 key');
  const fingerprint = cantonFingerprint(key);
  const [, namespace, ...rest] = expect.partyId.split('::');
  if (namespace !== fingerprint || rest.length > 0) refuse('the party is not in the namespace of the signing key');
  return { ...expect, key, fingerprint };
}

/** The transactions' bytes, once their multihash is the one to sign. */
function hashedTransactions(topologyTransactions: readonly string[] | undefined, multihash: string): Uint8Array[] {
  if (!Array.isArray(topologyTransactions) || topologyTransactions.length === 0) refuse('no topology transactions to check');
  let raw: Uint8Array[] = [];
  try {
    raw = (topologyTransactions as readonly string[]).map((tx) => fromBase64(tx));
  } catch {
    refuse('a topology transaction is not base64');
  }
  const hashes = raw.map((bytes) => cantonHash(TOPOLOGY_TRANSACTION_PURPOSE, bytes));
  const multi = cantonHash(MULTI_TOPOLOGY_TRANSACTION_PURPOSE, multiHashInput(hashes));
  if (bytesToHex(multi) !== strip0x(multihash)) refuse('the hash is not the multihash of the topology transactions');
  return raw;
}

/** The mapping of a transaction that adds it for the first time. */
function newPartyMapping(bytes: Uint8Array): NonNullable<Mapping> {
  let tx: TopologyTransaction;
  try {
    tx = decodeTopology(bytes);
  } catch {
    return refuse('a topology transaction does not decode');
  }
  if (tx.operation !== Enums_TopologyChangeOp.ADD_REPLACE) refuse('a topology transaction is not ADD_REPLACE');
  // A new party's mappings are at serial 1: a higher serial re-hosts or re-keys one that exists.
  if (tx.serial !== 1) refuse(`a topology transaction is at serial ${tx.serial}, not 1`);
  return tx.mapping?.mapping ?? refuse('a topology transaction has no mapping');
}

/** Checks one mapping; true when it is a PartyToParticipant that carries the party's signing keys itself. */
function checkMapping(mapping: NonNullable<Mapping>, expected: Expected): boolean {
  switch (mapping.oneofKind) {
    case 'namespaceDelegation': {
      const d = mapping.namespaceDelegation;
      if (d.namespace !== expected.fingerprint) refuse('the namespace is not the fingerprint of the signing key');
      if (rawEd25519(d.targetKey) !== expected.key) refuse('the namespace delegates to another key than the signing key');
      return false;
    }
    case 'partyToKeyMapping': {
      const m = mapping.partyToKeyMapping;
      if (m.party !== expected.partyId) refuse('the key mapping is for another party');
      onlyKey(m.signingKeys, m.threshold, expected.key);
      return false;
    }
    case 'partyToParticipant':
      return checkHosting(mapping.partyToParticipant, expected);
    default:
      return refuse(`a ${String(mapping.oneofKind)} mapping is not part of a party allocation`);
  }
}

/** The party is hosted on the expected participant alone, confirming; its own signing keys, if it carries them, are the key alone. */
function checkHosting(p: PartyToParticipant, expected: Expected): boolean {
  let signing: SigningKeys | undefined;
  try {
    signing = partySigningKeys(p);
  } catch {
    return refuse('unsupported party hosting fields');
  }
  if (signing) onlyKey(signing.keys, signing.threshold, expected.key);
  if (p.party !== expected.partyId) refuse('the hosting is for another party');
  if (p.threshold !== 1) refuse(`the hosting threshold is ${p.threshold}, not 1`);
  const [only, ...more] = p.participants;
  if (!only || more.length > 0 || participantId(only.participantUid) !== participantId(expected.participantUid)) {
    refuse('the party is hosted elsewhere than on the expected participant alone');
  }
  if (only?.permission !== Enums_ParticipantPermission.CONFIRMATION) refuse('the hosting permission is not Confirmation');
  return signing !== undefined;
}

/** The signing keys are the one key, at threshold 1. */
function onlyKey(keys: readonly SigningPublicKey[], threshold: number, key: string): void {
  if (threshold !== 1) refuse(`the key threshold is ${threshold}, not 1`);
  if (keys.length !== 1 || rawEd25519(keys[0]) !== key) refuse('the party has another signing key than the signing key alone');
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
 * A topology transaction as the Ledger API serializes it: Canton's
 * `UntypedVersionedMessage` (`data` = 1, `version` = 2) around the
 * `TopologyTransaction`, or the bare message.
 */
export function decodeTopology(bytes: Uint8Array): TopologyTransaction {
  if (bytes[0] !== 0x0a) return TopologyTransaction.fromBinary(bytes);
  const [length, start] = varint(bytes, 1);
  const end = start + length;
  if (end > bytes.length) throw new TypeError('truncated versioned topology transaction');
  // After `data` only the `version` field (2, varint) may follow, once; anything else is refused.
  if (end < bytes.length) {
    if (bytes[end] !== 0x10) throw new TypeError('unexpected field after the versioned topology transaction');
    const [, after] = varint(bytes, end + 1);
    if (after !== bytes.length) throw new TypeError('unexpected bytes after the version of the topology transaction');
  }
  return TopologyTransaction.fromBinary(bytes.subarray(start, end));
}

/** A protobuf varint (≤ 5 bytes: a length or an int32) at `at`: its value and the index after it. */
function varint(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const b = bytes[at + i];
    if (b === undefined) throw new TypeError('truncated varint');
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return [value >>> 0, at + i + 1];
  }
  throw new TypeError('varint longer than 5 bytes');
}

interface SigningKeys {
  keys: SigningPublicKey[];
  threshold: number;
}

// core-ledger-proto 1.13 omits PartyToParticipant field 6; use Canton's schema until its generated package catches up.
// https://github.com/digital-asset/canton/blob/fad99cfe87ab5a4d400f2a0d45f1d4a31097e3d7/community/base/src/main/protobuf/com/digitalasset/canton/protocol/v30/topology.proto
const keysWithThreshold = new MessageType<SigningKeys>('com.digitalasset.canton.crypto.v30.SigningKeysWithThreshold', [
  { no: 1, name: 'keys', kind: 'message', repeat: RepeatType.UNPACKED, T: () => SigningPublicKey },
  { no: 2, name: 'threshold', kind: 'scalar', T: ScalarType.UINT32 },
]);
const hosting = new MessageType<PartyToParticipant & { partySigningKeys?: SigningKeys }>(PartyToParticipant.typeName, [
  ...PartyToParticipant.fields,
  { no: 6, name: 'party_signing_keys', kind: 'message', T: () => keysWithThreshold },
]);

/** Decode every hosting field; unsupported fields are refused rather than silently signed. */
function partySigningKeys(mapping: PartyToParticipant): SigningKeys | undefined {
  return hosting.fromBinary(PartyToParticipant.toBinary(mapping), { readUnknownField: 'throw' }).partySigningKeys;
}
