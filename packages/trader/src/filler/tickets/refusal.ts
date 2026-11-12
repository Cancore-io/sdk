/** A failed check before the receipt, and the read rule every check shares (N-12). */
import type { DeclineReason } from '@cancore/contracts';
import { ChainReadError } from '../chain/client';

export type TicketCheckId =
  | 'form'
  | 'V-T4'
  | 'V-T2'
  | 'V-T3'
  | 'V-E1'
  | 'V-E2'
  | 'V-E3'
  | 'V-T1'
  | 'V-E4'
  | 'V-E5'
  | 'V-C1'
  | 'V-C2'
  | 'V-C3'
  | 'V-C4'
  | 'V-C5'
  | 'V-C6'
  | 'V-C7';

export class TicketRefusal extends Error {
  constructor(
    readonly check: TicketCheckId,
    readonly reason: DeclineReason,
    readonly detail: string,
    /** A refusal the operator of the node must see: logged as a warning, not as a routine decline. */
    readonly alert = false,
  ) {
    super(`${check}: ${reason} (${detail})`);
  }
}

/** A read the check needs; any failure to read is a refusal by that check (N-12). */
export async function readFor<T>(check: TicketCheckId, reason: DeclineReason, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const why = error instanceof ChainReadError ? `${error.reason}: ${error.message}` : String(error);
    throw new TicketRefusal(check, reason, `unverifiable: ${why}`);
  }
}
