import { CANCORE_ROUTER_ABI, type Hex } from '@cancore/contracts';
import { decodeParams, encodeFunctionCall, entryOf, type AbiEntry } from '../chain/abi';
import { ChainReadError } from '../chain/client';
import { reasonOf } from '../delivery/reverts';
import { LeaseLostError, type Fees, type TransactionCall, type TransactionDriver } from '../delivery/transactions';
import type { Clock, Logger } from '../runtime';
import type { InFlightTransaction, NonceLease } from '../store';

export interface SendSettleContext {
  instanceId: string;
  clock: Clock;
  logger: Logger;
}

/** Sends the settle on `lease`; a broadcast the node refused after the record still counts as sent, the tracker retries it. */
export async function sendSettle(ctx: SendSettleContext, driver: TransactionDriver, lease: NonceLease, call: TransactionCall, gasLimit: bigint, orderHash: Hex, attempt: number, fees?: Fees): Promise<InFlightTransaction> {
  try {
    return await driver.send(lease, call, gasLimit, fees ?? await driver.marketFees(), { kind: 'settle', orderHash, attempt }, ctx.clock.now());
  } catch (error) {
    if (error instanceof LeaseLostError) throw error;
    const record = await driver.record(lease);
    const recorded = record?.transactions.at(-1);
    if (record?.owner !== ctx.instanceId || !recorded || recorded.kind !== 'settle' || recorded.orderHash !== orderHash || recorded.attempt !== attempt || recorded.to !== call.to.toLowerCase() || recorded.data !== call.data || recorded.value !== call.value) throw error;
    ctx.logger.warn('settle: broadcast refused, the tracker retries it', { orderHash, attempt, txHash: recorded.hash, error: reasonOf(error) });
    return recorded;
  }
}

/** Re-read the bid after entering its nonce turn; a completed or transferred lease cannot be recovered. */
export async function recoverRecordedSettle(ctx: SendSettleContext, driver: TransactionDriver, record: NonceLease, orderHash: Hex, attempt: number, call: TransactionCall): Promise<{ lease: NonceLease; tx: InFlightTransaction }> {
  const current = await driver.record(record);
  if (!current || current.owner !== ctx.instanceId) throw new LeaseLostError(record);
  const lease = await driver.renew(current);
  if (!lease) throw new LeaseLostError(current);
  const tx = current.transactions.at(-1);
  if (tx?.kind !== 'settle' || tx.orderHash !== orderHash || tx.attempt !== attempt || tx.to !== call.to.toLowerCase() || tx.value !== call.value) {
    throw new Error('settle: the recorded transaction belongs to another operation');
  }
  return { lease, tx: await recoverSettleCall(ctx, driver, lease, tx, call) };
}

const SETTLE = entryOf(CANCORE_ROUTER_ABI as unknown as readonly AbiEntry[], 'function', 'settle');

/** Only the signatures may change on recovery. Keep a still-valid bid, or replace it on the same nonce. */
export async function recoverSettleCall(ctx: SendSettleContext, driver: TransactionDriver, lease: NonceLease, tx: InFlightTransaction, call: TransactionCall): Promise<InFlightTransaction> {
  if (tx.data === call.data) return tx;
  const inputs = SETTLE.inputs!;
  const [order, proof] = decodeParams(inputs, `0x${call.data.slice(10)}`);
  const [, , signatures] = decodeParams(inputs, `0x${tx.data.slice(10)}`);
  if (encodeFunctionCall(SETTLE, [order, proof, signatures]) !== tx.data) throw new Error('settle: recorded order or proof differs');
  try {
    await driver.client.call(tx.to, tx.data);
    return tx;
  } catch (error) {
    if (!(error instanceof ChainReadError) || error.reason !== 'reverted') throw error;
  }
  const fees = await driver.replacementFees(tx, { kind: 'settle' });
  return sendSettle(ctx, driver, lease, call, await driver.estimateGas(call), tx.orderHash!, tx.attempt!, fees);
}
