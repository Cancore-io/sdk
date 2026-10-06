import type { Hex } from '@cancore/contracts';
import { createRecordingLogger, FakeChain } from '../testing';
import { ChainClient } from './client';
import { RouterEventWatcher, type RouterEventUpdate } from './events';

const ROUTER: Hex = '0x3333333333333333333333333333333333333333';
const OTHER: Hex = '0x4444444444444444444444444444444444444444';
const A: Hex = `0x${'aa'.repeat(32)}`;
const B: Hex = `0x${'bb'.repeat(32)}`;
const FILLER: Hex = '0x2222222222222222222222222222222222222222';
const RECIPIENT: Hex = `0x${'00'.repeat(12)}${'0b'.repeat(20)}`;

const ORDER = {
  user: '0x1111111111111111111111111111111111111111',
  originChainId: 1n,
  inputToken: '0x0000000000000000000000000000000000000056',
  inputAmount: 105n,
  destination: `0x${'00'.repeat(31)}38`,
  outputAsset: `0x${'00'.repeat(12)}${'0a'.repeat(20)}`,
  minReceived: 99n,
  recipient: RECIPIENT,
  createdAt: 1_790_000_000n,
  fillDeadline: 1_790_000_600n,
  feeBps: 500n,
};

const filled = (orderHash: Hex) => ({ orderHash, filler: FILLER, amount: 99n, recipient: RECIPIENT, filledAt: 1_790_000_100n, attempt: 0n });

function setup(confirmations = 2) {
  const chain = new FakeChain(1n);
  chain.head = 100n;
  const updates: RouterEventUpdate[] = [];
  const watcher = new RouterEventWatcher({
    client: new ChainClient({ chain: 'eip155:1', endpoints: [chain], maxHeadLagBlocks: 5, logger: createRecordingLogger() }),
    router: ROUTER,
    confirmations,
    fromBlock: 90n,
    onUpdate: (u) => void updates.push(u),
    logger: createRecordingLogger(),
  });
  const seen = () => updates.map((u) => `${u.kind} ${u.log.name} ${u.log.orderHash.slice(0, 4)} @${u.log.blockNumber}`);
  return { chain, watcher, updates, seen };
}

describe('router events are reported once confirmed, in chain order', () => {
  test('Opened → Filled → Settled, each once, only after `confirmations` blocks', async () => {
    const { chain, watcher, seen, updates } = setup(2);
    chain.emit(ROUTER, 'IntentOpened', { orderHash: A, order: ORDER, refundAfter: 1_790_003_600n, blockNumber: 95n }, 95n);
    chain.emit(ROUTER, 'Filled', filled(A), 97n);
    chain.emit(ROUTER, 'Settled', { orderHash: A, filler: FILLER, payout: 100n, fee: 5n }, 99n);
    await watcher.poll();
    expect(seen()).toEqual(['added IntentOpened 0xaa @95', 'added Filled 0xaa @97']);
    await watcher.poll();
    expect(seen()).toHaveLength(2);
    chain.mine(1n);
    await watcher.poll();
    expect(seen()).toEqual(['added IntentOpened 0xaa @95', 'added Filled 0xaa @97', 'added Settled 0xaa @99']);
    expect(updates[0]!.log.args.order).toMatchObject({ inputAmount: 105n, feeBps: 500n });
    expect(watcher.cursor).toBe(100n);
  });

  test('logs of another address and logs flagged removed by the node are ignored', async () => {
    const { chain, watcher, seen } = setup(0);
    chain.emit(OTHER, 'Filled', filled(A), 95n);
    const original = chain.request.bind(chain);
    chain.request = (async (request) => {
      const result = await original(request);
      if (request.method !== 'eth_getLogs') return result;
      return [...(result as object[]), { ...(result as Array<Record<string, unknown>>)[0], removed: true, address: ROUTER }];
    }) as typeof chain.request;
    chain.emit(ROUTER, 'Refunded', { orderHash: B, user: FILLER, amount: 105n }, 96n);
    await watcher.poll();
    expect(seen()).toEqual(['added Refunded 0xbb @96']);
  });
});

describe('reorgs never produce a false or a duplicate event', () => {
  test('a reorg shallower than `confirmations`: the replaced log is never reported', async () => {
    const { chain, watcher, seen } = setup(3);
    chain.emit(ROUTER, 'Filled', filled(A), 99n);
    await watcher.poll();
    expect(seen()).toEqual([]);
    chain.reorg(99n).mine(5n);
    await watcher.poll();
    expect(seen()).toEqual([]);
  });

  test('a deeper reorg: the reported Filled is removed, its re-inclusion reported once', async () => {
    const { chain, watcher, seen } = setup(2);
    chain.emit(ROUTER, 'Filled', filled(A), 97n);
    await watcher.poll();
    expect(seen()).toEqual(['added Filled 0xaa @97']);

    chain.reorg(96n);
    chain.emit(ROUTER, 'Filled', filled(A), 98n);
    await watcher.poll();
    expect(seen()).toEqual(['added Filled 0xaa @97', 'removed Filled 0xaa @97', 'added Filled 0xaa @98']);

    chain.mine(3n);
    await watcher.poll();
    await watcher.poll();
    expect(seen()).toHaveLength(3);
  });

  test('a reorg that drops the log for good: removed, nothing re-added', async () => {
    const { chain, watcher, seen } = setup(1);
    chain.emit(ROUTER, 'Filled', filled(A), 95n);
    chain.emit(ROUTER, 'Filled', filled(B), 92n);
    await watcher.poll();
    chain.reorg(94n).mine(1n);
    await watcher.poll();
    expect(seen()).toEqual(['added Filled 0xbb @92', 'added Filled 0xaa @95', 'removed Filled 0xaa @95']);
  });

  test('a reorg under the last scanned block alone (no reported log in it) rescans without duplicates', async () => {
    const { chain, watcher, seen } = setup(1);
    chain.emit(ROUTER, 'IntentOpened', { orderHash: A, order: ORDER, refundAfter: 1n, blockNumber: 91n }, 91n);
    await watcher.poll();
    chain.reorg(98n);
    chain.emit(ROUTER, 'Filled', filled(A), 98n);
    chain.mine(1n);
    await watcher.poll();
    expect(seen()).toEqual(['added IntentOpened 0xaa @91', 'added Filled 0xaa @98']);
  });

  test('concurrent polls run one round', async () => {
    const { chain, watcher, seen } = setup(0);
    chain.emit(ROUTER, 'Filled', filled(A), 95n);
    await Promise.all([watcher.poll(), watcher.poll(), watcher.poll()]);
    expect(seen()).toEqual(['added Filled 0xaa @95']);
  });
});
