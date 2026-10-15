import type { RpcRequest, RpcResponse } from '../protocol/index';

export type Handler = (request: RpcRequest) => Promise<RpcResponse>;

export interface IpcServer {
  close(): Promise<void>;
}

/** Unix socket JSON-RPC 2.0, newline-delimited; socket mode 0660, group `cancore-bot-clients`. */
export function listen(socketPath: string, handler: Handler): Promise<IpcServer> {
  void [socketPath, handler];
  throw new Error('not implemented');
}
