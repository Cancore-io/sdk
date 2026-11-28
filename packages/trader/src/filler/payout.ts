// ---------------------------------------------------------------------------
// The payout
// ---------------------------------------------------------------------------

const BPS = 10_000n;

function checkPayoutInput(fn: string, total: bigint, feeBps: number): void {
  if (total < 0n) throw new RangeError(`${fn}: total must be non-negative`);
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > 0xffff) throw new RangeError(`${fn}: feeBps must be a uint16`);
}

/**
 * What an EVM source router pays the filler for a deposited total `T`
 * (protocol §3.11, `CancoreRouter.sol:664-665`): `⌊T × 10 000 / (10 000 + feeBps)⌋`.
 * Rounding dust goes to the fee. `T = 105`, `feeBps = 500` → 100.
 */
export function evmFillerPayout(total: bigint, feeBps: number): bigint {
  checkPayoutInput('evmFillerPayout', total, feeBps);
  return (total * BPS) / (BPS + BigInt(feeBps));
}

/**
 * What a Canton-source `SwapIntent_Settle` pays the filler (protocol §3.11,
 * T-12; `SwapIntent.daml:207-208`, `:598-601`). The ledger computes
 * `amount − (amount − amount / (1.0 + feeRate))` in Daml `Numeric 10`, where
 * only the division rounds — to nearest, ties to even. In the EVM-form units
 * of §3.7 (`T = amount × 10¹⁰`, `feeBps = feeRate × 10 000`) that is
 * `roundHalfEven(T × 10 000 / (10 000 + feeBps))`. It equals the EVM formula
 * or exceeds it by one unit. `T = 1000.0`, `feeRate 0.003` → `997.0089730808`.
 */
export function cantonFillerPayout(total: bigint, feeBps: number): bigint {
  checkPayoutInput('cantonFillerPayout', total, feeBps);
  const divisor = BPS + BigInt(feeBps);
  const numerator = total * BPS;
  const quotient = numerator / divisor;
  const twiceRemainder = 2n * (numerator % divisor);
  return twiceRemainder > divisor || (twiceRemainder === divisor && quotient % 2n === 1n) ? quotient + 1n : quotient;
}
