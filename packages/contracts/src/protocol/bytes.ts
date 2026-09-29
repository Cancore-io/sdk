// Internal: the few byte conversions hash.ts and draw.ts share. Not exported
// from the package — a consumer has @noble/hashes for this.
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { Hex } from './typedData';

export const toHex = (bytes: Uint8Array): Hex => `0x${bytesToHex(bytes)}`;

export const keccak = (bytes: Uint8Array): Uint8Array => keccak_256(bytes);

/** `0x`-prefixed hex of exactly `length` bytes (any length when omitted); either letter case. */
export function hexBytes(value: unknown, field: string, length?: number): Uint8Array {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) throw new TypeError(`${field}: expected 0x-prefixed hex, got ${String(value)}`);
  const bytes = hexToBytes(value.slice(2));
  if (length !== undefined && bytes.length !== length) throw new TypeError(`${field}: expected ${length} bytes, got ${bytes.length}`);
  return bytes;
}

/**
 * An unsigned integer below 2^bits from a bigint, a safe-integer number or a
 * canonical decimal string (the wire encoding: digits only, no leading zero).
 */
export function uint(value: unknown, bits: number, field: string): bigint {
  let n: bigint;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) n = BigInt(value);
  else throw new TypeError(`${field}: expected an unsigned integer, got ${String(value)}`);
  if (n < 0n || n >= 1n << BigInt(bits)) throw new RangeError(`${field}: ${n} does not fit uint${bits}`);
  return n;
}

/** Big-endian, left-padded to `size` bytes. */
export const beBytes = (n: bigint, size: number): Uint8Array => hexToBytes(n.toString(16).padStart(size * 2, '0'));
