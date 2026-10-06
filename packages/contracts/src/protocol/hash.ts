/**
 * EIP-712 hashing for the flat structs of the intent rail, RFC 8785 JCS, and
 * the two protocol hashes built on them. No signing here: a digest is what a
 * consumer hands its own secp256k1 implementation (protocol §3.3, SDK §7).
 */
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { beBytes, hexBytes, keccak, toHex, uint } from './bytes';
import type { Hex, UintLike } from './typedData';

export interface TypedField {
  readonly name: string;
  readonly type: string;
}

export type TypedDataTypes = Readonly<Record<string, readonly TypedField[]>>;

export type TypedValue = string | number | bigint | boolean;

export interface TypedDataDomain {
  name?: string;
  version?: string;
  chainId?: UintLike;
  verifyingContract?: Hex | string;
  salt?: Hex | string;
}

export interface TypedDataInput {
  domain: TypedDataDomain;
  types: TypedDataTypes;
  primaryType: string;
  message: Readonly<Record<string, unknown>>;
}

/** A JSON value JCS can canonicalise: numbers are safe integers only. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const ATOMIC = /^(address|bool|string|bytes([1-9]|[12][0-9]|3[0-2])?|uint(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256))$/;

const flatOnly = (type: string, field: string) =>
  new TypeError(`${field}: type ${type} is not supported — hashTypedData encodes flat structs of address/bool/bytes/bytesN/string/uintN only`);

/** One member as its 32-byte EIP-712 word. */
function encodeValue(type: string, value: unknown, field: string): Uint8Array {
  if (type === 'address') return padded(hexBytes(value, field, 20), 12);
  if (type === 'string') {
    if (typeof value !== 'string') throw new TypeError(`${field}: expected a string`);
    return keccak(utf8ToBytes(value));
  }
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new TypeError(`${field}: expected a boolean`);
    return beBytes(value ? 1n : 0n, 32);
  }
  if (type === 'bytes') return keccak(hexBytes(value, field));
  if (type.startsWith('bytes')) return padded(hexBytes(value, field, Number(type.slice(5))), 0);
  return beBytes(uint(value, Number(type.slice(4)), field), 32);
}

/** A 32-byte word with `bytes` placed at `offset`: 12 left-pads an address, 0 right-pads a bytesN. */
function padded(bytes: Uint8Array, offset: number): Uint8Array {
  const word = new Uint8Array(32);
  word.set(bytes, offset);
  return word;
}

function fieldsOf(types: TypedDataTypes, primaryType: string): readonly TypedField[] {
  const fields = types[primaryType];
  if (!fields) throw new TypeError(`no type ${primaryType}`);
  for (const f of fields) if (!ATOMIC.test(f.type)) throw flatOnly(f.type, `${primaryType}.${f.name}`);
  return fields;
}

/** `Name(type1 name1,…)` of a flat struct. */
export function encodeType(types: TypedDataTypes, primaryType: string): string {
  return `${primaryType}(${fieldsOf(types, primaryType).map((f) => `${f.type} ${f.name}`).join(',')})`;
}

export function typeHash(types: TypedDataTypes, primaryType: string): Hex {
  return toHex(keccak(utf8ToBytes(encodeType(types, primaryType))));
}

function structHash(types: TypedDataTypes, primaryType: string, message: Readonly<Record<string, unknown>>): Uint8Array {
  const words = fieldsOf(types, primaryType).map((f) => encodeValue(f.type, message[f.name], `${primaryType}.${f.name}`));
  return keccak(concatBytes(keccak(utf8ToBytes(encodeType(types, primaryType))), ...words));
}

export function hashStruct(types: TypedDataTypes, primaryType: string, message: Readonly<Record<string, unknown>>): Hex {
  return toHex(structHash(types, primaryType, message));
}

const DOMAIN_FIELDS: readonly TypedField[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' },
];

/** The domain separator; `EIP712Domain` lists exactly the members present, in the standard order. */
export function hashDomain(domain: TypedDataDomain): Hex {
  const present = DOMAIN_FIELDS.filter((f) => domain[f.name as keyof TypedDataDomain] !== undefined);
  return hashStruct({ EIP712Domain: present }, 'EIP712Domain', domain as Record<string, unknown>);
}

/** The EIP-712 digest `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))` — what a signature is over. */
export function hashTypedData({ domain, types, primaryType, message }: TypedDataInput): Hex {
  const separator = hexBytes(hashDomain(domain), 'domain', 32);
  return toHex(keccak(concatBytes(new Uint8Array([0x19, 0x01]), separator, structHash(types, primaryType, message))));
}

/**
 * RFC 8785 canonical JSON. Keys sorted by UTF-16 code units (`Array#sort`),
 * strings as `JSON.stringify` writes them. Numbers are safe integers only —
 * the wire carries every wider value as a decimal string — so the ECMAScript
 * number serialisation JCS borrows is never exercised beyond integers.
 */
export function jcs(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (/\p{Cs}/u.test(value)) throw new TypeError('jcs: lone surrogate in a string');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`jcs: ${value} is not a safe integer`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${jcs(k)}:${jcs(obj[k])}`).join(',')}}`;
  }
  throw new TypeError(`jcs: a ${typeof value} has no JSON form`);
}

/** `GatewayMessage.bodyHash`: keccak256 of the JCS text of an S→F message without its `sig`. */
export function gatewayBodyHash(message: Readonly<Record<string, unknown>>): Hex {
  const { sig: _sig, ...body } = message;
  return toHex(keccak(utf8ToBytes(jcs(body))));
}

/** `FillerMessage.bodyHash`: keccak256 of the JCS text of a filler message without its `msgSig`; `id`, `fillerId`, `sentAt` and any inner `sig` stay in. */
export function fillerMessageBodyHash(message: Readonly<Record<string, unknown>>): Hex {
  const { msgSig: _msgSig, ...body } = message;
  return toHex(keccak(utf8ToBytes(jcs(body))));
}

/** `FillerQuote.requestId`: keccak256(utf8(requestId)); the id is 1..64 printable ASCII (`Canonical.daml:90-93`). */
export function requestIdHash(requestId: string): Hex {
  if (!/^[\x21-\x7e]{1,64}$/.test(requestId)) throw new TypeError(`requestId must be 1..64 printable ASCII characters: ${JSON.stringify(requestId)}`);
  return toHex(keccak(utf8ToBytes(requestId)));
}
