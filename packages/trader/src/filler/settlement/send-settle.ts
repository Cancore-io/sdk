import type { Hex } from '@cancore/contracts';
import { LeaseLostError, type TransactionCall, type TransactionDriver } from '../delivery/transactions';
import type { Clock, Logger } from '../runtime';
import type { InFlightTransaction, NonceLease } from '../store';

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface SendSettleContext {
  instanceId: string;
  clock: Clock;
  logger: Logger;
}

/** Sends the settle on `lease`; a broadcast the node refused after the record still counts as sent, the tracker retries it. */
export async function sendSettle(ctx: SendSettleContext, driver: TransactionDriver, lease: NonceLease, call: TransactionCall, gasLimit: bigint, orderHash: Hex, attempt: number): Promise<InFlightTransaction> {
  try {
    return await driver.send(lease, call, gasLimit, await driver.marketFees(), { kind: 'settle', orderHash, attempt }, ctx.clock.now());
  } catch (error) {
    if (error instanceof LeaseLostError) throw error;
    const record = await driver.record(lease);
    const recorded = record?.transactions.at(-1);
    if (record?.owner !== ctx.instanceId || !recorded || recorded.kind !== 'settle' || recorded.orderHash !== orderHash || recorded.attempt !== attempt || recorded.to !== call.to.toLowerCase() || recorded.data !== call.data || recorded.value !== call.value) throw error;
    ctx.logger.warn('settle: broadcast refused, the tracker retries it', { orderHash, attempt, txHash: recorded.hash, error: reasonOf(error) });
    return recorded;
  }
}
