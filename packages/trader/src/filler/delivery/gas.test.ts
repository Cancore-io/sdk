import type { Hex } from '@cancore/contracts';
import type { FillerEvent, StageEvent } from '../events';
import type { InFlightTransaction, NonceLease } from '../store';
import { createRecordingLogger, FakeClock } from '../testing';
import { GasReporter, gasSpentOf, lateReceipt, unpricedNonce } from './gas';
import type { TransactionReceipt } from './transactions';

const CHAIN = 'eip155:8453' as const;
const ORDER: Hex = `0x${'ab'.repeat(32)}`;
const BLOCK_HASH: Hex = `0x${'b0'.repeat(32)}`;
const lease: NonceLease = { chain: CHAIN, address: `0x${'01'.repeat(20)}`, nonce: 7n, owner: 'r1', expiresAtMs: 0 };
const fill: InFlightTransaction = {
  hash: `0x${'f1'.repeat(32)}`,
  raw: '0x',
  kind: 'fill',
  orderHash: ORDER,
  attempt: 2,
  to: `0x${'02'.repeat(20)}`,
  data: '0x',
  value: 0n,
  gasLimit: 200_000n,
  maxFeePerGas: 3_000_000n,
  maxPriorityFeePerGas: 1_000_000n,
  sentAtMs: 0,
};
const { orderHash: _order, attempt: _attempt, ...unattached } = fill;
const cancel: InFlightTransaction = { ...unattached, hash: `0x${'c1'.repeat(32)}`, kind: 'cancel', to: lease.address, gasLimit: 21_000n };
const receiptOf = (tx: InFlightTransaction, raw: Record<string, unknown> = { effectiveGasPrice: '0x1e8480' }): TransactionReceipt => ({
  hash: tx.hash,
  status: 1,
  blockNumber: 42n,
  blockHash: BLOCK_HASH,
  gasUsed: 95_000n,
  effectiveGasPrice: 2_000_000n,
  logs: [],
  raw,
});
const noBlock = async (): Promise<Record<string, unknown>> => {
  throw new Error('the block is read only when the receipt has no effectiveGasPrice');
};
const blockWith = (baseFeePerGas?: bigint) => async (): Promise<Record<string, unknown>> => (baseFeePerGas === undefined ? {} : { baseFeePerGas: `0x${baseFeePerGas.toString(16)}` });

describe('BUG-1589: what an own transaction cost', () => {
  test('BUG-1589-06: an OP-stack receipt adds its L1 data fee to gasUsed × effectiveGasPrice; a receipt without one, or with a malformed one, adds nothing', async () => {
    const feeOf = async (raw: Record<string, unknown>) => (await gasSpentOf({ chain: CHAIN, tx: fill, receipt: receiptOf(fill, raw), nonceTransactions: [fill] }, noBlock))!;
    expect(await feeOf({ effectiveGasPrice: '0x1e8480', l1Fee: '0x3e8' })).toMatchObject({ l1Fee: '1000', feeWei: (95_000n * 2_000_000n + 1_000n).toString() });
    for (const raw of [{ effectiveGasPrice: '0x1e8480' }, { effectiveGasPrice: '0x1e8480', l1Fee: 'n/a' }]) {
      const spent = await feeOf(raw);
      expect(spent.feeWei).toBe((95_000n * 2_000_000n).toString());
      expect(spent).not.toHaveProperty('l1Fee');
    }
  });

  /** A reporter over a sink that refuses `gas` while `refusing()` holds. */
  const reporterWith = (refusing: () => boolean, attempts = 3) => {
    const delivered: FillerEvent[] = [];
    const alerts: StageEvent[] = [];
    const logger = createRecordingLogger();
    const events = { emit: async (event: FillerEvent) => (refusing() ? Promise.reject(new Error('the database is down')) : void delivered.push(event)) };
    const reporter = new GasReporter({ events, alert: (event) => alerts.push(event), logger, clock: new FakeClock(), attempts });
    return { reporter, delivered, alerts, logger };
  };
  const at = { lease, driver: { chain: CHAIN, rawBlock: noBlock } };

  test('BUG-1589-07: at least once — a sink that refuses the gas makes the report throw (the nonce stays open) until it accepts it; then it is delivered once', async () => {
    let down = 2;
    const { reporter, delivered, alerts } = reporterWith(() => down-- > 0);
    await expect(reporter.report(at, fill, receiptOf(fill), [fill])).rejects.toThrow('the event sink refused the gas');
    await expect(reporter.report(at, fill, receiptOf(fill), [fill])).rejects.toThrow('(2)');
    await reporter.report(at, fill, receiptOf(fill), [fill]);
    expect(delivered).toEqual([expect.objectContaining({ type: 'gas', txHash: fill.hash, feeWei: (95_000n * 2_000_000n).toString() })]);
    expect(alerts).toEqual([]);
  });

  test('BUG-1589-22: a sink that never accepts the gas is given up after its attempts: an error log and a gas.unpriced alert, and the report resolves so the nonce can close', async () => {
    const { reporter, delivered, alerts, logger } = reporterWith(() => true, 3);
    await expect(reporter.report(at, fill, receiptOf(fill), [fill])).rejects.toThrow('(1)');
    await expect(reporter.report(at, fill, receiptOf(fill), [fill])).rejects.toThrow('(2)');
    await reporter.report(at, fill, receiptOf(fill), [fill]);
    expect(delivered).toEqual([]);
    expect(logger.entries).toContainEqual(expect.objectContaining({ level: 'error', message: expect.stringContaining('gas report given up'), fields: expect.objectContaining({ txHash: fill.hash }) }));
    expect(alerts).toEqual([expect.objectContaining({ stage: 'gas.unpriced', orderHash: ORDER, attempt: 2, detail: expect.objectContaining({ nonce: '7', txHashes: fill.hash }) })]);
  });

  test('BUG-1589-16: a Filled log naming a transaction not journaled on this nonce reports no gas for it and raises gas.unpriced for the nonce own transactions', async () => {
    const foreign: InFlightTransaction = { ...fill, hash: `0x${'ee'.repeat(32)}` };
    const { reporter, delivered, alerts } = reporterWith(() => false);
    await reporter.report(at, foreign, receiptOf(foreign), [fill]);
    expect(delivered).toEqual([]);
    expect(alerts).toEqual([expect.objectContaining({ stage: 'gas.unpriced', orderHash: ORDER, detail: expect.objectContaining({ kinds: 'fill', txHashes: fill.hash }) })]);
  });

  test('BUG-1589-21: gas.unpriced of a nonce that holds only an approve or a gap cancel names no order', () => {
    const approve: InFlightTransaction = { ...unattached, hash: `0x${'a1'.repeat(32)}`, kind: 'approve' };
    for (const txs of [[approve], [cancel]]) {
      const alert = unpricedNonce(CHAIN, lease, txs, 5);
      expect(alert).toMatchObject({ type: 'stage', stage: 'gas.unpriced', atMs: 5, detail: { chain: CHAIN, nonce: '7', kinds: txs[0]!.kind, txHashes: txs[0]!.hash } });
      expect(alert).not.toHaveProperty('orderHash');
      expect(alert).not.toHaveProperty('attempt');
    }
  });

  test('BUG-1589-17: a receipt without effectiveGasPrice is priced min(maxFeePerGas, baseFee + tip) from its block, never 0', async () => {
    const priced = async (baseFee: bigint | undefined) => (await gasSpentOf({ chain: CHAIN, tx: fill, receipt: receiptOf(fill, {}), nonceTransactions: [fill] }, blockWith(baseFee)))!;
    expect(await priced(1_500_000n)).toMatchObject({ effectiveGasPrice: '2500000', feeWei: (95_000n * 2_500_000n).toString() });
    expect(await priced(5_000_000n)).toMatchObject({ effectiveGasPrice: '3000000', feeWei: (95_000n * 3_000_000n).toString() });
    expect(await priced(undefined)).toMatchObject({ effectiveGasPrice: '1000000', feeWei: (95_000n * 1_000_000n).toString() });
  });

  test('BUG-1589-18: a cancel is charged to the fill whose nonce it freed; a cancel that filled a nonce gap belongs to no trade', async () => {
    const spentBy = async (nonceTransactions: readonly InFlightTransaction[]) => (await gasSpentOf({ chain: CHAIN, tx: cancel, receipt: receiptOf(cancel), nonceTransactions }, noBlock))!;
    expect(await spentBy([fill, cancel])).toMatchObject({ kind: 'cancel', orderHash: ORDER, attempt: 2, txHash: cancel.hash });
    const gap = await spentBy([cancel]);
    expect(gap).toMatchObject({ kind: 'cancel', txHash: cancel.hash });
    expect(gap).not.toHaveProperty('orderHash');
    expect(gap).not.toHaveProperty('attempt');
  });

  test('BUG-1589-19: a nonce that looks spent is read once more for a canonical receipt of any of its transactions before it is given up', async () => {
    const driverWith = (receipts: Record<string, TransactionReceipt>, canonical: boolean) => ({
      receipt: async (hash: Hex) => receipts[hash],
      isCanonical: async () => canonical,
      client: { head: async () => 44n },
    });
    expect(await lateReceipt(driverWith({ [cancel.hash]: receiptOf(cancel) }, true), [fill, cancel])).toMatchObject({ tx: cancel, depth: 3n });
    expect(await lateReceipt(driverWith({ [cancel.hash]: receiptOf(cancel) }, false), [fill, cancel])).toBeUndefined();
    expect(await lateReceipt(driverWith({}, true), [fill, cancel])).toBeUndefined();
  });
});
