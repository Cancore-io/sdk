/**
 * Before signing: decode the prepared transaction, check it is exactly the DvP
 * the command asked for, and recompute its hash (packages/trader/src/filler/canton/hashing.ts).
 */
export interface VerifyInput {
  preparedTransaction: string;
  preparedTransactionHash: string;
  expected: { base: string; quote: string; side: 'buy' | 'sell'; amount: string; price: string; partyId: string };
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyPrepared(input: VerifyInput): Promise<VerifyResult> {
  void input;
  throw new Error('not implemented');
}
