import { priceShiftBps, wirePriceClaim } from './price-moved';

describe('CAN-3797 price claim', () => {
  const base = { payout: 10n ** 18n, midE18: 998_500_000_000_000_000n, fromDecimals: 18, toDecimals: 10 };

  test('TC-SDK-3797-U-01: shiftBps truncates toward zero on both sides of the mid', () => {
    expect(priceShiftBps({ ...base, amountOut: 10_000_000_000n })).toBe(15);
    expect(priceShiftBps({ ...base, amountOut: 9_985_000_000n })).toBe(0);
    expect(priceShiftBps({ ...base, amountOut: 9_970_000_000n })).toBe(-15);
  });

  test('TC-SDK-3797-U-02: no shift when the payout is worth nothing at the mid', () => {
    expect(priceShiftBps({ ...base, payout: 0n, amountOut: 1n })).toBeUndefined();
  });

  test('TC-SDK-3797-U-03: only a positive uint256 mid and an int32 shift go on the wire', () => {
    expect(wirePriceClaim({ midE18: 1n, shiftBps: -3 })).toEqual({ midE18: '1', shiftBps: -3 });
    expect(wirePriceClaim({ midE18: 0n, shiftBps: 3 })).toBeUndefined();
    expect(wirePriceClaim({ midE18: 1n << 256n, shiftBps: 3 })).toBeUndefined();
    expect(wirePriceClaim({ midE18: 1n, shiftBps: 2 ** 31 })).toBeUndefined();
    expect(wirePriceClaim({ midE18: 1n })).toBeUndefined();
  });
});
