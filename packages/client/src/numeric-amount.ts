import { units } from './dvp-verify';

// Numeric DTOs go through JSON.stringify; compare its decimal spelling to the ledger units.
export function exactNumericAmount(decimal: string): number {
  const expected = units(decimal);
  const value = Number(decimal);
  if (expected < 0n || !Number.isFinite(value)) throw new RangeError('Invalid Numeric 10 amount');
  const [mantissa, exponent = '0'] = String(value).split('e');
  const scale = Number(exponent);
  const [whole, fraction = ''] = mantissa!.split('.');
  const digits = BigInt(whole! + fraction);
  const power = scale + 10 - fraction.length;
  if (power < 0 || digits * 10n ** BigInt(power) !== expected) {
    throw new RangeError('Numeric 10 amount loses precision on the wire');
  }
  return value;
}
