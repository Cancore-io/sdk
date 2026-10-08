import { FILL_TICKET_DOMAIN, FILL_TICKET_TYPES, fillerIdHash, repayToFromEvm, type Hex, type OrderJson, type TicketJson } from '@cancore/contracts';
import { CANCORE_ROUTER_ABI } from '@cancore/contracts';
import { FillerChains, hashOrder, type ChainConfig } from '../chain';
import { encodeFunctionCall, entryOf, type AbiEntry } from '../chain/abi';
import type { FillerEvent, StageEvent } from '../events';
import type { TicketRecord } from '../store';
import {
  createRecordingEventSink,
  createRecordingLogger,
  createTestFillSigner,
  createTestTypedDataSigner,
  decodeSignedTransaction,
  FakeChain,
  FakeClock,
  InMemoryFillerStore,
} from '../testing';
import { Executor, type DeliveryOptions } from './executor';
import { LeaseLostError, TransactionDriver } from './transactions';

const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const OTHER_KEY: Hex = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';
const TICKET_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const SRC_ROUTER: Hex = '0x5656565656565656565656565656565656565656';
const DST_ROUTER: Hex = '0x1111111111111111111111111111111111111111';
const TOKEN: Hex = '0x00000000000000000000000000000000000000aa';
const RECIPIENT: Hex = `0x${'0b'.repeat(20)}`;
const FILLER = 'acme-1';
const DST = 'eip155:1' as const;

const fillSigner = createTestFillSigner(FILL_KEY);
const ticketSigner = createTestTypedDataSigner(TICKET_KEY);
const POLICY: ChainConfig = { router: DST_ROUTER, openConfirmations: 3, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30, minGasWei: 0n };
const TIMING: DeliveryOptions = { pollIntervalMs: 1_000, replaceAfterMs: 10_000, nonceLeaseTtlMs: 5_000 };

const flush = async () => {
  for (let i = 0; i < 80; i++) await new Promise((resolve) => setImmediate(resolve));
};

interface WorldOptions {
  /** Seconds from now to `validUntil`. Default 300. */
  ttlS?: number;
  amountOut?: bigint;
  /** Overrides of the issued ticket. */
  ticket?: Partial<TicketJson>;
  /** Ticket state stored. Default `receipted`, sent. */
  state?: TicketRecord['state'];
  allowance?: bigint;
  delivery?: DeliveryOptions;
  chain?: Partial<ChainConfig>;
}

/** A BSC → Ethereum order, its ticket receipted, the filler stocked on the fake destination; the fake chain's clock follows the process clock. */
async function world(options: WorldOptions = {}) {
  const clock = new FakeClock();
  const nowS = BigInt(Math.floor(clock.now() / 1000));
  const dst = new FakeChain(1n, 'eth');
  dst.setTimestamp(dst.head, nowS);
  dst.blockTime = 1n;
  const store = new InMemoryFillerStore(clock);
  const order: OrderJson = {
    user: '0x2222222222222222222222222222222222222222',
    originChainId: '56',
    inputToken: '0x0000000000000000000000000000000000000056',
    inputAmount: '105',
    destination: `0x${'00'.repeat(31)}01`,
    outputAsset: `0x${'00'.repeat(12)}${TOKEN.slice(2)}`,
    minReceived: '99',
    recipient: `0x${'00'.repeat(12)}${RECIPIENT.slice(2)}`,
    createdAt: String(nowS - 60n),
    fillDeadline: String(nowS + 3_600n),
    feeBps: '500',
  };
  const orderHash = hashOrder(order, { chainId: 56n, router: SRC_ROUTER });
  const validUntil = nowS + BigInt(options.ttlS ?? 300);
  const ticket: TicketJson = {
    orderHash,
    fillerId: fillerIdHash(FILLER),
    deliveryKey: fillSigner.address.toLowerCase() as Hex,
    repayTo: repayToFromEvm(fillSigner.address),
    attempt: 0,
    validFrom: String(nowS - 5n),
    validUntil: String(validUntil),
    ...options.ticket,
  };
  const ticketSig = await ticketSigner.signTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: { ...ticket } });
  const amountOut = options.amountOut ?? 100n;
  const record: TicketRecord = {
    orderHash,
    attempt: 0,
    state: options.state ?? 'receipted',
    offer: { type: 'ticket.offer', id: 'o1', fillerId: FILLER, sentAt: clock.now(), sig: '0x', orderHash, attempt: 0, order, amountOut: amountOut.toString(), validFrom: ticket.validFrom, validUntil: String(validUntil), acceptBy: clock.now() } as never,
    issued: { type: 'ticket.issued', id: 'i1', fillerId: FILLER, sentAt: clock.now(), sig: '0x', form: 'evm', orderHash, attempt: 0, ticket, ticketSig } as never,
    receipt: { type: 'ticket.receipt', id: 'r1' } as never,
    sentAtMs: clock.now(),
    updatedAtMs: clock.now(),
  };
  await store.withOrder(orderHash, (tx) => tx.putTicket(record));
  dst.router(DST_ROUTER);
  dst.token(TOKEN).setBalance(fillSigner.address, 1_000n).approve(fillSigner.address, DST_ROUTER, options.allowance ?? 1_000n);

  const events = createRecordingEventSink();
  const logger = createRecordingLogger();
  const chains = new FillerChains({ [DST]: [dst] }, { [DST]: { ...POLICY, ...options.chain } }, logger);
  const receipted = async (hash: Hex, attempt: number) => {
    const r = await store.withOrder(hash, (tx) => tx.getTicket(attempt));
    return r?.state === 'receipted' && r.sentAtMs !== undefined && r.receipt ? r : undefined;
  };
  const executor = (instanceId = 'r1', delivery: DeliveryOptions = { ...TIMING, ...options.delivery }) =>
    new Executor({ store, chains, fillSigners: { [DST]: fillSigner }, fillerId: FILLER, receipted, instanceId, clock, logger, events, delivery });

  /** Moves the process clock and the chain together, a second at a time: one block per second, mining the mempool. */
  const tick = async (ms: number, mine = true) => {
    for (let left = ms; left > 0; left -= 1_000) {
      clock.advance(Math.min(1_000, left));
      const target = BigInt(Math.floor(clock.now() / 1000));
      while (mine && dst.timestampOf(dst.head) < target) dst.mine();
      await flush();
    }
  };
  const fills = () => [...dst.minedTransactions.values(), ...dst.mempool.values()].filter((t) => t.to === DST_ROUTER);
  const stages = (stage: string) => events.events.filter((e): e is StageEvent => e.type === 'stage' && e.stage === stage);
  return { clock, dst, store, order, orderHash, ticket, ticketSig, validUntil, nowS, events, logger, chains, executor, tick, fills, stages };
}

const fillOf = (w: Awaited<ReturnType<typeof world>>) => w.store.withOrder(w.orderHash, (tx) => tx.getFill(0));

describe('Executor — fill (T-25)', () => {
  test('sends fill(order, amount, ticket, ticketSig) from the delivery key the ticket names; filled once fillConfirmations deep', async () => {
    const w = await world();
    const executor = w.executor();
    await executor.start();
    const result = await executor.deliver(w.orderHash, 0);
    expect(result).toMatchObject({ status: 'sent' });

    const [sent] = w.fills();
    expect(sent!.from).toBe(fillSigner.address.toLowerCase());
    expect(sent!.hash).toBe(result.txHash);
    expect(w.stages('fill.sent')[0]!.detail).toMatchObject({ nonce: '0', txHash: result.txHash });

    await w.tick(1_000); // mined: 1 deep of 3
    expect((await fillOf(w))!).toMatchObject({ state: 'included', txRef: result.txHash, received: '100' });
    expect(w.events.events.some((e) => e.type === 'filled')).toBe(false);

    await w.tick(2_000); // 3 deep
    const fill = await fillOf(w);
    expect(fill).toMatchObject({ state: 'confirmed', amount: '100', nonce: '0' });
    expect(fill!.inclusion).toMatchObject({ blockHash: w.dst.blockHash(BigInt(fill!.inclusion!.blockNumber)) });
    expect(fill!.inclusion!.receipt).toMatchObject({ transactionHash: result.txHash });
    expect(w.events.events.filter((e) => e.type === 'filled')).toEqual([{ type: 'filled', orderHash: w.orderHash, attempt: 0, txHash: result.txHash, amount: '100' }]);
    expect(w.stages('fill.confirmed')[0]!.detail).toMatchObject({ gasUsed: '95000', replacements: 0 });
    expect(await w.store.withOrder(w.orderHash, (tx) => tx.getTicket(0))).toMatchObject({ state: 'filled' });
    expect(await w.store.nonces.listOpen(DST, fillSigner.address.toLowerCase() as Hex)).toEqual([]);
    expect(w.dst.token(TOKEN).balances.get(RECIPIENT)).toBe(100n);
    executor.stop();
  });

  test('a fee-on-transfer output: the hook over-sends and the router measures what arrived (T-26)', async () => {
    const w = await world({ delivery: { fillAmount: ({ amountOut }) => (amountOut * 10_000n + 9_899n) / 9_900n } });
    w.dst.token(TOKEN).transferFeeBps = 100n;
    const executor = w.executor();
    await executor.start();
    expect(await executor.deliver(w.orderHash, 0)).toMatchObject({ status: 'sent' });
    await w.tick(3_000);
    expect(await fillOf(w)).toMatchObject({ state: 'confirmed', amount: '102', received: '101' });
    expect(w.dst.token(TOKEN).balances.get(RECIPIENT)).toBe(101n);
    executor.stop();
  });

  test('the same attempt asked twice, in one process or after a restart, sends one fill', async () => {
    const w = await world();
    const a = w.executor('r1');
    await a.start();
    const [first, second] = await Promise.all([a.deliver(w.orderHash, 0), a.deliver(w.orderHash, 0)]);
    expect(first).toBe(second);
    a.stop();
    const b = w.executor('r2');
    expect(await b.deliver(w.orderHash, 0)).toMatchObject({ status: 'tracking', txHash: first.txHash });
    expect(w.fills()).toHaveLength(1);
  });
});

describe('Executor — nothing is sent', () => {
  const sendCalls = (w: Awaited<ReturnType<typeof world>>) => w.dst.calls.filter((c) => c.method === 'eth_sendRawTransaction');

  test.each<[string, WorldOptions, string]>([
    ['no ticket.receipt went out (T-22)', { state: 'checking' }, 'no-receipt'],
    ['less than sendGuard left to validUntil (T-29)', { ttlS: 29 }, 'send-guard'],
    ['validUntil has passed', { ttlS: -1 }, 'send-guard'],
    ['the issued ticket names another delivery key (S13)', { ticket: { deliveryKey: createTestFillSigner(OTHER_KEY).address.toLowerCase() as Hex } }, 'ticket-mismatch'],
    ['the issued ticket names another payee (S13)', { ticket: { repayTo: repayToFromEvm(RECIPIENT) } }, 'ticket-mismatch'],
    ['the amount is below minReceived', { amountOut: 98n }, 'below-min-received'],
  ])('%s', async (_, options, reason) => {
    const w = await world(options);
    const result = await w.executor().deliver(w.orderHash, 0);
    expect(result).toMatchObject({ status: 'refused', reason });
    expect(sendCalls(w)).toHaveLength(0);
    expect(w.stages('fill.refused')[0]!.detail).toMatchObject({ reason });
  });

  test('exactly sendGuard left: sent (the guard is inclusive of its bound)', async () => {
    const w = await world({ ttlS: 30 });
    expect(await w.executor().deliver(w.orderHash, 0)).toMatchObject({ status: 'sent' });
  });

  test('filled(orderHash) already true (recovery): refused, no transaction', async () => {
    const w = await world();
    w.dst.router(DST_ROUTER).filled.set(w.orderHash.toLowerCase(), 50n);
    expect(await w.executor().deliver(w.orderHash, 0)).toMatchObject({ status: 'refused', reason: 'already-filled' });
    expect(sendCalls(w)).toHaveLength(0);
  });

  test('eth_estimateGas reverts: the custom error is named, the attempt closed failed', async () => {
    const w = await world();
    w.dst.token(TOKEN).setBalance(fillSigner.address, 1n);
    expect(await w.executor().deliver(w.orderHash, 0)).toMatchObject({ status: 'refused', reason: 'reverted', detail: 'TransferFailed()' });
    expect(await fillOf(w)).toMatchObject({ state: 'failed' });
    expect(sendCalls(w)).toHaveLength(0);
  });
});

describe('Executor — router allowance', () => {
  test('short allowance: approve(router, configured limit) first, then the fill; never unlimited', async () => {
    const w = await world({ allowance: 0n, delivery: { approvals: { [DST]: { [TOKEN]: 5_000n } } } });
    const executor = w.executor();
    const delivering = executor.deliver(w.orderHash, 0);
    await flush();
    expect(w.stages('approve.sent')[0]!.detail).toMatchObject({ token: TOKEN, amount: '5000' });
    await w.tick(1_000);
    expect(await delivering).toMatchObject({ status: 'sent' });
    expect(w.dst.token(TOKEN).allowances.get(`${fillSigner.address.toLowerCase()}:${DST_ROUTER}`)).toBe(5_000n);
    const nonces = w.fills().map((t) => t.nonce);
    expect(nonces).toEqual([1n]);
    executor.stop();
  });

  test('no limit configured: approves exactly the amount of the fill', async () => {
    const w = await world({ allowance: 0n });
    const executor = w.executor();
    const delivering = executor.deliver(w.orderHash, 0);
    await flush();
    expect(w.stages('approve.sent')[0]!.detail).toMatchObject({ amount: '100' });
    await w.tick(1_000);
    expect(await delivering).toMatchObject({ status: 'sent' });
    executor.stop();
  });

  test('a token that refuses to change a non-zero allowance is approved to zero first', async () => {
    const w = await world({ allowance: 10n, delivery: { approvals: { [DST]: { [TOKEN]: 5_000n } } } });
    w.dst.token(TOKEN).zeroFirst = true;
    const executor = w.executor();
    const delivering = executor.deliver(w.orderHash, 0);
    await flush();
    expect(w.stages('approve.sent').map((s) => s.detail!.amount)).toEqual(['0']);
    await w.tick(2_000);
    expect(w.stages('approve.sent').map((s) => s.detail!.amount)).toEqual(['0', '5000']);
    await w.tick(2_000);
    expect(await delivering).toMatchObject({ status: 'sent' });
    executor.stop();
  });
});

describe('Executor — replace-by-fee (T-29)', () => {
  test('a stuck fill is replaced on the same nonce with both fees raised; the replacement confirms', async () => {
    const w = await world();
    w.dst.minTip = 10n ** 12n; // nothing at the market tip is mined
    const executor = w.executor();
    await executor.start();
    const first = await executor.deliver(w.orderHash, 0);
    await w.tick(10_000);
    const [replaced] = w.stages('fill.replaced');
    expect(replaced!.detail).toMatchObject({ from: first.txHash, nonce: '0' });
    const pending = [...w.dst.mempool.values()];
    expect(pending).toHaveLength(1);
    const original = decodeSignedTransaction((await w.store.nonces.listOpen(DST, fillSigner.address.toLowerCase() as Hex))[0]!.transactions[0]!.raw);
    expect(pending[0]!.nonce).toBe(original.nonce);
    expect(pending[0]!.maxPriorityFeePerGas * 100n).toBeGreaterThanOrEqual(original.maxPriorityFeePerGas * 115n);
    expect(pending[0]!.maxFeePerGas * 100n).toBeGreaterThanOrEqual(original.maxFeePerGas * 115n);
    expect(pending[0]!.data).toBe(original.data);

    w.dst.minTip = 0n;
    await w.tick(3_000);
    expect(await fillOf(w)).toMatchObject({ state: 'confirmed', txRef: pending[0]!.hash });
    expect(w.stages('fill.confirmed')[0]!.detail).toMatchObject({ replacements: 1 });
    executor.stop();
  });

  test('no replacement above maxFeePerGasWei', async () => {
    const w = await world({ chain: { maxFeePerGasWei: 3_100_000_000n } });
    w.dst.minTip = 10n ** 12n;
    const executor = w.executor();
    await executor.deliver(w.orderHash, 0);
    await w.tick(12_000);
    expect(w.stages('fill.replaced')).toHaveLength(0);
    executor.stop();
  });

  test('the chain passed validUntil with the fill pending: no replacement of the fill; its nonce is freed by a transfer to self', async () => {
    const w = await world({ ttlS: 40 });
    w.dst.minTip = 10n ** 12n;
    const executor = w.executor('r1', { ...TIMING, replaceAfterMs: 60_000 });
    await executor.start();
    await executor.deliver(w.orderHash, 0);
    await w.tick(45_000);
    expect(w.stages('fill.replaced')).toHaveLength(0);
    const [cancel] = [...w.dst.mempool.values()];
    expect(cancel).toMatchObject({ to: fillSigner.address.toLowerCase(), data: '0x', value: 0n, nonce: 0n });
    w.dst.minTip = 0n;
    await w.tick(1_000);
    expect(w.stages('fill.cancelled')).toHaveLength(1);
    expect(await fillOf(w)).toMatchObject({ state: 'failed', reason: expect.stringContaining('cancelled') });
    expect(await w.store.nonces.listOpen(DST, fillSigner.address.toLowerCase() as Hex)).toEqual([]);
    executor.stop();
  });
});

describe('Executor — reorgs (T-30)', () => {
  test('a fill reorged out before validUntil is resent on its nonce and confirms', async () => {
    const w = await world();
    w.dst.dropOnReorg = true;
    const executor = w.executor();
    await executor.start();
    const sent = await executor.deliver(w.orderHash, 0);
    await w.tick(1_000);
    expect(await fillOf(w)).toMatchObject({ state: 'included' });
    const block = w.dst.minedTransactions.get(sent.txHash!)!.blockNumber;

    w.dst.reorg(block);
    expect(w.dst.minedTransactions.size).toBe(0);
    await w.tick(1_000, false);
    expect(w.stages('fill.reorged')).toHaveLength(1);
    expect(w.dst.pendingByHash(sent.txHash!)).toBeDefined(); // the same bytes, the same nonce

    await w.tick(3_000);
    expect(await fillOf(w)).toMatchObject({ state: 'confirmed', txRef: sent.txHash });
    expect(w.events.events.filter((e: FillerEvent) => e.type === 'filled')).toHaveLength(1);
    executor.stop();
  });

  test('reorged out after validUntil: not resent; the inclusion proof (header + receipt) stays', async () => {
    const w = await world({ ttlS: 31, chain: { fillConfirmations: 50 } });
    w.dst.dropOnReorg = true;
    const executor = w.executor();
    await executor.start();
    const sent = await executor.deliver(w.orderHash, 0);
    await w.tick(1_000);
    const block = w.dst.minedTransactions.get(sent.txHash!)!.blockNumber;
    await w.tick(40_000);
    w.dst.reorg(block);
    await w.tick(1_000);
    expect(w.dst.pendingByHash(sent.txHash!)).toBeUndefined();
    const fill = await fillOf(w);
    expect(fill!.inclusion).toMatchObject({ blockNumber: block.toString(), receipt: { transactionHash: sent.txHash } });
    executor.stop();
  });
});

describe('Executor — one writer per nonce, restart (N-9, N-15, N-34)', () => {
  test('a second replica without the lease sends nothing on the nonce', async () => {
    const w = await world();
    const a = w.executor('r1');
    await a.start();
    await a.deliver(w.orderHash, 0);
    const [lease] = await w.store.nonces.listOpen(DST, fillSigner.address.toLowerCase() as Hex);
    const b = new TransactionDriver({ chain: DST, client: w.chains.get(DST)!.client, signer: fillSigner, store: w.store, owner: 'r2', leaseTtlMs: 5_000, fees: { feeBumpPercent: 15, gasLimitMarginPercent: 20 }, logger: w.logger });
    await expect(b.send({ ...lease!, owner: 'r2' }, { to: DST_ROUTER, data: '0x', value: 0n }, 21_000n, { maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 10n ** 9n }, { kind: 'cancel' }, 0)).rejects.toBeInstanceOf(LeaseLostError);
    expect(w.dst.mempool.size).toBe(1);
    a.stop();
  });

  test('crash after the fill was recorded on its nonce, before the broadcast: the next replica takes the lease after its TTL and sends those bytes — no second fill', async () => {
    const w = await world();
    // The dead replica r1: nonce 0 leased, the fill signed and recorded on it, nothing broadcast, no fill record.
    const dead = new TransactionDriver({ chain: DST, client: w.chains.get(DST)!.client, signer: fillSigner, store: w.store, owner: 'r1', leaseTtlMs: 5_000, fees: { feeBumpPercent: 15, gasLimitMarginPercent: 20 }, logger: w.logger });
    const lease = await dead.acquire();
    const data = encodeFunctionCall(entryOf(CANCORE_ROUTER_ABI as unknown as readonly AbiEntry[], 'function', 'fill'), [w.order, 100n, w.ticket, w.ticketSig]);
    const call = { to: DST_ROUTER, data, value: 0n, gasLimit: 150_000n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    const raw = await fillSigner.signTransaction({ chainId: 1n, nonce: lease.nonce, ...call });
    const { hash } = decodeSignedTransaction(raw);
    expect(await w.store.nonces.recordTransaction(lease, { hash, raw, kind: 'fill', orderHash: w.orderHash, attempt: 0, ...call, sentAtMs: w.clock.now() })).toBe(true);

    const b = w.executor('r2');
    await b.start();
    expect(await b.deliver(w.orderHash, 0)).toMatchObject({ status: 'tracking', txHash: hash }); // the nonce journal names the fill
    expect(w.dst.mempool.size).toBe(0); // r1's lease is live: r2 does not touch the nonce
    await w.tick(7_000, false); // past the TTL: r2 claims nonce 0 and rebroadcasts the recorded bytes
    expect(w.dst.pendingByHash(hash)).toBeDefined();
    await w.tick(3_000);
    expect(await fillOf(w)).toMatchObject({ state: 'confirmed', txRef: hash, amount: '100' });
    expect(w.events.events.filter((e) => e.type === 'filled')).toHaveLength(1);
    expect(w.fills()).toHaveLength(1);
    expect(w.logger.entries.some((e) => e.message === 'delivery: took over expired nonce leases')).toBe(true);
    b.stop();
  });

  test('an abandoned nonce with nothing recorded is reused, never skipped', async () => {
    const w = await world();
    const driver = new TransactionDriver({ chain: DST, client: w.chains.get(DST)!.client, signer: fillSigner, store: w.store, owner: 'r1', leaseTtlMs: 5_000, fees: { feeBumpPercent: 15, gasLimitMarginPercent: 20 }, logger: w.logger });
    const first = await driver.acquire();
    const again = await driver.acquire();
    expect(again.nonce).toBe(first.nonce);
  });
});

describe('review sdk#65', () => {
  const driverOf = (w: Awaited<ReturnType<typeof world>>, owner: string) =>
    new TransactionDriver({ chain: DST, client: w.chains.get(DST)!.client, signer: fillSigner, store: w.store, owner, leaseTtlMs: 5_000, fees: { feeBumpPercent: 15, gasLimitMarginPercent: 20 }, logger: w.logger });

  test('F-1: an abandoned empty nonce whose lease EXPIRED is reused by the next fill, not skipped', async () => {
    const w = await world();
    const abandoned = await driverOf(w, 'r1').acquire(); // a send that failed after taking nonce 0
    expect(abandoned.nonce).toBe(0n);
    w.clock.advance(6_000); // past the 5 s lease, no delivery meanwhile
    const executor = w.executor('r1');
    expect(await executor.deliver(w.orderHash, 0)).toMatchObject({ status: 'sent' });
    expect(w.fills().map((t) => t.nonce)).toEqual([0n]);
    executor.stop();
  });

  test('F-1: an empty nonce another replica abandoned below our fill is filled by the sweep, and the fill is mined', async () => {
    const w = await world();
    await driverOf(w, 'r2').acquire(); // r2 holds nonce 0 and dies before sending
    const executor = w.executor('r1');
    await executor.start();
    expect(await executor.deliver(w.orderHash, 0)).toMatchObject({ status: 'sent' });
    expect(w.fills().map((t) => t.nonce)).toEqual([1n]);
    await w.tick(4_000);
    expect(w.dst.minedTransactions.size).toBe(0); // nonce 1 waits for nonce 0
    await w.tick(10_000); // r2's lease expires, the sweep claims nonce 0 and sends a transfer to self on it
    expect([...w.dst.minedTransactions.values()].map((t) => [t.nonce, t.to === fillSigner.address.toLowerCase() ? 'gap' : 'fill'])).toEqual([[0n, 'gap'], [1n, 'fill']]);
    expect(await fillOf(w)).toMatchObject({ state: 'confirmed' });
    executor.stop();
  });

  test('F-2: a fill executed while the endpoint shows no receipt is never recorded failed; it confirms once the receipt shows', async () => {
    const w = await world();
    const executor = w.executor();
    await executor.start();
    const sent = await executor.deliver(w.orderHash, 0);
    w.dst.hideReceipts = true;
    await w.tick(8_000); // mined, the nonce spent, no receipt for well over SPENT_TICKS
    expect(w.dst.router(DST_ROUTER).filled.has(w.orderHash.toLowerCase())).toBe(true);
    expect(await fillOf(w)).toMatchObject({ state: 'sent' });
    expect(await w.store.nonces.listOpen(DST, fillSigner.address.toLowerCase() as Hex)).toHaveLength(1);
    expect(w.logger.entries.some((e) => e.message === 'delivery: the router holds the fill, its receipt is not visible yet')).toBe(true);
    w.dst.hideReceipts = false;
    await w.tick(2_000);
    expect(await fillOf(w)).toMatchObject({ state: 'confirmed', txRef: sent.txHash });
    expect(w.events.events.filter((e) => e.type === 'filled')).toHaveLength(1);
    executor.stop();
  });

  test('F-4: the attempt claim is renewed while the approve waits: a second replica does not take it and no second fill goes out', async () => {
    const w = await world({ allowance: 0n });
    w.dst.minTip = 10n ** 12n; // the approve is stuck
    const r1 = w.executor('r1', { ...TIMING, replaceAfterMs: 600_000 });
    const delivering = r1.deliver(w.orderHash, 0);
    await w.tick(12_000); // more than two claim TTLs (5 s)
    const r2 = w.executor('r2');
    expect(await r2.deliver(w.orderHash, 0)).toMatchObject({ status: 'tracking', detail: 'another replica is sending it' });
    w.dst.minTip = 0n;
    await w.tick(3_000);
    expect(await delivering).toMatchObject({ status: 'sent' });
    expect(w.fills()).toHaveLength(1);
    r1.stop();
  });
});

describe('review sdk#65 — F-3: replacement cap', () => {
  test('a stuck transaction first sent at 2 gwei is replaced up to 3× (≤ 6 gwei), then only its bytes are rebroadcast', async () => {
    const w = await world({ allowance: 0n, ttlS: 3_600 });
    w.dst.baseFeePerGas = 500_000_000n; // maxFeePerGas = 2 × 0.5 + 1 = 2 gwei
    w.dst.minTip = 10n ** 12n; // the approve never gets mined
    const executor = w.executor('r1', { ...TIMING, replaceAfterMs: 1_000 });
    void executor.deliver(w.orderHash, 0);
    await w.tick(60_000);
    const pending = [...w.dst.mempool.values()];
    expect(pending).toHaveLength(1);
    expect(pending[0]!.nonce).toBe(0n);
    expect(pending[0]!.maxFeePerGas).toBeLessThanOrEqual(6_000_000_000n);
    expect(pending[0]!.maxFeePerGas).toBeGreaterThan(5_000_000_000n);
    expect(w.stages('tx.replaced').length).toBeLessThan(10);
    expect(w.stages('tx.capped')).toHaveLength(1);
    const rebroadcasts = w.dst.calls.filter((c) => c.method === 'eth_sendRawTransaction' && c.params![0] === pending[0]!.raw);
    expect(rebroadcasts.length).toBeGreaterThan(5);
    executor.stop();
  });
});
