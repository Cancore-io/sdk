/** Cashback owed or paid, per token. */
export interface CashbackTokenAmount {
  tokenId: string;
  amount: string;
  swaps: number;
}

export interface CashbackSummary {
  claimable: CashbackTokenAmount[];
  claimed: CashbackTokenAmount[];
  swapsAccrued: number;
  swapsClaimed: number;
  /** A claim is still being paid out; the API refuses a new one until it is. */
  hasPendingClaim: boolean;
}

export interface CashbackPayout {
  id: string;
  tokenId: string;
  amount: string;
  settlementStatus: 'pending' | 'accepted' | 'expired_reclaimed' | 'failed';
  /** The transfer to accept, for a token that is not delivered directly. */
  transferInstructionCid: string | null;
}

export interface CashbackClaim {
  id: string;
  status: 'settling' | 'executed' | 'failed';
  requestedAt: string;
  executedAt: string | null;
  failureReason: string | null;
  payouts?: CashbackPayout[];
}
