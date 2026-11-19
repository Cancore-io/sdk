import type { Hex } from '@cancore/contracts';
import type { CantonOperations } from '../canton/operations';
import type { Logger } from '../runtime';
import { assertNever, cantonClosure, SettleError, type CantonClosed, type Settleable } from './refusals';

export type CantonIntentWindow = { kind: 'closed'; closed: CantonClosed } | { kind: 'open'; refundAfter?: bigint };

/**
 * `refundAfter` of a Canton-source intent: the held set's while it is ahead, else the intent's as filler-gateway reads it.
 * The intent is read on every call without a set or from refundAfter on, since a cancel or withdraw can pass unseen there (CAN-3131):
 * a closure it reports comes back as `closed`. `known` keeps the last read for the life of the process: Daml fixes `refundAfter` per orderHash
 * (`SwapIntent_RenewSettlementFactory` re-creates the intent changing only its settlement factory;
 * `IntentBook_Record` refuses a second intent for the label inside `labelWindow`).
 * Undefined while it cannot be had: no Canton operations, or no read succeeded yet (a warning per failed read).
 */
export async function cantonRefundAfter(
  s: Pick<Settleable, 'orderHash' | 'payload'>,
  nowS: bigint,
  known: Map<Hex, bigint>,
  canton: Pick<CantonOperations, 'intent'> | undefined,
  logger: Logger,
): Promise<CantonIntentWindow> {
  const held = s.payload ? BigInt(s.payload.refundAfter) : undefined;
  if (held !== undefined && nowS < held) return { kind: 'open', refundAfter: held };
  const closed = canton && (await readIntent(s.orderHash, known, canton, logger));
  return closed ? { kind: 'closed', closed } : { kind: 'open', refundAfter: held ?? known.get(s.orderHash) };
}

async function readIntent(orderHash: Hex, known: Map<Hex, bigint>, canton: Pick<CantonOperations, 'intent'>, logger: Logger): Promise<CantonClosed | undefined> {
  try {
    known.set(orderHash, BigInt((await canton.intent(orderHash)).refundAfter));
  } catch (error) {
    const closed = cantonClosure(error);
    if (closed) return closed;
    logger.warn('settle: intent read failed, pulling with refundAfter unknown', { orderHash, error: error instanceof Error ? error.message : String(error) });
  }
  return undefined;
}

/**
 * Closes the settlement of a Canton-source intent filler-gateway reports gone: settled, or failed as refunded with one
 * `refunded` alert — raised only when `close` wrote, so `order.settled` landing first or a repeat raises none.
 */
export async function closeCantonSettlement(
  { closure, detail }: CantonClosed,
  close: (state: 'settled' | 'failed', reason: string) => Promise<boolean>,
  alert: (detail: string) => void,
): Promise<SettleError> {
  switch (closure) {
    case 'settled':
      await close('settled', 'the intent is settled');
      return new SettleError('already-settled', detail);
    case 'refunded':
      if (await close('failed', `refunded: ${detail}`)) alert(detail.slice(0, 256));
      return new SettleError('refunded', detail);
    default:
      return assertNever(closure);
  }
}
