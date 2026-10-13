import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pkg from './index';
import { cantonInclusiveFeeSplit, inclusiveFeeSplit } from './fee';

// The inclusive fee (protocol.md §3.11): the maker hands over T = N + F, the filler is paid
// the net. EVM source: payout = ⌊T × 10 000 / (10 000 + feeBps)⌋ (CancoreRouter.settle).
// Canton source: the same quotient rounded half to even at 10⁻¹⁰ (Daml inclusiveFee).

type Case = { note: string; total: string; feeBps: number; payout: string; fee: string };
const file = JSON.parse(readFileSync(join(__dirname, '..', 'spec', 'vectors', 'fee-split.json'), 'utf8')) as { evm: Case[]; canton: (Case & { amount: string; feeRate: string })[] };
const split = (s: { payout: bigint; fee: bigint }) => ({ payout: s.payout.toString(), fee: s.fee.toString() });
/** A Daml Numeric 10 decimal string in 10⁻¹⁰ units. */
const units10 = (d: string) => {
  const [whole, fraction = ''] = d.split('.');
  return BigInt(whole! + fraction.padEnd(10, '0'));
};

describe('EVM source: inclusiveFeeSplit is CancoreRouter.settle', () => {
  test.each(file.evm.map((c) => [c.note, c] as const))('fee-split.json %s', (_n, c) => {
    expect(split(inclusiveFeeSplit(c.total, c.feeBps))).toEqual({ payout: c.payout, fee: c.fee });
  });

  test.each([
    [105, 500, 100n, 5n],
    [1, 30, 0n, 1n],
    [11, 1000, 10n, 1n],
    [10_000, 0, 10_000n, 0n],
  ])('total %d at %d bps: payout %d, fee %d, no exception', (total, bps, payout, fee) => {
    expect(inclusiveFeeSplit(total, bps)).toEqual({ payout, fee });
  });

  test('dust goes to the fee: never below the ideal share, at most one unit above; payout + fee = total', () => {
    for (const [total, bps] of [[12_345n, 33], [1_000_001n, 7], [999n, 999], [7n, 1], [2n ** 250n, 1000], [1n, 1000]] as const) {
      const { payout, fee } = inclusiveFeeSplit(total, bps);
      expect(payout + fee).toBe(total);
      expect(fee * (10_000n + BigInt(bps))).toBeGreaterThanOrEqual(total * BigInt(bps));
      expect((fee - 1n) * (10_000n + BigInt(bps))).toBeLessThan(total * BigInt(bps));
    }
  });

  test.each([
    ['feeBps above MAX_FEE_BPS', 100, 1001],
    ['a negative total', -1, 30],
    ['a fractional total', 1.5, 30],
    ['a fractional feeBps', 100, 30.5],
  ])('%s is refused', (_n, total, bps) => {
    expect(() => inclusiveFeeSplit(total, bps)).toThrow();
  });
});

describe('Canton source: cantonInclusiveFeeSplit is Daml inclusiveFee in EVM-form units', () => {
  test.each(file.canton.map((c) => [c.note, c] as const))('fee-split.json %s', (_n, c) => {
    expect(split(cantonInclusiveFeeSplit(c.total, c.feeBps))).toEqual({ payout: c.payout, fee: c.fee });
    // The EVM form of the Daml amounts: T = amount × 10¹⁰, feeBps = feeRate × 10 000.
    expect(BigInt(c.total)).toBe(units10(c.amount));
    expect(c.feeBps).toBe(Number(units10(c.feeRate) / 1_000_000n));
  });

  test('pays the EVM formula or one unit more, never less', () => {
    for (const [total, bps] of [[10_000_000_000_000n, 30], [1_008_000_000_063n, 80], [1_008_000_000_189n, 80], [2n, 1000], [12_345n, 33]] as const) {
      const evm = inclusiveFeeSplit(total, bps).payout;
      const ledger = cantonInclusiveFeeSplit(total, bps).payout;
      expect(ledger - evm === 0n || ledger - evm === 1n).toBe(true);
    }
  });
});

test('fee helpers are exported from the package root, as the same functions (S4)', () => {
  expect(typeof pkg.inclusiveFeeSplit).toBe('function');
  expect(typeof pkg.cantonInclusiveFeeSplit).toBe('function');
  expect(pkg.inclusiveFeeSplit).toBe(inclusiveFeeSplit);
  expect(pkg.cantonInclusiveFeeSplit).toBe(cantonInclusiveFeeSplit);
});
