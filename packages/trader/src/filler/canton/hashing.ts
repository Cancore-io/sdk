/**
 * Canton's hashes the node recomputes before it signs (interactive submission
 * hashing scheme V2, topology multihash), synchronous and platform-neutral:
 * `@noble/hashes` only, no Node or DOM globals, so a consumer of the package
 * needs neither.
 *
 * The V2 encoding follows `@canton-network/core-tx-visualizer` 1.13
 * (`hashing_scheme_v2.ts`, Apache-2.0, Digital Asset), with two deliberate
 * differences: an `int64` value is encoded from its exact decimal (the
 * library parses it through a double), and an exercise node without a seed is
 * an error instead of an undefined read. The tests hold this port to the
 * library on the shapes both handle.
 */
import {
  type Create,
  type DamlTransaction,
  type DamlTransaction_Node,
  type DamlTransaction_NodeSeed,
  type Exercise,
  type Fetch,
  HashingSchemeVersion,
  type Identifier,
  type Metadata,
  type Metadata_InputContract,
  PreparedTransaction,
  type Value,
} from '@canton-network/core-ledger-proto';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/** `HashPurpose.PreparedSubmission` = 48, as int32BE. */
const PREPARED_TRANSACTION_PURPOSE = Uint8Array.of(0, 0, 0, 48);
const NODE_ENCODING_VERSION = 1;

export function concat(...parts: Array<Uint8Array | number>): Uint8Array {
  const arrays = parts.map((p) => (typeof p === 'number' ? Uint8Array.of(p) : p));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

export function int32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, false);
  return out;
}

function int64(value: bigint | string | number | undefined): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(value ?? 0), false);
  return out;
}

const bytes = (value: Uint8Array): Uint8Array => concat(int32(value.length), value);
const text = (value = ''): Uint8Array => bytes(utf8ToBytes(value));
const bool = (value: boolean): Uint8Array => Uint8Array.of(value ? 1 : 0);

function hexBytes(value = ''): Uint8Array {
  if (!/^([0-9a-fA-F]{2})*$/.test(value)) throw new TypeError('not a hex contract id');
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes(out);
}

const optional = <T>(value: T | undefined | null, encode: (v: T) => Uint8Array): Uint8Array =>
  value === undefined || value === null ? Uint8Array.of(0) : concat(1, encode(value));
const repeated = <T>(values: readonly T[] | undefined, encode: (v: T) => Uint8Array): Uint8Array =>
  concat(int32(values?.length ?? 0), ...(values ?? []).map(encode));

const identifier = (id: Identifier | undefined): Uint8Array =>
  concat(text(id?.packageId), repeated((id?.moduleName ?? '').split('.'), text), repeated((id?.entityName ?? '').split('.'), text));

function value(v: Value | undefined): Uint8Array {
  const sum = v?.sum;
  switch (sum?.oneofKind) {
    case 'unit':
      return Uint8Array.of(0);
    case 'bool':
      return concat(1, bool(sum.bool));
    case 'int64':
      return concat(2, int64(sum.int64));
    case 'numeric':
      return concat(3, text(sum.numeric));
    case 'timestamp':
      return concat(4, int64(sum.timestamp));
    case 'date':
      return concat(5, int32(sum.date));
    case 'party':
      return concat(6, text(sum.party));
    case 'text':
      return concat(7, text(sum.text));
    case 'contractId':
      return concat(8, hexBytes(sum.contractId));
    case 'optional':
      return concat(9, optional(sum.optional.value, value));
    case 'list':
      return concat(10, repeated(sum.list.elements, value));
    case 'textMap':
      return concat(11, repeated(sum.textMap.entries, (e) => concat(text(e.key), value(e.value))));
    case 'record':
      return concat(12, optional(sum.record.recordId, identifier), repeated(sum.record.fields, (f) => concat(optional(f.label, text), value(f.value))));
    case 'variant':
      return concat(13, optional(sum.variant.variantId, identifier), text(sum.variant.constructor), value(sum.variant.value));
    case 'enum':
      return concat(14, optional(sum.enum.enumId, identifier), text(sum.enum.constructor));
    case 'genMap':
      return concat(15, repeated(sum.genMap.entries, (e) => concat(value(e.key), value(e.value))));
    default:
      throw new TypeError(`unsupported value ${String(sum?.oneofKind)}`);
  }
}

type Nodes = ReadonlyMap<string, DamlTransaction_Node>;
const seedOf = (nodeId: string, seeds: readonly DamlTransaction_NodeSeed[]): Uint8Array | undefined => seeds.find((s) => String(s.nodeId) === nodeId)?.seed;

function createNode(create: Create, nodeId: string, seeds: readonly DamlTransaction_NodeSeed[]): Uint8Array {
  return concat(
    NODE_ENCODING_VERSION,
    text(create.lfVersion),
    0,
    optional(seedOf(nodeId, seeds), (s) => s),
    hexBytes(create.contractId),
    text(create.packageName),
    identifier(create.templateId),
    value(create.argument),
    repeated(create.signatories, text),
    repeated(create.stakeholders, text),
  );
}

function exerciseNode(exercise: Exercise, nodeId: string, nodes: Nodes, seeds: readonly DamlTransaction_NodeSeed[]): Uint8Array {
  const seed = seedOf(nodeId, seeds);
  if (!seed) throw new TypeError(`exercise node ${nodeId} has no seed`);
  return concat(
    NODE_ENCODING_VERSION,
    text(exercise.lfVersion),
    1,
    seed,
    hexBytes(exercise.contractId),
    text(exercise.packageName),
    identifier(exercise.templateId),
    repeated(exercise.signatories, text),
    repeated(exercise.stakeholders, text),
    repeated(exercise.actingParties, text),
    optional(exercise.interfaceId, identifier),
    text(exercise.choiceId),
    value(exercise.chosenValue),
    bool(exercise.consuming),
    optional(exercise.exerciseResult, value),
    repeated(exercise.choiceObservers, text),
    repeated(exercise.children, (child) => nodeHash(child, nodes, seeds)),
  );
}

function fetchNode(fetch: Fetch): Uint8Array {
  return concat(
    NODE_ENCODING_VERSION,
    text(fetch.lfVersion),
    2,
    hexBytes(fetch.contractId),
    text(fetch.packageName),
    identifier(fetch.templateId),
    repeated(fetch.signatories, text),
    repeated(fetch.stakeholders, text),
    optional(fetch.interfaceId, identifier),
    repeated(fetch.actingParties, text),
  );
}

function nodeHash(nodeId: string, nodes: Nodes, seeds: readonly DamlTransaction_NodeSeed[]): Uint8Array {
  const node = nodes.get(nodeId);
  if (!node) throw new TypeError(`node ${nodeId} is not in the transaction`);
  if (node.versionedNode.oneofKind !== 'v1') throw new TypeError(`node ${nodeId}: unsupported node version`);
  const type = node.versionedNode.v1.nodeType;
  switch (type.oneofKind) {
    case 'create':
      return sha256(createNode(type.create, nodeId, seeds));
    case 'exercise':
      return sha256(exerciseNode(type.exercise, nodeId, nodes, seeds));
    case 'fetch':
      return sha256(fetchNode(type.fetch));
    case 'rollback':
      return sha256(concat(NODE_ENCODING_VERSION, 3, repeated(type.rollback.children, (child) => nodeHash(child, nodes, seeds))));
    default:
      throw new TypeError(`node ${nodeId}: unsupported node type`);
  }
}

const inputContract = (c: Metadata_InputContract): Uint8Array => {
  if (c.contract.oneofKind !== 'v1') throw new TypeError('unsupported input contract version');
  return concat(int64(c.createdAt), sha256(createNode(c.contract.v1, 'unused_node_id', [])));
};

function metadataHash(m: Metadata | undefined): Uint8Array {
  if (!m) throw new TypeError('no metadata');
  const encoded = concat(
    1,
    repeated(m.submitterInfo?.actAs, text),
    text(m.submitterInfo?.commandId),
    text(m.transactionUuid),
    int32(m.mediatorGroup),
    text(m.synchronizerId),
    optional(m.minLedgerEffectiveTime, int64),
    optional(m.maxLedgerEffectiveTime, int64),
    int64(m.preparationTime),
    repeated(m.inputContracts, inputContract),
  );
  return sha256(concat(PREPARED_TRANSACTION_PURPOSE, encoded));
}

function transactionHash(t: DamlTransaction | undefined): Uint8Array {
  if (!t) throw new TypeError('no transaction');
  const nodes = new Map(t.nodes.map((n) => [n.nodeId, n] as const));
  const encoded = concat(text(t.version), repeated(t.roots, (root) => nodeHash(root, nodes, t.nodeSeeds)));
  return sha256(concat(PREPARED_TRANSACTION_PURPOSE, encoded));
}

/** The hash a party signs for a prepared transaction under hashing scheme V2: 32 bytes. */
export function hashPreparedTransactionV2(prepared: PreparedTransaction): Uint8Array {
  return sha256(concat(PREPARED_TRANSACTION_PURPOSE, HashingSchemeVersion.V2, transactionHash(prepared.transaction), metadataHash(prepared.metadata)));
}

/** Canton's hash with a purpose: `0x1220` ‖ sha256(int32BE(purpose) ‖ bytes). */
export const cantonHash = (purpose: number, data: Uint8Array): Uint8Array => concat(0x12, 0x20, sha256(concat(int32(purpose), data)));

/** The input of the topology multihash: int32(n) ‖ (int32(len) ‖ hash) for the hashes in hex order. */
export function multiHashInput(hashes: readonly Uint8Array[]): Uint8Array {
  const sorted = [...hashes].sort((a, b) => bytesToHex(a).localeCompare(bytesToHex(b)));
  return concat(int32(sorted.length), ...sorted.flatMap((h) => [int32(h.length), h]));
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i] as const));

/** Strict standard base64 (padding optional) to bytes, without `atob` or `Buffer`. */
export function fromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  if (clean.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(clean)) throw new TypeError('not base64');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let at = 0;
  for (const c of clean) {
    acc = (acc << 6) | (B64_INDEX.get(c) as number);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** A base64 prepared transaction, decoded. */
export const decodePreparedTransaction = (b64: string): PreparedTransaction => PreparedTransaction.fromBinary(fromBase64(b64));
