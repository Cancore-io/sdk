/**
 * `Executor` — delivery on an EVM destination (fillers.md §4.6, T-25…T-30;
 * filler-node N-9, N-15, N-34).
 *
 * ```
 * receipted ──► pending ──► sent ──► included ──► confirmed   (ticket → filled, `filled` event)
 *                  │          │  ▲        │
 *                  │          │  └─reorg──┘ (resent while the ticket is live)
 *                  └──────────┴──► failed (reverted; nonce spent elsewhere; cancelled after validUntil)
 * ```
 *
 * - **No fill without a receipt** (T-22): `deliver` starts only from a ticket
 *   the desk reports receipted, re-checks that the issued ticket names this
 *   filler, this delivery key and this payee (S13), and sends `amount ≥
 *   minReceived` from the delivery key the ticket names (T-25).
 * - **sendGuard** (T-29): nothing is broadcast when less than `sendGuardSec`
 *   remains to `validUntil`, by the process clock. A replacement (replace-by-fee)
 *   of a stuck fill goes out only while `validUntil` has not passed. Once the
 *   chain's own time is past `validUntil`, the fill can never succeed: its
 *   nonce is freed with a zero-value transfer to self instead.
 * - **Reorgs** (T-30): a fill counts as done only `fillConfirmations` deep. An
 *   inclusion that disappears is resent while the ticket is live; the header
 *   and receipt of the last inclusion seen are kept as evidence either way.
 * - **One writer per nonce** (N-9, N-34): transactions go out only on nonces
 *   this replica leases from the store, recorded before they are broadcast.
 *   Expired leases of a dead replica are claimed and driven from the chain.
 * - **Restart** (N-15): the store (the fill record and the nonce journal) and
 *   `filled(orderHash)` decide whether anything is sent again; a fill already
 *   recorded is driven, never sent a second time.
 *
 * Allowance: the router is approved for the output asset up to the configured
 * limit (never unlimited by default), when it no longer covers a fill or,
 * with a limit configured, when it has fallen below half of it.
 */
import {
  CANCORE_ROUTER_ABI,
  CANCORE_ROUTER_ERRORS,
  IBURN_MINT_ERC20_ABI,
  describeRevert,
  type DecString,
  type Hex,
  type OrderJson,
  type TicketIssuedEvm,
} from '@cancore/contracts';
import { decodeEventLog, decodeParams, encodeFunctionCall, entryOf, topicOf, type AbiEntry } from '../chain/abi';
import { ChainReadError, toQuantity } from '../chain/client';
import { erc20Allowance } from '../chain/erc20';
import type { ChainReaders, FillerChains } from '../chain';
import type { EvmChainId } from '../chains';
import type { EventSink, FillerEvent, FillerStage } from '../events';
import type { Cancel, Clock, Logger } from '../runtime';
import type { FillSigner } from '../signer';
import type { FillRecord, FillerStore, InFlightTransaction, NonceLease, TicketRecord } from '../store';
import { chainsOf, fillTicketOf, identityFor, orderOf, ticketMismatch } from '../tickets/terms';
import { FeeCeilingError, LeaseLostError, TransactionDriver, TRANSFER_GAS, type TransactionCall, type TransactionReceipt } from './transactions';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** What to send for an attempt: at least `order.minReceived`. Default: the `amountOut` of the offer. */
export type FillAmountHook = (input: FillAmountInput) => bigint | DecString | Promise<bigint | DecString>;

export interface FillAmountInput {
  orderHash: Hex;
  attempt: number;
  chain: EvmChainId;
  order: OrderJson;
  /** What the filler committed to (`ticket.offer.amountOut`). */
  amountOut: bigint;
}

/** Delivery tuning (`FillerConfig.delivery`). The defaults suit production; tests shorten the timings. */
export interface DeliveryOptions {
  /** How often an in-flight transaction is checked. Default 2 s. */
  pollIntervalMs?: number;
  /** A transaction still pending after this long is replaced with higher fees. Default 30 s. */
  replaceAfterMs?: number;
  /** Raise of both fees per replacement, percent; at least 10. Default 15. */
  feeBumpPercent?: number;
  /** Margin over `eth_estimateGas`, percent. Default 20. */
  gasLimitMarginPercent?: number;
  /** Lease of a nonce (filler-node `ops.nonceLeaseTtlSec`): longer than the longest send. Default 60 s. */
  nonceLeaseTtlMs?: number;
  /**
   * Allowance limit per destination chain and output token (lowercase address)
   * the router is approved for. A token without a limit is approved for
   * exactly the fill that needs it; nothing is ever approved unlimited by default.
   */
  approvals?: { readonly [chain: EvmChainId]: { readonly [token: Hex]: bigint } };
  /** Over-send for a fee-on-transfer output (the router measures what the recipient got, T-26). */
  fillAmount?: FillAmountHook;
}

export const DEFAULT_DELIVERY = {
  pollIntervalMs: 2_000,
  replaceAfterMs: 30_000,
  feeBumpPercent: 15,
  gasLimitMarginPercent: 20,
  nonceLeaseTtlMs: 60_000,
} as const;

/** Why a delivery was not started. */
export type FillRefusal =
  /** No `ticket.receipt` went out for the attempt (T-22). */
  | 'no-receipt'
  /** Not an EVM ticket, or no fill key or router for its destination. */
  | 'not-deliverable'
  /** The issued ticket does not name this filler, its delivery key or its payee (S13). */
  | 'ticket-mismatch'
  /** Less than `sendGuardSec` left to `validUntil` (T-29). */
  | 'send-guard'
  /** The amount to send is below `order.minReceived`. */
  | 'below-min-received'
  /** The destination router already has a fill for the order (T-27). */
  | 'already-filled'
  /** `eth_estimateGas` reverted: the router or the token would refuse it. */
  | 'reverted'
  /** The router could not be approved for the output asset. */
  | 'allowance'
  /** Priced above `maxFeePerGasWei`. */
  | 'fee-ceiling';

export interface DeliveryResult {
  /** `sent`: broadcast now; `tracking`: already under way (here or on another replica); `waiting`: retried later; `refused`: never sent. */
  status: 'sent' | 'tracking' | 'waiting' | 'refused';
  reason?: FillRefusal;
  detail?: string;
  txHash?: Hex;
}

export interface ExecutorOptions {
  store: FillerStore;
  chains: FillerChains;
  fillSigners: { readonly [chain: EvmChainId]: FillSigner };
  fillerId: string;
  cantonParty?: string;
  /** The ticket of an attempt the filler is bound to deliver; undefined otherwise (`TicketDesk.receipted`). */
  receipted: (orderHash: Hex, attempt: number) => Promise<TicketRecord | undefined>;
  /** This replica, the owner of its nonce leases. */
  instanceId: string;
  clock: Clock;
  logger: Logger;
  events: EventSink;
  delivery?: DeliveryOptions;
  /** Called once a fill is confirmed (settlement pulls its attestations at once). */
  onFilled?: (orderHash: Hex, attempt: number) => void;
}

/** A `settle` of this replica's, `fillConfirmations` deep: success or revert (`receipt.status`). */
export type SettleIncludedListener = (chain: EvmChainId, tx: InFlightTransaction, receipt: TransactionReceipt) => Promise<void>;

// ---------------------------------------------------------------------------

const ROUTER_ABI = CANCORE_ROUTER_ABI as unknown as readonly AbiEntry[];
const ERC20_ABI = IBURN_MINT_ERC20_ABI as unknown as readonly AbiEntry[];
const FILL = entryOf(ROUTER_ABI, 'function', 'fill');
const FILLED = entryOf(ROUTER_ABI, 'event', 'Filled');
const FILLED_TOPIC = topicOf(FILLED);
const APPROVE = entryOf(ERC20_ABI, 'function', 'approve');
const ZERO_HASH: Hex = `0x${'00'.repeat(32)}`;
/** Ticks in a row a nonce may look spent without a receipt of ours before it is given up (receipts lag the nonce). */
const SPENT_TICKS = 3;
/** How far back a `Filled` log of an executed fill is looked for, blocks. */
const FILLED_LOOKBACK = 5_000n;

/** The address of an EVM `bytes32` asset (left-padded), or undefined. */
const tokenOf = (asset: string): Hex | undefined => (/^0x0{24}[0-9a-fA-F]{40}$/.test(asset) ? (`0x${asset.slice(26).toLowerCase()}` as Hex) : undefined);
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The custom error a reverted call names, from the revert data of the RPC error. */
function revertName(error: unknown): string {
  const cause = error instanceof ChainReadError ? error.cause : error;
  const data = typeof cause === 'object' && cause !== null ? (cause as { data?: unknown }).data : undefined;
  const hex = typeof data === 'string' ? data : typeof data === 'object' && data !== null && typeof (data as { data?: unknown }).data === 'string' ? (data as { data: string }).data : undefined;
  const name = hex && /^0x[0-9a-fA-F]{8}/.test(hex) ? describeRevert(hex, [CANCORE_ROUTER_ERRORS]) : undefined;
  return name ?? reasonOf(error);
}

/** One in-flight nonce this replica drives. */
interface Tracker {
  lease: NonceLease;
  driver: TransactionDriver;
  /** Block hash of the inclusion seen last tick; a later tick without it is a reorg. */
  includedIn?: Hex;
  /** Ticks the nonce looked spent with no receipt of ours. */
  spentTicks: number;
  /** `validUntil` (unix s) of the fill on this nonce, once read. */
  validUntil?: bigint;
  cancel?: Cancel;
}

export class Executor {
  private readonly delivery: Required<Omit<DeliveryOptions, 'approvals' | 'fillAmount'>> & Pick<DeliveryOptions, 'approvals' | 'fillAmount'>;
  private readonly drivers = new Map<EvmChainId, TransactionDriver>();
  private readonly trackers = new Map<string, Tracker>();
  private readonly busy = new Map<string, Promise<DeliveryResult>>();
  private readonly approving = new Map<string, Promise<void>>();
  private sweep: Cancel | undefined;
  private settleListener: SettleIncludedListener | undefined;
  private started = false;
  private stopped = false;

  constructor(private readonly options: ExecutorOptions) {
    const d = options.delivery ?? {};
    this.delivery = {
      pollIntervalMs: d.pollIntervalMs ?? DEFAULT_DELIVERY.pollIntervalMs,
      replaceAfterMs: d.replaceAfterMs ?? DEFAULT_DELIVERY.replaceAfterMs,
      feeBumpPercent: d.feeBumpPercent ?? DEFAULT_DELIVERY.feeBumpPercent,
      gasLimitMarginPercent: d.gasLimitMarginPercent ?? DEFAULT_DELIVERY.gasLimitMarginPercent,
      nonceLeaseTtlMs: d.nonceLeaseTtlMs ?? DEFAULT_DELIVERY.nonceLeaseTtlMs,
      ...(d.approvals ? { approvals: d.approvals } : {}),
      ...(d.fillAmount ? { fillAmount: d.fillAmount } : {}),
    };
  }

  /** The transaction driver of `chain`'s delivery key; undefined without a fill key and a router for it. */
  driver(chain: EvmChainId): TransactionDriver | undefined {
    let driver = this.drivers.get(chain);
    const signer = this.options.fillSigners[chain];
    const readers = this.options.chains.get(chain);
    if (!driver && signer && readers) {
      driver = new TransactionDriver({
        chain,
        client: readers.client,
        signer,
        store: this.options.store,
        owner: this.options.instanceId,
        leaseTtlMs: this.delivery.nonceLeaseTtlMs,
        fees: {
          feeBumpPercent: this.delivery.feeBumpPercent,
          gasLimitMarginPercent: this.delivery.gasLimitMarginPercent,
          ...(readers.config.maxFeePerGasWei !== undefined ? { maxFeePerGasWei: readers.config.maxFeePerGasWei } : {}),
        },
        logger: this.options.logger,
      });
      this.drivers.set(chain, driver);
    }
    return driver;
  }

  /** Where a tracked `settle` goes once it is deep enough (the settlement). */
  onSettleIncluded(listener: SettleIncludedListener): void {
    this.settleListener = listener;
  }

  // -- lifecycle ----------------------------------------------------------------

  /** Resumes from the store and keeps claiming the expired nonce leases of dead replicas, every lease TTL. */
  async start(): Promise<void> {
    if (this.started && !this.stopped) return;
    this.started = true;
    this.stopped = false;
    const sweep = () => {
      this.sweep = this.options.clock.schedule(this.delivery.nonceLeaseTtlMs, () => {
        if (this.stopped) return;
        void this.claim().finally(sweep);
      });
    };
    sweep();
    await this.resume();
  }

  /** Stops every timer. In-flight work stays in the store for this or another replica. */
  stop(): void {
    this.stopped = true;
    this.sweep?.();
    for (const tracker of this.trackers.values()) tracker.cancel?.();
    this.trackers.clear();
  }

  /**
   * After a restart (N-15): drives every nonce this replica holds or can claim,
   * tops up the configured allowances, and starts the delivery of every
   * receipted attempt with no fill under way.
   */
  async resume(): Promise<void> {
    await this.claim();
    for (const [chain, tokens] of Object.entries(this.delivery.approvals ?? {}) as Array<[EvmChainId, Record<Hex, bigint>]>) {
      for (const token of Object.keys(tokens) as Hex[]) void this.topUp(chain, token);
    }
    for (const orderHash of await this.options.store.listOpenOrders()) {
      const work = await this.options.store.withOrder(orderHash, async (tx) => {
        const attempts: number[] = [];
        for (const ticket of await tx.listTickets()) {
          if (ticket.state !== 'receipted' || ticket.sentAtMs === undefined || ticket.unsent) continue;
          const fill = await tx.getFill(ticket.attempt);
          if (!fill || fill.state === 'pending') attempts.push(ticket.attempt);
        }
        return attempts;
      });
      for (const attempt of work) void this.deliver(orderHash, attempt);
    }
  }

  /**
   * The sweep, every lease TTL: claims expired leases (N-34), drives every open
   * nonce this replica holds, and fills the gaps — a held nonce with nothing
   * recorded below one that carries a transaction gets a zero-value transfer to
   * self, so the transactions above it can be mined.
   */
  private async claim(): Promise<void> {
    for (const chain of Object.keys(this.options.fillSigners) as EvmChainId[]) {
      const driver = this.driver(chain);
      if (!driver) continue;
      try {
        await this.claimChain(driver);
        await this.fillGaps(driver);
      } catch (error) {
        this.options.logger.warn('delivery: nonce sweep failed', { chain, error: reasonOf(error) });
      }
    }
  }

  /** Claims the expired leases of `driver`'s key and drives every open nonce this replica holds with a transaction on it. */
  private async claimChain(driver: TransactionDriver): Promise<void> {
    const { store, instanceId, logger } = this.options;
    const claimed = await store.nonces.claimExpired({ chain: driver.chain, address: driver.address, owner: instanceId, ttlMs: this.delivery.nonceLeaseTtlMs });
    if (claimed.length > 0) logger.warn('delivery: took over expired nonce leases', { chain: driver.chain, nonces: claimed.map((r) => r.nonce.toString()).join(',') });
    const now = await store.now();
    for (const record of await store.nonces.listOpen(driver.chain, driver.address)) {
      if (record.owner === instanceId && record.expiresAtMs > now && record.transactions.length > 0) this.track(driver, record);
    }
  }

  /** Sends a zero-value transfer to self on every held empty nonce that lies below a nonce with a transaction. */
  private async fillGaps(driver: TransactionDriver): Promise<void> {
    const { store, instanceId, logger, clock } = this.options;
    const open = await store.nonces.listOpen(driver.chain, driver.address);
    const highest = open.filter((r) => r.transactions.length > 0).reduce<bigint>((max, r) => (r.nonce > max ? r.nonce : max), -1n);
    const now = await store.now();
    for (const record of open) {
      if (record.nonce >= highest || record.transactions.length > 0 || record.owner !== instanceId || record.expiresAtMs <= now) continue;
      const lease = await driver.renew(record);
      if (!lease) continue;
      try {
        const tx = await driver.send(lease, { to: driver.address, data: '0x', value: 0n }, TRANSFER_GAS, await driver.marketFees(), { kind: 'cancel' }, clock.now());
        logger.warn('delivery: filled a nonce gap with a transfer to self', { chain: driver.chain, nonce: lease.nonce.toString(), txHash: tx.hash });
        this.track(driver, lease);
      } catch (error) {
        logger.warn('delivery: a nonce gap could not be filled yet', { chain: driver.chain, nonce: lease.nonce.toString(), error: reasonOf(error) });
      }
    }
  }

  /**
   * A nonce to send on: expired leases are claimed first, so an abandoned empty
   * nonce — a send that failed after its nonce was taken — is reused, never
   * skipped (the lowest held empty nonce wins).
   */
  async acquire(driver: TransactionDriver): Promise<NonceLease> {
    await this.claimChain(driver);
    return driver.acquire();
  }

  // -- delivery -------------------------------------------------------------------

  /**
   * Delivers a receipted attempt: one worker per attempt in this process;
   * a fill already under way is driven, never sent again.
   */
  deliver(orderHash: Hex, attempt: number): Promise<DeliveryResult> {
    const k = `${orderHash.toLowerCase()}:${attempt}`;
    const running = this.busy.get(k);
    if (running) return running;
    const work = this.run(orderHash.toLowerCase() as Hex, attempt)
      .catch((error: unknown): DeliveryResult => {
        this.options.logger.error('delivery: failed', { orderHash, attempt, error: reasonOf(error) });
        return { status: 'waiting', detail: reasonOf(error) };
      })
      .finally(() => this.busy.delete(k));
    this.busy.set(k, work);
    return work;
  }

  private async run(orderHash: Hex, attempt: number): Promise<DeliveryResult> {
    const { store, clock, instanceId } = this.options;
    const ticket = await this.options.receipted(orderHash, attempt);
    if (!ticket) return this.refuse(orderHash, attempt, 'no-receipt', 'no ticket.receipt went out for this attempt');
    const issued = ticket.issued as TicketIssuedEvm | undefined;
    const offer = ticket.offer;
    const chain = offer ? chainsOf(offer.order)?.destination : undefined;
    const driver = chain ? this.driver(chain) : undefined;
    const readers = chain ? this.options.chains.get(chain) : undefined;
    if (!offer || issued?.form !== 'evm' || !chain || !driver || !readers) return this.refuse(orderHash, attempt, 'not-deliverable', 'not an EVM ticket this filler holds a fill key and a router for');

    const identity = identityFor(offer.order, this.options);
    const mismatch = identity ? ticketMismatch(issued.ticket, { orderHash, attempt, validFrom: offer.validFrom, validUntil: offer.validUntil }, identity) : 'identity';
    if (mismatch || identity?.deliveryKey !== driver.address) return this.refuse(orderHash, attempt, 'ticket-mismatch', `the issued ticket differs in ${mismatch ?? 'deliveryKey'}`);

    // A fill already recorded is driven from its nonce, never sent again (N-15).
    const existing = await store.withOrder(orderHash, (tx) => tx.getFill(attempt));
    if (existing && existing.state !== 'pending') return { status: 'tracking', ...(existing.txRef ? { txHash: existing.txRef as Hex } : {}) };
    if (existing && existing.owner !== instanceId && (existing.leaseUntilMs ?? 0) > (await store.now())) return { status: 'tracking', detail: 'another replica is sending it' };

    const validUntilMs = Number(issued.ticket.validUntil) * 1000;
    const validFromMs = Number(issued.ticket.validFrom) * 1000;
    const guard = () => clock.now() + readers.config.sendGuardSec * 1000 > validUntilMs;
    if (guard()) return this.refuse(orderHash, attempt, 'send-guard', `less than sendGuard (${readers.config.sendGuardSec} s) left to validUntil`);
    if (clock.now() < validFromMs) {
      clock.schedule(validFromMs - clock.now(), () => void this.deliver(orderHash, attempt));
      return { status: 'waiting', detail: 'validFrom not reached' };
    }

    const minReceived = BigInt(offer.order.minReceived);
    const amount = await this.amountFor({ orderHash, attempt, chain, order: offer.order, amountOut: BigInt(offer.amountOut) });
    if (amount < minReceived) return this.refuse(orderHash, attempt, 'below-min-received', `${amount} < minReceived ${minReceived}`);
    const token = tokenOf(String(offer.order.outputAsset));
    if (!token) return this.refuse(orderHash, attempt, 'not-deliverable', 'the output asset is not an EVM token');

    // A fill recorded on a nonce but not yet in the fill record (a crash, a store error) is driven, not sent again.
    const recorded = (await store.nonces.listOpen(chain, driver.address)).find((r) => r.transactions.some((t) => t.kind === 'fill' && t.orderHash === orderHash && t.attempt === attempt));
    if (recorded) {
      if (recorded.owner === instanceId) this.track(driver, recorded);
      return { status: 'tracking', txHash: recorded.transactions.at(-1)!.hash };
    }

    try {
      if (await readers.router.filled(orderHash)) return this.refuse(orderHash, attempt, 'already-filled', 'the destination router has a fill for this order');
    } catch (error) {
      return this.retry(orderHash, attempt, validUntilMs, readers, `filled(orderHash) unreadable: ${reasonOf(error)}`);
    }

    // Claim the attempt: one sender across replicas while the claim lasts.
    const claimed = await store.withOrder(orderHash, async (tx) => {
      const fill = await tx.getFill(attempt);
      const now = await store.now();
      if (fill && !(fill.state === 'pending' && (fill.owner === instanceId || (fill.leaseUntilMs ?? 0) <= now))) return false;
      await tx.putFill({ orderHash, attempt, chain, txRef: '', amount: amount.toString(), state: 'pending', owner: instanceId, leaseUntilMs: now + this.delivery.nonceLeaseTtlMs, updatedAtMs: now });
      return true;
    });
    if (!claimed) return { status: 'tracking' };

    const allowance = await this.ensureAllowance(driver, readers, token, amount, guard, () => this.holdClaim(orderHash, attempt));
    if (allowance === 'lost') return { status: 'tracking', detail: 'another replica took the attempt over' };
    if (allowance !== true) return allowance === 'retry' ? this.retry(orderHash, attempt, validUntilMs, readers, 'allowance not ready') : this.refuse(orderHash, attempt, 'allowance', allowance, true);

    const call: TransactionCall = {
      to: readers.router.address,
      data: encodeFunctionCall(FILL, [orderOf(offer.order), amount, fillTicketOf(issued.ticket), issued.ticketSig]),
      value: 0n,
    };
    let gasLimit: bigint;
    try {
      gasLimit = await driver.estimateGas(call);
    } catch (error) {
      if (!(error instanceof ChainReadError) || error.reason !== 'reverted') return this.retry(orderHash, attempt, validUntilMs, readers, `eth_estimateGas: ${reasonOf(error)}`);
      const name = revertName(error);
      return this.refuse(orderHash, attempt, name.startsWith('AlreadyFilled') ? 'already-filled' : 'reverted', name, true);
    }
    if (guard()) return this.refuse(orderHash, attempt, 'send-guard', `less than sendGuard (${readers.config.sendGuardSec} s) left to validUntil`, true);

    let lease: NonceLease;
    let tx: InFlightTransaction;
    try {
      if (!(await this.holdClaim(orderHash, attempt))) return { status: 'tracking', detail: 'another replica took the attempt over' };
      lease = await this.acquire(driver);
      const fees = await driver.marketFees();
      tx = await this.sendRecorded(driver, lease, call, gasLimit, fees, orderHash, attempt);
    } catch (error) {
      if (error instanceof FeeCeilingError) return this.refuse(orderHash, attempt, 'fee-ceiling', error.message, true);
      // Nothing was recorded on a nonce: the attempt is tried again (a held empty nonce is reused).
      return this.retry(orderHash, attempt, validUntilMs, readers, reasonOf(error));
    }
    this.stage('fill.sent', orderHash, attempt, {
      chain,
      txHash: tx.hash,
      nonce: lease.nonce.toString(),
      gasLimit: gasLimit.toString(),
      maxFeePerGas: tx.maxFeePerGas.toString(),
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString(),
    });
    this.options.logger.info('delivery: fill sent', { orderHash, attempt, chain, txHash: tx.hash, nonce: lease.nonce.toString() });
    this.track(driver, lease);
    return { status: 'sent', txHash: tx.hash };
  }

  /**
   * Records the fill on its nonce, marks the attempt `sent`, then broadcasts.
   * A broadcast the node refuses leaves the transaction recorded: the tracker
   * rebroadcasts or replaces it.
   */
  private async sendRecorded(driver: TransactionDriver, lease: NonceLease, call: TransactionCall, gasLimit: bigint, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, orderHash: Hex, attempt: number): Promise<InFlightTransaction> {
    const { store, clock } = this.options;
    const sentAtMs = clock.now();
    const sending = driver.send(lease, call, gasLimit, fees, { kind: 'fill', orderHash, attempt }, sentAtMs);
    // The record on the nonce is written before the broadcast; the fill record follows it, whatever the broadcast answered.
    let tx: InFlightTransaction | undefined;
    let broadcastError: unknown;
    try {
      tx = await sending;
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      broadcastError = error;
      tx = (await driver.record(lease))?.transactions.at(-1);
      if (!tx) throw error;
    }
    const sent = tx;
    await store.withOrder(orderHash, async (otx) => {
      const fill = await otx.getFill(attempt);
      const { owner: _o, leaseUntilMs: _l, ...rest } = fill ?? ({} as FillRecord);
      await otx.putFill({ ...rest, orderHash, attempt, chain: driver.chain, amount: fill?.amount ?? '0', txRef: sent.hash, nonce: lease.nonce.toString(), sentAtMs, state: 'sent', updatedAtMs: await store.now() });
    });
    if (broadcastError) this.options.logger.warn('delivery: broadcast refused, the tracker retries it', { orderHash, attempt, txHash: sent.hash, error: reasonOf(broadcastError) });
    return sent;
  }

  /**
   * Extends this replica's claim on a `pending` attempt; false when the claim
   * is no longer this replica's (another one took it over after it expired).
   */
  private async holdClaim(orderHash: Hex, attempt: number): Promise<boolean> {
    const { store, instanceId } = this.options;
    return store.withOrder(orderHash, async (tx) => {
      const fill = await tx.getFill(attempt);
      if (fill?.state !== 'pending' || fill.owner !== instanceId) return false;
      const now = await store.now();
      await tx.putFill({ ...fill, leaseUntilMs: now + this.delivery.nonceLeaseTtlMs, updatedAtMs: now });
      return true;
    });
  }

  /** The amount to send: the hook's, or the offer's `amountOut`. */
  private async amountFor(input: Parameters<FillAmountHook>[0]): Promise<bigint> {
    const hook = this.delivery.fillAmount;
    if (!hook) return input.amountOut;
    const value = await hook(input);
    return typeof value === 'bigint' ? value : BigInt(value);
  }

  // -- allowance --------------------------------------------------------------------

  /**
   * Waits until the router may move `amount` of `token` from the delivery key,
   * approving it when it cannot. `true` when it may; `'retry'` on a read
   * failure; `'lost'` when `hold` reports the attempt's claim gone; otherwise
   * why it never will before the guard. The claim is renewed on every round.
   */
  private async ensureAllowance(driver: TransactionDriver, readers: ChainReaders, token: Hex, amount: bigint, guard: () => boolean, hold: () => Promise<boolean>): Promise<true | 'retry' | 'lost' | string> {
    for (;;) {
      if (!(await hold())) return 'lost';
      let allowance: bigint;
      try {
        allowance = await erc20Allowance(readers.client, token, driver.address, readers.router.address);
      } catch {
        return 'retry';
      }
      if (allowance >= amount) return true;
      if (guard()) return `allowance ${allowance} < ${amount} and no time left to approve`;
      try {
        await this.approve(driver, readers, token, amount, allowance);
      } catch (error) {
        return `approve failed: ${reasonOf(error)}`;
      }
      await this.sleep(this.delivery.pollIntervalMs);
    }
  }

  /** Tops up the configured allowance of `token` on `chain` when it has fallen below half of its limit. */
  private async topUp(chain: EvmChainId, token: Hex): Promise<void> {
    const driver = this.driver(chain);
    const readers = this.options.chains.get(chain);
    const limit = this.limitOf(chain, token);
    if (!driver || !readers || limit === undefined) return;
    try {
      const allowance = await erc20Allowance(readers.client, token, driver.address, readers.router.address);
      if (allowance * 2n < limit) await this.approve(driver, readers, token, 0n, allowance);
    } catch (error) {
      this.options.logger.warn('delivery: allowance top-up failed', { chain, token, error: reasonOf(error) });
    }
  }

  private limitOf(chain: EvmChainId, token: Hex): bigint | undefined {
    const limits = this.delivery.approvals?.[chain];
    if (!limits) return undefined;
    const hit = Object.entries(limits).find(([t]) => t.toLowerCase() === token);
    return hit?.[1];
  }

  /**
   * Sends `approve(router, max(limit, needed))` — once per token at a time:
   * while an approve of this token is in flight on any nonce of the key, no
   * second one is sent. A token that refuses to change a non-zero allowance
   * (USDT) is first approved to zero.
   */
  private approve(driver: TransactionDriver, readers: ChainReaders, token: Hex, needed: bigint, current: bigint): Promise<void> {
    const k = `${driver.chain}:${token}`;
    const running = this.approving.get(k);
    if (running) return running;
    const work = (async () => {
      const open = await this.options.store.nonces.listOpen(driver.chain, driver.address);
      if (open.some((r) => r.transactions.some((t) => t.kind === 'approve' && t.to === token))) return;
      const limit = this.limitOf(driver.chain, token);
      const target = limit !== undefined && limit > needed ? limit : needed;
      const call = (value: bigint): TransactionCall => ({ to: token, data: encodeFunctionCall(APPROVE, [readers.router.address, value]), value: 0n });
      let gasLimit: bigint;
      try {
        gasLimit = await driver.estimateGas(call(target));
      } catch (error) {
        if (!(error instanceof ChainReadError) || error.reason !== 'reverted' || current === 0n) throw error;
        await this.sendApprove(driver, call(0n), await driver.estimateGas(call(0n)), token, 0n);
        return;
      }
      await this.sendApprove(driver, call(target), gasLimit, token, target);
    })().finally(() => this.approving.delete(k));
    this.approving.set(k, work);
    return work;
  }

  private async sendApprove(driver: TransactionDriver, call: TransactionCall, gasLimit: bigint, token: Hex, amount: bigint): Promise<void> {
    const lease = await this.acquire(driver);
    const tx = await driver.send(lease, call, gasLimit, await driver.marketFees(), { kind: 'approve' }, this.options.clock.now());
    this.stage('approve.sent', undefined, undefined, { chain: driver.chain, token, amount: amount.toString(), txHash: tx.hash, nonce: lease.nonce.toString() });
    this.track(driver, lease);
  }

  // -- tracking -----------------------------------------------------------------------

  /** Drives the nonce of `lease` until it is done: confirmed, reverted, cancelled — or the lease is lost. */
  watch(driver: TransactionDriver, lease: NonceLease): void {
    this.track(driver, lease);
  }

  private track(driver: TransactionDriver, lease: NonceLease): void {
    const k = `${driver.chain}:${lease.nonce}`;
    if (this.stopped || this.trackers.has(k)) return;
    const tracker: Tracker = { lease, driver, spentTicks: 0 };
    this.trackers.set(k, tracker);
    const next = () => {
      if (this.stopped || this.trackers.get(k) !== tracker) return;
      tracker.cancel = this.options.clock.schedule(this.delivery.pollIntervalMs, () => {
        void this.tick(tracker)
          .catch((error: unknown) => {
            this.options.logger.warn('delivery: tick failed, retrying', { chain: driver.chain, nonce: tracker.lease.nonce.toString(), error: reasonOf(error) });
            return false;
          })
          .then((done) => (done ? this.trackers.delete(k) : next()));
      });
    };
    next();
  }

  /** One look at a tracked nonce; resolves `true` when there is nothing more to do for it. */
  private async tick(t: Tracker): Promise<boolean> {
    const renewed = await t.driver.renew(t.lease);
    if (!renewed) {
      this.options.logger.warn('delivery: nonce lease lost, another replica drives it', { chain: t.driver.chain, nonce: t.lease.nonce.toString() });
      return true;
    }
    t.lease = renewed;
    const record = await t.driver.record(renewed);
    if (!record || record.transactions.length === 0) return true;
    const txs = record.transactions;
    for (const tx of [...txs].reverse()) {
      const receipt = await t.driver.receipt(tx.hash);
      if (!receipt) continue;
      const canonical = await t.driver.client.block(receipt.blockNumber);
      if (canonical.hash !== receipt.blockHash) break; // a reorg is under way: look again next tick
      const depth = (await t.driver.client.head()) - receipt.blockNumber + 1n;
      return this.included(t, tx, receipt, depth, txs);
    }
    return this.pending(t, txs);
  }

  private confirmations(chain: EvmChainId): bigint {
    const config = this.options.chains.get(chain)?.config;
    return BigInt(Math.max(1, config?.fillConfirmations ?? config?.openConfirmations ?? 1));
  }

  /** A transaction of the nonce is in a block, `depth` deep. */
  private async included(t: Tracker, tx: InFlightTransaction, receipt: TransactionReceipt, depth: bigint, txs: readonly InFlightTransaction[]): Promise<boolean> {
    const { store } = this.options;
    const chain = t.driver.chain;
    if (tx.kind === 'settle') {
      if (depth < this.confirmations(chain)) return false;
      await this.settleListener?.(chain, tx, receipt);
      await store.nonces.complete(t.lease, tx.hash);
      return true;
    }
    if (tx.kind !== 'fill' || !tx.orderHash || tx.attempt === undefined) {
      if (tx.kind === 'cancel') await this.cancelled(chain, tx, txs, receipt);
      else this.stage(tx.kind === 'approve' ? 'approve.confirmed' : 'tx.confirmed', tx.orderHash, tx.attempt, { chain, kind: tx.kind, txHash: tx.hash, status: receipt.status, gasUsed: receipt.gasUsed.toString() });
      await store.nonces.complete(t.lease, tx.hash);
      return true;
    }
    const orderHash = tx.orderHash;
    const attempt = tx.attempt;
    if (t.includedIn !== receipt.blockHash) {
      t.includedIn = receipt.blockHash;
      const header = await t.driver.rawBlock(receipt.blockNumber);
      const received = this.receivedOf(receipt, orderHash);
      await store.withOrder(orderHash, async (otx) => {
        // No fill record: the replica that sent it died between the nonce journal and the record (N-15).
        const fill = (await otx.getFill(attempt)) ?? this.fillOf(chain, tx, await store.now());
        if (fill.state === 'confirmed' || fill.state === 'failed') return;
        await otx.putFill({
          ...fill,
          txRef: tx.hash,
          state: 'included',
          ...(received !== undefined ? { received: received.toString() } : {}),
          inclusion: { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, header, receipt: receipt.raw, seenAtMs: this.options.clock.now() },
          updatedAtMs: await store.now(),
        });
      });
      this.stage('fill.included', orderHash, attempt, { chain, txHash: tx.hash, block: receipt.blockNumber.toString(), status: receipt.status });
    }
    if (depth < this.confirmations(chain)) return false;

    if (receipt.status === 0) {
      await this.fail(orderHash, attempt, `reverted in block ${receipt.blockNumber}`);
      this.stage('fill.reverted', orderHash, attempt, { chain, txHash: tx.hash, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() });
      await store.nonces.complete(t.lease, tx.hash);
      return true;
    }
    const confirmed = await store.withOrder(orderHash, async (otx) => {
      const fill = await otx.getFill(attempt);
      if (!fill || fill.state === 'confirmed') return undefined;
      const now = await store.now();
      await otx.putFill({ ...fill, txRef: tx.hash, state: 'confirmed', updatedAtMs: now });
      const ticket = await otx.getTicket(attempt);
      if (ticket?.state === 'receipted') await otx.putTicket({ ...ticket, state: 'filled', updatedAtMs: now });
      return fill;
    });
    if (confirmed) {
      const first = txs[0]!;
      this.emit({ type: 'filled', orderHash, attempt, txHash: tx.hash, amount: confirmed.amount });
      this.stage('fill.confirmed', orderHash, attempt, {
        chain,
        txHash: tx.hash,
        block: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice.toString(),
        replacements: txs.filter((x) => x.kind === 'fill').length - 1,
        latencyMs: (confirmed.inclusion?.seenAtMs ?? this.options.clock.now()) - first.sentAtMs,
      });
      this.options.logger.info('delivery: fill confirmed', { orderHash, attempt, chain, txHash: tx.hash });
      this.options.onFilled?.(orderHash, attempt);
    }
    await store.nonces.complete(t.lease, tx.hash);
    return true;
  }

  /** A fill record rebuilt from the fill on a nonce: the amount is the call's own argument. */
  private fillOf(chain: EvmChainId, tx: InFlightTransaction, now: number): FillRecord {
    const [, amount] = decodeParams(FILL.inputs ?? [], `0x${tx.data.slice(10)}`) as [unknown, bigint];
    return { orderHash: tx.orderHash!, attempt: tx.attempt!, chain, txRef: tx.hash, amount: amount.toString(), state: 'sent', sentAtMs: tx.sentAtMs, updatedAtMs: now };
  }

  /** `Filled.received` of this order in the receipt, when the pinned ABI decodes it. */
  private receivedOf(receipt: TransactionReceipt, orderHash: Hex): bigint | undefined {
    for (const log of receipt.logs) {
      if (log.topics[0] !== FILLED_TOPIC) continue;
      try {
        const args = decodeEventLog(FILLED, { topics: [...log.topics], data: log.data });
        if (String(args.orderHash).toLowerCase() !== orderHash) continue;
        const value = args.received ?? args.amount;
        return typeof value === 'bigint' ? value : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /** The cancel of an expired fill is in: the fill never happened. */
  private async cancelled(chain: EvmChainId, tx: InFlightTransaction, txs: readonly InFlightTransaction[], receipt: TransactionReceipt): Promise<void> {
    const fill = txs.find((x) => x.kind === 'fill' && x.orderHash);
    if (!fill?.orderHash || fill.attempt === undefined) return;
    await this.fail(fill.orderHash, fill.attempt, 'cancelled: validUntil passed before the fill was included');
    this.stage('fill.cancelled', fill.orderHash, fill.attempt, { chain, txHash: tx.hash, block: receipt.blockNumber.toString() });
  }

  /** No transaction of the nonce is in a block: resend, replace or cancel. */
  private async pending(t: Tracker, txs: readonly InFlightTransaction[]): Promise<boolean> {
    const { clock, logger, store } = this.options;
    const driver = t.driver;
    const last = txs.at(-1)!;
    const fill = txs.find((x) => x.kind === 'fill' && x.orderHash && x.attempt !== undefined);

    if (t.includedIn) {
      t.includedIn = undefined;
      if (fill?.orderHash && fill.attempt !== undefined) {
        const { orderHash, attempt } = fill;
        await store.withOrder(orderHash, async (otx) => {
          const record = await otx.getFill(attempt);
          // The proof of the last inclusion stays: past validUntil it is what shows the fill happened (R-3).
          if (record?.state === 'included') await otx.putFill({ ...record, state: 'sent', updatedAtMs: await store.now() });
        });
        this.stage('fill.reorged', orderHash, attempt, { chain: driver.chain, txHash: last.hash });
        logger.warn('delivery: the fill was reorged out', { orderHash, attempt, chain: driver.chain });
      }
    }

    if ((await driver.transactionCount('latest')) > t.lease.nonce) {
      // Spent, with no receipt of ours: receipts may lag; past that, another transaction took the nonce.
      if (++t.spentTicks < SPENT_TICKS) return false;
      if (fill?.orderHash && fill.attempt !== undefined) {
        // Only this delivery key can fill the order: filled(orderHash) means one of its fills executed, whatever an endpoint's receipts say.
        const executed = await this.executedFill(t, fill, txs);
        if (executed !== 'not-filled') return executed;
      }
      logger.error('delivery: the nonce was spent by a transaction this replica did not record', { chain: driver.chain, nonce: t.lease.nonce.toString() });
      if (fill?.orderHash && fill.attempt !== undefined) await this.fail(fill.orderHash, fill.attempt, 'its nonce was spent by another transaction');
      await store.nonces.complete(t.lease, ZERO_HASH);
      return true;
    }
    t.spentTicks = 0;

    const stale = clock.now() - last.sentAtMs >= this.delivery.replaceAfterMs;
    if (fill && last.kind !== 'cancel') {
      const validUntil = (t.validUntil ??= await this.validUntilOf(fill));
      if (validUntil !== undefined && (await driver.chainTime()) > validUntil) return this.cancel(t, last, fill).then(() => false);
      if (stale && validUntil !== undefined && clock.now() <= Number(validUntil) * 1000) return this.replace(t, last, fill).then(() => false);
    } else if (stale) {
      return this.replace(t, last, fill).then(() => false);
    }
    if (!(await driver.known(last.hash))) {
      // Dropped from the mempool or reorged out: the same bytes again (T-30: resend while the ticket is live).
      await driver.broadcast(last);
      logger.info('delivery: rebroadcast', { chain: driver.chain, nonce: t.lease.nonce.toString(), kind: last.kind, txHash: last.hash });
    }
    return false;
  }

  /**
   * The nonce of a fill looks spent with no receipt of ours. When the router
   * holds a fill for the order, its `Filled` log names the transaction: that
   * receipt goes through the inclusion path; without a log or a receipt yet
   * the nonce stays tracked (an endpoint lagging, a reorg under way) — never
   * failed. `'not-filled'` when the router holds no fill.
   */
  private async executedFill(t: Tracker, fill: InFlightTransaction, txs: readonly InFlightTransaction[]): Promise<boolean | 'not-filled'> {
    const readers = this.options.chains.get(t.driver.chain);
    if (!readers || !(await readers.router.filled(fill.orderHash!))) return 'not-filled';
    t.spentTicks = 0;
    const head = await t.driver.client.head();
    const logs = await t.driver.client.request<Array<{ transactionHash?: string }>>('eth_getLogs', [
      { address: readers.router.address, topics: [FILLED_TOPIC, fill.orderHash], fromBlock: toQuantity(head > FILLED_LOOKBACK ? head - FILLED_LOOKBACK : 0n), toBlock: 'latest' },
    ]);
    const hash = logs.find((l) => typeof l.transactionHash === 'string')?.transactionHash?.toLowerCase() as Hex | undefined;
    const receipt = hash ? await t.driver.receipt(hash) : undefined;
    if (!hash || !receipt) {
      this.options.logger.warn('delivery: the router holds the fill, its receipt is not visible yet', { orderHash: fill.orderHash, chain: t.driver.chain, txHash: hash });
      return false;
    }
    const ours = txs.find((x) => x.hash === hash) ?? { ...fill, hash };
    return this.included(t, ours, receipt, head - receipt.blockNumber + 1n, txs);
  }

  /** Replace-by-fee: the same call on the same nonce, both fees raised. */
  private async replace(t: Tracker, last: InFlightTransaction, fill: InFlightTransaction | undefined): Promise<void> {
    let fees;
    try {
      fees = await t.driver.replacementFees(last);
    } catch (error) {
      if (!(error instanceof FeeCeilingError)) throw error;
      this.options.logger.warn('delivery: replacement above the fee ceiling, not sent', { chain: t.driver.chain, nonce: t.lease.nonce.toString(), error: error.message });
      return;
    }
    const tx = await t.driver.send(t.lease, { to: last.to, data: last.data, value: last.value }, last.gasLimit, fees, { kind: last.kind, ...(last.orderHash ? { orderHash: last.orderHash } : {}), ...(last.attempt !== undefined ? { attempt: last.attempt } : {}) }, this.options.clock.now());
    if (tx.kind === 'fill' && tx.orderHash && tx.attempt !== undefined) await this.setTxRef(tx.orderHash, tx.attempt, tx.hash);
    this.stage(tx.kind === 'fill' ? 'fill.replaced' : 'tx.replaced', fill?.orderHash, fill?.attempt, {
      chain: t.driver.chain,
      kind: tx.kind,
      nonce: t.lease.nonce.toString(),
      from: last.hash,
      txHash: tx.hash,
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
    });
  }

  /** The fill can no longer succeed (the chain is past `validUntil`): free its nonce with a zero-value transfer to self. */
  private async cancel(t: Tracker, last: InFlightTransaction, fill: InFlightTransaction): Promise<void> {
    let fees;
    try {
      fees = await t.driver.replacementFees(last);
    } catch (error) {
      if (!(error instanceof FeeCeilingError)) throw error;
      this.options.logger.warn('delivery: cancel above the fee ceiling, the expired fill stays to revert', { chain: t.driver.chain, nonce: t.lease.nonce.toString() });
      return;
    }
    const tx = await t.driver.send(t.lease, { to: t.driver.address, data: '0x', value: 0n }, TRANSFER_GAS, fees, { kind: 'cancel' }, this.options.clock.now());
    this.options.logger.warn('delivery: validUntil passed with the fill pending, cancelling it', { orderHash: fill.orderHash, attempt: fill.attempt, chain: t.driver.chain, txHash: tx.hash });
  }

  private async setTxRef(orderHash: Hex, attempt: number, txHash: Hex): Promise<void> {
    await this.options.store.withOrder(orderHash, async (otx) => {
      const fill = await otx.getFill(attempt);
      if (fill && (fill.state === 'sent' || fill.state === 'pending')) await otx.putFill({ ...fill, txRef: txHash, updatedAtMs: await this.options.store.now() });
    });
  }

  private async validUntilOf(fill: InFlightTransaction): Promise<bigint | undefined> {
    const ticket = await this.options.store.withOrder(fill.orderHash!, (tx) => tx.getTicket(fill.attempt!));
    const raw = ticket?.issued?.form === 'evm' ? ticket.issued.ticket.validUntil : undefined;
    return raw === undefined ? undefined : BigInt(raw);
  }

  private async fail(orderHash: Hex, attempt: number, reason: string): Promise<void> {
    await this.options.store.withOrder(orderHash, async (otx) => {
      const fill = await otx.getFill(attempt);
      if (fill && fill.state !== 'confirmed' && fill.state !== 'failed') await otx.putFill({ ...fill, state: 'failed', reason, updatedAtMs: await this.options.store.now() });
    });
  }

  // -- outcomes -------------------------------------------------------------------------

  /** Not sent. `release`: the attempt was claimed, and is closed `failed` so no replica sends it later. */
  private async refuse(orderHash: Hex, attempt: number, reason: FillRefusal, detail: string, release = false): Promise<DeliveryResult> {
    if (release) await this.fail(orderHash, attempt, `${reason}: ${detail}`);
    this.options.logger.warn('delivery: not sent', { orderHash, attempt, reason, detail });
    this.stage('fill.refused', orderHash, attempt, { reason, detail: detail.slice(0, 256) });
    return { status: 'refused', reason, detail };
  }

  /** A transient failure: the claim is released and the attempt tried again while the guard allows. */
  private async retry(orderHash: Hex, attempt: number, validUntilMs: number, readers: ChainReaders, detail: string): Promise<DeliveryResult> {
    const { clock, store, instanceId } = this.options;
    await store.withOrder(orderHash, async (otx) => {
      const fill = await otx.getFill(attempt);
      if (fill?.state === 'pending' && fill.owner === instanceId) await otx.putFill({ ...fill, leaseUntilMs: 0, updatedAtMs: await store.now() });
    });
    const at = clock.now() + this.delivery.pollIntervalMs;
    if (at + readers.config.sendGuardSec * 1000 > validUntilMs) return this.refuse(orderHash, attempt, 'send-guard', `no time left to try again after: ${detail}`, true);
    if (!this.stopped) clock.schedule(this.delivery.pollIntervalMs, () => void this.deliver(orderHash, attempt));
    this.options.logger.warn('delivery: not sent yet, retrying', { orderHash, attempt, detail });
    return { status: 'waiting', detail };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.options.clock.schedule(ms, resolve));
  }

  private stage(stage: FillerStage, orderHash: Hex | undefined, attempt: number | undefined, detail: Readonly<Record<string, string | number | boolean>>): void {
    this.emit({ type: 'stage', stage, atMs: this.options.clock.now(), ...(orderHash ? { orderHash } : {}), ...(attempt !== undefined ? { attempt } : {}), detail });
  }

  private emit(event: FillerEvent): void {
    try {
      const result = this.options.events.emit(event);
      if (result instanceof Promise) result.catch((error: unknown) => this.options.logger.warn('event sink failed', { error: String(error) }));
    } catch (error) {
      this.options.logger.warn('event sink failed', { error: String(error) });
    }
  }
}
