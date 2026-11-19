import type { Hex } from '@cancore/contracts';
import type { GasSpentEvent } from '../events';
import type { InFlightTransaction, NonceLease } from '../store';
import { gasSpentOf, lateReceipt, reportMined, type NonceCloser } from './gas';
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

  test('BUG-1589-07: at least once — the gas is reported before the nonce is marked mined, whether that write succeeds, is refused or throws', async () => {
    for (const outcome of ['held', 'lost', 'throws'] as const) {
      const log: string[] = [];
      const closer: NonceCloser = {
        lease,
        driver: { chain: CHAIN, rawBlock: noBlock },
        nonces: {
          complete: async (_: NonceLease, minedHash: Hex) => {
            log.push(`complete ${minedHash}`);
            if (outcome === 'throws') throw new Error('the reply to the UPDATE was lost');
            return outcome === 'held';
          },
        },
        emit: (event) => log.push(`gas ${event.txHash} ${event.feeWei}`),
      };
      const closing = reportMined(closer, fill, receiptOf(fill), [fill]);
      if (outcome === 'throws') await expect(closing).rejects.toThrow('lost');
      else await closing;
      expect(log).toEqual([`gas ${fill.hash} ${(95_000n * 2_000_000n).toString()}`, `complete ${fill.hash}`]);
    }
  });

  test('BUG-1589-16: a Filled log naming a transaction not journaled on this nonce closes the nonce and reports nothing: its own nonce reports it', async () => {
    const emitted: GasSpentEvent[] = [];
    const completed: Hex[] = [];
    const foreign: InFlightTransaction = { ...fill, hash: `0x${'ee'.repeat(32)}` };
    const closer: NonceCloser = { lease, driver: { chain: CHAIN, rawBlock: noBlock }, nonces: { complete: async (_, h) => (completed.push(h), true) }, emit: (e) => emitted.push(e) };
    await reportMined(closer, foreign, receiptOf(foreign), [fill]);
    expect(emitted).toEqual([]);
    expect(completed).toEqual([foreign.hash]);
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
      client: { head: async () => 44n } as never,
    });
    expect(await lateReceipt(driverWith({ [cancel.hash]: receiptOf(cancel) }, true), [fill, cancel])).toMatchObject({ tx: cancel, depth: 3n });
    expect(await lateReceipt(driverWith({ [cancel.hash]: receiptOf(cancel) }, false), [fill, cancel])).toBeUndefined();
    expect(await lateReceipt(driverWith({}, true), [fill, cancel])).toBeUndefined();
  });
});
