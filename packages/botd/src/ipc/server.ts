import { chmodSync, chownSync, readFileSync, rmSync, statSync } from 'fs';
import { createServer, type Socket } from 'net';
import { ERROR, JSONRPC_VERSION, parseRequest, RISK_CLASS, type RpcError, type RpcRequest, type RpcResponse } from '../protocol/index';

export type Handler = (request: RpcRequest) => Promise<RpcResponse>;

export interface IpcServer {
  close(): Promise<void>;
}

export interface ListenOptions {
  /** Socket file mode; default 0600. */
  mode?: number;
  /** Group name to chown the socket to (the daemon must be a member). */
  group?: string;
  /** Max bytes of one message, newline excluded; default 64 KiB. */
  maxMessageBytes?: number;
  /** Per-request handler timeout; default 30 s. */
  requestTimeoutMs?: number;
  /** Requests one connection may have running at once; more are refused. Default 8. */
  maxInFlight?: number;
  /** Concurrent connections beyond this are dropped; default unlimited. */
  maxConnections?: number;
}

/** Thrown by a handler to answer with a specific error code instead of INTERNAL. */
export class RpcFault extends Error {
  constructor(
    readonly code: RpcError['code'],
    message: string,
    readonly data?: RpcError['data'],
  ) {
    super(message);
  }
}

const reply = (socket: Socket, response: RpcResponse) => {
  if (socket.writable) socket.write(`${JSON.stringify(response)}\n`);
};
const fail = (id: RpcResponse['id'], error: RpcError): RpcResponse => ({ jsonrpc: JSONRPC_VERSION, id, error });

function gid(group: string): number {
  const line = readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.split(':')[0] === group);
  if (!line) throw new Error(`group ${group} not found`);
  return Number(line.split(':')[2]);
}

async function run(handler: Handler, request: RpcRequest, timeoutMs: number): Promise<RpcResponse> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      handler(request),
      new Promise<never>((_, reject) => {
        // A trade still running behind the timeout may yet place its order: the caller must not repeat it.
        const late = RISK_CLASS[request.method] === 'trade' ? new RpcFault(ERROR.UNCONFIRMED, 'unconfirmed') : new RpcFault(ERROR.INTERNAL, 'request timed out');
        timer = setTimeout(() => reject(late), timeoutMs);
      }),
    ]);
  } catch (err) {
    // Never leak a stack or an internal message across the socket.
    return fail(request.id, err instanceof RpcFault ? { code: err.code, message: err.message, ...(err.data && { data: err.data }) } : { code: ERROR.INTERNAL, message: 'internal error' });
  } finally {
    clearTimeout(timer);
  }
}

/** Unix socket JSON-RPC 2.0, newline-delimited. Removes a stale socket, then verifies the mode it ends up with. */
export async function listen(socketPath: string, handler: Handler, options: ListenOptions = {}): Promise<IpcServer> {
  const mode = options.mode ?? 0o600;
  const max = options.maxMessageBytes ?? 64 * 1024;
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const maxInFlight = options.maxInFlight ?? 8;
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let buffer = Buffer.alloc(0);
    // One peer cannot queue unbounded work (and audit entries) by pipelining requests.
    let inFlight = 0;
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let nl: number;
      while ((nl = buffer.indexOf(0x0a)) >= 0) {
        const line = buffer.subarray(0, nl);
        buffer = buffer.subarray(nl + 1);
        if (line.length > max) return void socket.end(`${JSON.stringify(fail(null, { code: ERROR.INVALID_REQUEST, message: 'message too large' }))}\n`);
        if (line.length === 0) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line.toString('utf8'));
        } catch {
          reply(socket, fail(null, { code: ERROR.PARSE_ERROR, message: 'parse error' }));
          continue;
        }
        const parsed = parseRequest(raw);
        if (!parsed.ok) reply(socket, fail(parsed.id, parsed.error));
        else if (inFlight >= maxInFlight) reply(socket, fail(parsed.request.id, { code: ERROR.INVALID_REQUEST, message: 'too many requests in flight' }));
        else {
          inFlight++;
          void run(handler, parsed.request, timeoutMs).then((r) => {
            inFlight--;
            reply(socket, r);
          });
        }
      }
      if (buffer.length > max) socket.end(`${JSON.stringify(fail(null, { code: ERROR.INVALID_REQUEST, message: 'message too large' }))}\n`);
    });
  });

  if (options.maxConnections !== undefined) server.maxConnections = options.maxConnections;

  rmSync(socketPath, { force: true });
  // The socket is created 0600 so it is never briefly wider than intended.
  const previous = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  } finally {
    process.umask(previous);
  }
  if (options.group) chownSync(socketPath, -1, gid(options.group));
  chmodSync(socketPath, mode);
  const actual = statSync(socketPath).mode & 0o777;
  if (actual !== mode) {
    server.close();
    throw new Error(`socket ${socketPath} has mode ${actual.toString(8)}, expected ${mode.toString(8)}`);
  }

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
