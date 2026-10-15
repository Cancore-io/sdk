import type { Method, Params, Result } from '../protocol/index';

export interface IpcClient {
  call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>;
  close(): void;
}

export function connect(socketPath: string): Promise<IpcClient> {
  void socketPath;
  throw new Error('not implemented');
}
