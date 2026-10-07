import type { Hex, QuoteAck, QuoteMessage } from '@cancore/contracts';
import { FillerStoreUnavailableError } from '../errors';
import type { EvidenceEntry, InFlightTransaction, TicketRecord } from '../store';
import { FakeClock } from './fakes';
import { InMemoryFillerStore } from './memoryStore';

const ORDER: Hex = `0x${'ab'.repeat(32)}`;
const OTHER: Hex = `0x${'cd'.repeat(32)}`;
const FILLER: Hex = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

const ticket = (attempt: number, state: TicketRecord['state']): TicketRecord => ({ orderHash: ORDER, attempt, state, updatedAtMs: 0 });
const evidence = (id: string, orderHash?: Hex): EvidenceEntry => ({
  id: `0x${id.repeat(64).slice(0, 64)}`,
  direction: 'from-gateway',
  type: 'ticket.issued',
  ...(orderHash ? { orderHash } : {}),
  raw: new TextEncoder().encode(`{"type":"ticket.issued","n":"${id}"}`),
  atMs: 0,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('InMemoryFillerStore: per-order transactions', () => {
  test('work for one orderHash runs one at a time; other hashes are not blocked', async () => {
    const store = new InMemoryFillerStore();
    const log: string[] = [];
    let releaseFirst!: () => void;
    const firstHolds = new Promise<void>((resolve) => (releaseFirst = resolve));

    const first = store.withOrder(ORDER, async () => {
      log.push('first:in');
      await firstHolds;
      log.push('first:out');
    });
    const second = store.withOrder(ORDER.toUpperCase().replace('0X', '0x') as Hex, async () => void log.push('second'));
    const other = store.withOrder(OTHER, async () => void log.push('other'));

    await other;
    await tick();
    expect(log).toEqual(['first:in', 'other']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(log).toEqual(['first:in', 'other', 'first:out', 'second']);
  });

  test('commits on resolve; a reader in the next transaction sees the write', async () => {
    const store = new InMemoryFillerStore();
    await store.withOrder(ORDER, (tx) => tx.putTicket(ticket(0, 'offered')));
    expect(await store.withOrder(ORDER, (tx) => tx.getTicket(0))).toMatchObject({ state: 'offered' });
  });

  test('rolls back everything, evidence included, when work throws', async () => {
    const store = new InMemoryFillerStore();
    await store.withOrder(ORDER, (tx) => tx.putTicket(ticket(0, 'offered')));
    await expect(
      store.withOrder(ORDER, async (tx) => {
        await tx.putTicket(ticket(0, 'receipted'));
        await tx.appendEvidence(evidence('1', ORDER));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.withOrder(ORDER, (tx) => tx.getTicket(0))).toMatchObject({ state: 'offered' });
    expect(store.journal()).toEqual([]);
  });

  test('a transaction used after its withOrder settled throws', async () => {
    const store = new InMemoryFillerStore();
    const leaked = await store.withOrder(ORDER, async (tx) => tx);
    await expect(leaked.getTicket(0)).rejects.toThrow(/used after/);
  });

  test('returned records are copies', async () => {
    const store = new InMemoryFillerStore();
    await store.withOrder(ORDER, (tx) => tx.putTicket(ticket(0, 'offered')));
    const read = await store.withOrder(ORDER, (tx) => tx.getTicket(0));
    read!.state = 'filled';
    expect(await store.withOrder(ORDER, (tx) => tx.getTicket(0))).toMatchObject({ state: 'offered' });
  });

  test('listTickets is ascending by attempt', async () => {
    const store = new InMemoryFillerStore();
    await store.withOrder(ORDER, async (tx) => {
      await tx.putTicket(ticket(2, 'offered'));
      await tx.putTicket(ticket(0, 'expired'));
    });
    expect((await store.withOrder(ORDER, (tx) => tx.listTickets())).map((t) => t.attempt)).toEqual([0, 2]);
  });

  test('listOpenOrders: a live ticket or an unsettled fill', async () => {
    const store = new InMemoryFillerStore();
    await store.withOrder(ORDER, (tx) => tx.putTicket(ticket(0, 'expired')));
    expect(await store.listOpenOrders()).toEqual([]);
    await store.withOrder(ORDER, (tx) =>
      tx.putFill({ orderHash: ORDER, attempt: 0, chain: 'eip155:1', txRef: '0x01', amount: '5', state: 'confirmed', updatedAtMs: 0 }),
    );
    expect(await store.listOpenOrders()).toEqual([ORDER]);
    await store.withOrder(ORDER, (tx) => tx.putSettlement({ orderHash: ORDER, attempt: 0, state: 'settled', updatedAtMs: 0 }));
    expect(await store.listOpenOrders()).toEqual([]);
    await store.withOrder(OTHER, (tx) => tx.putTicket({ ...ticket(1, 'issued'), orderHash: OTHER }));
    expect(await store.listOpenOrders()).toEqual([OTHER]);
  });
});

describe('InMemoryFillerStore: idempotent writes', () => {
  test('the same evidence twice is journalled once, inside and outside a transaction', async () => {
    const store = new InMemoryFillerStore();
    expect(await store.appendEvidence(evidence('1'))).toBe(true);
    expect(await store.appendEvidence(evidence('1'))).toBe(false);
    const inTx = await store.withOrder(ORDER, async (tx) => [await tx.appendEvidence(evidence('1', ORDER)), await tx.appendEvidence(evidence('2', ORDER)), await tx.appendEvidence(evidence('2', ORDER))]);
    expect(inTx).toEqual([false, true, false]);
    expect(store.journal().map((e) => e.id[2])).toEqual(['1', '2']);
  });

  test('quote nonces strictly increase per (signer, requestId)', async () => {
    const store = new InMemoryFillerStore();
    expect(await store.quotes.nextNonce('r1', FILLER)).toBe(1n);
    expect(await store.quotes.nextNonce('r1', FILLER.toUpperCase().replace('0X', '0x') as Hex)).toBe(2n);
    expect(await store.quotes.nextNonce('r2', FILLER)).toBe(1n);
  });

  test('a quote and its ack are each recorded once', async () => {
    const store = new InMemoryFillerStore();
    const quoteHash: Hex = `0x${'11'.repeat(32)}`;
    const quote: QuoteMessage = { type: 'quote', id: 'q1', fillerId: 'acme-1', sentAt: 1, msgSig: '0x', requestId: 'r1', amountOut: '1', validUntil: '2', nonce: '1', sig: '0x' };
    const stored = { requestId: 'r1', quoteHash, quote, sentAtMs: 0 };
    expect(await store.quotes.recordQuote(stored)).toBe(true);
    expect(await store.quotes.recordQuote(stored)).toBe(false);
    const ack: QuoteAck = { type: 'quote.ack', id: 'g1', requestId: 'r1', quoteHash, receivedAt: 1, status: 'COUNTED', sentAt: 1, sig: '0x' };
    expect(await store.quotes.recordAck(ack)).toBe(true);
    expect(await store.quotes.recordAck(ack)).toBe(false);
    expect(await store.quotes.recordAck({ ...ack, quoteHash: `0x${'22'.repeat(32)}` })).toBe(false);
    expect(await store.quotes.listQuotes('r1')).toEqual([{ ...stored, ack }]);
  });
});

describe('InMemoryFillerStore: nonce leases by store time (N-34)', () => {
  const tx = (hash: string): InFlightTransaction => ({ hash: `0x${hash}`, raw: '0x02', kind: 'fill', to: `0x${'11'.repeat(20)}`, data: '0x', value: 0n, gasLimit: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, sentAtMs: 0 });
  const where = { chain: 'eip155:1' as const, address: FILLER };

  test('allocation is max(chain nonce, last allocated + 1) and never repeats', async () => {
    const store = new InMemoryFillerStore(new FakeClock());
    const a = await store.nonces.allocate({ ...where, owner: 'r1', ttlMs: 60_000, chainNonce: 7n });
    const b = await store.nonces.allocate({ ...where, owner: 'r2', ttlMs: 60_000, chainNonce: 7n });
    const c = await store.nonces.allocate({ ...where, owner: 'r1', ttlMs: 60_000, chainNonce: 20n });
    expect([a.nonce, b.nonce, c.nonce]).toEqual([7n, 8n, 20n]);
  });

  test('only the holder writes; after expiry another replica takes the nonce over', async () => {
    const clock = new FakeClock();
    const store = new InMemoryFillerStore(clock);
    const lease = await store.nonces.allocate({ ...where, owner: 'r1', ttlMs: 60_000, chainNonce: 0n });
    expect(await store.nonces.recordTransaction(lease, tx('aa'))).toBe(true);
    expect(await store.nonces.recordTransaction({ ...lease, owner: 'r2' }, tx('bb'))).toBe(false);
    expect(await store.nonces.claimExpired({ ...where, owner: 'r2', ttlMs: 60_000 })).toEqual([]);

    clock.advance(60_000);
    expect(await store.nonces.renew(lease, 60_000)).toBeNull();
    const taken = await store.nonces.claimExpired({ ...where, owner: 'r2', ttlMs: 60_000 });
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatchObject({ nonce: 0n, owner: 'r2', transactions: [{ hash: '0xaa' }] });
    expect(await store.nonces.recordTransaction(lease, tx('cc'))).toBe(false);

    const r2 = { ...lease, owner: 'r2', expiresAtMs: taken[0]!.expiresAtMs };
    expect(await store.nonces.renew(r2, 60_000)).toMatchObject({ owner: 'r2' });
    expect(await store.nonces.complete(r2, '0xaa')).toBe(true);
    expect(await store.nonces.listOpen(where.chain, where.address)).toEqual([]);
  });
});

describe('InMemoryFillerStore: outage', () => {
  test('every call rejects with FillerStoreUnavailableError while unavailable', async () => {
    const store = new InMemoryFillerStore();
    store.setAvailable(false);
    await expect(store.now()).rejects.toBeInstanceOf(FillerStoreUnavailableError);
    await expect(store.withOrder(ORDER, async () => 1)).rejects.toBeInstanceOf(FillerStoreUnavailableError);
    await expect(store.quotes.nextNonce('r', FILLER)).rejects.toBeInstanceOf(FillerStoreUnavailableError);
    store.setAvailable(true);
    await expect(store.getOverrides()).resolves.toEqual({ paused: false });
  });

  test('an outage during work rolls the transaction back', async () => {
    const store = new InMemoryFillerStore();
    await expect(
      store.withOrder(ORDER, async (tx) => {
        await tx.putTicket(ticket(0, 'offered'));
        store.setAvailable(false);
      }),
    ).rejects.toBeInstanceOf(FillerStoreUnavailableError);
    store.setAvailable(true);
    expect(await store.withOrder(ORDER, (tx) => tx.getTicket(0))).toBeUndefined();
  });
});
