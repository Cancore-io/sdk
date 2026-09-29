import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { DEFAULT_FILLERS, startMockGateway, TEST_KEYS } from '../src/index';
import { MODES } from '../src/scenario';
import { BIN, ctl, KINDS, login, rest, signedByGateway, spawnMock, Taker } from './helpers';
import type { Kind, MockHandle } from './helpers';

const omega = { fillerId: 'omega-desk', quoteKey: TEST_KEYS.zetaQuote.address, fillerAddress: TEST_KEYS.zetaFiller.address };

async function start(kind: Kind): Promise<MockHandle> {
  if (kind === 'cli') return spawnMock(['--filler', `${omega.fillerId}:${omega.quoteKey}:${omega.fillerAddress}`]);
  const started = Date.now();
  const gw = await startMockGateway({ port: 0, controlPort: 0, fillers: [...DEFAULT_FILLERS, omega] });
  return { url: gw.url, http: gw.httpUrl, control: gw.controlUrl, readyMs: Date.now() - started, close: () => gw.close() };
}

describe.each(KINDS)('mock-gateway entry and control interface (%s)', (kind) => {
  let mock: MockHandle;
  beforeAll(async () => {
    mock = await start(kind);
  });
  afterAll(() => mock.close());
  beforeEach(() => ctl(mock, '/__mock/reset', {}));

  test('B16: ready within 5 s, health answers, a taker connects on /v1 and gets a signed challenge', async () => {
    expect(mock.readyMs).toBeLessThan(5_000);
    expect(mock.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/v1$/);
    const health = await ctl(mock, '/__mock/health');
    expect(health).toMatchObject({ status: 200, body: { ok: true, mode: 'HAPPY', config: { acceptByMs: 3000, issueDelayMs: 3000, heartbeatMs: 15000, heartbeatMisses: 3, minTicketTtlS: 60 } } });
    const taker = await Taker.open(mock.url);
    const challenge = await taker.next('auth.challenge');
    expect(signedByGateway(challenge)).toBe(true);
    await taker.close();
  });

  test('B16: the test switches scenarios through the control interface', async () => {
    expect(await ctl(mock, '/__mock/scenario', { mode: 'LATE_ISSUED' })).toMatchObject({ status: 200, body: { mode: 'LATE_ISSUED' } });
    expect(await ctl(mock, '/__mock/scenario')).toMatchObject({ status: 200, body: { mode: 'LATE_ISSUED' } });
    await ctl(mock, '/__mock/reset', {});
    expect((await ctl(mock, '/__mock/scenario')).body).toMatchObject({ mode: 'HAPPY' });
  });

  test('B15: an unknown scenario is 400 with the allowed list, and the current scenario does not change', async () => {
    await ctl(mock, '/__mock/scenario', { mode: 'SHORT_TTL' });
    const res = await ctl<{ allowed: string[] }>(mock, '/__mock/scenario', { mode: 'NO_SUCH_MODE' });
    expect(res.status).toBe(400);
    expect(res.body.allowed).toEqual([...MODES]);
    expect((await ctl(mock, '/__mock/scenario')).body).toMatchObject({ mode: 'SHORT_TTL' });
  });

  test('B15: an unknown control path is 404, a malformed body 400', async () => {
    expect((await ctl(mock, '/__mock/nope')).status).toBe(404);
    const bad = await fetch(`${mock.control}/__mock/scenario`, { method: 'POST', body: '{not json' });
    expect(bad.status).toBe(400);
  });

  test('A6: GET /v1/gateway publishes the gateway key and the ticket signers', async () => {
    expect(await rest(mock, 'GET', '/v1/gateway')).toEqual({
      status: 200,
      body: { env: 'mock', gateway: TEST_KEYS.gateway.address, ticketSigners: [TEST_KEYS.ticketSigner.address], protocolVersion: '1' },
    });
  });

  test('--filler registers an extra taker; /__mock/keys lists the TEST keys', async () => {
    const fillers = await ctl<{ fillers: { fillerId: string; quoteKey: string; fillerAddress: string }[] }>(mock, '/__mock/fillers');
    expect(fillers.body.fillers.map((f) => f.fillerId)).toEqual(['acme-markets', 'zeta-liquidity', 'omega-desk']);
    expect(fillers.body.fillers[2]).toEqual({ fillerId: 'omega-desk', quoteKey: TEST_KEYS.zetaQuote.address, fillerAddress: TEST_KEYS.zetaFiller.address });
    const keys = await ctl<{ gateway: string; ticketSigners: string[]; testOnly: boolean }>(mock, '/__mock/keys');
    expect(keys.body).toMatchObject({ gateway: TEST_KEYS.gateway.address, ticketSigners: [TEST_KEYS.ticketSigner.address], testOnly: true });
  });

  test('a WebSocket on a path other than /v1 is refused', async () => {
    const ws = new WebSocket(mock.url.replace(/\/v1$/, '/v2'));
    const outcome = await new Promise<string>((ok) => {
      ws.once('open', () => ok('open'));
      ws.once('error', () => ok('refused'));
    });
    expect(outcome).toBe('refused');
  });

  test('drop closes the sockets of a taker; the clock reads back', async () => {
    const { taker } = await login(mock);
    expect(await ctl(mock, '/__mock/drop', { fillerId: 'acme-markets' })).toEqual({ status: 200, body: { dropped: 1 } });
    await taker.closed;
    expect((await ctl<{ now: number }>(mock, '/__mock/clock')).body.now).toBe((await ctl<{ now: number }>(mock, '/__mock/health')).body.now);
    expect((await ctl(mock, '/__mock/offer', { fillerId: 'nobody' })).status).toBe(500);
  });

  test('an unknown REST path is 404 with a signed error body', async () => {
    const res = await rest(mock, 'GET', '/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ type: 'error', code: 'BAD_REQUEST' });
  });
});

describe('CLI usage', () => {
  test('an unknown subcommand prints usage and exits 2', () => {
    const run = spawnSync(process.execPath, [BIN, 'nope'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/usage: cancore-test-kit mock-gateway/);
  });

  test('a malformed --filler exits 2', () => {
    const run = spawnSync(process.execPath, [BIN, 'mock-gateway', '--port', '0', '--control', '0', '--filler', 'x'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/--filler/);
  });
});

describe('startMockGateway (the programmatic API)', () => {
  test('rfq, drop, health, reset', async () => {
    const gw = await startMockGateway({ port: 0, controlPort: 0, clock: 'real' });
    try {
      expect(gw.health()).toMatchObject({ ok: true, mode: 'HAPPY', config: { clock: 'real' } });
      expect(Math.abs(gw.now() - Date.now())).toBeLessThan(1_000);
      const req = gw.rfq({ fillerIds: ['acme-markets'] });
      expect(req.windowCloseAt).toBeGreaterThan(Date.now());
      expect(gw.drop()).toBe(0);
      gw.scenario('NO_ISSUED');
      gw.reset();
      expect(gw.scenario()).toBe('HAPPY');
      expect(gw.log()).toEqual([]);
    } finally {
      await gw.close();
    }
  });

  test('scenario, clock, offer, log and the conformance check without HTTP', async () => {
    const gw = await startMockGateway({ port: 0, controlPort: 0 });
    try {
      expect(gw.scenario()).toBe('HAPPY');
      expect(gw.scenario('BAD_GATEWAY_SIG')).toBe('BAD_GATEWAY_SIG');
      expect(() => gw.scenario('NOPE')).toThrow(/allowed/);
      const t0 = gw.now();
      gw.advance(1_000);
      expect(gw.now()).toBe(t0 + 1_000);
      const offer = gw.offer('acme-markets');
      expect(offer).toMatchObject({ type: 'ticket.offer', fillerId: 'acme-markets', attempt: 0 });
      expect(gw.log().some((e) => e.msg.type === 'ticket.offer')).toBe(true);
      // Nobody is connected: a conforming taker that never saw the offer sent no intent.
      expect(() => gw.assertTakerReaction('BAD_GATEWAY_SIG')).not.toThrow();
    } finally {
      await gw.close();
    }
  });
});
