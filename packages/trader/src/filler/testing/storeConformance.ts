import type { Hex } from '@cancore/contracts';
import type { FillerStore, FillRecord, InFlightTransaction, TicketRecord } from '../store';

/** Runner-independent cases. Give each case a fresh store and your runner's deep equality assertion. */
export interface FillerStoreConformanceCase {
  name: string;
  run(store: FillerStore, equal: (actual: unknown, expected: unknown) => void): Promise<void>;
}

const ORDER: Hex = `0x${'ab'.repeat(32)}`;
const ADDRESS: Hex = `0x${'11'.repeat(20)}`;
const ticket = (state: TicketRecord['state']): TicketRecord => ({ orderHash: ORDER, attempt: 0, state, updatedAtMs: 1 });
const fill: FillRecord = { orderHash: ORDER, attempt: 0, chain: 'eip155:1', txRef: '', amount: '100', state: 'pending', owner: 'replica-a', leaseUntilMs: 500, updatedAtMs: 1 };

export const fillerStoreConformance: readonly FillerStoreConformanceCase[] = [
  {
    name: 'ticket checking and delivery timestamps survive a read',
    async run(store, equal) {
      const record: TicketRecord = { ...ticket('checking'), issuedAtMs: 7, sentAtMs: 8, unsent: true };
      await store.withOrder(ORDER, (tx) => tx.putTicket(record));
      equal(await store.withOrder(ORDER, (tx) => tx.getTicket(0)), record);
      equal(await store.withOrder(ORDER, (tx) => tx.listTickets()), [record]);
    },
  },
  {
    name: 'all fill states retain recovery and inclusion metadata',
    async run(store, equal) {
      for (const state of ['pending', 'sent', 'included', 'confirmed', 'failed'] as const) {
        const record: FillRecord = {
          ...fill, state, received: '99', nonce: '7', sentAtMs: 9, reason: 'observed',
          inclusion: { blockNumber: '12', blockHash: `0x${'bc'.repeat(32)}`, header: { number: '0xc' }, receipt: { status: '0x1' }, seenAtMs: 10 },
        };
        await store.withOrder(ORDER, (tx) => tx.putFill(record));
        equal(await store.withOrder(ORDER, (tx) => tx.getFill(0)), record);
      }
      await store.withOrder(ORDER, (tx) => tx.putFill(fill));
      equal(await store.withOrder(ORDER, (tx) => tx.getFill(0)), fill);
    },
  },
  {
    name: 'pending settlement claims survive and are cleared by the next state',
    async run(store, equal) {
      const pending = { orderHash: ORDER, attempt: 0, state: 'pending' as const, owner: 'replica-a', leaseUntilMs: 500, updatedAtMs: 1 };
      await store.withOrder(ORDER, (tx) => tx.putSettlement(pending));
      equal(await store.withOrder(ORDER, (tx) => tx.getSettlement()), pending);
      const sent = { orderHash: ORDER, attempt: 0, state: 'sent' as const, chain: 'eip155:1' as const, txHash: `0x${'bc'.repeat(32)}` as Hex, updatedAtMs: 2 };
      await store.withOrder(ORDER, (tx) => tx.putSettlement(sent));
      equal(await store.withOrder(ORDER, (tx) => tx.getSettlement()), sent);
    },
  },
  {
    name: 'an unsent decline stays open until sent, while an unsettled fill stays open',
    async run(store, equal) {
      await store.withOrder(ORDER, (tx) => tx.putTicket(ticket('declined')));
      equal(await store.listOpenOrders(), [ORDER]);
      await store.withOrder(ORDER, (tx) => tx.putTicket({ ...ticket('declined'), sentAtMs: 2, unsent: true }));
      equal(await store.listOpenOrders(), []);
      await store.withOrder(ORDER, (tx) => tx.putFill(fill));
      equal(await store.listOpenOrders(), [ORDER]);
      await store.withOrder(ORDER, (tx) => tx.putSettlement({ orderHash: ORDER, attempt: 0, state: 'settled', updatedAtMs: 3 }));
      equal(await store.listOpenOrders(), []);
    },
  },
  {
    name: 'order writes roll back together and returned records cannot mutate the store',
    async run(store, equal) {
      await store.withOrder(ORDER, (tx) => tx.putTicket(ticket('offered')));
      const error = new Error('rollback');
      let caught: unknown;
      try {
        await store.withOrder(ORDER, async (tx) => { await tx.putTicket(ticket('filled')); await tx.putFill(fill); throw error; });
      } catch (e) { caught = e; }
      equal(caught, error);
      equal(await store.withOrder(ORDER, (tx) => tx.getFill(0)), undefined);
      const read = await store.withOrder(ORDER, (tx) => tx.getTicket(0));
      if (!read) throw new Error('ticket missing');
      read.state = 'filled';
      equal(await store.withOrder(ORDER, (tx) => tx.getTicket(0)), ticket('offered'));
    },
  },
  {
    name: 'reconfirmed quotes retain their signed frame and ack exactly once',
    async run(store, equal) {
      const quote = { type: 'quote' as const, requestId: 'r1', amountOut: '100', validUntil: '20', nonce: '1', sig: '0x' as Hex };
      const via = { type: 'quote.reconfirm.reply' as const, id: 'reply', fillerId: 'filler', sentAt: 1, msgSig: '0x' as Hex, orderHash: ORDER, accept: true, validUntil: '20', nonce: '1', sig: '0x' as Hex };
      const stored = { requestId: 'r1', quoteHash: ORDER, quote, via, sentAtMs: 2 };
      equal(await store.quotes.recordQuote(stored), true);
      equal(await store.quotes.recordQuote(stored), false);
      const ack = { type: 'quote.ack' as const, id: 'ack', sentAt: 3, sig: '0x' as Hex, requestId: 'r1', quoteHash: ORDER, receivedAt: 3, status: 'COUNTED' as const };
      equal(await store.quotes.recordAck(ack), true);
      equal(await store.quotes.recordAck(ack), false);
      equal(await store.quotes.listQuotes('r1'), [{ ...stored, ack }]);
    },
  },
  {
    name: 'evidence staged in a rolled back order is not committed',
    async run(store, equal) {
      const entry = { id: ORDER, direction: 'from-gateway' as const, type: 'ticket.issued', orderHash: ORDER, raw: new Uint8Array([0, 255, 1]), atMs: 1 };
      const error = new Error('rollback evidence');
      let caught: unknown;
      try {
        await store.withOrder(ORDER, async (tx) => { equal(await tx.appendEvidence(entry), true); throw error; });
      } catch (e) { caught = e; }
      equal(caught, error);
      equal(await store.appendEvidence(entry), true);
      equal(await store.appendEvidence(entry), false);
    },
  },
  {
    name: 'nonce payloads survive replacement history and only the holder can write',
    async run(store, equal) {
      const where = { chain: 'eip155:1' as const, address: ADDRESS };
      const lease = await store.nonces.allocate({ ...where, owner: 'replica-a', ttlMs: 60_000, chainNonce: 7n });
      const record: InFlightTransaction = { hash: ORDER, raw: '0x02', kind: 'settle', orderHash: ORDER, attempt: 0, to: ADDRESS, data: '0x1234', value: 2n ** 255n, gasLimit: 50_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 2n, sentAtMs: 10 };
      equal(await store.nonces.recordTransaction(lease, record), true);
      equal(await store.nonces.recordTransaction(lease, record), true);
      const cancel: InFlightTransaction = { ...record, kind: 'cancel', hash: `0x${'bc'.repeat(32)}`, data: '0x', value: 0n, gasLimit: 21_000n };
      equal(await store.nonces.recordTransaction(lease, cancel), true);
      equal(await store.nonces.recordTransaction({ ...lease, owner: 'replica-b' }, cancel), false);
      equal(await store.nonces.renew({ ...lease, owner: 'replica-b' }, 60_000), null);
      const open = await store.nonces.listOpen(where.chain, where.address);
      equal(open.map((n) => n.transactions), [[record, cancel]]);
      equal(await store.nonces.complete({ ...lease, owner: 'replica-b' }, cancel.hash), false);
      equal(await store.nonces.complete(lease, cancel.hash), true);
      equal(await store.nonces.listOpen(where.chain, where.address), []);
    },
  },
];
