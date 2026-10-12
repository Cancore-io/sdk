// Internal: the decimal and ABI encodings order.ts and cantonDestination.ts share. Not exported from the package.
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { beBytes } from './protocol/bytes';

/** A decimal string at exactly `decimals` scale, in base units; anything that does not land on a whole unit is refused. */
export function exactUnits(value: unknown, decimals: number, field: string): bigint {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) throw new TypeError(`${field}: not a plain decimal string: ${String(value)}`);
  if (!Number.isSafeInteger(decimals) || decimals < 0) throw new TypeError(`${field}: decimals must be a non-negative integer`);
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new RangeError(`${field}: ${value} does not fit ${decimals} decimals exactly`);
  return BigInt(whole! + fraction.padEnd(decimals, '0'));
}

/** `abi.encode(string, …, string)`: one offset word per string, then each as length word and right-padded bytes. */
export function abiEncodeStrings(values: readonly string[]): Uint8Array {
  const tails = values.map((v) => {
    const bytes = utf8ToBytes(v);
    const body = new Uint8Array(Math.ceil(bytes.length / 32) * 32);
    body.set(bytes);
    return concatBytes(beBytes(BigInt(bytes.length), 32), body);
  });
  let offset = BigInt(values.length * 32);
  const heads = tails.map((t) => {
    const head = beBytes(offset, 32);
    offset += BigInt(t.length);
    return head;
  });
  return concatBytes(...heads, ...tails);
}
