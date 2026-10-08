import { createFakeFetch, createFakeGatewayLogin, createFakeWebSocketFactory, createRecordingEventSink, createRecordingLogger, createTestGatewaySigner, FakeClock, FakeEvmRpc } from './fakes';

describe('FakeClock', () => {
  test('runs due callbacks in time order inside advance, including ones scheduled meanwhile', () => {
    const clock = new FakeClock(1_000);
    const ran: Array<[string, number]> = [];
    clock.schedule(30, () => ran.push(['b', clock.now()]));
    clock.schedule(10, () => {
      ran.push(['a', clock.now()]);
      clock.schedule(5, () => ran.push(['a2', clock.now()]));
    });
    const cancel = clock.schedule(20, () => ran.push(['cancelled', clock.now()]));
    cancel();
    clock.advance(25);
    expect(ran).toEqual([['a', 1_010], ['a2', 1_015]]);
    expect(clock.now()).toBe(1_025);
    expect(clock.pending).toBe(1);
    clock.advance(5);
    expect(ran.at(-1)).toEqual(['b', 1_030]);
  });
});

describe('FakeEvmRpc', () => {
  test('answers scripted methods, records calls, rejects the rest', async () => {
    const rpc = new FakeEvmRpc('main').on('eth_chainId', '0x1').on('eth_getBalance', ([address]: readonly unknown[]) => `bal:${String(address)}`);
    await expect(rpc.request({ method: 'eth_chainId' })).resolves.toBe('0x1');
    await expect(rpc.request({ method: 'eth_getBalance', params: ['0xabc', 'latest'] })).resolves.toBe('bal:0xabc');
    await expect(rpc.request({ method: 'eth_call' })).rejects.toThrow(/no handler for eth_call/);
    rpc.fail('eth_chainId', { code: -32000, message: 'down' });
    await expect(rpc.request({ method: 'eth_chainId' })).rejects.toEqual({ code: -32000, message: 'down' });
    expect(rpc.calls.map((c) => c.method)).toEqual(['eth_chainId', 'eth_getBalance', 'eth_call', 'eth_chainId']);
  });
});

describe('fake WebSocket factory', () => {
  test('the test plays filler-gateway: open, frames both ways, close once', () => {
    const { factory, sockets } = createFakeWebSocketFactory();
    const seen: string[] = [];
    const socket = factory(
      'wss://filler-gateway.example/v1',
      {
        onOpen: () => seen.push('open'),
        onMessage: (text) => seen.push(`msg:${text}`),
        onClose: (code) => seen.push(`close:${code}`),
        onError: () => seen.push('error'),
      },
      ['cancore-filler.v1', 'bearer.tok-1'],
    );
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.protocols).toEqual(['cancore-filler.v1', 'bearer.tok-1']);
    expect(sockets[0]!.token).toBe('tok-1');
    sockets[0]!.open();
    sockets[0]!.receive({ type: 'ping', id: 'p1' });
    sockets[0]!.receive('{"type":"raw"}');
    socket.send(JSON.stringify({ type: 'pong', re: 'p1' }));
    expect(sockets[0]!.sentFrames()).toEqual([{ type: 'pong', re: 'p1' }]);
    sockets[0]!.drop();
    socket.close();
    expect(seen).toEqual(['open', 'msg:{"type":"ping","id":"p1"}', 'msg:{"type":"raw"}', 'close:1006']);
    expect(() => socket.send('x')).toThrow(/after close/);
  });
});

describe('fake filler-gateway login', () => {
  const GATEWAY_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;

  test('challenge by fillerId, a token per login; an upgrade is accepted only with cancore-filler.v1 and one live bearer token, auth.ok first', async () => {
    const clock = new FakeClock();
    const gateway = createTestGatewaySigner(GATEWAY_KEY, clock);
    const login = createFakeGatewayLogin(gateway, { fillerId: 'acme-1', clock, tokenTtlMs: 60_000, heartbeatIntervalMs: 5_000 });
    const http = createFakeFetch(login.routes);
    const challenge = await http.fetch('https://g.example/v1/filler/auth/challenge?fillerId=acme-1', { method: 'GET' });
    expect(JSON.parse(await challenge.text())).toMatchObject({ type: 'auth.challenge', fillerId: 'acme-1', sig: expect.any(String) });
    expect((await http.fetch('https://g.example/v1/filler/auth/challenge', { method: 'GET' })).status).toBe(400);
    await http.fetch('https://g.example/v1/filler/auth', { method: 'POST', body: '{}' });
    expect(login.issued()).toEqual(['tok-1']);

    const { factory, sockets } = createFakeWebSocketFactory();
    const seen: string[] = [];
    const handlers = { onOpen: () => seen.push('open'), onMessage: (t: string) => seen.push(JSON.parse(t).type), onClose: (c: number) => seen.push(`close:${c}`), onError: () => seen.push('error') };
    factory('wss://g.example/v1', handlers, ['bearer.tok-1']);
    factory('wss://g.example/v1', handlers, ['cancore-filler.v1', 'bearer.tok-9']);
    factory('wss://g.example/v1', handlers, ['cancore-filler.v1', 'bearer.tok-1']);
    expect(sockets.map((s) => login.accept(s))).toEqual([false, false, true]);
    expect(seen).toEqual(['error', 'close:1006', 'error', 'close:1006', 'open', 'auth.ok']);
    clock.advance(60_000);
    factory('wss://g.example/v1', handlers, ['cancore-filler.v1', 'bearer.tok-1']);
    expect(login.accept(sockets[3]!)).toBe(false); // expired
  });

  test('createFakeFetch serves route headers to the response', async () => {
    const http = createFakeFetch({ 'GET /x': () => ({ status: 429, body: {}, headers: { 'Retry-After': '3' } }) });
    const response = await http.fetch('https://g.example/x', { method: 'GET' });
    expect(response.headers?.get('retry-after')).toBe('3');
    expect(response.headers?.get('x-none')).toBeNull();
  });
});

describe('recording sinks', () => {
  test('keep what they get', () => {
    const logger = createRecordingLogger();
    logger.warn('w', { a: 1 });
    logger.info('i');
    expect(logger.entries).toEqual([{ level: 'warn', message: 'w', fields: { a: 1 } }, { level: 'info', message: 'i' }]);
    const sink = createRecordingEventSink();
    sink.emit({ type: 'penalty', violationId: 'v', code: 'NO_SHOW', step: 'L1' });
    expect(sink.events).toHaveLength(1);
  });
});
