import type { BotState } from './types';

export interface StateStore {
  load(): Promise<BotState>;
  save(state: BotState): Promise<void>;
}

/** JSON file at `path`, written atomically (tmp + rename). */
export function createStateStore(path: string): StateStore {
  void path;
  throw new Error('not implemented');
}
