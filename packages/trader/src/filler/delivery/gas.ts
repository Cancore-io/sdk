import type { Hex } from '@cancore/contracts';
import type { EvmChainId } from '../chains';
import type { GasSpentEvent, StageEvent } from '../events';
import type { InFlightTransaction, NonceLease, NonceLeases } from '../store';
import type { TransactionDriver, TransactionReceipt } from './transactions';

const QUANTITY = /^0x[0-9a-fA-F]+$/;

type ChargedTransaction = InFlightTransaction & { orderHash: Hex; attempt: number };

const quantityOf = (value: unknown): bigint | undefined => (typeof value === 'string' && QUANTITY.test(value) ? BigInt(value) : undefined);

/**
 * OP-stack receipts (Base) carry the L1 data fee apart from `gasUsed × effectiveGasPrice`; other chains have none.
 * shortcut: the Isthmus operator fee (`operatorFeeScalar`, `operatorFeeConstant`) is not added — its formula
 * changed between OP-stack forks; add it once a chain the filler delivers on charges a non-zero operator fee.
 */
export function l1FeeOf(receipt: Pick<TransactionReceipt, 'raw'>): bigint | undefined {
  return quantityOf(receipt.raw.l1Fee);
}

/**
 * Wei per gas `tx` paid: the receipt's own `effectiveGasPrice`; from an RPC that omits it, EIP-1559's
 * `min(maxFeePerGas, baseFeePerGas + maxPriorityFeePerGas)` of the journaled transaction in its block
 * (a block with no base fee charges none, as `TransactionDriver.marketFees` reads it).
 */
export async function effectiveGasPriceOf(tx: InFlightTransaction, receipt: TransactionReceipt, readBlock: (at: bigint) => Promise<Record<string, unknown>>): Promise<bigint> {
  if (receipt.raw.effectiveGasPrice !== undefined) return receipt.effectiveGasPrice;
  const paid = (quantityOf((await readBlock(receipt.blockNumber)).baseFeePerGas) ?? 0n) + tx.maxPriorityFeePerGas;
  return paid < tx.maxFeePerGas ? paid : tx.maxFeePerGas;
}

const isCharged = (tx: InFlightTransaction): tx is ChargedTransaction => tx.orderHash !== undefined && tx.attempt !== undefined;

/**
 * The trade a transaction is charged to: its own; for the cancel that freed an expired fill's nonce, that
 * fill's. A cancel that filled a nonce gap and an `approve` belong to no trade.
 */
function chargedTo(tx: InFlightTransaction, nonceTransactions: readonly InFlightTransaction[]): { orderHash: Hex; attempt: number } | undefined {
  const owner = isCharged(tx) ? tx : tx.kind === 'cancel' ? nonceTransactions.find((x): x is ChargedTransaction => x.kind === 'fill' && isCharged(x)) : undefined;
  return owner && { orderHash: owner.orderHash, attempt: owner.attempt };
}

export interface MinedTransaction {
  chain: EvmChainId;
  tx: InFlightTransaction;
  receipt: TransactionReceipt;
  /** Every transaction journaled on the nonce. */
  nonceTransactions: readonly InFlightTransaction[];
}

/** The cost of `tx`; undefined when `tx` is not journaled on this nonce (a `Filled` log naming another transaction), whose own nonce reports it. */
export async function gasSpentOf(mined: MinedTransaction, readBlock: (at: bigint) => Promise<Record<string, unknown>>): Promise<GasSpentEvent | undefined> {
  const { chain, tx, receipt, nonceTransactions } = mined;
  if (!nonceTransactions.some((x) => x.hash === tx.hash)) return undefined;
  const price = await effectiveGasPriceOf(tx, receipt, readBlock);
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
    effectiveGasPrice: price.toString(),
    ...(l1Fee !== undefined ? { l1Fee: l1Fee.toString() } : {}),
    feeWei: (receipt.gasUsed * price + (l1Fee ?? 0n)).toString(),
  };
}

export interface NonceCloser {
  nonces: Pick<NonceLeases, 'complete'>;
  lease: NonceLease;
  driver: Pick<TransactionDriver, 'chain' | 'rawBlock'>;
  emit: (event: GasSpentEvent) => void;
}

/**
 * Reports the gas of `tx`, then marks its nonce mined. At least once: the report goes out before the store
 * write, so a crash or a lost write reply between them repeats it on the next look, never drops it —
 * consumers key it by `txHash`.
 */
export async function reportMined(closer: NonceCloser, tx: InFlightTransaction, receipt: TransactionReceipt, nonceTransactions: readonly InFlightTransaction[]): Promise<void> {
  const spent = await gasSpentOf({ chain: closer.driver.chain, tx, receipt, nonceTransactions }, (at) => closer.driver.rawBlock(at));
  if (spent) closer.emit(spent);
  await closer.nonces.complete(closer.lease, tx.hash);
}

/**
 * The receipt of any transaction journaled on a nonce that looks spent, read once more before the nonce is
 * given up: an endpoint behind a load balancer may lag the one that answered the transaction count.
 */
export async function lateReceipt(
  driver: Pick<TransactionDriver, 'receipt' | 'isCanonical' | 'client'>,
  nonceTransactions: readonly InFlightTransaction[],
): Promise<{ tx: InFlightTransaction; receipt: TransactionReceipt; depth: bigint } | undefined> {
  for (const tx of nonceTransactions) {
    const receipt = await driver.receipt(tx.hash);
    if (receipt && (await driver.isCanonical(receipt))) return { tx, receipt, depth: (await driver.client.head()) - receipt.blockNumber + 1n };
  }
  return undefined;
}

/** Operator alert for reconciliation: a nonce closed with no receipt of any of its transactions, so their gas is unknown. */
export function unpricedNonce(chain: EvmChainId, lease: NonceLease, nonceTransactions: readonly InFlightTransaction[], atMs: number): StageEvent {
  const charged = nonceTransactions.find(isCharged);
  return {
    type: 'stage',
    stage: 'gas.unpriced',
    atMs,
    ...(charged ? { orderHash: charged.orderHash, attempt: charged.attempt } : {}),
    detail: { chain, nonce: lease.nonce.toString(), kinds: nonceTransactions.map((x) => x.kind).join(','), txHashes: nonceTransactions.map((x) => x.hash).join(',') },
  };
}
