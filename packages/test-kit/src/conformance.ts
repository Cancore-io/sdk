import type { Mode } from './scenario';
export interface LogEntry { seq: number; at: number; dir: 'S2F' | 'F2S'; via: 'ws' | 'rest'; fillerId?: string; msg: Record<string, unknown> }
export interface TakerExpectation { rule: string; reaction: string; decline?: string }
export class TakerConformanceError extends Error {}
export const TAKER_EXPECTATIONS = {} as Record<Mode, TakerExpectation>;
export function assertTakerReaction(_log: LogEntry[], _mode: Mode, _opts: { fillerId?: string } = {}): void { throw new Error('not implemented'); }
export function issuedLate(_sentAt: number, _acceptBy: number, _d: number): boolean { throw new Error('not implemented'); }
