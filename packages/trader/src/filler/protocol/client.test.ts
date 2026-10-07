/**
 * The protocol client against crafted frames (sdk.md S15): a FakeSocket plays
 * filler-gateway on WebSocket, a fake fetch plays it on REST, a FakeClock
 * drives heartbeat and backoff. No server.
 */
import {
  FILLER_AUTH_TYPES,
  FILLER_PROTOCOL_DOMAIN,
  hashFillerMessage,
  type Hex,
  type QuoteMessage,
  type TicketDecline,
  type TicketIntentMessage,
} from '@cancore/contracts';
import { FillerStoppedError, GatewayError, UnsupportedVersionError } from '../errors';
import { createFiller, createFrameIds, type FillerConfig } from '../filler';
import { recoverAddress, recoverTypedDataSigner, type FillSigner } from '../signer';
import {
  createFakeFetch,
  createFakeWebSocketFactory,
  createRecordingEventSink,
  createRecordingLogger,
  createTestGatewaySigner,
  createTestTypedDataSigner,
  FakeClock,
  FakeEvmRpc,
  InMemoryFillerStore,
  type FakeSocket,
} from '../testing';
import { FillerProtocolClient, type Delivery } from './client';
import { createSealer } from './envelope';
import { keccakHex } from './frames';
import { GatewayRest } from './rest';
import { backoffDelay, CLOSE_HEARTBEAT, GatewaySession } from './session';

const GATEWAY_KEY: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const OTHER_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const QUOTE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const FILLER = 'acme-1';
const URL_ = 'wss://filler-gateway.example/v1';
const HEARTBEAT_MS = 1_000;
const ORDER_HASH: Hex = `0x${'11'.repeat(32)}`;

/** Lets pending promise chains (signing, store writes) run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

function harness(options: { random?: () => number } = {}) {
  const clock = new FakeClock();
  const store = new InMemoryFillerStore(clock);
  const logger = createRecordingLogger();
  const events = createRecordingEventSink();
  const gateway = createTestGatewaySigner(GATEWAY_KEY, clock);
  const impostor = createTestGatewaySigner(OTHER_KEY, clock);
  const quoteSigner = createTestTypedDataSigner(QUOTE_KEY);
  const ws = createFakeWebSocketFactory();
  const tickets: { OFFERED: unknown[]; ISSUED: unknown[] } = { OFFERED: [], ISSUED: [] };
  let challengeNonce = 0;
  const http = createFakeFetch({
    'GET /v1/filler/auth/challenge': () => ({
      status: 200,
      body: gateway.frame({ type: 'auth.challenge', nonce: `0x${(++challengeNonce).toString(16).padStart(64, '0')}`, expiresAt: String(Math.floor(clock.now() / 1000) + 30) }),
    }),
    'POST /v1/filler/auth': () => ({ status: 200, body: { token: 'tok-1', expiresAt: clock.now() + 3_600_000 } }),
    'GET /v1/filler/tickets': (request) => {
      const status = new URL(request.url).searchParams.get('status') as 'OFFERED' | 'ISSUED';
      return { status: 200, body: { items: tickets[status], nextCursor: null } };
    },
  });
  const nextId = createFrameIds('replica-1', clock.now());
  const seal = createSealer({ fillerId: FILLER, messageSigner: quoteSigner, clock });
  const client = new FillerProtocolClient({ store, clock, logger, events, restPollIntervalMs: 2_000, seal });
  const session = new GatewaySession(
    {
      url: URL_,
      fillerId: FILLER,
      gatewaySigner: gateway.address,
      quoteSigner,
      seal,
      webSocket: ws.factory,
      clock,
      logger,
      random: options.random ?? (() => 0),
      nextId,
      reconnect: { initialDelayMs: 500, maxDelayMs: 30_000 },
      heartbeatMisses: 3,
      loginTimeoutMs: 15_000,
    },
    client,
  );
  const rest = new GatewayRest({ gatewayUrl: URL_, fillerId: FILLER, gatewaySigner: gateway.address, quoteSigner, seal, fetch: http.fetch, clock, logger, nextId });
  client.attach(session, rest);

  const challenge = () =>
    gateway.frame({ type: 'auth.challenge', nonce: `0x${'ab'.repeat(32)}`, expiresAt: String(Math.floor(clock.now() / 1000) + 30) });
  const authOk = (re?: string) => gateway.frame({ type: 'auth.ok', fillerId: FILLER, heartbeatIntervalMs: HEARTBEAT_MS, ...(re ? { re } : {}) });

  /** Opens the newest socket and walks it through login. */
  const login = async (socket: FakeSocket = ws.sockets.at(-1)!) => {
    socket.open();
    socket.receive(challenge());
    await settle();
    const response = socket.sentFrames().at(-1)!;
    expect(response.type).toBe('auth.response');
    socket.receive(authOk(response.id as string));
    await settle();
    return socket;
  };

  const offer = (over: Record<string, unknown> = {}) =>
    gateway.frame({
      type: 'ticket.offer',
      fillerId: FILLER,
      orderHash: ORDER_HASH,
      attempt: 1,
      order: {},
      amountOut: '100',
      validFrom: '1790000000',
      validUntil: '1790000180',
      acceptBy: clock.now() + 5_000,
      ...over,
    });

  return { clock, store, logger, events, gateway, impostor, quoteSigner, ws, http, tickets, client, session, rest, challenge, authOk, login, offer };
}

const record = (h: ReturnType<typeof harness>, type: string) => {
  const seen: Delivery[] = [];
  h.client.on(type, async (delivery) => void seen.push(delivery));
  return seen;
};

describe('login (protocol §3.5 «Session»)', () => {
  test('auth.challenge → auth.response signed as FillerAuth by the quote key, protocolVersion "1" → auth.ok resolves start()', async () => {
    const h = harness();
    const started = h.client.start();
    const socket = h.ws.sockets[0]!;
    expect(socket.url).toBe(URL_);
    socket.open();
    const challenge = h.challenge();
    socket.receive(challenge);
    await settle();

    const [response] = socket.sentFrames();
    expect(response).toMatchObject({ type: 'auth.response', fillerId: FILLER, keyAddress: h.quoteSigner.address, protocolVersion: '1' });
    expect(String(response!.id).length).toBeLessThanOrEqual(64);
    const signer = recoverTypedDataSigner(
      { domain: FILLER_PROTOCOL_DOMAIN, types: FILLER_AUTH_TYPES, primaryType: 'FillerAuth', message: { fillerId: FILLER, nonce: challenge.nonce, expiresAt: challenge.expiresAt } },
      response!.sig as Hex,
    );
    expect(signer).toBe(h.quoteSigner.address);
    // the envelope: the same key signs FillerMessage over the whole body, the inner FillerAuth sig included
    expect(response).toMatchObject({ sentAt: h.clock.now() });
    expect(recoverAddress(hashFillerMessage(response!), response!.msgSig as Hex)).toBe(h.quoteSigner.address);

    socket.receive(h.authOk(response!.id as string));
    await expect(started).resolves.toBeUndefined();
    expect(h.client.connected).toBe(true);
    expect(h.events.events).toContainEqual(expect.objectContaining({ type: 'stage', stage: 'authenticated' }));
  });

  test('before auth.ok the SDK sends nothing but auth.*: other frames are refused, inbound frames are dropped', async () => {
    const h = harness();
    const offers = record(h, 'ticket.offer');
    void h.client.start();
    const socket = h.ws.sockets[0]!;
    socket.open();
    expect(h.client.send(await h.client.seal({ type: 'ping', id: 'p' }))).toBe(false);
    socket.receive(h.offer());
    socket.receive(h.challenge());
    await settle();
    expect(socket.sentFrames().map((f) => f.type)).toEqual(['auth.response']);
    expect(offers).toHaveLength(0);
    expect(h.store.journal()).toHaveLength(0);
    expect(h.logger.entries).toContainEqual(expect.objectContaining({ message: 'filler-gateway: frame before auth.ok dropped' }));
  });

  test('a challenge not signed by the pinned key gets no answer', async () => {
    const h = harness();
    void h.client.start();
    const socket = h.ws.sockets[0]!;
    socket.open();
    socket.receive(h.impostor.frame({ type: 'auth.challenge', nonce: `0x${'ab'.repeat(32)}`, expiresAt: String(Math.floor(h.clock.now() / 1000) + 30) }));
    await settle();
    expect(socket.sent).toHaveLength(0);
  });

  test('UNSUPPORTED_VERSION: start() rejects with a typed error and no reconnect loop follows', async () => {
    const h = harness();
    const started = h.client.start();
    const socket = h.ws.sockets[0]!;
    socket.open();
    socket.receive(h.challenge());
    await settle();
    socket.receive(h.gateway.frame({ type: 'error', code: 'UNSUPPORTED_VERSION', message: 'this filler-gateway speaks "2"' }));
    socket.drop(1008, 'UNSUPPORTED_VERSION');
    await expect(started).rejects.toBeInstanceOf(UnsupportedVersionError);
    h.clock.advance(10 * 60_000);
    expect(h.ws.sockets).toHaveLength(1);
    expect(h.session.state).toBe('failed');
  });

  test('a refused login (UNAUTHENTICATED) is retried with backoff', async () => {
    const h = harness();
    void h.client.start();
    const socket = h.ws.sockets[0]!;
    socket.open();
    socket.receive(h.challenge());
    await settle();
    socket.receive(h.gateway.frame({ type: 'error', code: 'UNAUTHENTICATED', message: 'challenge expired' }));
    socket.drop(1008, 'UNAUTHENTICATED');
    h.clock.advance(250);
    expect(h.ws.sockets).toHaveLength(2);
  });

  test('no auth.ok within loginTimeoutMs: the connection is closed and retried', async () => {
    const h = harness();
    void h.client.start();
    h.ws.sockets[0]!.open();
    h.clock.advance(15_000);
    expect(h.ws.sockets[0]!.closed).toBeDefined();
    h.clock.advance(250);
    expect(h.ws.sockets).toHaveLength(2);
  });

  test('stop() before the first login rejects start() with FillerStoppedError', async () => {
    const h = harness();
    const started = h.client.start();
    await h.client.stop();
    await expect(started).rejects.toBeInstanceOf(FillerStoppedError);
    h.clock.advance(60_000);
    expect(h.ws.sockets).toHaveLength(1);
  });
});

describe('heartbeat and reconnect', () => {
  test('a filler-gateway ping is answered with pong re = ping.id; the SDK pings every interval', async () => {
    const h = harness();
    void h.client.start();
    const socket = await h.login();
    socket.receive(h.gateway.frame({ type: 'ping', fillerId: FILLER, id: 'ping-7' }));
    await settle();
    const pong = socket.sentFrames().at(-1)!;
    expect(pong).toEqual({ type: 'pong', id: expect.any(String), re: 'ping-7', fillerId: FILLER, sentAt: h.clock.now(), msgSig: expect.any(String) });
    expect(recoverAddress(hashFillerMessage(pong), pong.msgSig as Hex)).toBe(h.quoteSigner.address);
    h.clock.advance(HEARTBEAT_MS);
    await settle();
    const ping = socket.sentFrames().at(-1)!;
    expect(ping).toMatchObject({ type: 'ping', fillerId: FILLER });
    expect(recoverAddress(hashFillerMessage(ping), ping.msgSig as Hex)).toBe(h.quoteSigner.address);
  });

  test('three silent intervals: the socket is closed (4000) and reopened after backoff', async () => {
    const h = harness();
    void h.client.start();
    const socket = await h.login();
    h.clock.advance(2 * HEARTBEAT_MS);
    expect(socket.closed).toBeUndefined();
    h.clock.advance(HEARTBEAT_MS);
    expect(socket.closed).toEqual({ code: CLOSE_HEARTBEAT, reason: 'heartbeat missed' });
    expect(h.events.events).toContainEqual(expect.objectContaining({ type: 'stage', stage: 'disconnected' }));
    h.clock.advance(250);
    expect(h.ws.sockets).toHaveLength(2);
  });

  test('any frame from filler-gateway counts as alive', async () => {
    const h = harness();
    void h.client.start();
    const socket = await h.login();
    for (let i = 0; i < 5; i++) {
      h.clock.advance(HEARTBEAT_MS);
      socket.receive(h.gateway.frame({ type: 'pong', fillerId: FILLER, re: 'x' }));
    }
    expect(socket.closed).toBeUndefined();
  });

  test('backoff doubles to the ceiling, jittered into [0.5, 1) of it, and resets after a login', async () => {
    const policy = { initialDelayMs: 500, maxDelayMs: 30_000 };
    expect([0, 1, 2, 3, 10].map((n) => backoffDelay(n, policy, () => 0))).toEqual([250, 500, 1_000, 2_000, 15_000]);
    expect(backoffDelay(2, policy, () => 0.999_999_9)).toBeLessThan(2_000);
    expect(backoffDelay(2, policy, () => 0.5)).toBe(1_500);

    const h = harness();
    void h.client.start();
    h.ws.sockets[0]!.drop();
    h.clock.advance(249);
    expect(h.ws.sockets).toHaveLength(1);
    h.clock.advance(1);
    expect(h.ws.sockets).toHaveLength(2);
    h.ws.sockets[1]!.drop();
    h.clock.advance(499);
    expect(h.ws.sockets).toHaveLength(2);
    h.clock.advance(1);
    expect(h.ws.sockets).toHaveLength(3);
    await h.login(h.ws.sockets[2]!);
    h.ws.sockets[2]!.drop();
    h.clock.advance(250);
    expect(h.ws.sockets).toHaveLength(4);
  });

  test('a socket factory that throws is retried like a dropped connection', () => {
    const h = harness();
    let calls = 0;
    const session = new GatewaySession(
      {
        url: URL_, fillerId: FILLER, gatewaySigner: h.gateway.address, quoteSigner: h.quoteSigner, seal: h.client.seal, clock: h.clock, logger: h.logger,
        webSocket: () => { calls++; throw new Error('ECONNREFUSED'); },
        random: () => 0, nextId: () => 'x', reconnect: { initialDelayMs: 500, maxDelayMs: 30_000 }, heartbeatMisses: 3, loginTimeoutMs: 15_000,
      },
      h.client,
    );
    session.start();
    h.clock.advance(250 + 500 + 1_000);
    expect(calls).toBe(4);
    session.stop();
  });
});

describe('frames after login', () => {
  test('a frame with a foreign signature is dropped and logged; nothing is stored or dispatched', async () => {
    const h = harness();
    const offers = record(h, 'ticket.offer');
    void h.client.start();
    const socket = await h.login();
    socket.receive(h.impostor.frame({ ...h.offer(), sig: undefined }));
    await settle();
    expect(offers).toHaveLength(0);
    expect(h.store.journal()).toHaveLength(0);
    expect(h.logger.entries).toContainEqual({ level: 'warn', message: 'filler-gateway: frame dropped', fields: { reason: 'wrong-signer', type: 'ticket.offer' } });
  });

  test('a frame addressed to another fillerId is dropped', async () => {
    const h = harness();
    const offers = record(h, 'ticket.offer');
    void h.client.start();
    const socket = await h.login();
    socket.receive(h.offer({ fillerId: 'another-filler' }));
    await settle();
    expect(offers).toHaveLength(0);
    expect(h.logger.entries).toContainEqual(expect.objectContaining({ fields: { reason: 'other-fillerId', type: 'ticket.offer' } }));
  });

  test('a frame cut mid-way is dropped and the session stays up', async () => {
    const h = harness();
    void h.client.start();
    const socket = await h.login();
    const text = JSON.stringify(h.offer());
    socket.receive(text.slice(0, 40));
    await settle();
    expect(socket.closed).toBeUndefined();
    expect(h.client.connected).toBe(true);
  });

  test('unknown types are ignored without closing; unknown fields reach the handler untouched (V-2)', async () => {
    const h = harness();
    const offers = record(h, 'ticket.offer');
    void h.client.start();
    const socket = await h.login();
    socket.receive(h.gateway.frame({ type: 'promo.banner', fillerId: FILLER, text: 'new informational type' }));
    socket.receive(h.offer({ futureField: { nested: true } }));
    await settle();
    expect(socket.closed).toBeUndefined();
    expect(offers).toHaveLength(1);
    expect(offers[0]!.frame.futureField).toEqual({ nested: true });
    expect(offers[0]!.channel).toBe('ws');
  });

  test('every verified frame is journalled byte for byte; a byte-identical redelivery is marked not first-seen', async () => {
    const h = harness();
    const offers = record(h, 'ticket.offer');
    void h.client.start();
    const socket = await h.login();
    const text = JSON.stringify(h.offer());
    socket.receive(text);
    socket.receive(text);
    await settle();
    const journal = h.store.journal();
    expect(journal).toHaveLength(1);
    expect(Buffer.from(journal[0]!.raw).toString('utf8')).toBe(text);
    expect(journal[0]).toMatchObject({ direction: 'from-gateway', type: 'ticket.offer', orderHash: ORDER_HASH, attempt: 1, id: keccakHex(new TextEncoder().encode(text)) });
    expect(offers.map((o) => o.firstSeen)).toEqual([true, false]);
  });

  test('quote.request is journalled with its requestId', async () => {
    const h = harness();
    void h.client.start();
    const socket = await h.login();
    const text = JSON.stringify(h.gateway.frame({ type: 'quote.request', fillerId: FILLER, requestId: 'rq-1', windowCloseAt: h.clock.now() + 500, quoteTtlMs: 30_000 }));
    socket.receive(text);
    await settle();
    expect(h.store.journal()).toEqual([expect.objectContaining({ type: 'quote.request', requestId: 'rq-1', raw: new TextEncoder().encode(text) })]);
  });

  test('quote.ack is kept byte for byte and attached to its quote', async () => {
    const h = harness();
    void h.client.start();
    const socket = await h.login();
    const quoteHash: Hex = `0x${'cd'.repeat(32)}`;
    const quote: QuoteMessage = { type: 'quote', id: 'q1', fillerId: FILLER, sentAt: h.clock.now(), msgSig: '0x', requestId: 'rq-1', amountOut: '100', validUntil: '1790000100', nonce: '1', sig: '0x' };
    await h.store.quotes.recordQuote({ requestId: 'rq-1', quoteHash, quote, sentAtMs: h.clock.now() });
    const ack = h.gateway.frame({ type: 'quote.ack', fillerId: FILLER, re: 'q1', requestId: 'rq-1', quoteHash, receivedAt: h.clock.now(), status: 'COUNTED' });
    const text = JSON.stringify(ack);
    socket.receive(text);
    await settle();
    const [stored] = await h.store.quotes.listQuotes('rq-1');
    expect(stored!.ack).toMatchObject({ quoteHash, status: 'COUNTED', sig: ack.sig });
    expect(Buffer.from(h.store.journal()[0]!.raw).toString('utf8')).toBe(text);
  });

  test('ticket.intent.ack is kept and moves an intent-sent attempt to intent-acked', async () => {
    const h = harness();
    void h.client.start();
    const socket = await h.login();
    await h.store.withOrder(ORDER_HASH, (tx) => tx.putTicket({ orderHash: ORDER_HASH, attempt: 1, state: 'intent-sent', updatedAtMs: h.clock.now() }));
    const ack = h.gateway.frame({ type: 'ticket.intent.ack', fillerId: FILLER, orderHash: ORDER_HASH, attempt: 1, intentHash: `0x${'ef'.repeat(32)}`, receivedAt: h.clock.now() });
    socket.receive(ack);
    socket.receive(ack);
    await settle();
    const ticket = await h.store.withOrder(ORDER_HASH, (tx) => tx.getTicket(1));
    expect(ticket).toMatchObject({ state: 'intent-acked', intentAck: { intentHash: ack.intentHash, sig: ack.sig } });
    expect(h.store.journal().filter((e) => e.type === 'ticket.intent.ack')).toHaveLength(1);
  });

  test('an error frame becomes a typed error for listeners; an unknown code stays generic', async () => {
    const h = harness();
    const errors: GatewayError[] = [];
    h.client.onGatewayError((e) => errors.push(e));
    void h.client.start();
    const socket = await h.login();
    socket.receive(h.gateway.frame({ type: 'error', fillerId: FILLER, re: 'q1', code: 'TICKET_CLOSED', message: 'after acceptBy' }));
    socket.receive(h.gateway.frame({ type: 'error', fillerId: FILLER, code: 'SOMETHING_NEW', message: 'later minor' }));
    await settle();
    expect(errors.map((e) => [e.code, e.known, e.re])).toEqual([
      ['TICKET_CLOSED', true, 'q1'],
      ['SOMETHING_NEW', false, undefined],
    ]);
    expect(socket.closed).toBeUndefined();
  });

  test('a store outage is logged; the session stays up', async () => {
    const h = harness();
    void h.client.start();
    const socket = await h.login();
    h.store.setAvailable(false);
    socket.receive(h.offer());
    await settle();
    expect(h.logger.entries).toContainEqual(expect.objectContaining({ level: 'error', message: 'filler-gateway: frame handling failed' }));
    expect(h.client.connected).toBe(true);
  });
});

describe('REST fallback (protocol §3.6)', () => {
  // Already sealed (the caller seals; a resend is the same bytes); the signatures are placeholders the fake gateway does not check.
  const intent = (): TicketIntentMessage => ({
    type: 'ticket.intent', id: 'i-1', fillerId: FILLER, sentAt: 1790000000000, msgSig: `0x${'00'.repeat(65)}`,
    orderHash: ORDER_HASH, attempt: 1, validFrom: '1790000000', validUntil: '1790000180',
    deliveryKey: `0x${'42'.repeat(20)}`, repayTo: `0x${'00'.repeat(12)}${'42'.repeat(20)}`, sig: `0x${'00'.repeat(65)}`,
  });

  test('after a drop the client pulls GET /v1/filler/tickets with a bearer token and handles the items', async () => {
    const h = harness();
    const offers = record(h, 'ticket.offer');
    void h.client.start();
    const socket = await h.login();
    await settle();
    h.http.requests.length = 0;
    h.tickets.OFFERED = [h.offer()];
    socket.drop();
    h.clock.advance(0);
    await settle();

    const paths = h.http.requests.map((r) => `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`);
    expect(paths).toEqual([
      'GET /v1/filler/tickets?status=OFFERED&limit=100',
      'GET /v1/filler/tickets?status=ISSUED&limit=100',
    ]);
    expect(h.http.requests[0]!.headers).toMatchObject({ authorization: 'Bearer tok-1' });
    expect(offers).toEqual([expect.objectContaining({ channel: 'rest' })]);
  });

  test('the REST login signs FillerAuth over the REST challenge', async () => {
    const h = harness();
    await h.rest.listTickets('OFFERED');
    const [challenge, auth] = h.http.requests;
    expect(new URL(challenge!.url).pathname).toBe('/v1/filler/auth/challenge');
    expect(challenge!.url.startsWith('https://filler-gateway.example/')).toBe(true);
    const body = JSON.parse(auth!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({ type: 'auth.response', fillerId: FILLER, keyAddress: h.quoteSigner.address, protocolVersion: '1', nonce: `0x${'1'.padStart(64, '0')}` });
    const signer = recoverTypedDataSigner(
      { domain: FILLER_PROTOCOL_DOMAIN, types: FILLER_AUTH_TYPES, primaryType: 'FillerAuth', message: { fillerId: FILLER, nonce: `0x${'1'.padStart(64, '0')}`, expiresAt: String(Math.floor(h.clock.now() / 1000) + 30) } },
      body.sig as Hex,
    );
    expect(signer).toBe(h.quoteSigner.address);
  });

  test('a list item with a bad signature is dropped', async () => {
    const h = harness();
    h.tickets.OFFERED = [h.impostor.frame({ ...h.offer(), sig: undefined }), h.offer({ attempt: 2 })];
    const items = await h.rest.listTickets('OFFERED');
    expect(items.map((i) => i.frame.attempt)).toEqual([2]);
  });

  test('a 401 renews the token once and repeats the call', async () => {
    const h = harness();
    let calls = 0;
    h.http.routes['GET /v1/filler/tickets'] = () =>
      ++calls === 1 ? { status: 401, body: h.gateway.frame({ type: 'error', code: 'UNAUTHENTICATED', message: 'expired' }) } : { status: 200, body: { items: [], nextCursor: null } };
    await expect(h.rest.listTickets()).resolves.toEqual([]);
    expect(h.http.requests.filter((r) => new URL(r.url).pathname === '/v1/filler/auth')).toHaveLength(2);
  });

  test('an error body becomes the typed error with its HTTP status', async () => {
    const h = harness();
    h.http.routes[`POST /v1/filler/tickets/${ORDER_HASH}/1/intent`] = () => ({
      status: 409,
      body: h.gateway.frame({ type: 'error', fillerId: FILLER, code: 'TICKET_CLOSED', message: 'after acceptBy' }),
    });
    await expect(h.rest.postTicket({ action: 'intent', message: intent() })).rejects.toMatchObject({ name: 'GatewayError', code: 'TICKET_CLOSED', known: true, httpStatus: 409 });
  });

  test('an error body without a valid filler-gateway signature is not trusted', async () => {
    const h = harness();
    h.http.routes[`POST /v1/filler/tickets/${ORDER_HASH}/1/decline`] = () => ({
      status: 409,
      body: h.impostor.frame({ type: 'error', fillerId: FILLER, code: 'TICKET_CLOSED', message: 'forged' }),
    });
    const decline = await h.client.seal<TicketDecline>({ type: 'ticket.decline', id: 'd-1', orderHash: ORDER_HASH, attempt: 1, reason: 'NO_INVENTORY' });
    await expect(h.rest.postTicket({ action: 'decline', message: decline })).rejects.toMatchObject({ code: 'UNVERIFIED_RESPONSE', httpStatus: 409 });
  });

  test('submitTicket: WebSocket when ready, REST while down; the REST ack is handled like a frame; a repeat is the same request', async () => {
    const h = harness();
    void h.client.start();
    const socket = await h.login();
    await h.store.withOrder(ORDER_HASH, (tx) => tx.putTicket({ orderHash: ORDER_HASH, attempt: 1, state: 'intent-sent', updatedAtMs: h.clock.now() }));
    await expect(h.client.submitTicket({ action: 'intent', message: intent() })).resolves.toBe('ws');
    expect(socket.sentFrames().at(-1)).toMatchObject({ type: 'ticket.intent', orderHash: ORDER_HASH });

    socket.drop();
    const ack = h.gateway.frame({ type: 'ticket.intent.ack', fillerId: FILLER, orderHash: ORDER_HASH, attempt: 1, intentHash: `0x${'ef'.repeat(32)}`, receivedAt: h.clock.now() });
    h.http.routes[`POST /v1/filler/tickets/${ORDER_HASH}/1/intent`] = () => ({ status: 200, body: ack });
    await expect(h.client.submitTicket({ action: 'intent', message: intent() })).resolves.toBe('rest');
    await expect(h.client.submitTicket({ action: 'intent', message: intent() })).resolves.toBe('rest');
    const posts = h.http.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/intent'));
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toBe(posts[1]!.body);
    const ticket = await h.store.withOrder(ORDER_HASH, (tx) => tx.getTicket(1));
    expect(ticket).toMatchObject({ state: 'intent-acked', intentAck: { sig: ack.sig } });
  });

  test('frames with no REST route are not sent while down', async () => {
    const h = harness();
    void h.client.start();
    const socket = await h.login();
    socket.drop();
    expect(h.client.send(await h.client.seal({ type: 'fill.reported', id: 'f', orderHash: ORDER_HASH, attempt: 1, txRef: '0x01' }))).toBe(false);
  });

  test('GET /v1/filler/attestations/{orderHash}: 404 ATTESTATIONS_NOT_READY is «not yet»; a verified frame goes to the settle.attestations handler as rest', async () => {
    const h = harness();
    const seen = record(h, 'settle.attestations');
    const path = `GET /v1/filler/attestations/${ORDER_HASH}`;
    h.http.routes[path] = () => ({ status: 404, body: h.gateway.frame({ type: 'error', fillerId: FILLER, code: 'ATTESTATIONS_NOT_READY', message: 'fewer than threshold' }) });
    await expect(h.client.pullAttestations(ORDER_HASH)).resolves.toBe(false);
    expect(seen).toEqual([]);

    const frame = h.gateway.frame({ type: 'settle.attestations', fillerId: FILLER, orderHash: ORDER_HASH, attempt: 1, sourceChainId: 'eip155:56', proof: {}, signatures: [], setId: 1, threshold: 2, refundAfter: '1790003600' });
    h.http.routes[path] = () => ({ status: 200, body: frame });
    await expect(h.client.pullAttestations(ORDER_HASH)).resolves.toBe(true);
    expect(seen).toEqual([expect.objectContaining({ channel: 'rest', firstSeen: true, frame: expect.objectContaining({ type: 'settle.attestations', sig: frame.sig }) })]);
    expect(h.store.journal().filter((e) => e.type === 'settle.attestations')).toHaveLength(1);
  });

  test('an attestation body not signed by filler-gateway is refused, never handled', async () => {
    const h = harness();
    const seen = record(h, 'settle.attestations');
    h.http.routes[`GET /v1/filler/attestations/${ORDER_HASH}`] = () => ({ status: 200, body: h.impostor.frame({ type: 'settle.attestations', fillerId: FILLER, orderHash: ORDER_HASH, attempt: 1 }) });
    await expect(h.client.pullAttestations(ORDER_HASH)).rejects.toMatchObject({ code: 'UNVERIFIED_RESPONSE' });
    expect(seen).toEqual([]);
  });

  test('restOrigin maps ws to http for the local stand', async () => {
    const h = harness();
    const rest = new GatewayRest({ gatewayUrl: 'ws://localhost:3010/v1', fillerId: FILLER, gatewaySigner: h.gateway.address, quoteSigner: h.quoteSigner, seal: h.client.seal, fetch: h.http.fetch, clock: h.clock, logger: h.logger, nextId: () => 'x' });
    await expect(rest.listTickets('OFFERED')).resolves.toEqual([]);
    expect(h.http.requests[0]!.url).toBe('http://localhost:3010/v1/filler/auth/challenge');
  });
});

describe('createFiller().start()', () => {
  const fillSigner = (key: Hex): FillSigner => ({ ...createTestTypedDataSigner(key), signTransaction: async () => '0x02' });

  test('logs in over the injected factory and resolves; stop() closes the session', async () => {
    const clock = new FakeClock();
    const gateway = createTestGatewaySigner(GATEWAY_KEY, clock);
    const ws = createFakeWebSocketFactory();
    const config: FillerConfig = {
      gatewayUrl: URL_,
      fillerId: FILLER,
      gatewaySigner: gateway.address,
      ticketSigners: ['0x2222222222222222222222222222222222222222'],
      quoteSigner: createTestTypedDataSigner(QUOTE_KEY),
      fillSigners: { 'eip155:1': fillSigner(FILL_KEY) },
      rpc: { 'eip155:1': [new FakeEvmRpc()] },
      chains: { 'eip155:1': { router: '0x3333333333333333333333333333333333333333', openConfirmations: 3, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30, minGasWei: 10n ** 15n } },
      tickets: { deltaIssueMs: 3_000 },
      store: new InMemoryFillerStore(clock),
      webSocket: ws.factory,
      fetch: createFakeFetch().fetch,
      clock,
      instanceId: 'replica-1',
      transport: { random: () => 0 },
    };
    const filler = createFiller(config);
    filler.onQuoteRequest(async () => null);
    filler.onReconfirm(async () => true);
    filler.onTicketOffer(async () => 'decline');
    const started = filler.start();
    void filler.start();
    expect(ws.sockets).toHaveLength(1);
    const socket = ws.sockets[0]!;
    socket.open();
    socket.receive(gateway.frame({ type: 'auth.challenge', nonce: `0x${'ab'.repeat(32)}`, expiresAt: String(Math.floor(clock.now() / 1000) + 30) }));
    await settle();
    const response = socket.sentFrames()[0]!;
    expect(String(response.id).startsWith('replica-1:')).toBe(true);
    socket.receive(gateway.frame({ type: 'auth.ok', fillerId: FILLER, heartbeatIntervalMs: HEARTBEAT_MS, re: response.id }));
    await expect(started).resolves.toBeUndefined();
    await filler.stop();
    expect(socket.closed).toEqual({ code: 1000, reason: 'filler stopping' });
    clock.advance(60_000);
    expect(ws.sockets).toHaveLength(1);
  });
});

describe('createFrameIds', () => {
  test('ids are ≤ 64 characters, distinct, and differ between replicas and restarts', () => {
    const a = createFrameIds('3f1c2b8e-1d2a-4c3b-9e8f-7a6b5c4d3e2f', 1_790_000_000_000);
    const b = createFrameIds('3f1c2b8e-1d2a-4c3b-9e8f-7a6b5c4d3e2f', 1_790_000_000_001);
    const ids = [a(), a(), b()];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(64);
    expect(createFrameIds('x'.repeat(200), 1)().length).toBeLessThanOrEqual(64);
  });
});
