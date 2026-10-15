import type { RiskGate } from './types';

export const check: RiskGate = (cmd, state, limits, now) => {
  void [cmd, state, limits, now];
  throw new Error('not implemented');
};
