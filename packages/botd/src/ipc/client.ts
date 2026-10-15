import { createConnection } from 'net';
import { JSONRPC_VERSION, type Method, type Params, type Result, type RpcError, type RpcResponse } from '../protocol/index';

export interface IpcClient {
  call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>;
  close(): void;
}

/** A JSON-RPC error answer from the daemon. */
export class RpcCallError extends Error {
  constructor(readonly error: RpcError) {
    super(error.message);
  }
}

export function connect(socketPath: string): Promise<IpcClient> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
    let nextId = 1;
    let buffer = '';
    const failAll = (err: Error) => {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const response = JSON.parse(buffer.slice(0, nl)) as RpcResponse;
        buffer = buffer.slice(nl + 1);
        const p = typeof response.id === 'number' ? pending.get(response.id) : undefined;
        if (!p) {
          // An id-less error (oversize, parse) is about the connection, not one call.
          if ('error' in response) failAll(new RpcCallError(response.error));
          continue;
        }
        pending.delete(response.id as number);
        if ('error' in response) p.reject(new RpcCallError(response.error));
        else p.resolve(response.result as never);
      }
    });
    socket.on('close', () => failAll(new Error('connection closed')));
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      socket.on('error', failAll);
      resolve({
        call: <M extends Method>(method: M, params: Params<M>) =>
          new Promise<Result<M>>((res, rej) => {
            const id = nextId++;
            pending.set(id, { resolve: res as (v: never) => void, reject: rej });
            socket.write(`${JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params })}\n`);
          }),
        close: () => socket.end(),
      });
    });
  });
}
