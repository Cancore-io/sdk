import { EventEmitter } from 'events';
import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
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
  jest.restoreAllMocks();
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

/** Leaves a socket file at `path` whose listener is gone, as a crashed daemon does. */
async function staleSocket(path: string): Promise<void> {
  const previousPath = `${path}.previous`;
  const previous = await listen(previousPath, jest.fn());
  try {
    renameSync(previousPath, path);
  } finally {
    await previous.close();
  }
}

/** Replaces the next stale-socket probe with one that runs `act` instead of connecting. */
function fakeProbe(act: (probe: EventEmitter) => void): void {
  const net = jest.requireActual<typeof import('net')>('net');
  jest.spyOn(net, 'createConnection').mockImplementationOnce(() => {
    let timer: NodeJS.Timeout | undefined;
    const probe = Object.assign(new EventEmitter(), {
      destroy: () => clearTimeout(timer),
      setTimeout: (ms: number, onTimeout: () => void) => (timer = setTimeout(onTimeout, ms)),
    });
    setImmediate(() => act(probe));
    return probe as never;
  });
}

const probeError = (code: string) => Object.assign(new Error(code), { code });
/** A listen that should have been refused still gets closed by afterEach, so the run cannot hang on it. */
const keepServer = (bound: IpcServer) => (server = bound);

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

  it('BUG-1623 releases the bound socket if its group cannot be configured', async () => {
    const path = join(dir, 's.sock');
    await expect(listen(path, jest.fn(), { group: 'missing-bug-1623-test-group' })).rejects.toThrow();
    expect(() => statSync(path)).toThrow(/ENOENT/);
  });
  it('BUG-1623 replaces a stale socket and applies the requested mode', async () => {
    const path = join(dir, 's.sock');
    const previousPath = join(dir, 'previous.sock');
    const previous = await listen(previousPath, jest.fn());
    try {
      renameSync(previousPath, path);
    } finally {
      await previous.close();
    }
    server = await listen(path, async () => ({ jsonrpc: JSONRPC_VERSION, id: 1, result: status as never }), { mode: 0o660 });
    expect(statSync(path).mode & 0o777).toBe(0o660);
    expect(statSync(path).isSocket()).toBe(true);
  });

  it('BUG-1623 refuses a symlink to a stale socket and keeps both', async () => {
    const path = join(dir, 's.sock');
    const target = join(dir, 'target.sock');
    await staleSocket(target);
    symlinkSync(target, path);
    await expect(listen(path, jest.fn()).then(keepServer)).rejects.toThrow(/not a socket/);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(lstatSync(target).isSocket()).toBe(true);
  });

  it('BUG-1623 treats a probe that never answers as a live socket', async () => {
    const path = join(dir, 's.sock');
    await staleSocket(path);
    fakeProbe(() => undefined);
    await expect(listen(path, jest.fn()).then(keepServer)).rejects.toThrow(/already in use/);
    expect(lstatSync(path).isSocket()).toBe(true);
  }, 2_000);

  it('BUG-1623 binds when the stale socket disappears during the probe', async () => {
    const path = join(dir, 's.sock');
    await staleSocket(path);
    fakeProbe((probe) => {
      rmSync(path);
      probe.emit('error', probeError('ENOENT'));
    });
    server = await listen(path, jest.fn());
    expect(statSync(path).isSocket()).toBe(true);
  });

  it('BUG-1623 keeps a socket whose probe fails for another reason', async () => {
    const path = join(dir, 's.sock');
    await staleSocket(path);
    fakeProbe((probe) => probe.emit('error', probeError('EACCES')));
    await expect(listen(path, jest.fn()).then(keepServer)).rejects.toMatchObject({ code: 'EACCES' });
    expect(lstatSync(path).isSocket()).toBe(true);
  });

  it.each<[string, (path: string) => void]>([
    ['a new file', (path) => {
      writeFileSync(`${path}.new`, 'replacement');
      renameSync(`${path}.new`, path);
    }],
    ['a symlink to the moved socket', (path) => {
      renameSync(path, `${path}.moved`);
      symlinkSync(`${path}.moved`, path);
    }],
  ])('BUG-1623 keeps %s that replaced the socket during the probe', async (_name, replace) => {
    const path = join(dir, 's.sock');
    await staleSocket(path);
    fakeProbe((probe) => {
      replace(path);
      probe.emit('error', probeError('ECONNREFUSED'));
    });
    await expect(listen(path, jest.fn()).then(keepServer)).rejects.toThrow(/changed while checking/);
    expect(lstatSync(path).isSocket()).toBe(false);
  });

  it.each(['dev', 'ino'] as const)('BUG-1623 refuses to remove a socket whose %s changed during the probe', async (field) => {
    const path = join(dir, 's.sock');
    await staleSocket(path);
    const fs = jest.requireActual<typeof import('fs')>('fs');
    const realLstat = fs.lstatSync;
    let calls = 0;
    jest.spyOn(fs, 'lstatSync').mockImplementation(((target: string, options?: object) => {
      const stats = realLstat(target, options as never);
      calls += 1;
      return stats && calls === 2 ? Object.assign(stats, { [field]: Number(stats[field]) + 1 }) : stats;
    }) as never);
    await expect(listen(path, jest.fn()).then(keepServer)).rejects.toThrow(/changed while checking/);
    jest.restoreAllMocks();
    expect(lstatSync(path).isSocket()).toBe(true);
  });

  it('BUG-1623 preserves a live socket and its listener', async () => {
    const path = join(dir, 's.sock');
    server = await listen(path, async (r) => ({ jsonrpc: JSONRPC_VERSION, id: r.id, result: status as never }));
    await expect(listen(path, jest.fn())).rejects.toThrow(/already in use/);
    const client = await connect(path);
    try {
      await expect(client.call('status', {})).resolves.toEqual(status);
    } finally {
      client.close();
    }
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
