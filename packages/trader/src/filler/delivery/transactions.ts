/**
 * The transactions of one delivery key on one EVM chain — `fill`, `approve`,
 * `settle`, `cancel` — on nonces leased from the store (sdk.md S16;
 * filler-node N-9, N-34). One writer per nonce: the lease owner.
 *
 * - **Write ahead.** A signed transaction is recorded on its nonce
 *   (`NonceLeases.recordTransaction`, which re-checks the lease) before it is
 *   broadcast. A lease lost in between means nothing goes out; a crash after
 *   it leaves the raw bytes for whoever drives the nonce next.
 * - **One nonce, many transactions.** A replacement (replace-by-fee) goes out
 *   on the same nonce with both fees raised by at least `feeBumpPercent`
 *   (nodes refuse less than +10 %), never above `maxFeePerGasWei`.
 * - **No gaps.** A held nonce with nothing recorded on it is reused before a
 *   new one is allocated, so a send abandoned after the nonce was taken never
 *   strands the transactions behind it.
 *
 * The signer only signs; this module picks the nonce, prices the
 * transaction and broadcasts it. Nothing here logs a raw transaction (S8).
 */
import type { Hex } from '@cancore/contracts';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { evmChainNumber, type EvmChainId } from '../chains';
import { ChainReadError, quantity, toQuantity, type ChainClient } from '../chain/client';
import type { Logger } from '../runtime';
import type { TransactionSigner } from '../signer';
import type { FillerStore, InFlightKind, InFlightTransaction, NonceLease, NonceRecord } from '../store';

/** Below this a node refuses a replacement (geth `txpool.pricebump`). */
export const MIN_FEE_BUMP_PERCENT = 10;
/** Gas of a plain transfer: the cancel transaction. */
export const TRANSFER_GAS = 21_000n;

export interface FeePolicy {
  /** Both fees of a replacement are at least this much above the replaced one. */
  feeBumpPercent: number;
  /** Added on top of `eth_estimateGas`. */
  gasLimitMarginPercent: number;
  /** Ceiling on `maxFeePerGas`; undefined for none. */
  maxFeePerGasWei?: bigint;
}

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** A contract call (or a plain transfer) to send. */
export interface TransactionCall {
  to: Hex;
  data: Hex;
  value: bigint;
}

/** What a transaction is for, recorded with it. */
export interface TransactionPurpose {
  kind: InFlightKind;
  orderHash?: Hex;
  attempt?: number;
}

/** A log of a receipt, as the ABI decoder takes it. */
export interface ReceiptLog {
  address: Hex;
  topics: readonly Hex[];
  data: Hex;
}

export interface TransactionReceipt {
  hash: Hex;
  /** 1 success, 0 reverted. */
  status: 0 | 1;
  blockNumber: bigint;
  blockHash: Hex;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: readonly ReceiptLog[];
  /** The receipt as the RPC returned it (evidence). */
  raw: Readonly<Record<string, unknown>>;
}

/** The lease of a nonce is no longer held: another replica drives it now. Nothing was broadcast. */
export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError';
  constructor(readonly lease: NonceLease) {
    super(`nonce ${lease.nonce} of ${lease.address} on ${lease.chain}: the lease is no longer held`);
  }
}

/** A replacement would have to be priced above `maxFeePerGasWei`. */
export class FeeCeilingError extends Error {
  override readonly name = 'FeeCeilingError';
}

export interface TransactionDriverOptions {
  chain: EvmChainId;
  client: ChainClient;
  signer: TransactionSigner;
  store: FillerStore;
  /** This replica (`FillerConfig.instanceId`). */
  owner: string;
  leaseTtlMs: number;
  fees: FeePolicy;
  logger: Logger;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

const ceilPercent = (value: bigint, percent: number): bigint => (value * BigInt(100 + percent) + 99n) / 100n;
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const message = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : String(error);

/** A broadcast the node answers this way already holds the transaction, or its nonce is spent: not a failure of the send. */
const KNOWN = /already known|known transaction|already imported|nonce too low|transaction already exists/i;

export class TransactionDriver {
  readonly chain: EvmChainId;
  readonly address: Hex;
  private readonly chainId: bigint;

  constructor(private readonly options: TransactionDriverOptions) {
    this.chain = options.chain;
    this.address = options.signer.address.toLowerCase() as Hex;
    this.chainId = evmChainNumber(options.chain);
  }

  get client(): ChainClient {
    return this.options.client;
  }

  // -- nonces -------------------------------------------------------------------

  /**
   * A nonce to send on, leased to this replica: a held one with nothing
   * recorded on it (a send abandoned after its nonce was taken), else a new
   * one from `max(pending nonce on chain, highest allocated + 1)`.
   */
  async acquire(): Promise<NonceLease> {
    const { store, owner, leaseTtlMs } = this.options;
    const now = await store.now();
    for (const record of await store.nonces.listOpen(this.chain, this.address)) {
      if (record.owner !== owner || record.expiresAtMs <= now || record.transactions.length > 0) continue;
      const renewed = await store.nonces.renew(record, leaseTtlMs);
      if (renewed) return renewed;
    }
    const chainNonce = await this.transactionCount('pending');
    return store.nonces.allocate({ chain: this.chain, address: this.address, owner, ttlMs: leaseTtlMs, chainNonce });
  }

  /** Extends a held lease; null when it is no longer held. */
  renew(lease: NonceLease): Promise<NonceLease | null> {
    return this.options.store.nonces.renew(lease, this.options.leaseTtlMs);
  }

  /** The store's record of `lease`'s nonce, while it is open. */
  async record(lease: NonceLease): Promise<NonceRecord | undefined> {
    return (await this.options.store.nonces.listOpen(this.chain, this.address)).find((r) => r.nonce === lease.nonce);
  }

  /** `eth_getTransactionCount` of the delivery key. */
  async transactionCount(tag: 'latest' | 'pending'): Promise<bigint> {
    return this.num(await this.options.client.request('eth_getTransactionCount', [this.address, tag]), 'eth_getTransactionCount');
  }

  // -- pricing ------------------------------------------------------------------

  /** `eth_estimateGas` from the delivery key plus the margin. A revert is a `ChainReadError` `reverted` with the revert data in `cause.data`. */
  async estimateGas(call: TransactionCall): Promise<bigint> {
    const estimate = this.num(
      await this.options.client.request('eth_estimateGas', [{ from: this.address, to: call.to, data: call.data, value: toQuantity(call.value) }]),
      'eth_estimateGas',
    );
    return ceilPercent(estimate, this.options.fees.gasLimitMarginPercent);
  }

  /** Market fees now: tip from `eth_maxPriorityFeePerGas`, `maxFeePerGas` = 2 × base fee + tip, capped. */
  async marketFees(): Promise<Fees> {
    const block = (await this.options.client.request<Record<string, unknown> | null>('eth_getBlockByNumber', ['latest', false])) ?? {};
    const baseFee = block.baseFeePerGas === undefined ? 0n : this.num(block.baseFeePerGas, 'baseFeePerGas');
    const tip = this.num(await this.options.client.request('eth_maxPriorityFeePerGas', []), 'eth_maxPriorityFeePerGas');
    const fees = { maxFeePerGas: 2n * baseFee + tip, maxPriorityFeePerGas: tip };
    const ceiling = this.options.fees.maxFeePerGasWei;
    if (ceiling !== undefined && fees.maxFeePerGas > ceiling) {
      if (ceiling < baseFee + tip) throw new FeeCeilingError(`${this.chain}: base fee ${baseFee} + tip ${tip} is above the ceiling ${ceiling}`);
      fees.maxFeePerGas = ceiling;
    }
    return fees;
  }

  /** Fees for a replacement of `last`: the market or `last` raised by `feeBumpPercent`, whichever is higher; `FeeCeilingError` above the ceiling. */
  async replacementFees(last: Fees): Promise<Fees> {
    const bump = Math.max(this.options.fees.feeBumpPercent, MIN_FEE_BUMP_PERCENT);
    let market: Fees;
    try {
      market = await this.marketFees();
    } catch (error) {
      if (!(error instanceof FeeCeilingError)) throw error;
      market = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n };
    }
    const fees = {
      maxFeePerGas: max(market.maxFeePerGas, ceilPercent(last.maxFeePerGas, bump)),
      maxPriorityFeePerGas: max(market.maxPriorityFeePerGas, ceilPercent(last.maxPriorityFeePerGas, bump)),
    };
    if (fees.maxPriorityFeePerGas > fees.maxFeePerGas) fees.maxFeePerGas = fees.maxPriorityFeePerGas;
    const ceiling = this.options.fees.maxFeePerGasWei;
    if (ceiling !== undefined && fees.maxFeePerGas > ceiling) throw new FeeCeilingError(`${this.chain}: a replacement needs maxFeePerGas ${fees.maxFeePerGas}, above the ceiling ${ceiling}`);
    return fees;
  }

  // -- sending ------------------------------------------------------------------

  /**
   * Signs `call` on `lease`'s nonce, records it (re-checking the lease), then
   * broadcasts it. `LeaseLostError` when the lease is gone — then nothing was
   * recorded or sent. A broadcast the node refuses is thrown after the record:
   * the transaction stays on the nonce and is rebroadcast or replaced later.
   */
  async send(lease: NonceLease, call: TransactionCall, gasLimit: bigint, fees: Fees, purpose: TransactionPurpose, sentAtMs: number): Promise<InFlightTransaction> {
    const raw = await this.options.signer.signTransaction({ chainId: this.chainId, nonce: lease.nonce, to: call.to, data: call.data, value: call.value, gasLimit, ...fees });
    if (typeof raw !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(raw)) throw new TypeError(`${this.chain}: the signer returned no raw transaction`);
    const tx: InFlightTransaction = {
      hash: `0x${bytesToHex(keccak_256(hexToBytes(raw.slice(2))))}`,
      raw: raw.toLowerCase() as Hex,
      kind: purpose.kind,
      ...(purpose.orderHash ? { orderHash: purpose.orderHash } : {}),
      ...(purpose.attempt !== undefined ? { attempt: purpose.attempt } : {}),
      to: call.to.toLowerCase() as Hex,
      data: call.data,
      value: call.value,
      gasLimit,
      ...fees,
      sentAtMs,
    };
    if (!(await this.options.store.nonces.recordTransaction(lease, tx))) throw new LeaseLostError(lease);
    await this.broadcast(tx);
    return tx;
  }

  /** `eth_sendRawTransaction`; an answer that the node already has it, or that its nonce is spent, is not an error. */
  async broadcast(tx: InFlightTransaction): Promise<void> {
    try {
      await this.options.client.request('eth_sendRawTransaction', [tx.raw]);
    } catch (error) {
      const cause = error instanceof ChainReadError ? error.cause : error;
      if (KNOWN.test(message(cause)) || KNOWN.test(message(error))) {
        this.options.logger.debug('tx: node already holds it or the nonce is spent', { chain: this.chain, hash: tx.hash, kind: tx.kind });
        return;
      }
      throw error;
    }
  }

  // -- reading ------------------------------------------------------------------

  /** The receipt of `hash`, or undefined while it is not in a block. */
  async receipt(hash: Hex): Promise<TransactionReceipt | undefined> {
    const raw = await this.options.client.request<Record<string, unknown> | null>('eth_getTransactionReceipt', [hash]);
    if (raw === null || raw === undefined || raw.blockHash === null || raw.blockHash === undefined) return undefined;
    try {
      const blockHash = String(raw.blockHash);
      if (!HEX32.test(blockHash)) throw new TypeError('blockHash');
      const status = quantity(raw.status, 'status');
      const logs = Array.isArray(raw.logs) ? (raw.logs as Array<Record<string, unknown>>) : [];
      return {
        hash,
        status: status === 1n ? 1 : 0,
        blockNumber: quantity(raw.blockNumber, 'blockNumber'),
        blockHash: blockHash.toLowerCase() as Hex,
        gasUsed: quantity(raw.gasUsed, 'gasUsed'),
        effectiveGasPrice: raw.effectiveGasPrice === undefined ? 0n : quantity(raw.effectiveGasPrice, 'effectiveGasPrice'),
        logs: logs.map((l) => ({ address: String(l.address).toLowerCase() as Hex, topics: (l.topics as Hex[]).map((t) => t.toLowerCase() as Hex), data: String(l.data) as Hex })),
        raw,
      };
    } catch (error) {
      throw new ChainReadError(this.chain, 'malformed', `receipt of ${hash}: ${message(error)}`, { cause: error });
    }
  }

  /** Whether any endpoint's node knows `hash` (mempool or chain). */
  async known(hash: Hex): Promise<boolean> {
    return (await this.options.client.request<unknown>('eth_getTransactionByHash', [hash])) !== null;
  }

  /** The latest block's header fields as the RPC returned them (transaction lists dropped). */
  async rawBlock(at: bigint | 'latest'): Promise<Record<string, unknown>> {
    const raw = await this.options.client.request<Record<string, unknown> | null>('eth_getBlockByNumber', [typeof at === 'bigint' ? toQuantity(at) : at, false]);
    if (!raw) throw new ChainReadError(this.chain, 'malformed', `no block ${String(at)}`);
    const { transactions: _t, uncles: _u, withdrawals: _w, ...header } = raw;
    return header;
  }

  /** `timestamp` of the latest block: the earliest `block.timestamp` any future transaction can see. */
  async chainTime(): Promise<bigint> {
    return this.num((await this.rawBlock('latest')).timestamp, 'timestamp');
  }

  private num(value: unknown, what: string): bigint {
    try {
      return quantity(value, what);
    } catch (error) {
      throw new ChainReadError(this.chain, 'malformed', message(error), { cause: error });
    }
  }
}
