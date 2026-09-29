export interface ClockOptions { mode: 'frozen' | 'real'; baseMs: number }
export class Clock {
  constructor(readonly opts: ClockOptions) {}
  now(): number { throw new Error('not implemented'); }
  advance(_ms: number): void { throw new Error('not implemented'); }
  schedule(_at: number, _fn: () => void): () => void { throw new Error('not implemented'); }
  reset(_baseMs: number): void { throw new Error('not implemented'); }
}
