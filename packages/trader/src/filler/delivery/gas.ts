import type { Hex } from '@cancore/contracts';
import type { EvmChainId } from '../chains';
import type { GasSpentEvent } from '../events';
import type { InFlightTransaction, NonceLease, NonceLeases } from '../store';
import type { TransactionReceipt } from './transactions';

const QUANTITY = /^0x[0-9a-fA-F]+$/;

/** OP-stack receipts (Base) carry the L1 data fee apart from `gasUsed × effectiveGasPrice`; other chains have none. */
export function l1FeeOf(receipt: Pick<TransactionReceipt, 'raw'>): bigint | undefined {
  const fee = receipt.raw.l1Fee;
  return typeof fee === 'string' && QUANTITY.test(fee) ? BigInt(fee) : undefined;
}

/** What the transaction cost in the chain's native asset, wei. */
export function feeWeiOf(receipt: Pick<TransactionReceipt, 'gasUsed' | 'effectiveGasPrice' | 'raw'>): bigint {
  return receipt.gasUsed * receipt.effectiveGasPrice + (l1FeeOf(receipt) ?? 0n);
}

/** The trade a transaction is charged to: its own, or — for the cancel that freed an expired fill's nonce — that fill's. */
function chargedTo(tx: InFlightTransaction, nonceTransactions: readonly InFlightTransaction[]): { orderHash: Hex; attempt?: number } | undefined {
  const owner = tx.orderHash ? tx : tx.kind === 'cancel' ? nonceTransactions.find((x) => x.kind === 'fill' && x.orderHash) : undefined;
  if (!owner?.orderHash) return undefined;
  return { orderHash: owner.orderHash, ...(owner.attempt !== undefined ? { attempt: owner.attempt } : {}) };
}

export function gasSpentOf(chain: EvmChainId, tx: InFlightTransaction, receipt: TransactionReceipt, nonceTransactions: readonly InFlightTransaction[]): GasSpentEvent {
  const l1Fee = l1FeeOf(receipt);
  return {
    type: 'gas',
    ...chargedTo(tx, nonceTransactions),
    kind: tx.kind,
    chain,
    txHash: tx.hash,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    reverted: receipt.status === 0,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    ...(l1Fee !== undefined ? { l1Fee: l1Fee.toString() } : {}),
    feeWei: feeWeiOf(receipt).toString(),
  };
}

/**
 * Marks the nonce mined by `tx` and reports its gas. Only the replica whose
 * write went through reports it: a lease lost here is driven to the same end
 * by its new owner, which reports it then — never twice.
 */
export async function completeMined(
  nonces: Pick<NonceLeases, 'complete'>,
  lease: NonceLease,
  mined: { chain: EvmChainId; tx: InFlightTransaction; receipt: TransactionReceipt; nonceTransactions: readonly InFlightTransaction[] },
  emit: (event: GasSpentEvent) => void,
): Promise<void> {
  if (await nonces.complete(lease, mined.tx.hash)) emit(gasSpentOf(mined.chain, mined.tx, mined.receipt, mined.nonceTransactions));
}
