import type { Engine, StrategyHandle } from '../types';

/** grid strategy loop; `config` is validated here. */
export function runGrid(engine: Engine, config: Record<string, unknown>): Promise<StrategyHandle> {
  void [engine, config];
  throw new Error('not implemented');
}
