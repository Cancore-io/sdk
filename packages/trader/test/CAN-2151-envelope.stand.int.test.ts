/**
 * CAN-2151, the signed envelope against the real filler-gateway of the intent stand: every frame the SDK seals —
 * `quote`, `ticket.intent`, `ticket.decline`, `routes.set` — is taken by filler-gateway (none comes back
 * BAD_SIGNATURE); frames signed by a key the SDK does not pin are dropped before any hook; a signed frame that arrives
 * later than `maxMessageAgeMs` is dropped as stale while a byte-identical redelivery is acted on once; a ticket issued for
 * another delivery key than the SDK's own intent is refused by filler-gateway and never reaches the checks; and a ticket
 * whose input token blocklists the SDK's `repayTo` is declined at V-E4.
 * `ticket.receipt` is TC-SDK-2151-INT-01 in canton-delivery.stand.int.test.ts. trading is played on the Redis
 * Streams (test/stand/filler-gateway.ts).
 *
 *   INTENT_STAND_ENV=<stand env> npx jest --selectProjects int --runInBand packages/trader/test/CAN-2151-envelope.stand.int.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANCORE_ROUTER_ABI,
  encodeCantonAmount,
  FILL_TICKET_DOMAIN,
  FILL_TICKET_TYPES,
  FILLER_KEY_REGISTRATION_TYPES,
  FILLER_PROTOCOL_DOMAIN,
  fillerIdHash,
  hashTypedData,
  type Hex,
  type TicketIntentMessage,
} from '@cancore/contracts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { encodeFunctionCall, entryOf, type AbiEntry } from '../src/filler/chain/abi';
import { hashOrder } from '../src/filler/chain/hashes';
import type { EvmRpc } from '../src/filler/rpc';
import { createFillerRoutes } from '../src/filler/routes';
import { signFillerKeyRegistration } from '../src/filler/signer';
import type { HttpFetch, WebSocketFactory } from '../src/filler/runtime';
import { createTestTypedDataSigner } from '../src/filler/testing';
import { adminApi, ADMIN_KEYS } from './stand/admin';
import { env } from './stand/canton-ledger';
import {
  command,
  cursor,
  eventsAfter,
  GATEWAY_KEYS,
  httpRpc,
  issueAckedTicket,
  nativeWebSocket,
  offerCommand,
  offerEvmTicket,
  ofOrder,
  openOnStand,
  sleep,
  standChain,
  standEvmOrder,
  standFiller,
  standOrder,
  standRouter,
  standSuite,
  STREAMS,
  until,
} from './stand/filler-gateway';

/** The stand's ticket signer: anvil's default mnemonic, index 16 (TICKETSIGNER of the runbook) — a test key. */
const STAND_TICKET_SIGNER_KEY: Hex = '0xea6c44ac03bff858b476bba40716402b03e41b8e97e276d1baec7c37d42484a0';

/** evm-contracts `TronUsdt` at the pinned commit: an open mint, and the owner's `addBlackList` behind `isBlackListed`. */
const TRON_USDT = (JSON.parse(readFileSync(join(__dirname, 'stand', 'artifacts.json'), 'utf8')) as { TronUsdt: { abi: readonly AbiEntry[]; bytecode: Hex } }).TronUsdt;
const call = (abi: readonly AbiEntry[], name: string, args: readonly unknown[]): Hex => encodeFunctionCall(entryOf(abi, 'function', name), args);

/** A transaction anvil signs as `from`: the stand setup acts as the router owner and as a token owner it holds no key of. */
async function sendAs(rpc: EvmRpc, from: Hex, tx: { to?: Hex; data: Hex }): Promise<{ contractAddress: Hex | null }> {
  await rpc.request({ method: 'anvil_impersonateAccount', params: [from] });
  try {
    const hash = await rpc.request<Hex>({ method: 'eth_sendTransaction', params: [{ from, ...tx, gas: '0x7a1200' }] });
    const receipt = await until('the stand transaction mined', async () => (await rpc.request<{ status: string; contractAddress: Hex | null } | null>({ method: 'eth_getTransactionReceipt', params: [hash] })) ?? undefined, 60_000);
    if (receipt.status !== '0x1') throw new Error(`the stand transaction from ${from} reverted`);
    return receipt;
  } finally {
    await rpc.request({ method: 'anvil_stopImpersonatingAccount', params: [from] });
  }
}

standSuite('CAN-2151: the signed envelope against the real filler-gateway', [...GATEWAY_KEYS, ...ADMIN_KEYS, 'STAND_FILLER2_ID', 'MAKER_EVM_KEY', 'PERMIT2_ADDRESS', 'QUOTE_SIGNER_KEY'], () => {
  test('TC-SDK-2151-INT-01: quote, ticket.intent, ticket.decline and routes.set sealed by the SDK are each taken by filler-gateway', async () => {
    const accept = standOrder(2151_01);
    const decline = standOrder(2151_02);
    const stand = standFiller({
      quote: async (r) => ({ amountOut: encodeCantonAmount('5'), validUntil: BigInt(Math.ceil((r.windowCloseAt + r.quoteTtlMs) / 1000) + 60) }),
      offer: async (o) => (o.orderHash.toLowerCase() === accept.orderHash ? 'accept' : { decline: 'RISK_LIMIT' }),
    });
    await stand.filler.start();
    try {
      const fromQuotes = await cursor(STREAMS.quotes);
      const fromTickets = await cursor(STREAMS.ticketEvents);
      const requestId = `can-2151-${Date.now().toString(36)}`;
      await command(STREAMS.quoteRequests, 'quote.request', {
        requestId, route: { src: standChain(), dst: env('CANTON_CHAIN') }, inputToken: env('INPUT_TOKEN_ADDRESS').toLowerCase(), inputAmount: '1050000000000000000',
        outputAsset: { admin: env('CNRX_ADMIN_PARTY'), id: 'CNRX' }, feeBps: 30, fillDeadlineHint: String(Math.floor(Date.now() / 1000) + 1_800),
        windowCloseAt: Date.now() + 8_000, quoteTtlMs: 30_000, fillerIds: [env('STAND_FILLER_ID')],
      });
      await command(STREAMS.tickets, 'ticket.offer', offerCommand(accept));
      await command(STREAMS.tickets, 'ticket.offer', offerCommand(decline));

      await until('quote.received', async () => (await eventsAfter(STREAMS.quotes, fromQuotes, (e) => e.kind === 'quote.received' && e.data.requestId === requestId))[0], 30_000, stand.diagnostics);
      await until('ticket.intent', async () => (await eventsAfter(STREAMS.ticketEvents, fromTickets, (e) => ofOrder(accept.orderHash)(e) && e.kind === 'ticket.intent'))[0], 30_000, stand.diagnostics);
      await until('ticket.declined', async () => (await eventsAfter(STREAMS.ticketEvents, fromTickets, (e) => ofOrder(decline.orderHash)(e) && e.kind === 'ticket.declined'))[0], 30_000, stand.diagnostics);
      const routes = createFillerRoutes({ gatewayUrl: env('FILLER_GATEWAY_WS_URL'), fillerId: env('STAND_FILLER_ID'), gatewaySigner: env('FILLER_GATEWAY_SIGNER') as Hex, messageSigner: createTestTypedDataSigner(env('STAND_FILLER_MESSAGE_KEY') as Hex) });
      const before = await routes.state();
      const after = await routes.set(before.routes.filter((r) => r.active).map(({ src, dst }) => ({ src, dst })));
      expect(after.routes).toEqual(before.routes);
      expect(stand.logger.entries.filter((l) => JSON.stringify(l).includes('BAD_SIGNATURE'))).toEqual([]);
    } finally {
      await stand.filler.stop();
    }
  }, 180_000);

  test('TC-SDK-2151-INT-02: the SDK pins another filler-gateway key — the stand’s signed frames are dropped: no session, the offer never reaches the hook', async () => {
    let asked = 0;
    const stand = standFiller({ gatewaySigner: createTestTypedDataSigner(`0x${'6a'.repeat(32)}`).address, offer: async () => (asked++, 'accept') });
    const started = stand.filler.start().then(() => 'started' as const, () => 'refused' as const);
    try {
      expect(await Promise.race([started, sleep(15_000).then(() => 'not-started' as const)])).not.toBe('started');
      const o = standOrder(2151_03);
      await command(STREAMS.tickets, 'ticket.offer', offerCommand(o));
      await sleep(10_000);
      expect(asked).toBe(0);
      expect(await stand.store.withOrder(o.orderHash, (tx) => tx.getTicket(0))).toBeUndefined();
      expect(stand.logger.entries.some((l) => /wrong-signer/.test(`${l.message} ${JSON.stringify(l.fields ?? {})}`))).toBe(true);
    } finally {
      await stand.filler.stop();
    }
  }, 120_000);

  test('TC-SDK-2151-INT-03: a signed offer that arrives later than maxMessageAgeMs is dropped as stale; a byte-identical redelivery is acted on once', async () => {
    const maxMessageAgeMs = 5_000;
    const late = standOrder(2151_31);
    const twice = standOrder(2151_32);
    const asked = new Map<string, number>();
    let heldId: string | undefined;
    const throughStand: WebSocketFactory = (url, h, protocols) =>
      nativeWebSocket(url, {
        ...h,
        onMessage: (text) => {
          const frame = JSON.parse(text) as { type?: string; orderHash?: string; id?: string };
          if (frame.type !== 'ticket.offer') return h.onMessage(text);
          const order = frame.orderHash?.toLowerCase();
          if (order === late.orderHash.toLowerCase()) {
            if (heldId !== undefined) return;
            heldId = frame.id;
            setTimeout(() => h.onMessage(text), maxMessageAgeMs + 2_000);
            return;
          }
          h.onMessage(text);
          if (order === twice.orderHash.toLowerCase()) h.onMessage(text);
        },
      }, protocols);
    let loginPullDone!: () => void;
    const loginPull = new Promise<void>((resolve) => (loginPullDone = resolve));
    const watchingLoginPull: HttpFetch = async (url, request) => {
      const response = await fetch(url, request);
      if (request.method === 'GET' && url.includes('/v1/filler/tickets') && url.includes('status=ISSUED')) loginPullDone();
      return response;
    };
    const stand = standFiller({
      webSocket: throughStand,
      fetch: watchingLoginPull,
      maxMessageAgeMs,
      offer: async (o) => (asked.set(o.orderHash.toLowerCase(), (asked.get(o.orderHash.toLowerCase()) ?? 0) + 1), 'accept'),
    });
    await stand.filler.start();
    try {
      // The pull that follows login lists open offers over REST: an offer it saw fresh would reach the hook past the held frame.
      await loginPull;
      const from = await cursor(STREAMS.ticketEvents);
      await command(STREAMS.tickets, 'ticket.offer', offerCommand(late));
      await command(STREAMS.tickets, 'ticket.offer', offerCommand(twice));
      await until('the redelivered offer acted on', async () => (await eventsAfter(STREAMS.ticketEvents, from, (e) => ofOrder(twice.orderHash)(e) && e.kind === 'ticket.intent'))[0], 60_000, stand.diagnostics);
      const dropped = await until('the late offer dropped as stale', async () =>
        stand.logger.entries.find((l) => l.message === 'filler-gateway: frame dropped' && l.fields?.reason === 'stale' && l.fields?.id === heldId), maxMessageAgeMs + 30_000, stand.diagnostics);
      expect(dropped.fields).toEqual({ reason: 'stale', type: 'ticket.offer', id: heldId });
      await sleep(3_000);
      expect(asked.get(twice.orderHash.toLowerCase())).toBe(1);
      expect((await eventsAfter(STREAMS.ticketEvents, from, (e) => ofOrder(twice.orderHash)(e) && e.kind === 'ticket.intent'))).toHaveLength(1);
      expect(asked.get(late.orderHash.toLowerCase())).toBeUndefined();
      expect(await stand.store.withOrder(late.orderHash, (tx) => tx.getTicket(0))).toBeUndefined();
      expect((await eventsAfter(STREAMS.ticketEvents, from, (e) => ofOrder(late.orderHash)(e) && e.kind === 'ticket.intent'))).toEqual([]);
    } finally {
      await stand.filler.stop();
    }
  }, 180_000);

  test('TC-SDK-2151-INT-04: an issue naming another delivery key than the SDK’s intent — refused by filler-gateway; the SDK never sees ticket.issued', async () => {
    const stand = standFiller({ offer: async () => 'accept' });
    await stand.filler.start();
    try {
      const base = standOrder(2151_04);
      const o = { ...base, order: { ...base.order } };
      const from = await cursor(STREAMS.ticketEvents);
      await command(STREAMS.tickets, 'ticket.offer', offerCommand(o));
      const acked = await until('the intent acked', async () => {
        const t = await stand.store.withOrder(o.orderHash, (tx) => tx.getTicket(0));
        return t?.intentAck ? t : undefined;
      }, 60_000, stand.diagnostics);
      const intent = acked.intent as TicketIntentMessage;
      const otherKey = '0x00000000000000000000000000000000000c2151' as Hex;
      const ticket = { orderHash: o.orderHash, fillerId: fillerIdHash(env('STAND_FILLER_ID')), deliveryKey: otherKey, repayTo: intent.repayTo, attempt: 0, validFrom: String(o.nowS), validUntil: String(o.nowS + 900) };
      const ticketSig = await createTestTypedDataSigner(STAND_TICKET_SIGNER_KEY).signTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: ticket });
      await command(STREAMS.tickets, 'ticket.issue', { orderHash: o.orderHash, attempt: 0, ticketSig, deliveryKey: otherKey, repayTo: intent.repayTo });
      await until('the issue refused', async () => (await eventsAfter(STREAMS.ticketEvents, from, (e) => ofOrder(o.orderHash)(e) && e.kind === 'ticket.issue.refused'))[0], 30_000, stand.diagnostics);
      await sleep(3_000);
      expect((await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind)).not.toContain('ticket.issued');
      expect((await stand.store.withOrder(o.orderHash, (tx) => tx.getTicket(0)))?.state).toBe('intent-acked');
    } finally {
      await stand.filler.stop();
    }
  }, 120_000);

  test('TC-SDK-2151-INT-05: the input token blocklists the SDK’s repayTo — V-E4 declines OTHER repayTo-blocklisted, no receipt', async () => {
    const rpc = httpRpc(env('EVM_RPC_URL'));
    const maker = env('MAKER_EVM_ADDRESS').toLowerCase() as Hex;
    // The stand's USDC is a TestToken with no blocklist view: the order pays in a USDT double the maker owns, which the router owner allows.
    const deployed = await sendAs(rpc, maker, { data: TRON_USDT.bytecode });
    const token = String(deployed.contractAddress).toLowerCase() as Hex;
    await sendAs(rpc, maker, { to: token, data: call(TRON_USDT.abi, 'mint', [10n ** 24n]) });
    await sendAs(rpc, maker, { to: token, data: call(TRON_USDT.abi, 'approve', [env('PERMIT2_ADDRESS'), 2n ** 256n - 1n]) });
    const router = standRouter();
    const routerAbi = CANCORE_ROUTER_ABI as unknown as readonly AbiEntry[];
    const owner = `0x${(await rpc.request<Hex>({ method: 'eth_call', params: [{ to: router, data: call(routerAbi, 'owner', []) }, 'latest'] })).slice(26)}` as Hex;
    await sendAs(rpc, owner, { to: router, data: call(routerAbi, 'setMinInput', [token, 10n ** 12n]) });

    const base = standEvmOrder(2151_05);
    const order = { ...base.order, inputToken: token };
    const o = { ...base, order, orderHash: hashOrder(order, { chainId: BigInt(env('EVM_CHAIN_ID')), router }) };
    await openOnStand(o);

    const stand = standFiller({ offer: async () => 'accept' });
    await stand.filler.start();
    try {
      const { from, intent } = await offerEvmTicket(stand, o);
      // Blocklisted between the consent and the issue: the SDK named this repayTo, and the token now refuses to pay it.
      await sendAs(rpc, maker, { to: token, data: call(TRON_USDT.abi, 'addBlackList', [`0x${intent.repayTo.slice(26)}`]) });
      await issueAckedTicket(o, intent, STAND_TICKET_SIGNER_KEY);

      const declined = await until('ticket.declined at filler-gateway', async () => (await eventsAfter(STREAMS.ticketEvents, from, (e) => ofOrder(o.orderHash)(e) && e.kind === 'ticket.declined'))[0], 60_000, stand.diagnostics);
      expect(declined.data).toMatchObject({ reason: 'OTHER' });
      const checked = stand.events.events.flatMap((e) => (e.type === 'stage' && e.stage === 'ticket.checked' && 'orderHash' in e && e.orderHash === o.orderHash ? [e.detail as Record<string, unknown>] : []));
      const vE4 = checked.find((d) => d.check === 'V-E4');
      expect(vE4).toMatchObject({ status: 'failed', reason: 'OTHER' });
      expect(String(vE4?.detail)).toContain('repayTo-blocklisted');
      expect((await eventsAfter(STREAMS.ticketEvents, from, ofOrder(o.orderHash))).map((e) => e.kind)).not.toContain('ticket.receipt');
      expect((await stand.store.withOrder(o.orderHash, (tx) => tx.getTicket(0)))?.state).toBe('declined');
    } finally {
      await stand.filler.stop();
    }
  }, 180_000);

  test('TC-SDK-2151-INT-06: a key registration signed through signFillerKeyRegistration is the one Cancore staff verify, and its digest is the golden vector’s', async () => {
    type Vector = { message: { fillerId: string; messageKey: string; issuedAt: string }; digest: Hex };
    const file = JSON.parse(readFileSync(join(__dirname, '../../contracts/spec/protocol/typed-data/FillerKeyRegistration.json'), 'utf8')) as { vectors: Vector[] };
    for (const v of file.vectors) {
      expect(hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types: FILLER_KEY_REGISTRATION_TYPES, primaryType: 'FillerKeyRegistration', message: v.message })).toBe(v.digest);
    }
    const fresh = createTestTypedDataSigner(`0x${bytesToHex(secp256k1.utils.randomSecretKey())}`);
    const fillerId = env('STAND_FILLER2_ID');
    const registration = await signFillerKeyRegistration(fresh, { fillerId, issuedAt: BigInt(Math.floor(Date.now() / 1000)) });
    const preview = await adminApi<{ ok: boolean; messageKey: string | null; problems: unknown[] }>('POST', `/admin/fillers/${encodeURIComponent(fillerId)}/message-key/verify`, { registration });
    expect(preview).toMatchObject({ ok: true, messageKey: fresh.address.toLowerCase(), problems: [] });
  }, 60_000);
});
