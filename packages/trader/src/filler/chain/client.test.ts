import type { Hex } from '@cancore/contracts';
import { createRecordingLogger, FakeChain, FakeEvmRpc } from '../testing';
import { ChainClient, ChainReadError } from './client';
import { RouterReader, INTENT_STATUS } from './router';

const ROUTER: Hex = '0x3333333333333333333333333333333333333333';
const ORDER_HASH: Hex = `0x${'ab'.repeat(32)}`;

const client = (endpoints: ConstructorParameters<typeof ChainClient>[0]['endpoints'], maxHeadLagBlocks = 5) =>
  new ChainClient({ chain: 'eip155:1', endpoints, maxHeadLagBlocks, logger: createRecordingLogger() });

const rejection = async (promise: Promise<unknown>): Promise<ChainReadError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ChainReadError);
    return error as ChainReadError;
  }
  throw new Error('expected a ChainReadError');
};

/** The block tags `eth_call` was sent with. */
const callBlocks = (calls: ReadonlyArray<{ method: string; params?: readonly unknown[] }>) =>
  calls.filter((c) => c.method === 'eth_call').map((c) => BigInt(c.params![1] as string));

describe('eth_chainId is checked against the configured CAIP-2 id before any read (C-1)', () => {
  test('one endpoint on another chain: a typed refusal, and no read is made', async () => {
    const chain = new FakeChain(1n);
    const wrong = chain.endpoint({ label: 'wrong', chainId: 56n });
    const error = await rejection(new RouterReader('eip155:1', ROUTER, client([wrong])).intents(ORDER_HASH));
    expect(error.reason).toBe('wrong-chain');
    expect(error.chain).toBe('eip155:1');
    expect(wrong.calls.map((c) => c.method)).toEqual(['eth_chainId']);
  });

  test('the first endpoint on another chain is never used again; the second serves', async () => {
    const chain = new FakeChain(1n);
    chain.router(ROUTER).openIntent(ORDER_HASH, { refundAfter: 2_000n, openedAt: 1_000n });
    const wrong = chain.endpoint({ label: 'wrong', chainId: 56n });
    const right = chain.endpoint({ label: 'right' });
    const reader = new RouterReader('eip155:1', ROUTER, client([wrong, right]));
    await expect(reader.intents(ORDER_HASH)).resolves.toMatchObject({ status: INTENT_STATUS.Opened });
    await expect(reader.filled(ORDER_HASH)).resolves.toBe(false);
    expect(wrong.calls.map((c) => c.method)).toEqual(['eth_chainId']);
  });
});

describe('failover in the configured order', () => {
  test('the first endpoint down: the second answers', async () => {
    const chain = new FakeChain(1n);
    chain.router(ROUTER).ticketSigners.add('0x2222222222222222222222222222222222222222');
    const first = chain.endpoint({ label: 'first' });
    const second = chain.endpoint({ label: 'second' });
    first.down = true;
    await expect(new RouterReader('eip155:1', ROUTER, client([first, second])).ticketSigners('0x2222222222222222222222222222222222222222')).resolves.toBe(true);
    expect(second.calls.some((c) => c.method === 'eth_call')).toBe(true);
  });

  test('every endpoint down: unavailable, naming each', async () => {
    const chain = new FakeChain(1n);
    const a = chain.endpoint({ label: 'a' });
    const b = chain.endpoint({ label: 'b' });
    a.down = true;
    b.down = true;
    const error = await rejection(new RouterReader('eip155:1', ROUTER, client([a, b])).filled(ORDER_HASH));
    expect(error.reason).toBe('unavailable');
    expect(error.message).toMatch(/a: .*b: /);
  });

  test('a revert is the chain answering: thrown as reverted, not retried on the next endpoint', async () => {
    const reverting = new FakeEvmRpc('reverting')
      .on('eth_chainId', '0x1')
      .on('eth_blockNumber', '0x64')
      .fail('eth_call', { code: 3, message: 'execution reverted', data: '0x' });
    const next = new FakeEvmRpc('next').on('eth_chainId', '0x1').on('eth_blockNumber', '0x64');
    const error = await rejection(new RouterReader('eip155:1', ROUTER, client([reverting, next])).minInput('0x0000000000000000000000000000000000000056'));
    expect(error.reason).toBe('reverted');
    expect(next.calls.some((c) => c.method === 'eth_call')).toBe(false);
  });

  test('an answer that does not decode is malformed, not a value', async () => {
    const liar = new FakeEvmRpc('liar').on('eth_chainId', '0x1').on('eth_blockNumber', '0x64').on('eth_call', `0x${'00'.repeat(31)}02`);
    expect((await rejection(new RouterReader('eip155:1', ROUTER, client([liar])).filled(ORDER_HASH))).reason).toBe('malformed');
  });

  test('a router address without code answers empty data: malformed, never "not filled"', async () => {
    const chain = new FakeChain(1n);
    expect((await rejection(new RouterReader('eip155:1', '0x4444444444444444444444444444444444444444', client([chain])).filled(ORDER_HASH))).reason).toBe('malformed');
  });
});

describe('head lag (ops.maxHeadLagBlocks)', () => {
  test('the first endpoint trails by more than the limit: reads go to the second', async () => {
    const chain = new FakeChain(1n);
    chain.head = 1_000n;
    chain.router(ROUTER);
    const stale = chain.endpoint({ label: 'stale', headLag: 6n });
    const fresh = chain.endpoint({ label: 'fresh' });
    const c = client([stale, fresh], 5);
    await expect(c.head()).resolves.toBe(1_000n);
    await new RouterReader('eip155:1', ROUTER, c).currentSetId();
    expect(stale.calls.some((x) => x.method === 'eth_call')).toBe(false);
    expect(callBlocks(fresh.calls)).toEqual([1_000n]);
  });

  test('the best head is this round only: one inflated answer does not condemn the others for good', async () => {
    const chain = new FakeChain(1n);
    chain.head = 1_000n;
    chain.router(ROUTER);
    let inflated = true;
    const liar = new FakeEvmRpc('liar').on('eth_chainId', '0x1').on('eth_blockNumber', () => (inflated ? '0x2710' : '0x3e8'));
    const honest = chain.endpoint({ label: 'honest' });
    const c = client([honest, liar], 5);
    await expect(c.head()).resolves.toBe(10_000n);
    inflated = false;
    liar.fail('eth_blockNumber', new Error('down'));
    await expect(c.head()).resolves.toBe(1_000n);
    await new RouterReader('eip155:1', ROUTER, c).currentSetId();
    expect(callBlocks(honest.calls)).toEqual([1_000n]);
  });

  test('a lag within the limit keeps the configured order', async () => {
    const chain = new FakeChain(1n);
    chain.head = 1_000n;
    chain.router(ROUTER);
    const first = chain.endpoint({ label: 'first', headLag: 5n });
    const second = chain.endpoint({ label: 'second' });
    const c = client([first, second], 5);
    await expect(c.head()).resolves.toBe(995n);
    await new RouterReader('eip155:1', ROUTER, c).currentSetId();
    expect(callBlocks(first.calls)).toEqual([995n]);
  });

  test('health() reports chain id, head and lag per endpoint for the node check', async () => {
    const chain = new FakeChain(1n);
    chain.head = 500n;
    const down = chain.endpoint({ label: 'down' });
    down.down = true;
    const rows = await client([chain.endpoint({ label: 'ok' }), chain.endpoint({ label: 'behind', headLag: 9n }), chain.endpoint({ label: 'other', chainId: 5n }), down]).health();
    expect(rows).toEqual([
      { label: 'ok', chainIdOk: true, head: 500n, lag: 0n },
      { label: 'behind', chainIdOk: true, head: 491n, lag: 9n },
      { label: 'other', chainIdOk: false },
      { label: 'down', error: 'down: connection refused' },
    ]);
  });
});

describe('reads at a depth', () => {
  const setup = () => {
    const chain = new FakeChain(1n);
    chain.head = 200n;
    chain.safe = 190n;
    chain.finalized = 150n;
    chain.router(ROUTER);
    const reader = new RouterReader('eip155:1', ROUTER, client([chain]));
    return { chain, reader };
  };

  test.each([
    ['openConfirmations = 3', { confirmations: 3 }, 197n],
    ['safe', 'safe', 190n],
    ['finalized', 'finalized', 150n],
    ['latest', 'latest', 200n],
    ['a block number', { blockNumber: 123n }, 123n],
  ] as const)('%s', async (_name, at, block) => {
    const { chain, reader } = setup();
    await reader.intents(ORDER_HASH, at);
    expect(callBlocks(chain.calls)).toEqual([block]);
  });

  test('an escrow opened less than openConfirmations deep is not open yet; at the boundary it is', async () => {
    const { chain, reader } = setup();
    chain.router(ROUTER).openIntent(ORDER_HASH, { refundAfter: 2_000n, openedAt: 1_000n, atBlock: 198n });
    await expect(reader.intents(ORDER_HASH, { confirmations: 3 })).resolves.toMatchObject({ status: INTENT_STATUS.None });
    await expect(reader.intents(ORDER_HASH, { confirmations: 2 })).resolves.toMatchObject({ status: INTENT_STATUS.Opened, refundAfter: 2_000n });
  });

  test('one resolved block for every call: the head moving between calls does not mix blocks', async () => {
    const { chain, reader } = setup();
    const block = await reader.client.resolve({ confirmations: 3 });
    chain.mine(5n);
    await reader.intents(ORDER_HASH, { blockNumber: block });
    await reader.filled(ORDER_HASH, { blockNumber: block });
    expect(callBlocks(chain.calls)).toEqual([197n, 197n]);
  });

  test('more confirmations than blocks reads the genesis block', async () => {
    const { chain, reader } = setup();
    await reader.intents(ORDER_HASH, { confirmations: 1_000 });
    expect(callBlocks(chain.calls)).toEqual([0n]);
  });
});
