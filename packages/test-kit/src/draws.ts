import type { Hex } from './keys';
export interface EpochLeaf { fillerId: string; base: string; tier: number; reliabilityBps: number }
export interface StakeStep { tier: number; minStake: string; step: string }
export interface Candidate { fillerId: string; weight: string }
export interface DrawAttempt { attempt: number; tBase: string; closedBy: string | null; drandRound: string; drandRandomness: Hex; drandSignature: Hex; candidates: Candidate[]; r: string; winnerFillerId: string; fallbackReason: null }
const todo = (): never => { throw new Error('not implemented'); };
export function weightsRoot(_l: EpochLeaf[]): Hex { return todo(); }
export function weightOf(_l: EpochLeaf, _s: StakeStep[]): bigint { return todo(); }
export function firstRoundAtOrAfter(_t: number | bigint): bigint { return todo(); }
export function beacon(_r: bigint): { signature: Hex; randomness: Hex; real: boolean } { return todo(); }
export function drawAttempt(_i: { orderHash: Hex; attempt: number; tBase: number; deltaDrand: number; candidates: Candidate[] }): DrawAttempt { return todo(); }
