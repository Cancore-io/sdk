import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { createConnection, createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { ERROR, JSONRPC_VERSION, type RpcRequest, type RpcResponse } from '../protocol/index';
import { listen, RpcFault, type IpcServer } from './server';
import { connect, RpcCallError } from './client';

let dir: string;
let server: IpcServer | undefined;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'botd-ipc-'))));
afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Sends raw bytes, collects response lines until the socket closes or `count` lines arrived. */
function raw(path: string, payload: string | Buffer, count = 1): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let buf = '';
    const done = () => resolve(buf.split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    socket.on('data', (d) => {
      buf += d.toString();
      if (buf.split('\n').filter(Boolean).length >= count) (socket.end(), done());
    });
    socket.on('close', done);
    socket.write(payload);
  });
}

const status = { locked: true, paused: false, strategies: [], version: 't' };

describe('ipc server', () => {
  it('a call after the daemon closed the connection rejects at once and marks the client closed', async () => {
    const path = join(dir, 'c.sock');
    const srv = createServer((sock) => sock.destroy());
    await new Promise<void>((r) => srv.listen(path, r));
    try {
      const client = await connect(path);
      await new Promise((r) => setTimeout(r, 50));
      expect(client.closed).toBe(true);
      await expect(client.call('status', {})).rejects.toThrow(/closed/);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('round-trips a typed call through the client', async () => {
    const path = join(dir, 's.sock');
    server = await listen(path, async (r) => ({ jsonrpc: JSONRPC_VERSION, id: r.id, result: status as never }));
    const client = await connect(path);
    await expect(client.call('status', {})).resolves.toEqual(status);
    client.close();
  });

  it('applies the requested socket mode and replaces a stale socket file', async () => {
    const path = join(dir, 's.sock');
    writeFileSync(path, 'stale');
    server = await listen(path, async () => ({ jsonrpc: JSONRPC_VERSION, id: 1, result: status as never }), { mode: 0o660 });
    expect(statSync(path).mode & 0o777).toBe(0o660);
    expect(statSync(path).isSocket()).toBe(true);
  });

  it('defaults to 0600', async () => {
    const path = join(dir, 's.sock');
    server = await listen(path, async () => ({ jsonrpc: JSONRPC_VERSION, id: 1, result: status as never }));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('answers malformed JSON with PARSE_ERROR and keeps the connection', async () => {
    const path = join(dir, 's.sock');
    server = await listen(path, async (r) => ({ jsonrpc: JSONRPC_VERSION, id: r.id, result: status as never }));
    const [bad, good] = await raw(path, `{nope\n${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'status' })}\n`, 2);
    expect(bad).toMatchObject({ id: null, error: { code: ERROR.PARSE_ERROR } });
    expect(good).toMatchObject({ id: 7, result: status });
  });

  it('rejects unknown methods and bad params before the handler', async () => {
    const path = join(dir, 's.sock');
    const handler = jest.fn();
    server = await listen(path, handler);
    const res = await raw(path, `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'order.take', params: { orderId: 'x', amount: 1 } })}\n`, 2);
    expect(res.map((r) => (r.error as { code: number }).code)).toEqual([ERROR.METHOD_NOT_FOUND, ERROR.INVALID_PARAMS]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('closes the connection on an oversize message, with or without a newline', async () => {
    const path = join(dir, 's.sock');
    const handler = jest.fn();
    server = await listen(path, handler, { maxMessageBytes: 1024 });
    for (const payload of ['x'.repeat(4096), `${'x'.repeat(2048)}\n`]) {
      const res = await raw(path, payload, 99);
      expect(res).toEqual([expect.objectContaining({ error: { code: ERROR.INVALID_REQUEST, message: 'message too large' } })]);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('maps RpcFault to its code and hides other errors', async () => {
    const path = join(dir, 's.sock');
    server = await listen(path, async (r) => {
      if (r.method === 'lock') throw new RpcFault(ERROR.LOCKED, 'keystore is locked');
      throw new Error('secret internals at /var/lib/x');
    });
    const client = await connect(path);
    await expect(client.call('lock', {})).rejects.toMatchObject({ error: { code: ERROR.LOCKED, message: 'keystore is locked' } });
    const err = (await client.call('status', {}).catch((e: RpcCallError) => e)) as RpcCallError;
    expect(err.error).toEqual({ code: ERROR.INTERNAL, message: 'internal error' });
    client.close();
  });

  it('times out a slow handler', async () => {
    const path = join(dir, 's.sock');
    server = await listen(path, () => new Promise(() => undefined), { requestTimeoutMs: 50 });
    const client = await connect(path);
    await expect(client.call('status', {})).rejects.toMatchObject({ error: { code: ERROR.INTERNAL, message: 'request timed out' } });
    client.close();
  });

  it('runs at most maxInFlight requests of one connection at once; the rest wait their turn', async () => {
    const path = join(dir, 's.sock');
    let running = 0;
    let peak = 0;
    const handler = async (r: RpcRequest) => {
      peak = Math.max(peak, ++running);
      await new Promise((res) => setTimeout(res, 10));
      running--;
      return { jsonrpc: JSONRPC_VERSION, id: r.id, result: {} } as RpcResponse;
    };
    server = await listen(path, handler, { maxInFlight: 2 });
    const client = await connect(path);
    await Promise.all(Array.from({ length: 6 }, () => client.call('status', {})));
    expect(peak).toBe(2);
    client.close();
  });

  it('a garbled response fails the call instead of crashing the client', async () => {
    const path = join(dir, 'g.sock');
    const raw = createServer((s) => s.on('data', () => s.write('not json\n')));
    await new Promise<void>((r) => raw.listen(path, r));
    const client = await connect(path);
    await expect(client.call('status', {})).rejects.toThrow('malformed response');
    raw.close();
  });

  it('a trade that times out is unconfirmed, not an error to retry: its order may still be placed', async () => {
    const path = join(dir, 's.sock');
    server = await listen(path, () => new Promise(() => undefined), { requestTimeoutMs: 50 });
    const client = await connect(path);
    const make = { base: 'CC', quote: 'USDCx', side: 'buy', amount: '1', price: '0.15' } as const;
    await expect(client.call('order.make', make)).rejects.toMatchObject({ error: { code: ERROR.UNCONFIRMED, message: 'unconfirmed' } });
    client.close();
  });
});
