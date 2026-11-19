import { CancoreProvider } from './provider';
import {
  RpcCode,
  type MessageEventLike,
  type PrepareExecuteResult,
  type ProviderRpcError,
  type RequestInitLike,
  type StreamLike,
} from './types';

const SESSION = {
  token: 'cs_grant',
  rpcUrl: 'https://api-dev.cancore.app/dapp/rpc',
  scopes: ['wallet:connect'],
  expiresAt: '2026-09-01T00:00:00.000Z',
};

interface Answer {
  ok?: boolean;
  status?: number;
  body?: unknown;
}

function transport(answers: Answer[] | (() => Answer)) {
  const calls: Array<{ url: string; init: RequestInitLike }> = [];
  const queue = Array.isArray(answers) ? [...answers] : null;
  const fetchImpl = jest.fn(async (url: string, init: RequestInitLike) => {
    calls.push({ url, init });
    const answer = queue ? (queue.shift() ?? { body: { result: null } }) : (answers as () => Answer)();
    return {
      ok: answer.ok ?? true,
      status: answer.status ?? 200,
      json: async () => answer.body,
    };
  });
  return { fetchImpl, calls };
}

function fakeStream() {
  const handlers = new Map<string, (event: { data: string }) => void>();
  const stream: StreamLike & { fire(type: string, data: string): void; closed: boolean } = {
    closed: false,
    addEventListener: (type, listener) => handlers.set(type, listener),
    close: () => {
      stream.closed = true;
    },
    fire: (type, data) => handlers.get(type)?.({ data }),
  };
  return stream;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Retries the provider asked for, with their delays, run by hand. */
function retries() {
  const scheduled: Array<{ run: () => void; ms: number }> = [];
  return { scheduled, schedule: (run: () => void, ms: number) => void scheduled.push({ run, ms }) };
}

async function failure(run: Promise<unknown>): Promise<ProviderRpcError> {
  try {
    await run;
  } catch (err) {
    return err as ProviderRpcError;
  }
  throw new Error('expected the call to fail');
}

describe('CancoreProvider — the request surface', () => {
  it('sends the grant as a bearer and unwraps the result', async () => {
    const { fetchImpl, calls } = transport([{ body: { result: { networkId: 'canton:da-devnet' } } }]);
    const provider = new CancoreProvider({ host: 'https://app-dev.cancore.app', session: SESSION, fetchImpl });

    await expect(provider.request({ method: 'getActiveNetwork' })).resolves.toEqual({
      networkId: 'canton:da-devnet',
    });
    expect(calls[0]!.url).toBe(SESSION.rpcUrl);
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer cs_grant');
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({ jsonrpc: '2.0', method: 'getActiveNetwork' });
  });

  // The reason this package exists: upstream's HttpTransport throws the whole
  // envelope, so `err.code` is undefined and every standard error handler misses.
  it('raises the wallet error code at the top of the thrown object', async () => {
    const { fetchImpl } = transport([
      { ok: false, status: 501, body: { jsonrpc: '2.0', id: 1, error: { code: 4200, message: 'nope', data: { m: 1 } } } },
    ]);
    const provider = new CancoreProvider({ host: 'https://app-dev.cancore.app', session: SESSION, fetchImpl });

    const err = await failure(provider.request({ method: 'ledgerApi' }));
    expect(err).toEqual({ code: 4200, message: 'nope', data: { m: 1 } });
  });

  it('answers an unknown method itself, with the code the spec names', async () => {
    const { fetchImpl, calls } = transport([]);
    const provider = new CancoreProvider({ host: 'https://app-dev.cancore.app', session: SESSION, fetchImpl });

    const err = await failure(provider.request({ method: 'canton_prepareSignExecute' }));
    expect(err.code).toBe(RpcCode.METHOD_NOT_FOUND);
    expect(calls).toHaveLength(0);
  });

  it('reports an unreachable wallet as disconnected, not as a crash', async () => {
    const fetchImpl = jest.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const provider = new CancoreProvider({ host: 'https://app-dev.cancore.app', session: SESSION, fetchImpl });

    const err = await failure(provider.request({ method: 'status' }));
    expect(err.code).toBe(RpcCode.DISCONNECTED);
  });

  it('refuses to call anything before there is a grant', async () => {
    const provider = new CancoreProvider({ host: 'https://app-dev.cancore.app' });

    const err = await failure(provider.request({ method: 'status' }));
    expect(err.code).toBe(RpcCode.DISCONNECTED);
  });

  it('does not report an HTTP failure carrying no RPC error as success', async () => {
    const { fetchImpl } = transport([{ ok: false, status: 502, body: '<html>gateway</html>' }]);
    const provider = new CancoreProvider({ host: 'https://app-dev.cancore.app', session: SESSION, fetchImpl });

    const err = await failure(provider.request({ method: 'status' }));
    expect(err.code).toBe(RpcCode.INTERNAL);
  });

  it('needs a window to run the consent ceremony', async () => {
    const provider = new CancoreProvider({ host: 'https://app-dev.cancore.app' });

    const err = await failure(provider.request({ method: 'connect' }));
    expect(err.code).toBe(RpcCode.DISCONNECTED);
  });
});

// Everything above injects its seams. The defaults are what actually runs in a
// dApp, so they get their own pass over the same paths.
describe('CancoreProvider — what it reaches for when nothing is injected', () => {
  const globals = globalThis as {
    fetch?: unknown;
    window?: unknown;
    EventSource?: unknown;
  };
  const original = { fetch: globals.fetch, window: globals.window, EventSource: globals.EventSource };

  afterEach(() => {
    globals.fetch = original.fetch;
    globals.window = original.window;
    globals.EventSource = original.EventSource;
  });

  it('uses the platform fetch', async () => {
    globals.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: 'ok' }) }));
    const provider = new CancoreProvider({ host: 'https://app-dev.cancore.app', session: SESSION });

    await expect(provider.request({ method: 'status' })).resolves.toBe('ok');
    expect(globals.fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the platform EventSource, and says so plainly when there is none', async () => {
    const opened: string[] = [];
    globals.EventSource = class {
      constructor(url: string) {
        opened.push(url);
      }
      addEventListener() {}
      close() {}
    };
    const { fetchImpl } = transport([{ body: { result: { ticket: 't 1' } } }, { body: { result: {} } }]);
    await new CancoreProvider({ host: 'https://app-dev.cancore.app', session: SESSION, fetchImpl }).request({
      method: 'connect',
    });
    expect(opened).toEqual([`${SESSION.rpcUrl}/events?token=t%201`]);

    delete globals.EventSource;
    const { fetchImpl: second } = transport(() => ({ body: { result: { ticket: 't' } } }));
    const err = await failure(
      new CancoreProvider({ host: 'https://app-dev.cancore.app', session: SESSION, fetchImpl: second }).request({
        method: 'connect',
      }),
    );
    expect(err.code).toBe(RpcCode.INTERNAL);
  });

  it('runs the ceremony against the page it is loaded in', async () => {
    globals.window = { open: () => null, addEventListener: () => {}, removeEventListener: () => {} };
    const provider = new CancoreProvider({ host: 'https://app-dev.cancore.app' });

    // The window is there; the popup is what the browser blocked.
    const err = await failure(provider.request({ method: 'connect' }));
    expect(err.message).toMatch(/blocked/);
  });

  it('schedules its own retry when the stream drops', async () => {
    const stream = fakeStream();
    const { fetchImpl, calls } = transport(() => ({ body: { result: { ticket: 't' } } }));
    const provider = new CancoreProvider({
      host: 'https://app-dev.cancore.app',
      session: SESSION,
      fetchImpl,
      openStream: () => (streamsHandedOut.push(stream), stream),
    });
    const streamsHandedOut: unknown[] = [];

    await provider.request({ method: 'connect' });
    const before = calls.length;
    stream.fire('error', '');
    await new Promise((resolve) => setTimeout(resolve, 3100));

    expect(calls.length).toBeGreaterThan(before);
    provider.close();
  }, 10000);
});

describe('CancoreProvider — events', () => {
  it('chains on/removeListener and reports whether anyone heard', () => {
    const provider = new CancoreProvider({ host: 'https://app-dev.cancore.app' });
    const heard: unknown[] = [];
    const listener = (...args: unknown[]) => heard.push(args[0]);

    expect(provider.on('statusChanged', listener)).toBe(provider);
    expect(provider.emit('statusChanged', { a: 1 })).toBe(true);
    expect(provider.removeListener('statusChanged', listener)).toBe(provider);
    expect(provider.emit('statusChanged', { a: 2 })).toBe(false);
    expect(provider.emit('nobodyListens')).toBe(false);
    expect(heard).toEqual([{ a: 1 }]);
  });

  it('opens the stream on a one-shot ticket before connect answers', async () => {
    const stream = fakeStream();
    const { fetchImpl, calls } = transport([
      { body: { result: { ticket: 'st_one shot', expiresInSeconds: 30 } } },
      { body: { result: { isConnected: true } } },
    ]);
    const provider = new CancoreProvider({
      host: 'https://app-dev.cancore.app',
      session: SESSION,
      fetchImpl,
      openStream: () => stream,
    });
    const seen: unknown[] = [];
    provider.on('txChanged', (frame) => seen.push(frame));

    await provider.request({ method: 'connect' });

    expect(JSON.parse(calls[0]!.init.body).method).toBe('cancore_streamTicket');
    expect(JSON.parse(calls[1]!.init.body).method).toBe('connect');
    stream.fire('txChanged', '{"status":"pending","commandId":"c-1"}');
    expect(seen).toEqual([{ status: 'pending', commandId: 'c-1' }]);
  });

  it('hands over a frame that is not JSON instead of dropping it', async () => {
    const stream = fakeStream();
    const { fetchImpl } = transport([{ body: { result: { ticket: 't' } } }, { body: { result: {} } }]);
    const provider = new CancoreProvider({
      host: 'https://app-dev.cancore.app',
      session: SESSION,
      fetchImpl,
      openStream: () => stream,
    });
    const seen: unknown[] = [];
    provider.on('statusChanged', (frame) => seen.push(frame));

    await provider.request({ method: 'connect' });
    stream.fire('statusChanged', 'not json');

    expect(seen).toEqual(['not json']);
  });

  // The browser's own reconnect replays the spent ticket, so it can only fail.
  it('re-opens a dropped stream with a fresh ticket', async () => {
    const first = fakeStream();
    const second = fakeStream();
    const streams = [first, second];
    const { fetchImpl, calls } = transport(() => ({ body: { result: { ticket: 't', isConnected: true } } }));
    const scheduled: Array<() => void> = [];
    const provider = new CancoreProvider({
      host: 'https://app-dev.cancore.app',
      session: SESSION,
      fetchImpl,
      openStream: () => streams.shift()!,
      schedule: (run) => scheduled.push(run),
    });

    await provider.request({ method: 'connect' });
    first.fire('error', '');
    expect(first.closed).toBe(true);

    const before = calls.length;
    scheduled[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBeGreaterThan(before);
    expect(streams).toHaveLength(0);
  });

  it('stops re-opening once closed', async () => {
    const stream = fakeStream();
    const { fetchImpl } = transport(() => ({ body: { result: { ticket: 't' } } }));
    const scheduled: Array<() => void> = [];
    const provider = new CancoreProvider({
      host: 'https://app-dev.cancore.app',
      session: SESSION,
      fetchImpl,
      openStream: () => stream,
      schedule: (run) => scheduled.push(run),
    });

    await provider.request({ method: 'connect' });
    provider.close();
    stream.fire('error', '');

    expect(scheduled).toHaveLength(0);
    expect(stream.closed).toBe(true);
  });

  // BUG-1633: one failed ticket fetch used to end the stream for good.
  it('keeps re-opening a dropped stream, backing off to a cap, while the wallet cannot be reached', async () => {
    let reachable = true;
    const { fetchImpl } = transport(() => {
      if (!reachable) throw new TypeError('Failed to fetch');
      return { body: { result: { ticket: 't' } } };
    });
    const first = fakeStream();
    const streams = [first, fakeStream()];
    const { scheduled, schedule } = retries();
    const provider = new CancoreProvider({
      host: 'https://app-dev.cancore.app',
      session: SESSION,
      fetchImpl,
      openStream: () => streams.shift()!,
      schedule,
    });

    await provider.request({ method: 'connect' });
    reachable = false;
    first.fire('error', '');
    for (let attempt = 0; attempt < 6; attempt++) {
      scheduled[attempt]!.run();
      await flush();
    }
    expect(scheduled.map((retry) => retry.ms)).toEqual([3000, 6000, 12000, 24000, 30000, 30000, 30000]);

    reachable = true;
    scheduled[6]!.run();
    await flush();
    expect(streams).toHaveLength(0);
  });

  it('asks again when the wallet hands back no ticket', async () => {
    const first = fakeStream();
    const streams = [first, fakeStream()];
    const { fetchImpl } = transport([
      { body: { result: { ticket: 't' } } },
      { body: { result: null } },
      { body: { result: {} } },
      { body: { result: { ticket: 't' } } },
    ]);
    const { scheduled, schedule } = retries();
    const provider = new CancoreProvider({
      host: 'https://app-dev.cancore.app',
      session: SESSION,
      fetchImpl,
      openStream: () => streams.shift()!,
      schedule,
    });

    await provider.request({ method: 'connect' });
    first.fire('error', '');
    scheduled[0]!.run();
    await flush();
    expect(scheduled).toHaveLength(2);
    scheduled[1]!.run();
    await flush();
    expect(streams).toHaveLength(0);
  });

  it('starts the backoff over once a stream is up again', async () => {
    const first = fakeStream();
    const second = fakeStream();
    const streams = [first, second];
    const { fetchImpl } = transport(() => ({ body: { result: { ticket: 't' } } }));
    const { scheduled, schedule } = retries();
    const provider = new CancoreProvider({
      host: 'https://app-dev.cancore.app',
      session: SESSION,
      fetchImpl,
      openStream: () => streams.shift()!,
      schedule,
    });

    await provider.request({ method: 'connect' });
    first.fire('error', '');
    scheduled[0]!.run();
    await flush();
    second.fire('open', '');
    second.fire('error', '');

    expect(scheduled.map((retry) => retry.ms)).toEqual([3000, 3000]);
  });

  it('drops a revoked grant instead of retrying the stream on it', async () => {
    const first = fakeStream();
    const { fetchImpl, calls } = transport([
      { body: { result: { ticket: 't' } } },
      { body: { result: null } },
      { ok: false, status: 401, body: { error: { code: RpcCode.UNAUTHORIZED, message: 'grant revoked' } } },
    ]);
    const { scheduled, schedule } = retries();
    const provider = new CancoreProvider({
      host: 'https://app-dev.cancore.app',
      session: SESSION,
      fetchImpl,
      openStream: () => first,
      schedule,
    });

    await provider.request({ method: 'connect' });
    first.fire('error', '');
    scheduled[0]!.run();
    await flush();

    expect(scheduled).toHaveLength(1);
    const err = await failure(provider.request({ method: 'status' }));
    expect(err.code).toBe(RpcCode.DISCONNECTED);
    expect(calls).toHaveLength(3);
  });

  it('opens no stream when closed while the ticket is in flight', async () => {
    let release!: () => void;
    const ticketHeld = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = jest.fn(async (_url: string, init: RequestInitLike) => {
      if (JSON.parse(init.body).method === 'cancore_streamTicket') await ticketHeld;
      return { ok: true, status: 200, json: async () => ({ result: { ticket: 't' } }) };
    });
    const opened: unknown[] = [];
    const provider = new CancoreProvider({
      host: 'https://app-dev.cancore.app',
      session: SESSION,
      fetchImpl,
      openStream: () => (opened.push(1), fakeStream()),
    });

    const connecting = provider.request({ method: 'connect' });
    await flush();
    provider.close();
    release();
    await connecting;

    expect(opened).toHaveLength(0);
  });

  it('answers 4900, not a crash, when disconnect lands while the ticket is in flight', async () => {
    let release!: () => void;
    const ticketHeld = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = jest.fn(async (_url: string, init: RequestInitLike) => {
      if (JSON.parse(init.body).method === 'cancore_streamTicket') await ticketHeld;
      return { ok: true, status: 200, json: async () => ({ result: { ticket: 't' } }) };
    });
    const opened: unknown[] = [];
    const provider = new CancoreProvider({
      host: 'https://app-dev.cancore.app',
      session: SESSION,
      fetchImpl,
      openStream: () => (opened.push(1), fakeStream()),
    });

    const connecting = failure(provider.request({ method: 'connect' }));
    await flush();
    await provider.request({ method: 'disconnect' });
    release();

    expect((await connecting).code).toBe(RpcCode.DISCONNECTED);
    expect(opened).toHaveLength(0);
  });

  // The wallet revokes the grant on `disconnect`; reusing it skipped the next
  // ceremony and answered 4100 to every `connect` after.
  it('forgets the grant on disconnect, so the next connect asks the user and streams on the new one', async () => {
    const first = fakeStream();
    const streams = [first, fakeStream()];
    const { fetchImpl, calls } = transport(() => ({ body: { result: { ticket: 't' } } }));
    const popup = { closed: false, postMessage: () => {}, close: () => {} };
    const win = {
      open: jest.fn(() => popup),
      addEventListener: (_type: 'message', deliver: (event: MessageEventLike) => void) =>
        queueMicrotask(() =>
          deliver({
            origin: 'https://app-dev.cancore.app',
            source: popup,
            data: { type: 'cancore:connect-result', ...SESSION, token: 'cs_fresh' },
          }),
        ),
      removeEventListener: () => {},
    };
    const provider = new CancoreProvider({
      host: 'https://app-dev.cancore.app',
      session: SESSION,
      fetchImpl,
      openStream: () => streams.shift()!,
      schedule: () => {},
      win,
    });

    await provider.request({ method: 'connect' });
    await provider.request({ method: 'disconnect' });
    expect(first.closed).toBe(true);

    await provider.request({ method: 'connect' });
    expect(win.open).toHaveBeenCalledTimes(1);
    expect(streams).toHaveLength(0);
    expect(calls[calls.length - 1]!.init.headers.Authorization).toBe('Bearer cs_fresh');
  });
  // CAN-744, checked against the kernel's OpenRPC: a method the spec names and
  // this provider declines must be REFUSED BY THE WALLET, with 4200. Answering
  // -32601 here would tell a dApp author the name is wrong, when the name is
  // right and the provider is simply not obliged.
  it('TC-SDK-3340-12: hands a prepared transaction and its hash through to the caller untouched', async () => {
    const answer: PrepareExecuteResult = {
      commandId: 'cmd-1',
      userUrl: 'https://app-dev.cancore.app/sign/cmd-1',
      preparedTransaction: 'CgMyLjESBTAuMC4x',
      preparedTransactionHash: 'q83vEjRWeJA=',
    };
    const { fetchImpl, calls } = transport([{ body: { result: answer } }]);
    const provider = new CancoreProvider({ host: 'https://app-dev.cancore.app', session: SESSION, fetchImpl });
    const params = { commands: [{ ExerciseCommand: { choice: 'IntentFactory_Open' } }] };

    await expect(provider.request({ method: 'prepareExecute', params })).resolves.toEqual(answer);
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({ method: 'prepareExecute', params });
  });

  it('lets the wallet refuse the methods it declines, rather than refusing them here', async () => {
    const { fetchImpl, calls } = transport([
      { body: { error: { code: 4200, message: 'Method prepareExecuteAndWait is not supported by this provider' } } },
    ]);
    const provider = new CancoreProvider({
      host: 'https://app-dev.cancore.app',
      session: SESSION,
      fetchImpl,
    });

    const error = (await provider
      .request({ method: 'prepareExecuteAndWait', params: {} })
      .catch((e: ProviderRpcError) => e)) as ProviderRpcError;

    expect(calls).toHaveLength(1);
    expect(error.code).toBe(RpcCode.UNSUPPORTED_METHOD);
  });

  it('still refuses a name the spec does not have, without a round trip', async () => {
    const { fetchImpl, calls } = transport([]);
    const provider = new CancoreProvider({
      host: 'https://app-dev.cancore.app',
      session: SESSION,
      fetchImpl,
    });

    const error = (await provider
      .request({ method: 'canton_doTheThing' })
      .catch((e: ProviderRpcError) => e)) as ProviderRpcError;

    expect(calls).toHaveLength(0);
    expect(error.code).toBe(RpcCode.METHOD_NOT_FOUND);
  });
});
