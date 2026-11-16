/**
 * CAN-1861, the ticket desk against the real filler-gateway of the intent stand: the hook's declines, the checks
 * of an issued EVM-form ticket that refuse it, an offer delivered twice, a hook that never answers, a foreign
 * ticket signature, the expiries and a node restarted mid-ticket. trading is played on the Redis Streams (test/stand/filler-gateway.ts); the
 * full path to the receipt is TC-SDK-1861-INT-01 in canton-delivery.stand.int.test.ts.
 *
 *   INTENT_STAND_ENV=<stand env> npx jest --selectProjects int --runInBand packages/trader/test/CAN-1861-tickets.stand.int.test.ts
 */
import type { Hex } from '@cancore/contracts';
import type { EvmRpc } from '../src/filler/rpc';
import { OFFER_DECLINE_REASONS, type TicketOfferDecision } from '../src/filler/tickets/desk';
import { createTestTypedDataSigner, InMemoryFillerStore } from '../src/filler/testing';
import { env } from './stand/canton-ledger';
import {
  command,
  cursor,
  eventsAfter,
  GATEWAY_KEYS,
  httpRpc,
  issueAckedTicket,
  issueEvmTicket,
  offerEvmTicket,
  offerCommand,
  ofOrder,
  openOnStand,
  sleep,
  STAND_TICKET_SIGNER_KEY,
  standEvmOrder,
  standFiller,
  standOrder,
  standSuite,
  STREAMS,
  until,
  type StandFiller,
  type StandFillerOptions,
} from './stand/filler-gateway';

/** Any other key: what filler-gateway must not pass off as Cancore's. */
const FOREIGN_KEY: Hex = `0x${'4d'.repeat(32)}`;

standSuite('CAN-1861: the ticket desk against the real filler-gateway', [...GATEWAY_KEYS, 'MAKER_EVM_KEY', 'PERMIT2_ADDRESS', 'QUOTE_SIGNER_KEY'], () => {
  const decisions = new Map<Hex, () => Promise<TicketOfferDecision>>();
  const asked = new Map<Hex, number>();
  const offerHook: StandFillerOptions['offer'] = async (offer) => {
    const orderHash = offer.orderHash.toLowerCase() as Hex;
    asked.set(orderHash, (asked.get(orderHash) ?? 0) + 1);
    return (decisions.get(orderHash) ?? (async () => 'accept'))();
  };
  let stand: StandFiller;

  const ticket = (s: StandFiller, orderHash: Hex, attempt = 0) => s.store.withOrder(orderHash, (tx) => tx.getTicket(attempt));
  const declined = (orderHash: Hex, from: string) =>
    until('ticket.declined at filler-gateway', async () => (await eventsAfter(STREAMS.ticketEvents, from, (e) => ofOrder(orderHash)(e) && e.kind === 'ticket.declined'))[0], 60_000, () => stand?.diagnostics() ?? '');

  describe('one filler pinned to the stand', () => {
    beforeAll(async () => {
      expect(env('TICKET_SIGNERS').toLowerCase()).toContain(createTestTypedDataSigner(STAND_TICKET_SIGNER_KEY).address.toLowerCase());
      stand = standFiller({ offer: offerHook });
      await stand.filler.start();
    }, 120_000);
    afterAll(async () => {
      await stand?.filler.stop();
    });

    test.each(OFFER_DECLINE_REASONS.map((r, i) => [r, i] as const))('TC-SDK-1861-INT-02: the hook declines with %s — ticket.decline reaches filler-gateway with it, no intent', async (reason, i) => {
      const o = standOrder(100 + i);
      decisions.set(o.orderHash, async () => ({ decline: reason }));
      const from = await cursor(STREAMS.ticketEvents);
      await command(STREAMS.tickets, 'ticket.offer', offerCommand(o));
      expect((await declined(o.orderHash, from)).data).toMatchObject({ reason });
      expect((await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind)).not.toContain('ticket.intent');
      expect(await ticket(stand, o.orderHash)).toMatchObject({ state: 'declined' });
    }, 120_000);

    test('TC-SDK-1861-INT-03: an issued EVM-form ticket of an order never opened — V-E2 refuses ESCROW_NOT_OPEN, the decline reaches filler-gateway, no receipt', async () => {
      const o = standEvmOrder(110);
      const from = await issueEvmTicket(stand, o, STAND_TICKET_SIGNER_KEY);
      expect((await declined(o.orderHash, from)).data).toMatchObject({ reason: 'ESCROW_NOT_OPEN' });
      const kinds = (await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind);
      expect(kinds).toEqual(expect.arrayContaining(['ticket.offered', 'ticket.intent', 'ticket.issued', 'ticket.declined']));
      expect(kinds).not.toContain('ticket.receipt');
    }, 120_000);

    test('TC-SDK-1861-INT-05: a ticket signed by a key filler-gateway does not hold is refused there and never reaches the SDK', async () => {
      const o = standEvmOrder(111);
      const from = await issueEvmTicket(stand, o, FOREIGN_KEY);
      const refused = await until('the issue refused', async () => (await eventsAfter(STREAMS.ticketEvents, from, (e) => ofOrder(o.orderHash)(e) && /refused$/.test(e.kind)))[0], 30_000, stand.diagnostics);
      expect(refused.kind).toMatch(/^ticket\.issue/);
      await sleep(3_000);
      expect((await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind)).not.toContain('ticket.issued');
      expect((await ticket(stand, o.orderHash))?.state).toBe('intent-acked');
    }, 120_000);

    test('TC-SDK-1861-INT-06: the same offer delivered twice — one hook call, one intent', async () => {
      const o = standOrder(112);
      const from = await cursor(STREAMS.ticketEvents);
      const offer = offerCommand(o);
      await command(STREAMS.tickets, 'ticket.offer', offer);
      await command(STREAMS.tickets, 'ticket.offer', offer);
      await until('the intent acked', async () => ((await ticket(stand, o.orderHash))?.intentAck ? true : undefined), 60_000, stand.diagnostics);
      await sleep(3_000);
      expect(asked.get(o.orderHash)).toBe(1);
      const kinds = (await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind);
      expect(kinds.filter((k) => k === 'ticket.offered')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'ticket.intent')).toHaveLength(1);
    }, 120_000);

    test('TC-SDK-1861-INT-08: a hook that never answers — the SDK declines OTHER in time, and filler-gateway takes the decline', async () => {
      const o = standOrder(113);
      decisions.set(o.orderHash, () => new Promise<TicketOfferDecision>(() => undefined));
      const from = await cursor(STREAMS.ticketEvents);
      await command(STREAMS.tickets, 'ticket.offer', offerCommand(o, { acceptBy: Date.now() + 8_000 }));
      expect((await declined(o.orderHash, from)).data).toMatchObject({ reason: 'OTHER' });
      expect((await ticket(stand, o.orderHash))?.state).toBe('declined');
    }, 120_000);

    // filler-gateway expires an issued ticket only (STATE), and NO_SHOW only over a receipt (P-4): the ticket here is
    // issued and declined, so the misses it can carry are FILLED and NO_SHOW_UNCONFIRMED.
    test.each(['FILLED', 'NO_SHOW_UNCONFIRMED'])('TC-SDK-1861-INT-09: ticket.expired %s — the SDK records the attempt expired with the result', async (result) => {
      const o = standEvmOrder(result === 'FILLED' ? 114 : 115);
      const from = await issueEvmTicket(stand, o, STAND_TICKET_SIGNER_KEY);
      await declined(o.orderHash, from);
      await command(STREAMS.tickets, 'ticket.expire', { orderHash: o.orderHash, attempt: 0, result });
      const expired = await until('expired', async () => {
        const t = await ticket(stand, o.orderHash);
        return t?.state === 'expired' ? t : undefined;
      }, 60_000, stand.diagnostics);
      expect(expired.expired).toMatchObject({ result });
      expect(stand.events.events.some((e) => e.type === 'stage' && e.stage === 'ticket.expired' && e.orderHash === o.orderHash && e.detail?.result === result)).toBe(true);
    }, 120_000);
  });

  test('TC-SDK-1861-INT-03: a filler that pins another ticket signer — the stand-signed ticket is refused TICKET_SIGNER_UNKNOWN, no receipt', async () => {
    const pinnedElsewhere = standFiller({ offer: offerHook, ticketSigners: [createTestTypedDataSigner(FOREIGN_KEY).address] });
    stand = pinnedElsewhere;
    await pinnedElsewhere.filler.start();
    try {
      // V-T1 is read after the escrow checks: only an open escrow lets the ticket reach it.
      const o = standEvmOrder(120);
      await openOnStand(o);
      const from = await issueEvmTicket(pinnedElsewhere, o, STAND_TICKET_SIGNER_KEY);
      expect((await declined(o.orderHash, from)).data).toMatchObject({ reason: 'TICKET_SIGNER_UNKNOWN' });
      expect((await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind)).not.toContain('ticket.receipt');
    } finally {
      await pinnedElsewhere.filler.stop();
    }
  }, 180_000);

  test('TC-SDK-1861-INT-04: the chain RPC is a closed port — the checks cannot read, the ticket is declined, no receipt', async () => {
    const blind = standFiller({ offer: offerHook, rpc: [httpRpc('http://127.0.0.1:9')] });
    stand = blind;
    await blind.filler.start();
    try {
      const o = standEvmOrder(121);
      const from = await issueEvmTicket(blind, o, STAND_TICKET_SIGNER_KEY);
      await declined(o.orderHash, from);
      expect((await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind)).not.toContain('ticket.receipt');
      expect((await ticket(blind, o.orderHash))?.state).toBe('declined');
    } finally {
      await blind.filler.stop();
    }
  }, 180_000);

  test('TC-SDK-1861-INT-03: the filler requires a longer proof window than the stand router leaves — V-E3 refuses PROOF_WINDOW_TOO_SHORT, no receipt', async () => {
    const strict = standFiller({ offer: offerHook, requiredProofWindowSec: 10 * 365 * 86_400 });
    stand = strict;
    await strict.filler.start();
    try {
      // V-E3 is read after V-E2: only an open escrow lets the ticket reach it.
      const o = standEvmOrder(122);
      await openOnStand(o);
      const from = await issueEvmTicket(strict, o, STAND_TICKET_SIGNER_KEY);
      expect((await declined(o.orderHash, from)).data).toMatchObject({ reason: 'PROOF_WINDOW_TOO_SHORT' });
      expect((await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind)).not.toContain('ticket.receipt');
    } finally {
      await strict.filler.stop();
    }
  }, 180_000);

  /** The receipt filler-gateway records for `orderHash` after `from`, once the restarted node sends it. */
  const receiptedOnce = async (orderHash: Hex, from: string, s: StandFiller) => {
    await until('ticket.receipt at filler-gateway', async () => (await eventsAfter(STREAMS.ticketEvents, from, (e) => ofOrder(orderHash)(e) && e.kind === 'ticket.receipt'))[0], 120_000, s.diagnostics);
    await sleep(3_000);
    const kinds = (await eventsAfter(STREAMS.ticketEvents, from, ofOrder(orderHash))).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'ticket.intent')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'ticket.receipt')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'ticket.declined')).toEqual([]);
  };

  /** A process that died: whatever it still had in flight never finishes. */
  const crash = async (s: StandFiller) => {
    await Promise.race([s.filler.stop(), sleep(10_000)]);
  };

  test('TC-SDK-1861-INT-07: the node dies with the intent sent, before the ticket — restarted on the same store it takes the ticket to one receipt', async () => {
    const store = new InMemoryFillerStore();
    const first = standFiller({ offer: offerHook, store });
    stand = first;
    await first.filler.start();
    const o = standEvmOrder(130);
    await openOnStand(o);
    const { from, intent } = await offerEvmTicket(first, o);
    expect((await ticket(first, o.orderHash))?.state).toMatch(/^intent-(sent|acked)$/);
    await crash(first);

    const second = standFiller({ offer: offerHook, store });
    stand = second;
    await second.filler.start();
    try {
      await issueAckedTicket(o, intent, STAND_TICKET_SIGNER_KEY);
      await receiptedOnce(o.orderHash, from, second);
      expect(asked.get(o.orderHash)).toBe(1);
    } finally {
      await second.filler.stop();
    }
  }, 300_000);

  test('TC-SDK-1861-INT-07: the node dies in the checks (CHECKING) — restarted on the same store it finishes them and sends one receipt', async () => {
    const store = new InMemoryFillerStore();
    const anvil = httpRpc(env('EVM_RPC_URL'));
    let dead = false;
    // Once the node is dead its reads never come back: nothing it started can still write to the store.
    const dying: EvmRpc = { label: 'stand-anvil-dying', request: <T>(r: { method: string; params?: readonly unknown[] }) => (dead ? new Promise<T>(() => undefined) : anvil.request<T>(r)) };
    const first = standFiller({ offer: offerHook, store, rpc: [dying] });
    stand = first;
    await first.filler.start();
    const o = standEvmOrder(131);
    await openOnStand(o);
    const { from, intent } = await offerEvmTicket(first, o);
    dead = true;
    await issueAckedTicket(o, intent, STAND_TICKET_SIGNER_KEY);
    await until('the checks started', async () => ((await ticket(first, o.orderHash))?.state === 'checking' ? true : undefined), 60_000, first.diagnostics);
    await crash(first);

    const second = standFiller({ offer: offerHook, store });
    stand = second;
    await second.filler.start();
    try {
      await receiptedOnce(o.orderHash, from, second);
    } finally {
      await second.filler.stop();
    }
  }, 300_000);
});
