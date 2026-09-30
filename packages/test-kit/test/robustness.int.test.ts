import { advance, authResponse, ctl, KINDS, login, nextId, rest, restLogin, spawnMock, startMock, Taker } from './helpers';
import type { Frame, MockHandle } from './helpers';

const ZERO_R = `0x${'00'.repeat(64)}1b`;
const HUGE_U64 = '9'.repeat(20);
const ORDER_HASH = `0x${'22'.repeat(32)}`;
const oversizedIntent = () => ({ type: 'ticket.intent', orderHash: ORDER_HASH, attempt: 0, validFrom: '1', validUntil: HUGE_U64, sig: ZERO_R });

describe.each(KINDS)('a malformed input never takes the mock down (%s)', (kind) => {
  let mock: MockHandle;
  beforeAll(async () => {
    mock = await startMock(kind);
  });
  afterAll(() => mock.close());
  beforeEach(() => ctl(mock, '/__mock/reset', {}));

  async function stillServing() {
    expect((await ctl(mock, '/__mock/health')).status).toBe(200);
    const { taker, ok } = await login(mock);
    expect(ok.type).toBe('auth.ok');
    await taker.close();
  }

  test('auth.response signed with r = 0 is error BAD_SIGNATURE; the next connection logs in', async () => {
    const taker = await Taker.open(mock.url);
    const challenge = await taker.next('auth.challenge');
    taker.send(authResponse(challenge, 'acme-markets', { sig: ZERO_R }));
    expect(await taker.next('error')).toMatchObject({ code: 'BAD_SIGNATURE' });
    expect(await taker.closed).toBe(1008);
    await stillServing();
  });

  test('ticket.intent with validUntil past uint64 is error BAD_REQUEST; the socket keeps serving', async () => {
    const { taker } = await login(mock);
    const sent = taker.send(oversizedIntent());
    expect(await taker.next('error')).toMatchObject({ code: 'BAD_REQUEST', re: sent.id });
    const ping = taker.send({ type: 'ping' });
    expect(await taker.next('pong')).toMatchObject({ re: ping.id });
    await taker.close();
    await stillServing();
  });

  test('REST: the same inputs are 422 BAD_SIGNATURE and 400 BAD_REQUEST, never 500', async () => {
    const challenge = (await rest<Frame>(mock, 'GET', '/v1/filler/auth/challenge')).body;
    const login = await rest(mock, 'POST', '/v1/filler/auth', { id: nextId(), ...authResponse(challenge, 'acme-markets', { sig: ZERO_R }) });
    expect(login).toMatchObject({ status: 422, body: { type: 'error', code: 'BAD_SIGNATURE' } });
    const token = await restLogin(mock);
    const { type: _type, ...body } = oversizedIntent();
    const intent = await rest(mock, 'POST', `/v1/filler/tickets/${ORDER_HASH}/0/intent`, body, token);
    expect(intent).toMatchObject({ status: 400, body: { type: 'error', code: 'BAD_REQUEST' } });
    await stillServing();
  });

  test('a WebSocket frame over 64 KiB closes that socket only', async () => {
    const { taker } = await login(mock);
    taker.send({ type: 'ping', pad: 'x'.repeat(65 * 1024) });
    expect(await taker.closed).toBe(1009);
    await stillServing();
  });

  test('a request body over 64 KiB is 413, REST and control alike', async () => {
    const big = { pad: 'x'.repeat(65 * 1024) };
    expect(await rest(mock, 'POST', '/v1/filler/auth', big)).toMatchObject({ status: 413, body: { type: 'error', code: 'BAD_REQUEST' } });
    expect((await ctl(mock, '/__mock/scenario', big)).status).toBe(413);
    await stillServing();
  });

  test('an unknown REST route is 404 UNKNOWN_REQUEST', async () => {
    expect(await rest(mock, 'GET', '/v1/nope')).toMatchObject({ status: 404, body: { type: 'error', code: 'UNKNOWN_REQUEST' } });
  });

  test.each([['15s'], [-1], [1.5], [true]])('POST /__mock/clock {advanceMs: %p} is 400 and the clock stays readable', async (advanceMs) => {
    const before = (await ctl<{ now: number }>(mock, '/__mock/clock')).body.now;
    expect((await ctl(mock, '/__mock/clock', { advanceMs })).status).toBe(400);
    expect((await ctl<{ now: number }>(mock, '/__mock/health')).body.now).toBe(before);
  });

  test('HAPPY: past the fixture order fill window, the offered ticket still satisfies S-1 and S-3', async () => {
    const { taker } = await login(mock);
    await advance(mock, 11 * 60_000);
    const minTtl = (await ctl<{ config: { minTicketTtlS: number } }>(mock, '/__mock/health')).body.config.minTicketTtlS;
    expect((await ctl(mock, '/__mock/offer', { fillerId: 'acme-markets' })).status).toBe(200);
    const offer = await taker.next('ticket.offer');
    const [from, until] = [Number(offer.validFrom), Number(offer.validUntil)];
    expect(until - from).toBeGreaterThanOrEqual(minTtl);
    expect(until).toBeLessThan(Number((offer.order as { fillDeadline: string }).fillDeadline));
    await taker.close();
  });
});

test('spawnMock().close() resolves when the child has already exited', async () => {
  const mock = await spawnMock();
  await mock.close();
  await expect(Promise.race([mock.close().then(() => 'closed'), new Promise((ok) => setTimeout(() => ok('hung'), 2_000))])).resolves.toBe('closed');
});
