/**
 * A small Solidity ABI codec driven by the ABI arrays of `@cancore/contracts`
 * (sdk.md S1: no function signature is typed by hand here). It covers what the
 * filler reads and decodes off the routers and ERC-20 tokens — `uintN`,
 * `intN`, `address`, `bool`, `bytesN`, `bytes`, `string`, tuples and dynamic
 * arrays — and refuses anything else loudly. The package takes no ABI library:
 * the node injects only an EIP-1193 `request` (`EvmRpc`), and selectors and
 * topics are keccak256 of the canonical signature, computed from the ABI entry.
 *
 * Decoded values: integers as `bigint`, addresses and fixed bytes as lowercase
 * `0x` hex, `bool` as boolean, tuples as objects keyed by component name.
 */
import type { Hex } from '@cancore/contracts';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export interface AbiParam {
  readonly name?: string;
  readonly type: string;
  readonly indexed?: boolean;
  readonly components?: readonly AbiParam[];
}

export interface AbiEntry {
  readonly type: string;
  readonly name?: string;
  readonly inputs?: readonly AbiParam[];
  readonly outputs?: readonly AbiParam[];
  readonly anonymous?: boolean;
}

/** Bytes that do not decode under the expected ABI types: a malformed or hostile RPC answer. */
export class AbiDecodeError extends Error {
  override readonly name = 'AbiDecodeError';
}

const WORD = 32;
const INT = /^(u?)int([0-9]*)$/;
const FIXED_BYTES = /^bytes([0-9]+)$/;
const ARRAY = /^(.*)\[\]$/;

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/** The canonical type of a parameter: tuples expanded, `uint` → `uint256`. */
export function canonicalType(param: AbiParam): string {
  const array = ARRAY.exec(param.type);
  if (array) return `${canonicalType({ ...param, type: array[1]! })}[]`;
  if (param.type === 'tuple') return `(${(param.components ?? []).map(canonicalType).join(',')})`;
  if (param.type === 'uint' || param.type === 'int') return `${param.type}256`;
  return param.type;
}

export const signatureOf = (entry: AbiEntry): string => `${entry.name}(${(entry.inputs ?? []).map(canonicalType).join(',')})`;

const keccakHex = (text: string): Hex => `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`;

/** The 4-byte selector of a function. */
export const selectorOf = (entry: AbiEntry): Hex => keccakHex(signatureOf(entry)).slice(0, 10) as Hex;

/** `topics[0]` of a non-anonymous event. */
export const topicOf = (entry: AbiEntry): Hex => keccakHex(signatureOf(entry));

/** The one entry of `abi` named `name` of `type`; throws when there is none or it is overloaded. */
export function entryOf(abi: readonly AbiEntry[], type: 'function' | 'event', name: string): AbiEntry {
  const hits = abi.filter((e) => e.type === type && e.name === name);
  if (hits.length !== 1) throw new TypeError(`ABI: expected one ${type} ${name}, found ${hits.length}`);
  return hits[0]!;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const word = (n: bigint): Uint8Array => hexToBytes(n.toString(16).padStart(WORD * 2, '0'));

function intOf(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new TypeError(`${field}: expected an integer, got ${String(value)}`);
}

function hexOf(value: unknown, field: string, length?: number): Uint8Array {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) throw new TypeError(`${field}: expected 0x-prefixed hex`);
  const bytes = hexToBytes(value.slice(2));
  if (length !== undefined && bytes.length !== length) throw new TypeError(`${field}: expected ${length} bytes, got ${bytes.length}`);
  return bytes;
}

function isDynamic(param: AbiParam): boolean {
  if (param.type === 'bytes' || param.type === 'string' || ARRAY.test(param.type)) return true;
  if (param.type === 'tuple') return (param.components ?? []).some(isDynamic);
  return false;
}

/** Bytes a static parameter takes in the head. */
function staticSize(param: AbiParam): number {
  if (param.type === 'tuple') return (param.components ?? []).reduce((sum, c) => sum + staticSize(c), 0);
  return WORD;
}

const fieldName = (param: AbiParam, index: number): string => (param.name ? param.name : String(index));

function tupleValues(components: readonly AbiParam[], value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) {
    if (value.length !== components.length) throw new TypeError(`${field}: expected ${components.length} values, got ${value.length}`);
    return value;
  }
  if (typeof value !== 'object' || value === null) throw new TypeError(`${field}: expected a tuple`);
  const record = value as Record<string, unknown>;
  return components.map((c, i) => {
    const key = fieldName(c, i);
    if (!(key in record)) throw new TypeError(`${field}: missing ${key}`);
    return record[key];
  });
}

function dynamicBytes(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(data.length / WORD) * WORD);
  padded.set(data);
  return concatBytes(word(BigInt(data.length)), padded);
}

function encodeOne(param: AbiParam, value: unknown, field: string): Uint8Array {
  const array = ARRAY.exec(param.type);
  if (array) {
    if (!Array.isArray(value)) throw new TypeError(`${field}: expected an array`);
    const element = { ...param, type: array[1]! };
    return concatBytes(word(BigInt(value.length)), encodeParams(value.map(() => element), value, field));
  }
  if (param.type === 'tuple') {
    const components = param.components ?? [];
    return encodeParams(components, tupleValues(components, value, field), field);
  }
  if (param.type === 'address') return concatBytes(new Uint8Array(12), hexOf(value, field, 20));
  if (param.type === 'bool') {
    if (typeof value !== 'boolean') throw new TypeError(`${field}: expected a boolean`);
    return word(value ? 1n : 0n);
  }
  if (param.type === 'bytes') return dynamicBytes(hexOf(value, field));
  if (param.type === 'string') {
    if (typeof value !== 'string') throw new TypeError(`${field}: expected a string`);
    return dynamicBytes(utf8ToBytes(value));
  }
  const fixed = FIXED_BYTES.exec(param.type);
  if (fixed) {
    const out = new Uint8Array(WORD);
    out.set(hexOf(value, field, Number(fixed[1])));
    return out;
  }
  const int = INT.exec(param.type);
  if (int) {
    const bits = BigInt(int[2] || '256');
    const n = intOf(value, field);
    if (int[1] === 'u') {
      if (n < 0n || n >= 1n << bits) throw new RangeError(`${field}: ${n} does not fit uint${bits}`);
      return word(n);
    }
    const bound = 1n << (bits - 1n);
    if (n < -bound || n >= bound) throw new RangeError(`${field}: ${n} does not fit int${bits}`);
    return word(n < 0n ? (1n << 256n) + n : n);
  }
  throw new TypeError(`${field}: ABI type ${param.type} is not supported`);
}

/** Head/tail encoding of `values` under `params` (a function's arguments, a tuple, an array's elements). */
export function encodeParams(params: readonly AbiParam[], values: readonly unknown[], field = 'args'): Uint8Array {
  if (values.length !== params.length) throw new TypeError(`${field}: expected ${params.length} values, got ${values.length}`);
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailOffset = params.reduce((sum, p) => sum + (isDynamic(p) ? WORD : staticSize(p)), 0);
  params.forEach((param, i) => {
    const encoded = encodeOne(param, values[i], `${field}.${fieldName(param, i)}`);
    if (isDynamic(param)) {
      heads.push(word(BigInt(tailOffset)));
      tails.push(encoded);
      tailOffset += encoded.length;
    } else heads.push(encoded);
  });
  return concatBytes(...heads, ...tails);
}

/** Calldata of `entry` with `args` in declaration order. */
export function encodeFunctionCall(entry: AbiEntry, args: readonly unknown[]): Hex {
  return `${selectorOf(entry)}${bytesToHex(encodeParams(entry.inputs ?? [], args, entry.name))}`;
}

/** What a node returns for `entry` (used by test doubles of the chain). */
export function encodeFunctionResult(entry: AbiEntry, values: readonly unknown[]): Hex {
  return `0x${bytesToHex(encodeParams(entry.outputs ?? [], values, `${entry.name} result`))}`;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function readWord(data: Uint8Array, offset: number, field: string): bigint {
  if (offset < 0 || offset + WORD > data.length) throw new AbiDecodeError(`${field}: out of bounds at ${offset}`);
  return BigInt(`0x${bytesToHex(data.subarray(offset, offset + WORD))}`);
}

function readOffset(data: Uint8Array, at: number, field: string): number {
  const n = readWord(data, at, field);
  if (n > BigInt(data.length)) throw new AbiDecodeError(`${field}: offset ${n} beyond ${data.length} bytes`);
  return Number(n);
}

function decodeOne(param: AbiParam, data: Uint8Array, offset: number, field: string): unknown {
  const array = ARRAY.exec(param.type);
  if (array) {
    const length = readWord(data, offset, field);
    // Every element takes at least one word: a longer claim is a lie about the data.
    if (length * BigInt(WORD) > BigInt(data.length)) throw new AbiDecodeError(`${field}: length ${length} beyond the data`);
    const element = { ...param, type: array[1]! };
    return decodeParamsAt(Array.from({ length: Number(length) }, () => element), data, offset + WORD, field);
  }
  if (param.type === 'tuple') {
    const components = param.components ?? [];
    const values = decodeParamsAt(components, data, offset, field);
    return Object.fromEntries(components.map((c, i) => [fieldName(c, i), values[i]]));
  }
  if (param.type === 'bytes' || param.type === 'string') {
    const length = readWord(data, offset, field);
    const start = offset + WORD;
    if (BigInt(start) + length > BigInt(data.length)) throw new AbiDecodeError(`${field}: ${length} bytes beyond the data`);
    const bytes = data.subarray(start, start + Number(length));
    if (param.type === 'bytes') return `0x${bytesToHex(bytes)}`;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new AbiDecodeError(`${field}: not UTF-8`);
    }
  }
  const value = readWord(data, offset, field);
  if (param.type === 'address') {
    if (value >> 160n !== 0n) throw new AbiDecodeError(`${field}: not an address word`);
    return `0x${value.toString(16).padStart(40, '0')}`;
  }
  if (param.type === 'bool') {
    if (value > 1n) throw new AbiDecodeError(`${field}: not a bool word`);
    return value === 1n;
  }
  const fixed = FIXED_BYTES.exec(param.type);
  if (fixed) {
    const size = Number(fixed[1]);
    const bytes = data.subarray(offset, offset + WORD);
    if (bytes.subarray(size).some((b) => b !== 0)) throw new AbiDecodeError(`${field}: bytes${size} with non-zero padding`);
    return `0x${bytesToHex(bytes.subarray(0, size))}`;
  }
  const int = INT.exec(param.type);
  if (int) {
    const bits = BigInt(int[2] || '256');
    if (int[1] === 'u') {
      if (value >> bits !== 0n) throw new AbiDecodeError(`${field}: does not fit uint${bits}`);
      return value;
    }
    const signed = value >= 1n << 255n ? value - (1n << 256n) : value;
    const bound = 1n << (bits - 1n);
    if (signed < -bound || signed >= bound) throw new AbiDecodeError(`${field}: does not fit int${bits}`);
    return signed;
  }
  throw new AbiDecodeError(`${field}: ABI type ${param.type} is not supported`);
}

function decodeParamsAt(params: readonly AbiParam[], data: Uint8Array, base: number, field: string): unknown[] {
  let head = base;
  return params.map((param, i) => {
    const name = `${field}.${fieldName(param, i)}`;
    if (isDynamic(param)) {
      const value = decodeOne(param, data, base + readOffset(data, head, name), name);
      head += WORD;
      return value;
    }
    const value = decodeOne(param, data, head, name);
    head += staticSize(param);
    return value;
  });
}

export function decodeParams(params: readonly AbiParam[], data: Hex, field = 'data'): unknown[] {
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) throw new AbiDecodeError(`${field}: expected 0x-prefixed hex`);
  return decodeParamsAt(params, hexToBytes(data.slice(2)), 0, field);
}

/**
 * The result of `entry`: the value itself for a single output, otherwise an
 * object keyed by output name (index for an unnamed one).
 */
export function decodeFunctionResult(entry: AbiEntry, data: Hex): unknown {
  const outputs = entry.outputs ?? [];
  const values = decodeParams(outputs, data, `${entry.name} result`);
  if (outputs.length === 1) return values[0];
  return Object.fromEntries(outputs.map((o, i) => [fieldName(o, i), values[i]]));
}

export interface RawLog {
  topics: readonly Hex[];
  data: Hex;
}

/** Topics and data of an event, as a node returns them in a log (used by test doubles of the chain). */
export function encodeEventLog(entry: AbiEntry, args: Readonly<Record<string, unknown>>): RawLog {
  const inputs = entry.inputs ?? [];
  const topics: Hex[] = entry.anonymous ? [] : [topicOf(entry)];
  const dataParams: AbiParam[] = [];
  const dataValues: unknown[] = [];
  inputs.forEach((param, i) => {
    const value = args[fieldName(param, i)];
    if (!param.indexed) {
      dataParams.push(param);
      dataValues.push(value);
    } else if (isDynamic(param)) throw new TypeError(`${entry.name}: indexed dynamic ${param.type} is not supported`);
    else topics.push(`0x${bytesToHex(encodeOne(param, value, `${entry.name}.${fieldName(param, i)}`))}`);
  });
  return { topics, data: `0x${bytesToHex(encodeParams(dataParams, dataValues, entry.name))}` };
}

/**
 * The arguments of an event log, keyed by name. An indexed dynamic value
 * (`string`, `bytes`, array, tuple) is only its keccak256 in the topic and is
 * returned as that hash.
 */
export function decodeEventLog(entry: AbiEntry, log: RawLog): Record<string, unknown> {
  const inputs = entry.inputs ?? [];
  const topics = log.topics.map((t) => t.toLowerCase() as Hex);
  if (!entry.anonymous && topics[0] !== topicOf(entry)) throw new AbiDecodeError(`${entry.name}: topic0 does not match`);
  const offset = entry.anonymous ? 0 : 1;
  const indexed = inputs.filter((p) => p.indexed);
  if (topics.length !== indexed.length + offset) throw new AbiDecodeError(`${entry.name}: expected ${indexed.length + offset} topics, got ${topics.length}`);
  const data = decodeParams(inputs.filter((p) => !p.indexed), log.data, entry.name ?? 'event');
  const out: Record<string, unknown> = {};
  let t = offset;
  let d = 0;
  inputs.forEach((param, i) => {
    const key = fieldName(param, i);
    if (param.indexed) {
      const topic = topics[t++]!;
      if (!/^0x[0-9a-f]{64}$/.test(topic)) throw new AbiDecodeError(`${entry.name}.${key}: a topic is 32 bytes`);
      out[key] = isDynamic(param) ? topic : decodeOne(param, hexToBytes(topic.slice(2)), 0, `${entry.name}.${key}`);
    } else out[key] = data[d++];
  });
  return out;
}
