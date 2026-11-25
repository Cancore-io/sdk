import type { Hex } from '@cancore/contracts';
import type { EvmChainId } from '../chains';
import type { ChainClient } from '../chain/client';
import type { EventSink, GasSpentEvent, StageEvent } from '../events';
import type { Clock, Logger } from '../runtime';
import type { InFlightTransaction, NonceLease } from '../store';
import { inclusionDepth, type TransactionDriver, type TransactionReceipt } from './transactions';

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

/**
 * Looks a nonce is held open while the event sink refuses its `gas` event. A broken sink must not hold the key's
 * nonces for good: `approve` waits on an open approve, and gaps are filled only below the highest open nonce.
 */
export const GAS_REPORT_ATTEMPTS = 10;

export interface GasReporterOptions {
  /** Awaited for every `gas` event: a rejection keeps the nonce open. */
  events: EventSink;
  /** The `gas.unpriced` alert, through the executor's own (non-blocking) emit. */
  alert: (event: StageEvent) => void;
  logger: Logger;
  clock: Clock;
  attempts?: number;
}

/** Where a mined transaction sits: its nonce lease and the driver of its chain. */
export interface MinedAt {
  lease: NonceLease;
  driver: Pick<TransactionDriver, 'chain' | 'rawBlock'>;
}

export class GasReporter {
  private readonly refusals = new Map<Hex, number>();

  constructor(private readonly options: GasReporterOptions) {}

  /**
   * Reports what `tx` cost; the caller marks its nonce mined only after this resolves, so the report is at least
   * once. A sink that refuses it makes this throw — the nonce stays open and the next look reports again — up to
   * `GAS_REPORT_ATTEMPTS` looks; then the report is given up with an error log and a `gas.unpriced` alert.
   */
  async report(at: MinedAt, tx: InFlightTransaction, receipt: TransactionReceipt, nonceTransactions: readonly InFlightTransaction[]): Promise<void> {
    const { chain } = at.driver;
    const spent = await gasSpentOf({ chain, tx, receipt, nonceTransactions }, (block) => at.driver.rawBlock(block));
    if (!spent) return this.unpriced(chain, at.lease, nonceTransactions);
    try {
      await this.options.events.emit(spent);
      this.refusals.delete(spent.txHash);
    } catch (error) {
      const refused = (this.refusals.get(spent.txHash) ?? 0) + 1;
      if (refused < (this.options.attempts ?? GAS_REPORT_ATTEMPTS)) {
        this.refusals.set(spent.txHash, refused);
        throw new Error(`the event sink refused the gas of ${spent.txHash} (${refused}): ${String(error)}`, { cause: error });
      }
      this.refusals.delete(spent.txHash);
      this.options.logger.error('delivery: gas report given up, the event sink keeps refusing it', { chain, txHash: spent.txHash, feeWei: spent.feeWei, error: String(error) });
      this.unpriced(chain, at.lease, nonceTransactions);
    }
  }

  /** Raises `gas.unpriced` for a nonce whose own transactions' gas will not be reported. */
  unpriced(chain: EvmChainId, lease: NonceLease, nonceTransactions: readonly InFlightTransaction[]): void {
    this.options.alert(unpricedNonce(chain, lease, nonceTransactions, this.options.clock.now()));
  }
}

/**
 * The receipt of any transaction journaled on a nonce that looks spent, read once more before the nonce is
 * given up: an endpoint behind a load balancer may lag the one that answered the transaction count.
 */
export async function lateReceipt(
  driver: Pick<TransactionDriver, 'receipt' | 'isCanonical'> & { client: Pick<ChainClient, 'head'> },
  nonceTransactions: readonly InFlightTransaction[],
): Promise<{ tx: InFlightTransaction; receipt: TransactionReceipt; depth: bigint } | undefined> {
  for (const tx of nonceTransactions) {
    const receipt = await driver.receipt(tx.hash);
    if (receipt && (await driver.isCanonical(receipt))) return { tx, receipt, depth: inclusionDepth(await driver.client.head(), receipt) };
  }
  return undefined;
}

/** Operator alert for reconciliation: the gas of a nonce's own transactions is not reported (no receipt of any of them, a receipt of another transaction, or a sink that keeps refusing). */
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
