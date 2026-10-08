/**
 * The protocol client against crafted frames (sdk.md S15): a FakeSocket plays
 * filler-gateway on WebSocket, a fake fetch plays it on REST (the login among
 * it), a FakeClock drives heartbeat and backoff. No server.
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
import type { WebSocketFactory } from '../runtime';
import { recoverAddress, recoverTypedDataSigner, type FillSigner } from '../signer';
import {
  createFakeFetch,
  createFakeGatewayLogin,
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

/** Lets pending promise chains (the REST login, signing, store writes) run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

const pathOf = (url: string) => new URL(url).pathname;

function harness(options: { random?: () => number; tokenTtlMs?: number; heartbeatIntervalMs?: number; webSocket?: WebSocketFactory } = {}) {
  const clock = new FakeClock();
  const store = new InMemoryFillerStore(clock);
  const logger = createRecordingLogger();
  const events = createRecordingEventSink();
  const gateway = createTestGatewaySigner(GATEWAY_KEY, clock);
  const impostor = createTestGatewaySigner(OTHER_KEY, clock);
  const quoteSigner = createTestTypedDataSigner(QUOTE_KEY);
  const ws = createFakeWebSocketFactory();
  const tickets: { OFFERED: unknown[]; ISSUED: unknown[] } = { OFFERED: [], ISSUED: [] };
  const gw = createFakeGatewayLogin(gateway, {
    fillerId: FILLER,
    clock,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? HEARTBEAT_MS,
    ...(options.tokenTtlMs !== undefined ? { tokenTtlMs: options.tokenTtlMs } : {}),
  });
  const http = createFakeFetch({
    ...gw.routes,
    'GET /v1/filler/tickets': (request) => {
      const status = new URL(request.url).searchParams.get('status') as 'OFFERED' | 'ISSUED';
      return { status: 200, body: { items: tickets[status], nextCursor: null } };
    },
  });
  const nextId = createFrameIds('replica-1', clock.now());
  const seal = createSealer({ fillerId: FILLER, messageSigner: quoteSigner, clock });
  const client = new FillerProtocolClient({ store, clock, logger, events, restPollIntervalMs: 2_000, seal });
  const rest = new GatewayRest({ gatewayUrl: URL_, fillerId: FILLER, gatewaySigner: gateway.address, quoteSigner, seal, fetch: http.fetch, clock, logger, nextId });
  const session = new GatewaySession(
    {
      url: URL_,
      fillerId: FILLER,
      gatewaySigner: gateway.address,
      tokens: rest,
      seal,
      webSocket: options.webSocket ?? ws.factory,
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
  client.attach(session, rest);

  /** The newest socket, once the REST login before it has run. */
  const connected = async (): Promise<FakeSocket> => {
    await settle();
    return ws.sockets.at(-1)!;
  };
  /** Lets the newest connect log in and filler-gateway accept it (auth.ok first). */
  const login = async (): Promise<FakeSocket> => {
    const socket = await connected();
    expect(gw.accept(socket)).toBe(true);
    await settle();
    return socket;
  };
  const requests = (path: string) => http.requests.filter((r) => pathOf(r.url) === path);

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

  return { clock, store, logger, events, gateway, impostor, quoteSigner, ws, http, gw, tickets, client, session, rest, connected, login, requests, offer };
}

const record = (h: ReturnType<typeof harness>, type: string) => {
  const seen: Delivery[] = [];
  h.client.on(type, async (delivery) => void seen.push(delivery));
  return seen;
};

/** A signed challenge; a field set to undefined in `over` is left out. */
const challengeFrame = (h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) => {
  const body: Record<string, unknown> = { fillerId: FILLER, nonce: `0x${'ab'.repeat(32)}`, expiresAt: String(Math.floor(h.clock.now() / 1000) + 30), ...over };
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return h.gateway.frame({ type: 'auth.challenge', ...body });
};

describe('login: REST first, then the WebSocket with the token (protocol §3.5 «Session»)', () => {
  test('GET challenge?fillerId= → FillerAuth by the quote key → POST /v1/filler/auth; the upgrade offers cancore-filler.v1 + bearer.<token>; auth.ok resolves start()', async () => {
    const h = harness();
    const started = h.client.start();
    const socket = await h.connected();

    const [challenge] = h.requests('/v1/filler/auth/challenge');
    expect(challenge!.url).toBe('https://filler-gateway.example/v1/filler/auth/challenge?fillerId=acme-1');
    const [auth] = h.requests('/v1/filler/auth');
    const response = JSON.parse(auth!.body!) as Record<string, unknown>;
    const nonce = `0x${'1'.padStart(64, '0')}`;
    expect(response).toMatchObject({ type: 'auth.response', fillerId: FILLER, keyAddress: h.quoteSigner.address, protocolVersion: '1', nonce, sentAt: h.clock.now() });
    const signer = recoverTypedDataSigner(
      { domain: FILLER_PROTOCOL_DOMAIN, types: FILLER_AUTH_TYPES, primaryType: 'FillerAuth', message: { fillerId: FILLER, nonce, expiresAt: String(Math.floor(h.clock.now() / 1000) + 30) } },
      response.sig as Hex,
    );
    expect(signer).toBe(h.quoteSigner.address);
    expect(recoverAddress(hashFillerMessage(response), response.msgSig as Hex)).toBe(h.quoteSigner.address);

    expect(socket.url).toBe(URL_);
    expect(socket.protocols).toEqual(['cancore-filler.v1', 'bearer.tok-1']);
    expect(h.gw.accept(socket)).toBe(true);
    await expect(started).resolves.toBeUndefined();
    expect(socket.sent).toHaveLength(0); // nothing goes out on the socket for the login
    expect(h.client.connected).toBe(true);
    expect(h.events.events).toContainEqual(expect.objectContaining({ type: 'stage', stage: 'authenticated' }));
  });

  test('one login serves REST and the WebSocket: a REST call meanwhile shares it', async () => {
    const h = harness();
    void h.client.start();
    const listed = h.rest.listTickets('OFFERED');
    await h.login();
    await listed;
    expect(h.requests('/v1/filler/auth')).toHaveLength(1);
    expect(h.requests('/v1/filler/tickets').every((r) => r.headers?.authorization === 'Bearer tok-1')).toBe(true);
  });

  test('before auth.ok the SDK sends nothing: frames are refused, inbound frames other than auth.ok and error are dropped', async () => {
    const h = harness();
    const offers = record(h, 'ticket.offer');
    void h.client.start();
    const socket = await h.connected();
    socket.open();
    expect(h.client.send(await h.client.seal({ type: 'ping', id: 'p' }))).toBe(false);
    socket.receive(h.offer());
    socket.receive(challengeFrame(h));
    await settle();
    expect(socket.sent).toHaveLength(0);
    expect(offers).toHaveLength(0);
    expect(h.store.journal()).toHaveLength(0);
    expect(h.logger.entries).toContainEqual(expect.objectContaining({ message: 'filler-gateway: frame before auth.ok dropped' }));
  });

  test.each([
    ['addressed to another fillerId', { fillerId: 'someone-else' }, 'other-fillerId'],
    ['addressed to no one', { fillerId: undefined }, 'no-fillerId'],
  ])('a challenge %s is refused: no auth.response, no socket; the login is retried with backoff', async (_what, over, reason) => {
    const h = harness();
    h.http.routes['GET /v1/filler/auth/challenge'] = () => ({ status: 200, body: challengeFrame(h, over) });
    void h.client.start();
    await settle();
    expect(h.requests('/v1/filler/auth')).toHaveLength(0);
    expect(h.ws.sockets).toHaveLength(0);
    expect(h.logger.entries).toContainEqual(expect.objectContaining({ message: 'filler-gateway: login failed, retrying', fields: expect.objectContaining({ error: expect.stringContaining(reason) }) }));
    h.clock.advance(250);
    await settle();
    expect(h.requests('/v1/filler/auth/challenge')).toHaveLength(2);
  });

  test('a challenge not signed by the pinned key is refused', async () => {
    const h = harness();
    h.http.routes['GET /v1/filler/auth/challenge'] = () => ({
      status: 200,
      body: h.impostor.frame({ type: 'auth.challenge', fillerId: FILLER, nonce: `0x${'ab'.repeat(32)}`, expiresAt: String(Math.floor(h.clock.now() / 1000) + 30) }),
    });
    void h.client.start();
    await settle();
    expect(h.requests('/v1/filler/auth')).toHaveLength(0);
    expect(h.ws.sockets).toHaveLength(0);
  });

  test('an unsigned refusal of the challenge route (404) becomes a typed error and a retry with backoff', async () => {
    const h = harness();
    h.http.routes['GET /v1/filler/auth/challenge'] = () => ({ status: 404, body: { type: 'error', code: 'UNKNOWN_REQUEST', message: 'unknown fillerId' } });
    await expect(h.rest.validToken()).rejects.toMatchObject({ code: 'UNKNOWN_REQUEST', known: true, httpStatus: 404, message: expect.stringContaining('unsigned') });
    void h.client.start();
    await settle();
    expect(h.ws.sockets).toHaveLength(0);
    h.clock.advance(250);
    await settle();
    expect(h.requests('/v1/filler/auth/challenge')).toHaveLength(3);
  });

  test('POST /v1/filler/auth refused unsigned 401 (no live challenge): the next attempt starts over from a fresh challenge', async () => {
    const h = harness();
    let refusals = 1;
    h.http.routes['POST /v1/filler/auth'] = (request) =>
      refusals-- > 0 ? { status: 401, body: { type: 'error', code: 'UNAUTHENTICATED', message: 'no live challenge for this fillerId' } } : h.gw.routes['POST /v1/filler/auth']!(request);
    await expect(h.rest.validToken()).rejects.toMatchObject({ code: 'UNAUTHENTICATED', known: true, httpStatus: 401, message: expect.stringContaining('unsigned') });
    refusals = 1;
    void h.client.start();
    await settle();
    expect(h.ws.sockets).toHaveLength(0);
    h.clock.advance(250);
    const socket = await h.connected();
    const nonces = h.requests('/v1/filler/auth').map((r) => (JSON.parse(r.body!) as { nonce: string }).nonce);
    expect(new Set(nonces).size).toBe(nonces.length); // every attempt answers its own challenge
    expect(h.requests('/v1/filler/auth/challenge')).toHaveLength(3);
    expect(socket.token).toBe('tok-1');
  });

  test('POST /v1/filler/auth refused unsigned 404 / 429: a typed hint; the 429 holds the login class back', async () => {
    const h = harness();
    h.http.routes['POST /v1/filler/auth'] = () => ({ status: 404, body: { type: 'error', code: 'UNKNOWN_REQUEST', message: 'filler not ACTIVE' } });
    await expect(h.rest.validToken()).rejects.toMatchObject({ code: 'UNKNOWN_REQUEST', httpStatus: 404 });
    h.http.routes['POST /v1/filler/auth'] = () => ({ status: 429, headers: { 'Retry-After': '9' }, body: { type: 'error', code: 'RATE_LIMITED', message: 'login class', retryAfterMs: 8_500 } });
    await expect(h.rest.validToken()).rejects.toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: 8_500 });
    expect(h.rest.limits.remainingMs('login')).toBe(8_500);
    const challenges = h.requests('/v1/filler/auth/challenge').length;
    await expect(h.rest.validToken()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(h.requests('/v1/filler/auth/challenge')).toHaveLength(challenges); // no request while paused
  });

  test('an unverified refusal of POST /v1/filler/auth is only a hint: a forged UNSUPPORTED_VERSION does not stop the filler', async () => {
    const h = harness();
    h.http.routes['POST /v1/filler/auth'] = () => ({ status: 400, body: h.impostor.frame({ type: 'error', code: 'UNSUPPORTED_VERSION', message: 'forged' }) });
    const refused = h.rest.validToken();
    await expect(refused).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION', message: expect.stringContaining('unsigned') });
    await expect(refused).rejects.not.toBeInstanceOf(UnsupportedVersionError);
    void h.client.start();
    await settle();
    h.clock.advance(250);
    await settle();
    expect(h.session.state).not.toBe('failed');
    expect(h.requests('/v1/filler/auth/challenge')).toHaveLength(3); // retried, with backoff
  });

  test('UNSUPPORTED_VERSION on the socket: start() rejects with a typed error and no reconnect loop follows', async () => {
    const h = harness();
    const started = h.client.start();
    const socket = await h.connected();
    socket.open();
    socket.receive(h.gateway.frame({ type: 'error', fillerId: FILLER, code: 'UNSUPPORTED_VERSION', message: 'this filler-gateway speaks "2"' }));
    socket.drop(1008, 'UNSUPPORTED_VERSION');
    await expect(started).rejects.toBeInstanceOf(UnsupportedVersionError);
    h.clock.advance(10 * 60_000);
    await settle();
    expect(h.ws.sockets).toHaveLength(1);
    expect(h.session.state).toBe('failed');
  });

  test('UNSUPPORTED_VERSION from POST /v1/filler/auth: start() rejects, no socket is ever opened', async () => {
    const h = harness();
    h.http.routes['POST /v1/filler/auth'] = () => ({ status: 400, body: h.gateway.frame({ type: 'error', code: 'UNSUPPORTED_VERSION', message: 'protocolVersion "1" is not served' }) });
    const started = h.client.start();
    await expect(started).rejects.toBeInstanceOf(UnsupportedVersionError);
    h.clock.advance(10 * 60_000);
    await settle();
    expect(h.ws.sockets).toHaveLength(0);
    expect(h.session.state).toBe('failed');
  });

  test('a refused upgrade (401) drops the token: the next attempt logs in again and offers the new one', async () => {
    const h = harness();
    void h.client.start();
    const first = await h.connected();
    first.refuse(401);
    h.clock.advance(250);
    const second = await h.connected();
    expect(h.ws.sockets).toHaveLength(2);
    expect(h.requests('/v1/filler/auth')).toHaveLength(2);
    expect(second.token).toBe('tok-2');
    expect(h.gw.accept(second)).toBe(true);
  });

  test('a close before auth.ok drops the token; a close after it keeps it, unless the key was changed (4002)', async () => {
    const h = harness();
    void h.client.start();
    (await h.connected()).drop(1006); // opened nothing, said nothing
    h.clock.advance(250);
    const second = await h.login();
    expect(second.token).toBe('tok-2');

    second.drop(1006);
    h.clock.advance(250);
    const third = await h.login();
    expect(third.token).toBe('tok-2');

    third.drop(4002, 'message key changed');
    h.clock.advance(250);
    expect((await h.connected()).token).toBe('tok-3');
  });

  test('the token is renewed before expiresAt: a reconnect never offers an expiring one', async () => {
    const h = harness({ tokenTtlMs: 120_000, heartbeatIntervalMs: 600_000 });
    void h.client.start();
    const first = await h.login();
    expect(first.token).toBe('tok-1');
    h.clock.advance(60_000);
    first.drop(1006);
    h.clock.advance(250);
    const second = await h.login();
    expect(second.token).toBe('tok-1'); // 60 s left: still well inside its lifetime
    h.clock.advance(35_000); // 25 s left: inside the renewal margin
    second.drop(1006);
    h.clock.advance(250);
    const third = await h.login();
    expect(third.token).toBe('tok-2');
    expect(h.requests('/v1/filler/auth')).toHaveLength(2);
  });

  test('no auth.ok within loginTimeoutMs: the connection is closed and retried with a fresh login', async () => {
    const h = harness();
    void h.client.start();
    const socket = await h.connected();
    socket.open();
    h.clock.advance(15_000);
    expect(socket.closed).toBeDefined();
    h.clock.advance(250);
    expect((await h.connected()).token).toBe('tok-2');
  });

  test('a login that never answers is cut by loginTimeoutMs too', async () => {
    const h = harness();
    let hang = true;
    h.http.routes['GET /v1/filler/auth/challenge'] = (request) => (hang ? new Promise(() => undefined) : h.gw.routes['GET /v1/filler/auth/challenge']!(request));
    void h.client.start();
    await settle();
    expect(h.session.state).toBe('connecting');
    h.clock.advance(15_000);
    expect(h.session.state).toBe('waiting');
    expect(h.ws.sockets).toHaveLength(0);
    hang = false;
    h.clock.advance(250);
    expect((await h.connected()).token).toBe('tok-1'); // a new login, not the hung one
    expect(h.requests('/v1/filler/auth/challenge')).toHaveLength(2);
  });

  test('stop() before the first login rejects start() with FillerStoppedError', async () => {
    const h = harness();
    const started = h.client.start();
    await h.client.stop();
    await expect(started).rejects.toBeInstanceOf(FillerStoppedError);
    h.clock.advance(60_000);
    await settle();
    expect(h.ws.sockets).toHaveLength(0);
  });

  test('the token never reaches the logs, even from an adapter error that quotes the subprotocols', async () => {
    const h = harness({
      webSocket: (_url, _handlers, protocols) => {
        throw new Error(`invalid subprotocol "${protocols[1]}"`);
      },
    });
    void h.client.start();
    await settle();
    h.clock.advance(250);
    await settle();
    const logged = JSON.stringify(h.logger.entries);
    expect(h.requests('/v1/filler/auth')).toHaveLength(2); // each failed connect dropped its token
    expect(logged).toContain('<token>');
    expect(logged).not.toMatch(/tok-\d/);

    const g = harness();
    void g.client.start();
    (await g.connected()).refuse(401);
    g.clock.advance(250);
    const socket = await g.login();
    socket.drop(4029);
    g.clock.advance(250);
    await settle();
    expect(JSON.stringify(g.logger.entries)).not.toMatch(/tok-\d/);
  });
});

describe('rate limits per fillerId (RATE_LIMITED, retryAfterMs)', () => {
  test('a login refused 429 (unsigned, retryAfterMs) is not retried before retryAfterMs', async () => {
    const h = harness();
    let limited = true;
    h.http.routes['GET /v1/filler/auth/challenge'] = (request) =>
      limited ? { status: 429, body: { type: 'error', code: 'RATE_LIMITED', message: 'login rate class over its limit', retryAfterMs: 5_000 } } : h.gw.routes['GET /v1/filler/auth/challenge']!(request);
    void h.client.start();
    await settle();
    expect(h.requests('/v1/filler/auth/challenge')).toHaveLength(1);
    limited = false;
    h.clock.advance(4_999);
    await settle();
    expect(h.requests('/v1/filler/auth/challenge')).toHaveLength(1);
    expect(h.ws.sockets).toHaveLength(0);
    h.clock.advance(1);
    await settle();
    expect(h.requests('/v1/filler/auth/challenge')).toHaveLength(2);
    expect(h.ws.sockets).toHaveLength(1);
  });

  test('close 4029: the reconnect waits at least the last retryAfterMs filler-gateway named', async () => {
    const h = harness({ heartbeatIntervalMs: 600_000 });
    void h.client.start();
    const socket = await h.login();
    socket.receive(h.gateway.frame({ type: 'error', fillerId: FILLER, code: 'RATE_LIMITED', message: 'cooling down', retryAfterMs: 20_000 }));
    socket.drop(4029, 'rate limited');
    h.clock.advance(19_999);
    await settle();
    expect(h.ws.sockets).toHaveLength(1);
    h.clock.advance(1);
    await settle();
    expect(h.ws.sockets).toHaveLength(2);
    expect(h.ws.sockets[1]!.token).toBe('tok-1'); // a cooldown is not a bad token
  });

  test('error RATE_LIMITED on the socket holds back the class of the refused frame until retryAfterMs, logged once', async () => {
    const h = harness({ heartbeatIntervalMs: 600_000 });
    void h.client.start();
    const socket = await h.login();
    const quote = (id: string) => h.client.seal<QuoteMessage>({ type: 'quote', id, requestId: 'rq-1', amountOut: '100', validUntil: '1790000100', nonce: '1', sig: `0x${'00'.repeat(65)}` });
    expect(h.client.send(await quote('q-1'))).toBe(true);
    socket.receive(h.gateway.frame({ type: 'error', fillerId: FILLER, re: 'q-1', code: 'RATE_LIMITED', message: 'quote rate class over its limit', retryAfterMs: 3_000 }));
    await settle();
    expect(h.client.rateLimitedMs('quote')).toBe(3_000);
    expect(h.client.rateLimitedMs('quote.reconfirm.reply')).toBe(3_000);
    expect(h.client.send(await quote('q-2'))).toBe(false);
    expect(h.client.send(await quote('q-3'))).toBe(false);
    expect(h.logger.entries.filter((e) => e.message === 'filler-gateway: rate limited, frames of this class held back')).toHaveLength(1);
    // another class is not held back
    expect(h.client.send(await h.client.seal({ type: 'ping', id: 'p-1' }))).toBe(true);
    expect(socket.sentFrames().map((f) => f.id)).toEqual(['q-1', 'p-1']);
    h.clock.advance(3_000);
    expect(h.client.send(await quote('q-4'))).toBe(true);
  });

  test('a ticket action is refused locally with the remaining retryAfterMs while the ticket class is paused, on either channel', async () => {
    const h = harness({ heartbeatIntervalMs: 600_000 });
    void h.client.start();
    const socket = await h.login();
    const report = await h.client.seal({ type: 'fill.reported', id: 'f-1', orderHash: ORDER_HASH, attempt: 1, txRef: '0x01' });
    expect(h.client.send(report)).toBe(true);
    socket.receive(h.gateway.frame({ type: 'error', fillerId: FILLER, re: 'f-1', code: 'RATE_LIMITED', message: 'ticket class', retryAfterMs: 2_000 }));
    await settle();
    const decline = await h.client.seal<TicketDecline>({ type: 'ticket.decline', id: 'd-1', orderHash: ORDER_HASH, attempt: 1, reason: 'NO_INVENTORY' });
    await expect(h.client.submitTicket({ action: 'decline', message: decline })).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 2_000 });
    socket.drop();
    await expect(h.client.submitTicket({ action: 'decline', message: decline })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(h.requests(`/v1/filler/tickets/${ORDER_HASH}/1/decline`)).toHaveLength(0);
  });

  test('REST 429 on a bearer route (unsigned): retryAfterMs of the body, the class is paused, no request goes out before it', async () => {
    const h = harness();
    let limited = true;
    h.http.routes['GET /v1/filler/tickets'] = () =>
      limited
        ? { status: 429, headers: { 'Retry-After': '5' }, body: { type: 'error', code: 'RATE_LIMITED', message: 'read class', retryAfterMs: 4_000 } }
        : { status: 200, body: { items: [], nextCursor: null } };
    await expect(h.rest.listTickets('OFFERED')).rejects.toMatchObject({ name: 'GatewayError', code: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: 4_000 });
    expect(h.requests('/v1/filler/tickets')).toHaveLength(1);
    limited = false;
    h.clock.advance(3_999);
    await expect(h.rest.listTickets('OFFERED')).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 1 });
    expect(h.requests('/v1/filler/tickets')).toHaveLength(1);
    // another class is not paused
    expect(h.rest.limits.remainingMs('ticket')).toBe(0);
    h.clock.advance(1);
    await expect(h.rest.listTickets('OFFERED')).resolves.toEqual([]);
  });

  test('REST 429 is decided by the status: without retryAfterMs in the body, Retry-After (seconds) is the wait', async () => {
    const h = harness();
    h.http.routes['GET /v1/filler/tickets'] = () => ({ status: 429, headers: { 'Retry-After': '7' }, body: 'Too Many Requests' });
    await expect(h.rest.listTickets()).rejects.toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: 7_000 });
    expect(h.rest.limits.remainingMs('read')).toBe(7_000);
  });

  test('a signed 429 is read the same way', async () => {
    const h = harness();
    h.http.routes['GET /v1/filler/tickets'] = () => ({ status: 429, body: h.gateway.frame({ type: 'error', fillerId: FILLER, code: 'RATE_LIMITED', message: 'read class', retryAfterMs: 2_500 }) });
    await expect(h.rest.listTickets()).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 2_500 });
    expect(h.rest.limits.remainingMs('read')).toBe(2_500);
  });

  test('a non-429 refusal of a bearer route must be signed: an unsigned body is not trusted', async () => {
    const h = harness();
    h.http.routes['GET /v1/filler/tickets'] = () => ({ status: 409, body: { type: 'error', code: 'TICKET_CLOSED', message: 'unsigned' } });
    await expect(h.rest.listTickets()).rejects.toMatchObject({ code: 'UNVERIFIED_RESPONSE', httpStatus: 409 });
    expect(h.rest.limits.remainingMs('read')).toBe(0);
  });

  test('the ticket poll while down does not storm a rate-limited route', async () => {
    const h = harness({ heartbeatIntervalMs: 600_000 });
    let calls = 0;
    h.http.routes['GET /v1/filler/tickets'] = () => {
      calls++;
      return { status: 429, headers: { 'Retry-After': '10' }, body: { type: 'error', code: 'RATE_LIMITED', message: 'read class', retryAfterMs: 10_000 } };
    };
    void h.client.start();
    const socket = await h.login();
    const afterLogin = calls; // the pull after login
    socket.drop(4003, 'suspended');
    for (let i = 0; i < 4; i++) {
      h.clock.advance(2_000);
      await settle();
    }
    expect(calls).toBe(afterLogin);
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
    await settle();
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
    (await h.connected()).drop();
    h.clock.advance(249);
    await settle();
    expect(h.ws.sockets).toHaveLength(1);
    h.clock.advance(1);
    (await h.connected()).drop();
    expect(h.ws.sockets).toHaveLength(2);
    h.clock.advance(499);
    await settle();
    expect(h.ws.sockets).toHaveLength(2);
    h.clock.advance(1);
    const third = await h.login();
    expect(h.ws.sockets).toHaveLength(3);
    third.drop();
    h.clock.advance(250);
    await settle();
    expect(h.ws.sockets).toHaveLength(4);
  });

  test('a socket factory that throws is retried like a dropped connection', async () => {
    const h = harness();
    let calls = 0;
    const session = new GatewaySession(
      {
        url: URL_, fillerId: FILLER, gatewaySigner: h.gateway.address, tokens: h.rest, seal: h.client.seal, clock: h.clock, logger: h.logger,
        webSocket: () => { calls++; throw new Error('ECONNREFUSED'); },
        random: () => 0, nextId: () => 'x', reconnect: { initialDelayMs: 500, maxDelayMs: 30_000 }, heartbeatMisses: 3, loginTimeoutMs: 15_000,
      },
      h.client,
    );
    session.start();
    for (const delayMs of [250, 500, 1_000]) {
      await settle();
      h.clock.advance(delayMs);
    }
    await settle();
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

  test('the REST login asks for a challenge by fillerId and signs FillerAuth over it', async () => {
    const h = harness();
    await h.rest.listTickets('OFFERED');
    const [challenge, auth] = h.http.requests;
    expect(challenge!.url).toBe('https://filler-gateway.example/v1/filler/auth/challenge?fillerId=acme-1');
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

  test('restOrigin maps ws to http for the local stand', async () => {
    const h = harness();
    const rest = new GatewayRest({ gatewayUrl: 'ws://localhost:3010/v1', fillerId: FILLER, gatewaySigner: h.gateway.address, quoteSigner: h.quoteSigner, seal: h.client.seal, fetch: h.http.fetch, clock: h.clock, logger: h.logger, nextId: () => 'x' });
    await expect(rest.listTickets('OFFERED')).resolves.toEqual([]);
    expect(h.http.requests[0]!.url).toBe('http://localhost:3010/v1/filler/auth/challenge?fillerId=acme-1');
  });
});

describe('createFiller().start()', () => {
  const fillSigner = (key: Hex): FillSigner => ({ ...createTestTypedDataSigner(key), signTransaction: async () => '0x02' });

  test('logs in over REST, connects over the injected factory with the token and resolves; stop() closes the session', async () => {
    const clock = new FakeClock();
    const gateway = createTestGatewaySigner(GATEWAY_KEY, clock);
    const ws = createFakeWebSocketFactory();
    const gw = createFakeGatewayLogin(gateway, { fillerId: FILLER, clock, heartbeatIntervalMs: HEARTBEAT_MS });
    const http = createFakeFetch(gw.routes);
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
      fetch: http.fetch,
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
    await settle();
    expect(ws.sockets).toHaveLength(1);
    const socket = ws.sockets[0]!;
    expect(socket.protocols).toEqual(['cancore-filler.v1', 'bearer.tok-1']);
    const response = JSON.parse(http.requests.find((r) => pathOf(r.url) === '/v1/filler/auth')!.body!) as Record<string, unknown>;
    expect(String(response.id).startsWith('replica-1:')).toBe(true);
    expect(gw.accept(socket)).toBe(true);
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
