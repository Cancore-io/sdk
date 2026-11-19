import type { Hex } from '@cancore/contracts';
import type { GasSpentEvent } from '../events';
import type { InFlightTransaction, NonceLease } from '../store';
import { completeMined, feeWeiOf } from './gas';
import type { TransactionReceipt } from './transactions';

const CHAIN = 'eip155:8453' as const;
const ORDER: Hex = `0x${'ab'.repeat(32)}`;
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
  maxFeePerGas: 3n,
  maxPriorityFeePerGas: 1n,
  sentAtMs: 0,
};
const receiptOf = (raw: Record<string, unknown> = {}): TransactionReceipt => ({
  hash: fill.hash,
  status: 1,
  blockNumber: 42n,
  blockHash: `0x${'b0'.repeat(32)}`,
  gasUsed: 95_000n,
  effectiveGasPrice: 2_000_000n,
  logs: [],
  raw,
});

describe('BUG-1589: what an own transaction cost', () => {
  test('BUG-1589-06: an OP-stack receipt adds its L1 data fee to gasUsed × effectiveGasPrice; a receipt without one, or with a malformed one, adds nothing', () => {
    expect(feeWeiOf(receiptOf({ l1Fee: '0x3e8' }))).toBe(95_000n * 2_000_000n + 1_000n);
    expect(feeWeiOf(receiptOf())).toBe(95_000n * 2_000_000n);
    expect(feeWeiOf(receiptOf({ l1Fee: 'n/a' }))).toBe(95_000n * 2_000_000n);
  });

  test('BUG-1589-07: the gas is reported only when this replica marks the nonce mined; a lost lease reports nothing (its new owner will)', async () => {
    const mined = { chain: CHAIN, tx: fill, receipt: receiptOf({ l1Fee: '0x3e8' }), nonceTransactions: [fill] };
    for (const held of [true, false]) {
      const emitted: GasSpentEvent[] = [];
      const completed: Hex[] = [];
      const nonces = { complete: async (_: NonceLease, minedHash: Hex) => (completed.push(minedHash), held) };
      await completeMined(nonces, lease, mined, (event) => emitted.push(event));
      expect(completed).toEqual([fill.hash]);
      expect(emitted).toEqual(
        held
          ? [{ type: 'gas', orderHash: ORDER, attempt: 2, kind: 'fill', chain: CHAIN, txHash: fill.hash, blockNumber: '42', blockHash: `0x${'b0'.repeat(32)}`, reverted: false, gasUsed: '95000', effectiveGasPrice: '2000000', l1Fee: '1000', feeWei: (95_000n * 2_000_000n + 1_000n).toString() }]
          : [],
      );
    }
  });
});
