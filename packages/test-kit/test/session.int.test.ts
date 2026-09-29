import { TEST_KEYS } from '../src/index';
import { advance, authResponse, ctl, KINDS, login, nextId, signedByGateway, startMock, Taker } from './helpers';
import type { MockHandle } from './helpers';

describe.each(KINDS)('session (%s mock)', (kind) => {
  let mock: MockHandle;
  beforeAll(async () => {
    mock = await startMock(kind);
  });
  afterAll(() => mock.close());
  beforeEach(() => ctl(mock, '/__mock/reset', {}));

  test('B2: challenge → FillerAuth → auth.ok{heartbeatIntervalMs} → epoch.weights, all signed', async () => {
    const taker = await Taker.open(mock.url);
    const challenge = await taker.next('auth.challenge');
    expect(challenge).toMatchObject({ nonce: expect.stringMatching(/^0x[0-9a-f]{64}$/), expiresAt: expect.stringMatching(/^[1-9][0-9]*$/), sentAt: expect.any(Number) });
    expect(challenge.fillerId).toBeUndefined(); // D-C: the recipient is not known yet
    taker.send(authResponse(challenge, 'acme-markets'));
    const ok = await taker.next('auth.ok');
    expect(ok).toMatchObject({ fillerId: 'acme-markets', heartbeatIntervalMs: 15_000 });
    const epoch = await taker.next('epoch.weights');
    expect(epoch).toMatchObject({ fillerId: 'acme-markets', epochId: expect.any(String), weightsRoot: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(taker.frames.slice(0, 3).map((f) => f.type)).toEqual(['auth.challenge', 'auth.ok', 'epoch.weights']);
    for (const f of taker.frames) expect(signedByGateway(f)).toBe(true);
    await taker.close();
  });

  test('B2: ping/pong both ways; three missed pongs close the socket (virtual clock)', async () => {
    const { taker } = await login(mock);
    const ping = taker.send({ type: 'ping' });
    expect(await taker.next('pong')).toMatchObject({ re: ping.id });
    await advance(mock, 15_000);
    const serverPing = await taker.next('ping');
    expect(signedByGateway(serverPing)).toBe(true);
    taker.send({ type: 'pong', re: serverPing.id });
    await advance(mock, 15_000);
    await taker.next('ping'); // answered the previous one: still open
    await advance(mock, 45_000); // three pings unanswered
    expect(await taker.closed).toBeGreaterThan(0);
  });

  test('B8: a quote before auth.ok is UNAUTHENTICATED and closes the socket', async () => {
    const taker = await Taker.open(mock.url);
    await taker.next('auth.challenge');
    const quote = taker.send({ type: 'quote', requestId: 'req-1', filler: TEST_KEYS.acmeFiller.address, amountOut: '1', validUntil: '1', nonce: '1', sig: '0x00' });
    const error = await taker.next('error');
    expect(error).toMatchObject({ code: 'UNAUTHENTICATED', re: quote.id });
    expect(signedByGateway(error)).toBe(true);
    await taker.closed;
    expect(taker.frames.map((f) => f.type)).toEqual(['auth.challenge', 'error']);
  });

  test('B5: mode UNSUPPORTED_VERSION answers error UNSUPPORTED_VERSION and closes', async () => {
    await ctl(mock, '/__mock/scenario', { mode: 'UNSUPPORTED_VERSION' });
    const taker = await Taker.open(mock.url);
    const sent = taker.send(authResponse(await taker.next('auth.challenge'), 'acme-markets'));
    expect(await taker.next('error')).toMatchObject({ code: 'UNSUPPORTED_VERSION', re: sent.id });
    await taker.closed;
  });

  test('B5: protocolVersion "2" is UNSUPPORTED_VERSION in HAPPY mode too', async () => {
    const taker = await Taker.open(mock.url);
    taker.send(authResponse(await taker.next('auth.challenge'), 'acme-markets', { protocolVersion: '2' }));
    expect(await taker.next('error')).toMatchObject({ code: 'UNSUPPORTED_VERSION' });
    await taker.closed;
  });

  test('a FillerAuth signed by the wrong key is BAD_SIGNATURE; an unknown filler UNAUTHENTICATED', async () => {
    const a = await Taker.open(mock.url);
    const challenge = await a.next('auth.challenge');
    a.send({ ...authResponse(challenge, 'acme-markets'), sig: authResponse(challenge, 'zeta-liquidity').sig });
    expect(await a.next('error')).toMatchObject({ code: 'BAD_SIGNATURE' });
    await a.closed;
    const b = await Taker.open(mock.url);
    b.send({ ...authResponse(await b.next('auth.challenge'), 'acme-markets'), fillerId: 'nobody' });
    expect(await b.next('error')).toMatchObject({ code: 'UNAUTHENTICATED' });
    await b.closed;
  });

  test('a challenge answered after expiresAt is UNAUTHENTICATED', async () => {
    const taker = await Taker.open(mock.url);
    const challenge = await taker.next('auth.challenge');
    await advance(mock, 61_000);
    taker.send(authResponse(challenge, 'acme-markets'));
    expect(await taker.next('error')).toMatchObject({ code: 'UNAUTHENTICATED' });
    await taker.closed;
  });

  test('after auth: malformed JSON and a schema violation are BAD_REQUEST naming the field; an unknown type UNSUPPORTED_TYPE', async () => {
    const { taker } = await login(mock);
    taker.ws.send('{not json');
    expect(await taker.next('error')).toMatchObject({ code: 'BAD_REQUEST', fillerId: 'acme-markets' });
    taker.send({ type: 'ticket.intent', orderHash: '0x12', attempt: 'zero', validFrom: '1', validUntil: '2', sig: '0x00' });
    const bad = await taker.next('error');
    expect(bad).toMatchObject({ code: 'BAD_REQUEST' });
    expect(String(bad.message)).toMatch(/orderHash|attempt/);
    const unknown = taker.send({ type: 'future.thing', id: nextId() });
    expect(await taker.next('error')).toMatchObject({ code: 'UNSUPPORTED_TYPE', re: unknown.id });
    await taker.close();
  });
});
