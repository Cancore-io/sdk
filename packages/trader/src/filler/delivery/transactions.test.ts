import type { Hex } from '@cancore/contracts';
import type { ChainClient } from '../chain/client';
import { silentLogger } from '../runtime';
import type { TransactionSigner } from '../signer';
import type { FillerStore } from '../store';
import { FeeCeilingError, MIN_FEE_BUMP_PERCENT, REPLACEMENT_FEE_CAP_MULTIPLE, ReplacementCapError, TransactionDriver, type FeePolicy, type Fees } from './transactions';

const GWEI = 1_000_000_000n;

/** A chain whose latest block has `baseFee` and whose node suggests `tip`: all the pricing reads. */
function driverAt(market: { baseFee?: bigint; tip: bigint }, fees: Partial<FeePolicy> = {}): TransactionDriver {
  const client = {
    async request(method: string) {
      if (method === 'eth_getBlockByNumber') return market.baseFee === undefined ? {} : { baseFeePerGas: `0x${market.baseFee.toString(16)}` };
      if (method === 'eth_maxPriorityFeePerGas') return `0x${market.tip.toString(16)}`;
      if (method === 'eth_estimateGas') return '0x5208';
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as ChainClient;
  return new TransactionDriver({
    chain: 'eip155:1',
    client,
    signer: { address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Hex } as unknown as TransactionSigner,
    store: {} as FillerStore,
    owner: 'r1',
    leaseTtlMs: 5_000,
    fees: { feeBumpPercent: 15, gasLimitMarginPercent: 20, ...fees },
    logger: silentLogger,
  });
}

const fees = (maxFeePerGas: bigint, maxPriorityFeePerGas: bigint): Fees => ({ maxFeePerGas, maxPriorityFeePerGas });

describe('marketFees: 2 × base fee + tip, held to the ceiling', () => {
  test('without a ceiling', async () => {
    await expect(driverAt({ baseFee: 10n * GWEI, tip: GWEI }).marketFees()).resolves.toEqual(fees(21n * GWEI, GWEI));
  });

  test('a block with no base fee (pre-London) prices at the tip', async () => {
    await expect(driverAt({ tip: 3n * GWEI }).marketFees()).resolves.toEqual(fees(3n * GWEI, 3n * GWEI));
  });

  test('above the ceiling, maxFeePerGas is the ceiling while base fee + tip still fits under it, to the wei', async () => {
    await expect(driverAt({ baseFee: 10n * GWEI, tip: GWEI }, { maxFeePerGasWei: 15n * GWEI }).marketFees()).resolves.toEqual(fees(15n * GWEI, GWEI));
    await expect(driverAt({ baseFee: 10n * GWEI, tip: GWEI }, { maxFeePerGasWei: 11n * GWEI }).marketFees()).resolves.toEqual(fees(11n * GWEI, GWEI));
  });

  test('a ceiling below base fee + tip by one wei: FeeCeilingError, nothing is priced to sit unmined', async () => {
    await expect(driverAt({ baseFee: 10n * GWEI, tip: GWEI }, { maxFeePerGasWei: 11n * GWEI - 1n }).marketFees()).rejects.toBeInstanceOf(FeeCeilingError);
  });

  test('exactly at the ceiling is not capped', async () => {
    await expect(driverAt({ baseFee: 10n * GWEI, tip: GWEI }, { maxFeePerGasWei: 21n * GWEI }).marketFees()).resolves.toEqual(fees(21n * GWEI, GWEI));
  });
});

describe('estimateGas: the estimate plus the margin, rounded up', () => {
  test('21000 + 20 % = 25200; + 1 % rounds 21210 up', async () => {
    await expect(driverAt({ tip: 1n }).estimateGas({ to: '0x0000000000000000000000000000000000000001', data: '0x', value: 0n })).resolves.toBe(25_200n);
    await expect(driverAt({ tip: 1n }, { gasLimitMarginPercent: 1 }).estimateGas({ to: '0x0000000000000000000000000000000000000001', data: '0x', value: 0n })).resolves.toBe(21_210n);
  });
});

describe('replacementFees: both fees raised enough for a node to take the replacement', () => {
  const quiet = { baseFee: 0n, tip: 0n };

  test('the bump is at least MIN_FEE_BUMP_PERCENT even when the policy asks for less, and rounds up', async () => {
    expect(MIN_FEE_BUMP_PERCENT).toBe(10);
    await expect(driverAt(quiet, { feeBumpPercent: 5 }).replacementFees(fees(101n, 11n))).resolves.toEqual(fees(112n, 13n));
    await expect(driverAt(quiet, { feeBumpPercent: 15 }).replacementFees(fees(100n, 10n))).resolves.toEqual(fees(115n, 12n));
  });

  test('the market wins when it is above the bumped fees', async () => {
    await expect(driverAt({ baseFee: 50n, tip: 20n }).replacementFees(fees(100n, 10n))).resolves.toEqual(fees(120n, 20n));
  });

  test('a priority fee above maxFeePerGas lifts maxFeePerGas to it', async () => {
    await expect(driverAt({ baseFee: 0n, tip: 500n }).replacementFees(fees(100n, 10n))).resolves.toEqual(fees(500n, 500n));
  });

  test('a market above the ceiling does not stop the replacement: the bumped fees go out', async () => {
    await expect(driverAt({ baseFee: 1_000n, tip: 1_000n }, { maxFeePerGasWei: 200n }).replacementFees(fees(100n, 10n))).resolves.toEqual(fees(115n, 12n));
  });

  test('bumped above the ceiling: FeeCeilingError; exactly at it: sent', async () => {
    await expect(driverAt(quiet, { maxFeePerGasWei: 114n }).replacementFees(fees(100n, 10n))).rejects.toBeInstanceOf(FeeCeilingError);
    await expect(driverAt(quiet, { maxFeePerGasWei: 115n }).replacementFees(fees(100n, 10n))).resolves.toEqual(fees(115n, 12n));
  });

  test('urgent (a settle near refundAfter) goes straight to the ceiling', async () => {
    await expect(driverAt(quiet, { maxFeePerGasWei: 900n }).replacementFees(fees(100n, 10n), { kind: 'settle', urgent: true })).resolves.toEqual(fees(900n, 12n));
    await expect(driverAt(quiet).replacementFees(fees(100n, 10n), { kind: 'settle', urgent: true })).resolves.toEqual(fees(115n, 12n));
  });
});

describe(`replacementFees: fill, approve and cancel are held to ${REPLACEMENT_FEE_CAP_MULTIPLE}× the first fee on the nonce`, () => {
  const first = fees(100n, 10n);
  const quiet = { baseFee: 0n, tip: 0n };

  test.each(['fill', 'approve', 'cancel'] as const)('%s: exactly 3× goes out, one wei more is refused', async (kind) => {
    await expect(driverAt({ baseFee: 0n, tip: 300n }).replacementFees(fees(260n, 10n), { kind, first })).resolves.toEqual(fees(300n, 300n));
    await expect(driverAt({ baseFee: 0n, tip: 301n }).replacementFees(fees(260n, 10n), { kind, first })).rejects.toBeInstanceOf(ReplacementCapError);
  });

  test('settle is not held to it (R-14): only the ceiling applies', async () => {
    await expect(driverAt(quiet).replacementFees(fees(1_000n, 10n), { kind: 'settle', first })).resolves.toEqual(fees(1_150n, 12n));
  });

  test('without the first fee or the kind there is no relative cap', async () => {
    await expect(driverAt(quiet).replacementFees(fees(1_000n, 10n), { kind: 'fill' })).resolves.toEqual(fees(1_150n, 12n));
    await expect(driverAt(quiet).replacementFees(fees(1_000n, 10n), { first })).resolves.toEqual(fees(1_150n, 12n));
  });
});
