import { claimOfDecline, priceShiftBps, reconfirmOutcome, wirePriceClaim } from './price-moved';

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

  test('TC-SDK-3797-U-04: a shift beyond int32 is clamped, not dropped; decimals that are no catalog decimals give no shift', () => {
    expect(priceShiftBps({ ...base, midE18: 10n ** 18n, amountOut: 10n ** 30n })).toBe(2 ** 31 - 1);
    expect(priceShiftBps({ ...base, fromDecimals: -1, amountOut: 1n })).toBeUndefined();
    expect(priceShiftBps({ ...base, toDecimals: 1.5, amountOut: 1n })).toBeUndefined();
  });

  test('TC-SDK-3797-U-05: the claim of a decline — only PRICE_MOVED carries one; a malformed one is reported and dropped', () => {
    const dropped: string[] = [];
    const onDropped = () => dropped.push('dropped');
    expect(claimOfDecline({ decline: 'PRICE_MOVED', midE18: 5n, shiftBps: 7 }, onDropped)).toEqual({ midE18: '5', shiftBps: 7 });
    expect(claimOfDecline({ decline: 'NO_INVENTORY', midE18: 5n, shiftBps: 7 }, onDropped)).toBeUndefined();
    expect(claimOfDecline({ decline: 'PRICE_MOVED' }, onDropped)).toBeUndefined();
    expect(dropped).toEqual([]);
    expect(claimOfDecline({ decline: 'PRICE_MOVED', midE18: 5n, shiftBps: 1.5 }, onDropped)).toBeUndefined();
    expect(dropped).toEqual(['dropped']);
  });

  test('TC-SDK-3797-U-06: the reconfirm hook answer as the reply it makes', () => {
    const never = () => {
      throw new Error('nothing to drop');
    };
    expect(reconfirmOutcome(true, never)).toBe(true);
    expect(reconfirmOutcome(false, never)).toEqual({ reason: 'declined' });
    expect(reconfirmOutcome({ decline: 'PRICE_MOVED', midE18: 5n, shiftBps: 7 }, never)).toEqual({
      reason: 'price-moved',
      priceMoved: { reason: 'PRICE_MOVED', midE18: '5', shiftBps: 7 },
    });
  });
});
