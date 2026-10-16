import { createConnection, type Socket } from 'net';
import { start } from '../../src/daemon';
import { ERROR, parseRequest } from '../../src/protocol/index';
import { raw, rig, type Rig } from './rig';

/** The agent socket as an attacker with a shell sees it: raw bytes, no client library. */
describe('security: agent socket', () => {
  let r: Rig;
  let stop: () => Promise<void>;
  beforeEach(async () => {
    r = await rig();
    stop = await start(r.config, r.deps);
  });
  afterEach(async () => {
    await stop();
    r.cleanup();
  });

  const one = async (msg: unknown) => {
    const { lines } = await raw(r.config.agentSocket, [`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`]);
    return JSON.parse(lines[0]!) as { id: unknown; result?: unknown; error?: { code: number; message: string } };
  };
  const call = (method: string, params?: unknown, id: unknown = 1) => one({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) });

  it.each([
    ['unlock', { passphrase: 'right' }],
    ['lock', {}],
    ['resume', {}],
    ['limits.set', { limits: { maxOpenOrders: 1000 } }],
    ['withdraw', { to: 'owner::1220aa', instrument: 'CC', amount: '1' }],
  ])('owner method %s is FORBIDDEN and audited', async (method, params) => {
    expect((await call(method, params)).error).toMatchObject({ code: ERROR.FORBIDDEN });
    expect(r.audit()).toContainEqual(expect.objectContaining({ method, decision: 'deny', reason: 'forbidden' }));
    expect(r.engine.made).toEqual([]);
  });

  it('never audits the passphrase of a forbidden unlock', async () => {
    await call('unlock', { passphrase: 'hunter2-secret' });
    expect(JSON.stringify(r.audit())).not.toContain('hunter2');
  });

  it.each(['Unlock', 'UNLOCK', 'unlock ', ' unlock', 'unlock\u0000', 'ｕnlock', 'un​lock', 'limits.Set', 'limits_set', 'limits/set', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype', 'transfer', 'send', 'export', ''])(
    'method name %j is not found',
    async (method) => expect((await call(method, {})).error).toMatchObject({ code: ERROR.METHOD_NOT_FOUND }),
  );

  it('rejects extra params, prototype keys and non-object params', async () => {
    for (const params of [{ x: 1 }, JSON.parse('{"__proto__":{"owner":true}}'), { constructor: 1 }, [], 'x', 1]) {
      expect((await call('status', params)).error?.code).toBe(ERROR.INVALID_PARAMS);
    }
    // null is "no params", as for a read it means nothing.
    expect((await call('status', null)).result).toBeDefined();
    expect((await call('order.make', { base: 'CC', quote: 'USDCx', side: 'buy', amount: '1', price: '0.15', owner: true })).error).toMatchObject({ code: ERROR.INVALID_PARAMS });
  });

  it('rejects batches, notifications and broken envelopes', async () => {
    expect((await one([{ jsonrpc: '2.0', id: 1, method: 'status' }, { jsonrpc: '2.0', id: 2, method: 'unlock', params: { passphrase: 'x' } }])).error).toMatchObject({ code: ERROR.INVALID_REQUEST });
    expect((await one({ jsonrpc: '2.0', method: 'status' })).error).toMatchObject({ code: ERROR.INVALID_REQUEST });
    expect((await one({ jsonrpc: '1.0', id: 1, method: 'status' })).error).toMatchObject({ code: ERROR.INVALID_REQUEST });
    expect((await one({ jsonrpc: '2.0', id: { x: 1 }, method: 'status' })).error).toMatchObject({ code: ERROR.INVALID_REQUEST });
    expect((await one({ jsonrpc: '2.0', id: 1, method: 'status', owner: true })).error).toMatchObject({ code: ERROR.INVALID_REQUEST });
    expect((await one('{"jsonrpc":"2.0",')).error).toMatchObject({ code: ERROR.PARSE_ERROR });
  });

  it('closes on an oversized message and keeps serving others', async () => {
    const { lines, closed } = await raw(r.config.agentSocket, [`{"jsonrpc":"2.0","id":1,"method":"status","params":{"p":"${'x'.repeat(70_000)}"}}\n`], 2);
    expect(JSON.parse(lines[0]!).error.message).toBe('message too large');
    expect(closed).toBe(true);
    // No newline at all: the buffer cap still applies.
    const noNewline = await raw(r.config.agentSocket, ['{'.repeat(70_000)], 2);
    expect(noNewline.closed).toBe(true);
    expect(JSON.parse(noNewline.lines[0]!).error.message).toBe('message too large');
    expect((await call('status')).result).toMatchObject({ paused: false });
  });

  it('refuses deeply nested params, and still audits the attempt', async () => {
    const deep = (n: number) => `${'{"a":'.repeat(n)}1${'}'.repeat(n)}`;
    expect(parseRequest({ jsonrpc: '2.0', id: 1, method: 'strategy.start', params: JSON.parse(`{"kind":"grid","base":"CC","quote":"USDCx","config":${deep(100)}}`) })).toMatchObject({ ok: false, error: { code: ERROR.INVALID_PARAMS } });
    const res = await one(`{"jsonrpc":"2.0","id":1,"method":"limits.set","params":{"limits":${deep(10_000)}}}`);
    expect(res.error?.code).toBe(ERROR.INVALID_PARAMS);
    // The daemon is still up and the chain intact.
    expect((await call('status')).result).toBeDefined();
    expect(await r.deps.audit.verify()).toMatchObject({ ok: true });
  });

  it('reassembles a request split byte by byte (partial frames)', async () => {
    const msg = `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'status' })}\n`;
    const { lines } = await raw(r.config.agentSocket, [...msg].map((c) => Buffer.from(c)));
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 7, result: { paused: false } });
  });

  it('a slowloris peer holding a half frame does not block other clients or the owner', async () => {
    const slow = createConnection(r.config.agentSocket);
    await new Promise((res) => slow.once('connect', res));
    slow.write('{"jsonrpc":"2.0","id":1,"method":"st');
    try {
      expect((await call('status')).result).toBeDefined();
      const { lines } = await raw(r.config.ownerSocket, [`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status' })}\n`]);
      expect(JSON.parse(lines[0]!).result).toBeDefined();
    } finally {
      slow.destroy();
    }
  });

  it('caps concurrent agent connections; the owner socket still answers', async () => {
    const held: Socket[] = [];
    try {
      for (let i = 0; i < 100; i++) {
        const s = createConnection(r.config.agentSocket);
        s.on('error', () => undefined);
        held.push(s);
      }
      await Promise.all(held.map((s) => new Promise((res) => (s.connecting ? s.once('connect', res).once('close', res) : res(null)))));
      await new Promise((res) => setTimeout(res, 100));
      expect(held.filter((s) => !s.destroyed && s.readyState === 'open').length).toBeLessThanOrEqual(32);
      const { lines } = await raw(r.config.ownerSocket, [`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status' })}\n`]);
      expect(JSON.parse(lines[0]!).result).toBeDefined();
    } finally {
      for (const s of held) s.destroy();
    }
  });

  it('answers pipelined requests on one connection each by its own id', async () => {
    const msgs = Array.from({ length: 50 }, (_, i) => `${JSON.stringify({ jsonrpc: '2.0', id: `r${i}`, method: i % 2 ? 'status' : 'resume' })}\n`).join('');
    const { lines } = await raw(r.config.agentSocket, [msgs], 50);
    const byId = new Map(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
    for (let i = 0; i < 50; i++) expect(byId.get(`r${i}`)[i % 2 ? 'result' : 'error']).toBeDefined();
  });
});
