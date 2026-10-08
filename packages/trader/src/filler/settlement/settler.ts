/**
 * `SettlementTracker` — getting paid for a delivery on an EVM source
 * (fillers.md §4.7 T-33, T-34, R-4, R-12; protocol §10 D-N, T-7; sdk.md S14).
 *
 * The filler settles its own fills; Cancore does not.
 *
 * - **Two channels, one set.** The attestor signatures arrive only from
 *   filler-gateway: pushed as `settle.attestations` on the session, and pulled
 *   from `GET /v1/filler/attestations/{orderHash}` for every confirmed fill
 *   without a settlement — after the fill, after every login and every
 *   `pullIntervalMs`, until `refundAfter`. Whichever arrives first is kept
 *   (deduplicated by `orderHash` + `attempt`); the node never polls attestors.
 * - **Verify before sending.** The proof must be the filler's own: its fill
 *   (`fillRef`, `amountDelivered`, `recipient`, `outputAsset`, `attempt`), its
 *   `fillerId`, the `repayTo` of its ticket, and `setId =
 *   attestationSetFor(orderHash)` on the source router — never `currentSetId`.
 *   Every signature must recover to a non-revoked member of that set over that
 *   one digest; the lowest `threshold` signers go, strictly ascending. A proof
 *   that differs from the filler's own is a divergence: an alert, nothing sent.
 * - **`eth_call` first.** `settle(order, proof, sigs)` is simulated on the source
 *   router; a revert is named and nothing is sent. `IntentNotOpen` on an
 *   intent someone else settled is a success, not an error (L7).
 * - **Alerts** (R-4): a confirmed fill not settled by half its proof window,
 *   and one still unsettled `alertBeforeRefundMs` before `refundAfter`
 *   (filler-node `settle.alertBeforeRefundSec`); a refund that won the race.
 */
import {
  CANCORE_ROUTER_ABI,
  CANCORE_ROUTER_ERRORS,
  PROOF_KIND_ATTESTATION,
  describeRevert,
  fillerIdHash,
  settleAttestationsErrors,
  settleAttestationsPayload,
  type AttestationEvm,
  type FillProofJson,
  type Hex,
  type OrderJson,
  type OrderSettled,
  type SettleAttestationsPayload,
  type TicketIssuedEvm,
} from '@cancore/contracts';
import { encodeFunctionCall, entryOf, type AbiEntry } from '../chain/abi';
import { ChainReadError } from '../chain/client';
import { INTENT_STATUS, type FillerChains } from '../chain';
import { evmChainNumber, type EvmChainId } from '../chains';
import type { Executor } from '../delivery/executor';
import { FeeCeilingError, LeaseLostError, type TransactionCall, type TransactionReceipt } from '../delivery/transactions';
import type { EventSink, FillerEvent, FillerStage } from '../events';
import type { Delivery, FillerProtocolClient } from '../protocol/client';
import type { Cancel, Clock, Logger } from '../runtime';
import type { FillRecord, FillerStore, InFlightTransaction, NonceLease, SettlementRecord, TicketRecord } from '../store';
import { chainsOf, orderOf } from '../tickets/terms';
import { collectAttestations, fillProofOf } from './attestations';

export interface SettlementOptions {
  /** How often confirmed fills without a settlement pull their attestations (filler-node `settle.pullIntervalSec`). Default 15 s. */
  pullIntervalMs?: number;
  /** An unsettled fill this close to `refundAfter` raises an alert (filler-node `settle.alertBeforeRefundSec`). Default 1 h. */
  alertBeforeRefundMs?: number;
}

export const DEFAULT_SETTLEMENT = { pullIntervalMs: 15_000, alertBeforeRefundMs: 3_600_000 } as const;

/** Why `selfSettle` sent nothing. */
export type SettleRefusal =
  /** No confirmed fill of this filler for the order. */
  | 'no-fill'
  /** A Canton source settles with `SwapIntent_SettleWithProof`, not here. */
  | 'canton-source'
  /** No fill key (delivery key) or router for the source chain. */
  | 'no-delivery-key'
  /** filler-gateway holds no attestation set for the fill yet. */
  | 'not-ready'
  /** The payload does not describe the filler's own fill, ticket or set. */
  | 'mismatch'
  /** The signatures are over a proof other than the filler's own. */
  | 'divergent'
  /** Fewer than `threshold` signatures recover to non-revoked members of the set. */
  | 'insufficient-signatures'
  /** The set of `attestationSetFor(orderHash)` no longer verifies (the intent outlived its grace). */
  | 'set-not-active'
  /** The intent is settled already (by this filler or anyone). */
  | 'already-settled'
  /** The maker refunded first (R-5). */
  | 'refunded'
  /** `eth_call` of `settle` reverted: `detail` names the error. */
  | 'reverted'
  /** Priced above `maxFeePerGasWei`. */
  | 'fee-ceiling'
  /** A source chain read failed; try again. */
  | 'unavailable';

export class SettleError extends Error {
  override readonly name = 'SettleError';
  constructor(
    readonly reason: SettleRefusal,
    readonly detail: string,
  ) {
    super(`settle: ${reason}: ${detail}`);
  }
}

export interface SettlerOptions {
  store: FillerStore;
  chains: FillerChains;
  executor: Executor;
  protocol: FillerProtocolClient;
  fillerId: string;
  instanceId: string;
  clock: Clock;
  logger: Logger;
  events: EventSink;
  settlement?: SettlementOptions;
}

const ROUTER_ABI = CANCORE_ROUTER_ABI as unknown as readonly AbiEntry[];
const SETTLE = entryOf(ROUTER_ABI, 'function', 'settle');
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
/**
 * Nothing more to do for the settlement: confirmed, settled, or lost to a refund.
 * A `failed` settle for any other reason, and a `sent` one whose nonce was lost,
 * are retried while the intent is open and `refundAfter` has not come.
 */
const isTerminal = (s: SettlementRecord | undefined): boolean =>
  s?.state === 'confirmed' || s?.state === 'settled' || (s?.state === 'failed' && (s.reason?.startsWith('refunded') ?? false));
const decoder = new TextDecoder();

const lower = (value: unknown): string => String(value).toLowerCase();
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function revertName(error: unknown): string {
  const cause = error instanceof ChainReadError ? error.cause : error;
  const data = typeof cause === 'object' && cause !== null ? (cause as { data?: unknown }).data : undefined;
  const hex = typeof data === 'string' ? data : typeof data === 'object' && data !== null && typeof (data as { data?: unknown }).data === 'string' ? (data as { data: string }).data : undefined;
  return (hex && /^0x[0-9a-fA-F]{8}/.test(hex) ? describeRevert(hex, [CANCORE_ROUTER_ERRORS]) : undefined) ?? reasonOf(error);
}

/** What one order's settlement works from. */
interface Settleable {
  orderHash: Hex;
  fill: FillRecord;
  ticket: TicketRecord;
  order: OrderJson;
  settlement?: SettlementRecord;
  payload?: SettleAttestationsPayload;
  channel?: 'ws' | 'rest';
  /** Why the set held for the fill failed verification (`<SettleRefusal>: <detail>`). */
  rejected?: string;
}

export class Settler {
  private readonly settings: Required<SettlementOptions>;
  private readonly busy = new Map<string, Promise<Hex>>();
  /** Alerts raised in this process, `${orderHash}:${kind}`: once each. */
  private readonly alerted = new Set<string>();
  /** `attested` emitted in this process, by `${orderHash}:${attempt}`. */
  private readonly attested = new Set<string>();
  private timer: Cancel | undefined;
  private stopped = false;

  constructor(private readonly options: SettlerOptions) {
    this.settings = { ...DEFAULT_SETTLEMENT, ...options.settlement };
  }

  register(): void {
    const { protocol, executor } = this.options;
    protocol.on('settle.attestations', (d) => this.onAttestations(d));
    protocol.on('order.settled', async (d) => this.onOrderSettled(d));
    protocol.onLogin(() => void this.sweep());
    executor.onSettleIncluded((chain, tx, receipt) => this.onIncluded(chain, tx, receipt));
    executor.onSettleLost((chain, tx) => this.onLost(chain, tx));
  }

  /** Sweeps now and then every `pullIntervalMs`. */
  start(): void {
    this.stopped = false;
    const loop = () => {
      this.timer = this.options.clock.schedule(this.settings.pullIntervalMs, () => {
        if (this.stopped) return;
        void this.sweep().finally(loop);
      });
    };
    void this.sweep();
    loop();
  }

  stop(): void {
    this.stopped = true;
    this.timer?.();
  }

  /** A fill was confirmed: its attestations are pulled at once. */
  onFilled(orderHash: Hex): void {
    void this.pull(orderHash).then((got) => (got ? undefined : this.options.logger.debug('settle: attestations not ready yet', { orderHash })));
  }

  // -- frames --------------------------------------------------------------------

  /** A `settle.attestations` from either channel: kept once per attempt, then settled. */
  async onAttestations(delivery: Delivery): Promise<void> {
    const frame = delivery.frame as Record<string, unknown>;
    if (!HEX32.test(String(frame.orderHash)) || !Number.isSafeInteger(frame.attempt)) {
      this.options.logger.warn('settle: malformed settle.attestations ignored');
      return;
    }
    const orderHash = lower(frame.orderHash) as Hex;
    const attempt = frame.attempt as number;
    const kept = await this.options.store.withOrder(orderHash, async (tx) => {
      const existing = await tx.getAttestations(attempt);
      // The first set wins; a later one only replaces a set that failed verification.
      if (existing && existing.verified) return false;
      if (existing && !existing.reason) return false;
      await tx.putAttestations({ orderHash, attempt, channel: delivery.channel, raw: delivery.raw, verified: false, receivedAtMs: this.options.clock.now() });
      return true;
    });
    if (!kept) return;
    this.stage('attestations.received', orderHash, attempt, { channel: delivery.channel });
    try {
      await this.settle(orderHash);
    } catch (error) {
      if (!(error instanceof SettleError)) this.options.logger.error('settle: failed', { orderHash, error: reasonOf(error) });
    }
  }

  /** `order.settled`, after the chain event is final: the settlement is done; the `settled` event. */
  async onOrderSettled(delivery: Delivery): Promise<void> {
    const s = delivery.frame as unknown as OrderSettled;
    if (!HEX32.test(String(s.orderHash))) return;
    const orderHash = lower(s.orderHash) as Hex;
    await this.options.store.withOrder(orderHash, async (tx) => {
      const current = await tx.getSettlement();
      if (current?.orderSettled) return;
      const attempt = current?.attempt ?? (await tx.listTickets()).find((t) => t.state === 'filled')?.attempt ?? 0;
      await tx.putSettlement({ ...current, orderHash, attempt, state: 'settled', orderSettled: s, updatedAtMs: await this.options.store.now() });
    });
    if (delivery.firstSeen) this.emit({ type: 'settled', orderHash, payout: s.payout, penaltyWithheld: s.penaltyWithheld, txRef: s.txRef });
  }

  // -- the sweep -----------------------------------------------------------------------

  /** Every confirmed fill without a settlement: pull, settle, alert. */
  async sweep(): Promise<void> {
    let orders: readonly Hex[];
    try {
      orders = await this.options.store.listOpenOrders();
    } catch (error) {
      this.options.logger.warn('settle: sweep failed', { error: reasonOf(error) });
      return;
    }
    for (const orderHash of orders) {
      try {
        const s = await this.load(orderHash);
        if (!s || isTerminal(s.settlement)) continue;
        const source = chainsOf(s.order)?.source;
        if (!source) continue;
        // The alerts run for a settle in flight or one that failed, too.
        const { status, refundAfter } = await this.checkWindow(s, source);
        if (status !== INTENT_STATUS.Opened || s.settlement?.state === 'sent') continue;
        if (BigInt(Math.floor(this.options.clock.now() / 1000)) >= refundAfter) continue;
        if (s.payload) await this.settle(orderHash).catch((error: unknown) => this.quiet(orderHash, error));
        else await this.pull(orderHash);
      } catch (error) {
        this.options.logger.warn('settle: sweep of an order failed', { orderHash, error: reasonOf(error) });
      }
    }
  }

  /** Reads the intent; raises the window alerts; closes a refunded or settled intent. Returns its status and `refundAfter`. */
  private async checkWindow(s: Settleable, source: EvmChainId): Promise<{ status: number; refundAfter: bigint }> {
    const readers = this.options.chains.get(source);
    if (!readers) return { status: INTENT_STATUS.None, refundAfter: 0n };
    const intent = await readers.router.intents(s.orderHash);
    if (intent.status === INTENT_STATUS.Refunded) {
      await this.close(s.orderHash, s.fill.attempt, 'failed', 'refunded: the maker refunded before settle (R-5)');
      this.alert(s.orderHash, s.fill.attempt, 'refunded', {});
      return intent;
    }
    if (intent.status === INTENT_STATUS.Settled) {
      await this.close(s.orderHash, s.fill.attempt, 'settled', 'the intent is settled');
      return intent;
    }
    const nowS = BigInt(Math.floor(this.options.clock.now() / 1000));
    const filledAt = s.fill.inclusion ? BigInt(String(s.fill.inclusion.header.timestamp ?? '0')) : undefined;
    if (filledAt !== undefined && filledAt > 0n) {
      const window = await readers.router.proofWindow(s.order.destination);
      if (window > 0n && nowS >= filledAt + window / 2n) this.alert(s.orderHash, s.fill.attempt, 'half-window', { filledAt: filledAt.toString(), proofWindow: window.toString() });
    }
    if (nowS * 1000n + BigInt(this.settings.alertBeforeRefundMs) >= intent.refundAfter * 1000n) {
      this.alert(s.orderHash, s.fill.attempt, 'refund-near', { refundAfter: intent.refundAfter.toString() });
    }
    return intent;
  }

  /** `GET /v1/filler/attestations/{orderHash}`; false while not ready or filler-gateway is unreachable. */
  private async pull(orderHash: Hex): Promise<boolean> {
    try {
      return await this.options.protocol.pullAttestations(orderHash);
    } catch (error) {
      this.options.logger.warn('settle: attestation pull failed', { orderHash, error: reasonOf(error) });
      return false;
    }
  }

  // -- settling --------------------------------------------------------------------------

  /**
   * Settles `orderHash` now from the set held for it, pulling one when there
   * is none. Resolves the `settle` transaction hash; throws `SettleError`.
   */
  async selfSettle(orderHash: Hex): Promise<{ txHash: Hex }> {
    const hash = lower(orderHash) as Hex;
    const s = await this.load(hash);
    if (s && !s.payload && !isTerminal(s.settlement) && s.settlement?.state !== 'sent') await this.pull(hash);
    return { txHash: await this.settle(hash) };
  }

  /** One worker per order in this process. */
  private settle(orderHash: Hex): Promise<Hex> {
    const running = this.busy.get(orderHash);
    if (running) return running;
    const work = this.run(orderHash).finally(() => this.busy.delete(orderHash));
    this.busy.set(orderHash, work);
    return work;
  }

  private async run(orderHash: Hex): Promise<Hex> {
    const { store, instanceId, executor, clock } = this.options;
    const s = await this.load(orderHash);
    if (!s) throw new SettleError('no-fill', 'no confirmed fill of this filler for the order');
    const attempt = s.fill.attempt;
    const settled = s.settlement;
    if (settled?.state === 'settled') throw new SettleError('already-settled', 'the intent is settled');
    if (settled?.txHash && (settled.state === 'sent' || settled.state === 'confirmed')) return settled.txHash;
    if (settled?.state === 'failed' && settled.reason?.startsWith('refunded')) throw new SettleError('refunded', settled.reason);

    const chains = chainsOf(s.order);
    if (!chains?.source) throw new SettleError('canton-source', 'the source is not an EVM chain: SwapIntent_SettleWithProof');
    const source = chains.source;
    const readers = this.options.chains.get(source);
    const driver = executor.driver(source);
    if (!readers || !driver) throw new SettleError('no-delivery-key', `no fill key or router for the source ${source}`);
    if (!s.payload) {
      const [reason, ...detail] = (s.rejected ?? '').split(': ');
      if (s.rejected) throw new SettleError(reason as SettleRefusal, detail.join(': '));
      throw new SettleError('not-ready', 'filler-gateway holds no attestation set for the fill yet');
    }

    const sigs = await this.verify(s, source, readers);
    const call: TransactionCall = { to: readers.router.address, data: encodeFunctionCall(SETTLE, [orderOf(s.order), fillProofOf(s.payload.proof), sigs.map((x) => x.signature)]), value: 0n };

    // eth_call first: a revert is named and nothing is sent (T-34).
    try {
      await readers.client.call(call.to, call.data);
    } catch (error) {
      if (!(error instanceof ChainReadError) || error.reason !== 'reverted') throw new SettleError('unavailable', reasonOf(error));
      const name = revertName(error);
      if (name.startsWith('IntentNotOpen')) {
        const status = (await readers.router.intents(orderHash)).status;
        if (status === INTENT_STATUS.Settled) {
          await this.close(orderHash, attempt, 'settled', 'settled by another transaction');
          throw new SettleError('already-settled', 'the intent was settled by another transaction');
        }
        if (status === INTENT_STATUS.Refunded) {
          await this.close(orderHash, attempt, 'failed', 'refunded: the maker refunded before settle (R-5)');
          this.alert(orderHash, attempt, 'refunded', {});
          throw new SettleError('refunded', 'the maker refunded before settle');
        }
      }
      this.stage('settle.refused', orderHash, attempt, { reason: 'reverted', error: name });
      throw new SettleError('reverted', name);
    }

    // Claim the settlement: one sender across replicas while the claim lasts.
    const claimed = await store.withOrder(orderHash, async (tx) => {
      const current = await tx.getSettlement();
      const now = await store.now();
      if (current && (isTerminal(current) || current.state === 'sent')) return false;
      if (current?.state === 'pending' && current.owner !== instanceId && (current.leaseUntilMs ?? 0) > now) return false;
      await tx.putSettlement({ orderHash, attempt, state: 'pending', chain: source, owner: instanceId, leaseUntilMs: now + 60_000, updatedAtMs: now });
      return true;
    });
    if (!claimed) {
      const current = await store.withOrder(orderHash, (tx) => tx.getSettlement());
      // Only a settle in flight or confirmed answers with its hash; never one that failed.
      if (current?.txHash && (current.state === 'sent' || current.state === 'confirmed')) return current.txHash;
      if (current?.state === 'settled') throw new SettleError('already-settled', 'the intent is settled');
      if (current?.state === 'failed' && current.reason?.startsWith('refunded')) throw new SettleError('refunded', current.reason);
      throw new SettleError('unavailable', 'another replica is settling the order');
    }

    let sent: InFlightTransaction;
    try {
      const recovered = await executor.recoverSettlement(driver, orderHash, attempt, call);
      let lease: NonceLease;
      if (recovered) {
        lease = recovered.lease;
        sent = recovered.tx;
      } else {
        const gasLimit = await driver.estimateGas(call);
        lease = await executor.acquire(driver);
        try {
          sent = await driver.send(lease, call, gasLimit, await driver.marketFees(), { kind: 'settle', orderHash, attempt }, clock.now());
        } catch (error) {
          if (error instanceof LeaseLostError) throw error;
          const record = await driver.record(lease);
          const recorded = record?.transactions.at(-1);
          if (record?.owner !== instanceId || !recorded || recorded.kind !== 'settle' || recorded.orderHash !== orderHash || recorded.attempt !== attempt || recorded.to !== call.to.toLowerCase() || recorded.data !== call.data || recorded.value !== call.value) throw error;
          sent = recorded;
          this.options.logger.warn('settle: broadcast refused, the tracker retries it', { orderHash, attempt, txHash: sent.hash, error: reasonOf(error) });
        }
      }
      if (!(await driver.renew(lease))) throw new LeaseLostError(lease);
      await store.withOrder(orderHash, async (tx) => {
        const current = await tx.getSettlement();
        // A receipt or a newer replica's claim may have arrived while the RPC was pending.
        if (current && (isTerminal(current) || current.state === 'sent')) return;
        const now = await store.now();
        if (current?.state !== 'pending' || current.attempt !== attempt || current.owner !== instanceId || (current.leaseUntilMs ?? 0) <= now) throw new SettleError('unavailable', 'the settlement claim was lost');
        await tx.putSettlement({ orderHash, attempt, state: 'sent', chain: source, txHash: sent.hash, updatedAtMs: now, ...(current.orderSettled ? { orderSettled: current.orderSettled } : {}) });
      });
      executor.watch(driver, lease);
    } catch (error) {
      await this.release(orderHash);
      if (error instanceof FeeCeilingError) throw new SettleError('fee-ceiling', error.message);
      if (error instanceof ChainReadError && error.reason === 'reverted') throw new SettleError('reverted', revertName(error));
      throw new SettleError('unavailable', reasonOf(error));
    }
    this.stage('settle.sent', orderHash, attempt, { chain: source, txHash: sent.hash, signers: sigs.map((x) => x.signer).join(','), maxFeePerGas: sent.maxFeePerGas.toString() });
    this.options.logger.info('settle: sent', { orderHash, attempt, chain: source, txHash: sent.hash });
    return sent.hash;
  }

  /**
   * Holds the payload to the filler's own fill, ticket and set, and keeps the
   * signatures `settle` accepts. Records the verdict on the attestation record;
   * `attested` the first time a set passes.
   */
  private async verify(s: Settleable, source: EvmChainId, readers: NonNullable<ReturnType<FillerChains['get']>>): Promise<AttestationEvm[]> {
    const payload = s.payload!;
    const attempt = s.fill.attempt;
    const fail = async (reason: SettleRefusal, detail: string): Promise<never> => {
      await this.options.store.withOrder(s.orderHash, async (tx) => {
        const record = await tx.getAttestations(attempt);
        if (record) await tx.putAttestations({ ...record, verified: false, reason: `${reason}: ${detail}` });
      });
      this.stage('settle.refused', s.orderHash, attempt, { reason, detail: detail.slice(0, 256) });
      if (reason === 'divergent' || reason === 'set-not-active' || reason === 'insufficient-signatures' || reason === 'mismatch') this.alert(s.orderHash, attempt, reason, { detail: detail.slice(0, 256) });
      throw new SettleError(reason, detail);
    };

    const errors = settleAttestationsErrors(payload);
    if (errors.length > 0) return fail('mismatch', errors.join('; '));
    if (payload.sourceChainId !== source) return fail('mismatch', `sourceChainId ${payload.sourceChainId} is not the order's source ${source}`);
    if (payload.signatures.some((x) => !('signature' in x) || 'pubKey' in x)) return fail('mismatch', 'not EVM signatures');

    let setId: number;
    let set: Awaited<ReturnType<typeof readers.router.getAttestorSet>>;
    let revoked: Hex[];
    let chainTime: bigint;
    try {
      setId = await readers.router.attestationSetFor(s.orderHash);
      set = await readers.router.getAttestorSet(setId);
      revoked = (await Promise.all(set.members.map(async (m) => ((await readers.router.revokedAttestors(m)) ? m : undefined)))).filter((m): m is Hex => m !== undefined);
      chainTime = await this.options.executor.driver(source)!.chainTime();
    } catch (error) {
      throw new SettleError('unavailable', reasonOf(error));
    }
    if (payload.setId !== setId) return fail('mismatch', `setId ${payload.setId} is not attestationSetFor(orderHash) = ${setId}`);
    if (chainTime < set.activeFrom || (set.retiredAt !== 0n && chainTime >= set.retiredAt)) return fail('set-not-active', `set ${setId} verifies from ${set.activeFrom} to ${set.retiredAt || '∞'}, chain time ${chainTime}`);

    const expected = this.expectedProof(s, setId);
    const own = this.ownMismatch(s, payload.proof);
    if (own) return fail('divergent', own);
    const collected = collectAttestations({
      answers: [{ proof: payload.proof, signatures: payload.signatures as AttestationEvm[] }],
      source: { chainId: evmChainNumber(source), router: readers.router.address },
      set: { setId, members: set.members, threshold: set.threshold, revoked },
      expected,
    });
    if (collected.divergent) return fail('divergent', `the attested proof is not this filler's own (digests ${collected.digests.join(', ')})`);
    if (!collected.enough) {
      return fail('insufficient-signatures', `${collected.valid.length} valid of threshold ${set.threshold}; rejected ${collected.rejected.map((r) => `${r.signer}:${r.reason}`).join(', ') || 'none'}`);
    }
    await this.options.store.withOrder(s.orderHash, async (tx) => {
      const record = await tx.getAttestations(attempt);
      if (record && !record.verified) await tx.putAttestations({ ...record, verified: true });
    });
    const k = `${s.orderHash}:${attempt}`;
    if (!this.attested.has(k)) {
      this.attested.add(k);
      this.emit({ type: 'attested', orderHash: s.orderHash, attempt, setId, threshold: set.threshold, signers: collected.selected.map((x) => x.signer), refundAfter: payload.refundAfter });
    }
    if (collected.rejected.length > 0) this.options.logger.warn('settle: signatures dropped', { orderHash: s.orderHash, rejected: collected.rejected.map((r) => `${r.signer}:${r.reason}`).join(',') });
    return collected.selected;
  }

  /**
   * The proof of this filler's own fill (sdk.md §3.6): what the attestors
   * should have signed. `amountDelivered` and `filledAt` are taken from the
   * payload where the fill record does not know them; `ownMismatch` bounds them.
   */
  private expectedProof(s: Settleable, setId: number): FillProofJson {
    const issued = s.ticket.issued as TicketIssuedEvm;
    const header = s.fill.inclusion?.header;
    return {
      kind: PROOF_KIND_ATTESTATION,
      orderHash: s.orderHash,
      destination: lower(s.order.destination) as Hex,
      fillRef: lower(s.fill.txRef) as Hex,
      recipient: lower(s.order.recipient) as Hex,
      outputAsset: lower(s.order.outputAsset) as Hex,
      amountDelivered: s.fill.received ?? s.payload!.proof.amountDelivered,
      filledAt: header?.timestamp !== undefined ? BigInt(String(header.timestamp)).toString() : s.payload!.proof.filledAt,
      fillerId: fillerIdHash(this.options.fillerId),
      repayTo: lower(issued.ticket.repayTo) as Hex,
      attempt: s.fill.attempt,
      setId,
    };
  }

  /** The first field of `proof` that is not this filler's own fill, ticket or identity; undefined when it is. */
  private ownMismatch(s: Settleable, proof: FillProofJson): string | undefined {
    const issued = s.ticket.issued as TicketIssuedEvm;
    if (proof.kind !== PROOF_KIND_ATTESTATION) return `kind ${proof.kind}`;
    if (lower(proof.orderHash) !== s.orderHash) return 'orderHash';
    if (proof.attempt !== s.fill.attempt) return `attempt ${proof.attempt}, filled ${s.fill.attempt}`;
    if (lower(proof.fillRef) !== lower(s.fill.txRef)) return `fillRef ${proof.fillRef}, own fill ${s.fill.txRef}`;
    if (lower(proof.fillerId) !== fillerIdHash(this.options.fillerId)) return 'fillerId';
    if (lower(proof.repayTo) !== lower(issued.ticket.repayTo)) return `repayTo ${proof.repayTo}, ticket ${issued.ticket.repayTo}`;
    const delivered = BigInt(proof.amountDelivered);
    if (s.fill.received !== undefined ? delivered !== BigInt(s.fill.received) : delivered > BigInt(s.fill.amount)) return `amountDelivered ${proof.amountDelivered}`;
    if (delivered < BigInt(s.order.minReceived)) return `amountDelivered ${proof.amountDelivered} below minReceived`;
    return undefined;
  }

  // -- the settle transaction ---------------------------------------------------------------

  /** A `settle` of this replica's is deep enough. */
  private async onIncluded(chain: EvmChainId, tx: InFlightTransaction, receipt: TransactionReceipt): Promise<void> {
    if (!tx.orderHash) return;
    const orderHash = tx.orderHash;
    const attempt = tx.attempt ?? 0;
    if (receipt.status === 1) {
      await this.close(orderHash, attempt, 'confirmed', undefined, tx.hash);
      this.stage('settle.confirmed', orderHash, attempt, { chain, txHash: tx.hash, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() });
      return;
    }
    // Reverted: someone settled or refunded first, or the set stopped verifying.
    const readers = this.options.chains.get(chain);
    const status = readers ? (await readers.router.intents(orderHash)).status : INTENT_STATUS.None;
    if (status === INTENT_STATUS.Settled) await this.close(orderHash, attempt, 'settled', 'settled by another transaction');
    else if (status === INTENT_STATUS.Refunded) {
      await this.close(orderHash, attempt, 'failed', 'refunded: the maker refunded before settle (R-5)');
      this.alert(orderHash, attempt, 'refunded', {});
    } else {
      // Still open: not terminal — the sweep settles again (verified afresh, eth_call first) until refundAfter.
      await this.close(orderHash, attempt, 'failed', `reverted in block ${receipt.blockNumber}`);
      this.alert(orderHash, attempt, 'settle-reverted', { txHash: tx.hash });
    }
    this.stage('settle.reverted', orderHash, attempt, { chain, txHash: tx.hash, block: receipt.blockNumber.toString() });
  }

  /** The nonce of a `settle` of this replica's went to another transaction: it will never be mined; the sweep settles again. */
  private async onLost(chain: EvmChainId, tx: InFlightTransaction): Promise<void> {
    if (!tx.orderHash) return;
    await this.close(tx.orderHash, tx.attempt ?? 0, 'failed', 'its nonce was spent by another transaction');
    this.stage('settle.reverted', tx.orderHash, tx.attempt ?? 0, { chain, txHash: tx.hash, lost: true });
  }

  // -- store --------------------------------------------------------------------------------

  /** The order's confirmed fill with its ticket and the attestation set held for it. */
  private async load(orderHash: Hex): Promise<Settleable | undefined> {
    return this.options.store.withOrder(orderHash, async (tx) => {
      for (const ticket of [...(await tx.listTickets())].reverse()) {
        const fill = await tx.getFill(ticket.attempt);
        if (fill?.state !== 'confirmed' || !ticket.offer || ticket.issued?.form !== 'evm') continue;
        const record = await tx.getAttestations(ticket.attempt);
        const settlement = await tx.getSettlement();
        let payload: SettleAttestationsPayload | undefined;
        let unreadable: string | undefined;
        if (record && (record.verified || !record.reason)) {
          try {
            payload = settleAttestationsPayload(JSON.parse(decoder.decode(record.raw)) as object);
          } catch (error) {
            // A stored frame that does not parse is a failed set: the reason lets the next frame on either channel replace it.
            unreadable = `mismatch: the stored settle.attestations does not parse (${reasonOf(error)})`;
            await tx.putAttestations({ ...record, verified: false, reason: unreadable });
          }
        }
        return {
          orderHash,
          fill,
          ticket,
          order: ticket.offer.order,
          ...(settlement ? { settlement } : {}),
          ...(payload ? { payload, channel: record!.channel } : {}),
          ...(unreadable ? { rejected: unreadable } : record?.reason && !record.verified ? { rejected: record.reason } : {}),
        };
      }
      return undefined;
    });
  }

  private async close(orderHash: Hex, attempt: number, state: SettlementRecord['state'], reason?: string, txHash?: Hex): Promise<void> {
    await this.options.store.withOrder(orderHash, async (tx) => {
      const current = await tx.getSettlement();
      if (current?.state === 'settled' || (current?.state === state && current.reason === reason && state !== 'confirmed')) return;
      const { owner: _o, leaseUntilMs: _l, ...rest } = current ?? ({} as Partial<SettlementRecord>);
      await tx.putSettlement({ ...rest, orderHash, attempt, state, ...(txHash ? { txHash } : {}), ...(reason ? { reason } : {}), updatedAtMs: await this.options.store.now() });
    });
  }

  private async release(orderHash: Hex): Promise<void> {
    await this.options.store.withOrder(orderHash, async (tx) => {
      const current = await tx.getSettlement();
      if (current?.state === 'pending' && current.owner === this.options.instanceId) await tx.putSettlement({ ...current, leaseUntilMs: 0, updatedAtMs: await this.options.store.now() });
    });
  }

  private quiet(orderHash: Hex, error: unknown): void {
    if (error instanceof SettleError) this.options.logger.info('settle: not sent', { orderHash, reason: error.reason, detail: error.detail });
    else this.options.logger.warn('settle: failed', { orderHash, error: reasonOf(error) });
  }

  // -- events -------------------------------------------------------------------------------

  /** An operator alert, once per order and kind in this process: stage `settle.alert` and an error log. */
  private alert(orderHash: Hex, attempt: number, kind: string, detail: Readonly<Record<string, string>>): void {
    const k = `${orderHash}:${kind}`;
    if (this.alerted.has(k)) return;
    this.alerted.add(k);
    this.options.logger.error('settle: alert', { orderHash, attempt, kind, ...detail });
    this.stage('settle.alert', orderHash, attempt, { kind, ...detail });
  }

  private stage(stage: FillerStage, orderHash: Hex, attempt: number, detail: Readonly<Record<string, string | number | boolean>>): void {
    this.emit({ type: 'stage', stage, atMs: this.options.clock.now(), orderHash, attempt, detail });
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
