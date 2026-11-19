import type { Hex } from '@cancore/contracts';
import type { CantonOperations } from '../canton/operations';
import type { Logger } from '../runtime';
import type { Settleable } from './refusals';

/**
 * `refundAfter` of a Canton-source intent: the held set's, else the intent's as filler-gateway reads it.
 * `known` keeps a read for the life of the process: Daml fixes `refundAfter` per orderHash
 * (`SwapIntent_RenewSettlementFactory` re-creates the intent changing only its settlement factory;
 * `IntentBook_Record` refuses a second intent for the label inside `labelWindow`).
 * Undefined while it cannot be had: no Canton operations, or the read failed (a warning).
 */
export async function cantonRefundAfter(
  s: Pick<Settleable, 'orderHash' | 'payload'>,
  known: Map<Hex, bigint>,
  canton: Pick<CantonOperations, 'intent'> | undefined,
  logger: Logger,
): Promise<bigint | undefined> {
  if (s.payload) return BigInt(s.payload.refundAfter);
  if (canton && !known.has(s.orderHash)) {
    try {
      known.set(s.orderHash, BigInt((await canton.intent(s.orderHash)).refundAfter));
    } catch (error) {
      logger.warn('settle: intent read failed, pulling with refundAfter unknown', { orderHash: s.orderHash, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return known.get(s.orderHash);
}
