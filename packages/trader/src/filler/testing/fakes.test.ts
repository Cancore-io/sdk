import { createFakeWebSocketFactory, createRecordingEventSink, createRecordingLogger, FakeClock, FakeEvmRpc } from './fakes';

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
    const socket = factory('wss://filler-gateway.example/v1', {
      onOpen: () => seen.push('open'),
      onMessage: (text) => seen.push(`msg:${text}`),
      onClose: (code) => seen.push(`close:${code}`),
      onError: () => seen.push('error'),
    });
    expect(sockets).toHaveLength(1);
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
