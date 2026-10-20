import type { Leg } from './dvp-verify';

export interface HtlcPins {
  escrows: readonly string[];
  executors: readonly string[];
  feeParties: readonly string[];
  providers: readonly string[];
  packages: Record<string, readonly string[]>;
}

export interface FlowBTerms extends HtlcPins {
  party: string;
  receiver: string;
  amount: string;
  instrument: string;
  admins: string[];
  hashLock: string;
  timeoutHours: number;
  maxFeeRate: string;
  now?: number;
  maxFee: string;
  feeRecipients: string[];
  dso: string[];
}

export interface AcceptCounterTerms extends HtlcPins {
  party: string;
  amount: string;
  instrument: string;
  admins: string[];
  hashLock: string;
  minTimeout: number;
  now?: number;
}

export async function verifyHtlcFlowBPrepared(_legs: Leg[], _terms: FlowBTerms): Promise<void> {}

export async function verifyHtlcAcceptCounterPrepared(_legs: Leg[], _terms: AcceptCounterTerms): Promise<void> {}
