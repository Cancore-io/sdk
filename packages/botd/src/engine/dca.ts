import type { Engine, StrategyHandle } from '../types';

/** dca strategy loop; `config` is validated here. */
export function runDca(engine: Engine, config: Record<string, unknown>): Promise<StrategyHandle> {
  void [engine, config];
  throw new Error('not implemented');
}
