/**
 * `@cancore/client/selfcustody` — a self-custody Canton account, run entirely
 * by a program.
 *
 * The account's key stays with the caller: every step that needs its authority
 * (the Canton party itself, each leg of a swap, accepting a delivery or a
 * cashback payout) comes back from the API as a prepared hash, the signer signs
 * it here, and only the signature leaves. The API never holds the key; this
 * package never asks for more than a signer.
 *
 *   const signer = await providerFromMnemonic(phrase, { account: 0 }); // @cancore/wallet
 *   const acct = createSelfCustody({ baseUrl, signer });
 *   await acct.session.register({ inviteCode });   // once per account
 *   await acct.onboard();                          // its Canton party + CC receipts
 *   const order = await acct.swap.createForPair({ tradingPairId, sourceAmount, targetAmount });
 *   await acct.make(order.id);                     // … while the other side runs take(order.id)
 *
 * Canton↔Canton orders only: an EVM leg is locked by an EVM key, which is not
 * this signer.
 */
import { signLegs, type OperationLeg } from '@cancore/wallet/operations';
import { createHttp, type Http } from './http';
import { refusalOf } from './refusal';
import { createSession, type AccountUser, type KeySigner, type Session, type SessionOptions } from './session';
import { createSwapClient, TERMINAL_ORDER_STATUSES, type Order, type SwapClient } from './swap';

export { createSession, expiresWithin } from './session';
export type { AccountUser, KeySigner, RegisterInput, Session, SessionOptions } from './session';

/** `HtlcStatus` — where a swap is between its two legs. */
export type HtlcStatus =
  | 'init_request_created'
  | 'proposal_created'
  | 'proposal_accepted'
  | 'proposal_rejected'
  | 'proposal_cancelled'
  | 'htlc_active'
  | 'htlc_claimed'
  | 'htlc_refunded'
  | 'counter_accepted'
  | 'main_claimed'
  | 'both_claimed'
  | 'counter_refunded'
  | 'escrow_compromised';

/** `HtlcSwapResponseDto`, the fields a trading program reads. */
export interface HtlcSwap {
  id: string;
  status: HtlcStatus;
  sender: string;
  receiver: string;
  tokenId: string;
  amount: string;
  counterTokenId?: string | null;
  counterAmount?: string | null;
  hashLock: string;
  timeout: string;
  counterTimeout?: string | null;
  rejectReason?: string | null;
}

/** `TransferInstructionResponseDto` — a transfer waiting for this account to accept it. */
export interface IncomingTransfer {
  contractId: string;
  templateId: string;
  transferId: string;
  sender: string;
  receiver: string;
  amount: string;
  instrumentId: string;
  instrumentAdmin: string;
  memo: string;
  requestedAt: string;
  executeBefore: string;
  /** The swap this transfer delivers, when it delivers one. */
  swapContext?: { swapId: string; orderId: string | null; swapStatus: string; leg: 'main' | 'counter' | 'fee' } | null;
}

/** One document accepted, pinned to the version read. */
export interface ConsentedDocument {
  key: string;
  version: string;
  url: string;
}

/** `LegalConsentStatusDto` */
export interface LegalStatus {
  accepted: boolean;
  /** The document bundle this stand requires, or null when it requires none. */
  requiredVersion: string | null;
}

/** Cashback owed or paid, per token. */
export interface CashbackTokenAmount {
  tokenId: string;
  amount: string;
  swaps: number;
}

export interface CashbackSummary {
  claimable: CashbackTokenAmount[];
  claimed: CashbackTokenAmount[];
  swapsAccrued: number;
  swapsClaimed: number;
  /** A claim is still being paid out; the API refuses a new one until it is. */
  hasPendingClaim: boolean;
}

export interface CashbackPayout {
  id: string;
  tokenId: string;
  amount: string;
  settlementStatus: 'pending' | 'accepted' | 'expired_reclaimed' | 'failed';
  /** The transfer to accept, for a token that is not delivered directly. */
  transferInstructionCid: string | null;
}

export interface CashbackClaim {
  id: string;
  status: 'settling' | 'executed' | 'failed';
  requestedAt: string;
  executedAt: string | null;
  failureReason: string | null;
  payouts?: CashbackPayout[];
}

export interface Executed<TMeta = Record<string, unknown>> {
  meta: TMeta | null;
  /** What the submit answered; null when the operation had nothing to sign. */
  result: unknown;
}

/** How a settled swap's proceeds reached this account. */
export type Delivery =
  /** CC arrives through the account's own TransferPreapproval — nothing to accept. */
  | 'direct'
  /** A registry-token delivery, accepted by this account's signature. */
  | 'accepted'
  /** Not seen within the wait. `acceptIncoming` accepts it whenever it arrives. */
  | 'pending';

export interface Settled {
  swap: HtlcSwap;
  delivery: Delivery;
}

export interface SettleOptions {
  /** HTLC timeout; must be one the stand offers for the order. Default: the shortest it offers. */
  timeoutHours?: number;
  /** Give up waiting on the other side after this long. Default 45 minutes. */
  deadlineMs?: number;
  /** After settlement, how long to wait for a registry-token delivery to accept. Default 5 minutes. */
  deliveryWaitMs?: number;
}

export interface SelfCustodyOptions extends SessionOptions {
  /** Poll interval while waiting on the counterparty or the venue. Default 5 s. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** A settle that cannot finish: the swap went somewhere it cannot come back from, or time ran out. */
export class SettleError extends Error {
  constructor(
    message: string,
    readonly swapId: string | null,
    readonly last?: HtlcSwap | Order,
  ) {
    super(message);
    this.name = 'SettleError';
  }
}

/** A signing ceremony that failed, with what its prepare had already said (a submit failure still knows its swap). */
export class CeremonyError extends Error {
  constructor(
    readonly operation: string,
    readonly stage: 'prepare' | 'submit',
    readonly cause: unknown,
    readonly meta: Record<string, unknown> | null,
  ) {
    super(`${operation} ${stage} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'CeremonyError';
  }
}

export interface SelfCustodyAccount {
  readonly session: Session;
  /** Orders, signed in as this account. */
  readonly swap: SwapClient;
  /** `GET /auth/me` */
  me(): Promise<AccountUser>;
  /**
   * Create the account's Canton party (a topology transaction only its key can
   * sign) and enable CC receipts (a venue-paid TransferPreapproval). Safe to run
   * again: each step that is already done is skipped.
   */
  onboard(): Promise<AccountUser>;
  legalStatus(): Promise<LegalStatus>;
  /**
   * Accept the platform documents, signed with the account key. Orders are
   * refused until the version the stand requires is accepted. `version` and
   * `documents` are the ones the caller actually read — nothing is accepted
   * on their behalf.
   */
  acceptTerms(version: string, documents: ConsentedDocument[]): Promise<void>;
  /** Any wallet operation (`GET /wallet/operations`): prepare, sign every leg, submit. */
  execute<TMeta = Record<string, unknown>>(type: string, params?: Record<string, unknown>): Promise<Executed<TMeta>>;
  swapState(swapId: string): Promise<HtlcSwap>;
  /**
   * The maker's whole side of a Canton↔Canton order: wait until it is taken,
   * open the swap (the escrowed main leg), accept the taker's counter leg and
   * claim — which settles both legs at once. Resumes an order whose swap
   * already exists.
   */
  make(orderId: string, options?: SettleOptions): Promise<Settled>;
  /**
   * The taker's whole side: take the order (unless this account already has),
   * wait for the maker's swap, accept it and fund the counter leg, then wait for
   * settlement and accept the delivery.
   */
  take(orderId: string, options?: SettleOptions): Promise<Settled>;
  /** Transfers waiting for this account's acceptance. */
  incoming(): Promise<IncomingTransfer[]>;
  /** Accept one incoming transfer with this account's signature. */
  accept(transfer: IncomingTransfer): Promise<void>;
  /**
   * Accept every incoming transfer still acceptable — swap deliveries and
   * cashback payouts alike, or the ones `filter` keeps. One refusal does not
   * stop the rest; it is reported in `failed`.
   */
  acceptIncoming(filter?: (transfer: IncomingTransfer) => boolean): Promise<{
    accepted: IncomingTransfer[];
    failed: Array<{ transfer: IncomingTransfer; error: unknown }>;
  }>;
  /** Send from this account. `tokenId` omitted sends CC. */
  send(input: { receiverPartyId: string; amount: string; tokenId?: string; description?: string }): Promise<unknown>;
  /** Merge small holdings into few, one signed batch per call. Returns how many merged; 0 means compact. */
  consolidate(tokenId?: string): Promise<number>;
  /** `GET /tokens/balance/{partyId}/{instrumentId}` */
  balance(instrumentId: string): Promise<{ balance: string; holdingsCount?: number }>;
  /** Partner cashback (role `partner-bot`). */
  readonly cashback: {
    summary(): Promise<CashbackSummary>;
    claims(): Promise<CashbackClaim[]>;
    /** Reserve everything claimable into one claim; the venue then pays it out. */
    claim(): Promise<CashbackClaim>;
    /**
     * Claim, then accept the claim's payouts as they arrive. A CC payout lands
     * directly; a registry-token payout is a transfer only this key can accept.
     * Resolves when every payout is in, or with `pending` > 0 when `waitMs` ran out.
     */
    collect(options?: { waitMs?: number }): Promise<{ claim: CashbackClaim; accepted: IncomingTransfer[]; pending: number }>;
  };
}

const DEFAULT_DEADLINE_MS = 45 * 60_000;
const DEFAULT_DELIVERY_WAIT_MS = 5 * 60_000;
/** Incoming transfers are read from the venue's ledger view — poll them slower than the swap. */
const INCOMING_POLL_FACTOR = 3;
/** Merge passes before one retry of a swap the API refused as too fragmented (one pass merges ~40 holdings). */
const HEAL_MERGE_PASSES = 3;

/** Still waiting on the taker: the maker's swap exists, nobody has accepted it. */
const BEFORE_TAKER: ReadonlySet<HtlcStatus> = new Set(['init_request_created', 'proposal_created']);
/** The maker's counter accept has landed — or the swap is past it. */
const COUNTER_DONE: ReadonlySet<HtlcStatus> = new Set(['counter_accepted', 'main_claimed', 'htlc_claimed', 'both_claimed']);
/** A swap that will not settle any more. */
const DEAD: ReadonlySet<HtlcStatus> = new Set([
  'proposal_rejected',
  'proposal_cancelled',
  'htlc_refunded',
  'counter_refunded',
  'escrow_compromised',
]);

export function createSelfCustody(options: SelfCustodyOptions): SelfCustodyAccount {
  const { baseUrl, signer, pollMs = 5_000, now = Date.now } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const session = createSession(options);
  const http: Http = createHttp({ baseUrl, request: session.request });
  const swap = createSwapClient(http);

  const me = () => http.get<AccountUser>('/auth/me');
  const swapState = (swapId: string) => http.get<HtlcSwap>(`/htlc/${encodeURIComponent(swapId)}`);
  const incoming = () => http.get<IncomingTransfer[]>('/tokens/transfer-requests/incoming');

  async function submit(operationId: string, signatures: Array<{ legId: string; signature: string }>): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await http.post('/wallet/operations/submit', { operationId, signatures });
      } catch (err) {
        if (attempt < 2 && refusalOf(err) === 'retrySameSignatures') {
          await sleep(pollMs);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * prepare → sign every leg → submit. A submit is never re-sent blindly (the
   * operation record is one-shot); only the two answers that say it is safe get
   * a second go — a timeout resubmits the same signatures, and, where the caller
   * allows it, a stale stash re-runs the whole ceremony once.
   */
  async function run<TMeta>(type: string, params: Record<string, unknown> | undefined, rerunOnStalePrepare: boolean): Promise<Executed<TMeta>> {
    for (let attempt = 0; ; attempt++) {
      let prepared: { operationId: string; legs: OperationLeg[]; meta: TMeta | null };
      try {
        prepared = await http.post('/wallet/operations/prepare', { type, ...(params ? { params } : {}) });
      } catch (err) {
        throw new CeremonyError(type, 'prepare', err, null);
      }
      // No legs is a success: the thing is already done, and `meta` says so.
      if (prepared.legs.length === 0) return { meta: prepared.meta, result: null };
      const signatures = await signLegs(signer, prepared.legs);
      try {
        return { meta: prepared.meta, result: await submit(prepared.operationId, signatures) };
      } catch (err) {
        if (rerunOnStalePrepare && attempt === 0 && refusalOf(err) === 'rerunCeremony') continue;
        throw new CeremonyError(type, 'submit', err, prepared.meta as Record<string, unknown> | null);
      }
    }
  }

  const execute = <TMeta = Record<string, unknown>>(type: string, params?: Record<string, unknown>) =>
    run<TMeta>(type, params, false);

  async function accept(transfer: IncomingTransfer): Promise<void> {
    await run('tokens.accept', {
      instructionCid: transfer.contractId,
      templateId: transfer.templateId,
      adminPartyId: transfer.instrumentAdmin,
      executeBefore: transfer.executeBefore,
    }, false);
  }

  async function consolidate(tokenId?: string): Promise<number> {
    const { meta } = await run<{ mergedCount?: number }>('tokens.consolidate', tokenId ? { tokenId } : {}, false);
    return Number(meta?.mergedCount ?? 0);
  }

  async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, deadline: number, what: string, swapId: string | null): Promise<T> {
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (now() >= deadline) {
        throw new SettleError(`timed out waiting for ${what}`, swapId, value as HtlcSwap | Order);
      }
      await sleep(pollMs);
    }
  }

  async function feeRate(): Promise<string> {
    // Null when the stand has no fee configured: nothing to cover.
    const config = await http.get<{ feeRate?: string } | null>('/htlc/fee-config');
    return config?.feeRate ?? '0';
  }

  async function pickTimeout(orderId: string, wanted?: number): Promise<number> {
    const { timeoutHours } = await http.get<{ timeoutHours: number[] }>('/htlc/timeout-options', { orderId });
    if (wanted !== undefined) {
      if (!timeoutHours.includes(wanted)) {
        throw new SettleError(`timeoutHours ${wanted} is not offered for this order (offered: ${timeoutHours.join(', ')})`, null);
      }
      return wanted;
    }
    const shortest = Math.min(...timeoutHours);
    if (!Number.isFinite(shortest)) throw new SettleError('the stand offers no HTLC timeout for this order', null);
    return shortest;
  }

  /** The maker's swap: Flow B step 1 signed here, steps 2–3 finished by the venue inside the submit. */
  async function openSwap(order: Order, preimage: string, timeoutHours: number): Promise<string> {
    const receiver = (order.opponent as { partyId?: string | null } | undefined)?.partyId;
    if (!receiver) throw new SettleError(`order ${order.id} has no counterparty party yet`, null, order);
    const params = {
      tokenId: order.sourceTokenAddress,
      amount: grossAmount(order.sourceAmount, await feeRate()),
      timeoutHours,
      hashLock: await sha256Hex(preimage),
      receiver,
      orderId: order.id,
      // Plaintext: the API stores it encrypted for this account, so a maker that
      // loses the preimage mid-swap reads it back (`GET /htlc/{id}/preimage`)
      // instead of waiting out the timeout for a refund.
      encryptedPreimage: preimage,
    };
    for (let healed = false; ; healed = true) {
      try {
        const { meta } = await run<{ swapId?: string }>('htlc.flow-b-create', params, false);
        if (meta?.swapId) return meta.swapId;
        throw new SettleError('the swap was created but the API did not name it', null, order);
      } catch (err) {
        if (!(err instanceof CeremonyError)) throw err;
        // Too many small holdings for one command: only this key can merge them.
        if (!healed && err.stage === 'prepare' && refusalOf(err.cause) === 'mergeThenRetry') {
          let merged = 0;
          for (let pass = 0; pass < HEAL_MERGE_PASSES; pass++) {
            const n = await consolidate(order.sourceTokenAddress);
            merged += n;
            if (n === 0) break;
          }
          if (merged > 0) continue;
        }
        // A submit failure leaves the swap row the prepare made: it may still
        // commit, so follow it instead of preparing a second swap.
        const swapId = typeof err.meta?.swapId === 'string' ? err.meta.swapId : null;
        if (err.stage === 'submit' && swapId) {
          const recovered = await waitFor(
            () => swapState(swapId),
            (s) => s.status !== 'init_request_created',
            now() + 2 * 60_000,
            'the swap to recover after a failed submit',
            swapId,
          ).catch(() => null);
          if (recovered && !DEAD.has(recovered.status)) return swapId;
        }
        throw err;
      }
    }
  }

  /** The maker accepts the counter leg once the venue has proposed it (a moment after the taker's accept). */
  async function acceptCounter(swapId: string, deadline: number): Promise<void> {
    let state = await waitFor(() => swapState(swapId), (s) => !BEFORE_TAKER.has(s.status), deadline, 'the taker to accept', swapId);
    for (;;) {
      if (COUNTER_DONE.has(state.status)) return;
      if (DEAD.has(state.status)) throw new SettleError(`swap ${swapId} is ${state.status}`, swapId, state);
      try {
        await run('htlc.accept-counter', { swapId }, true);
        return;
      } catch (err) {
        const cause = err instanceof CeremonyError ? err.cause : err;
        if (refusalOf(cause) === 'counterAlreadyAccepted') return;
        if (refusalOf(cause) !== 'counterNotReady') throw err;
      }
      if (now() >= deadline) throw new SettleError('timed out waiting for the counter proposal', swapId, state);
      await sleep(pollMs);
      state = await swapState(swapId);
    }
  }

  /**
   * Wait for the swap to settle while accepting its delivery to this account.
   * The two are watched together because settlement can wait on the delivery:
   * accepting only after `both_claimed` could stall a swap that needs it first.
   */
  async function finish(swapId: string, deliveredTokenId: string, deadline: number, deliveryWaitMs: number): Promise<Settled> {
    let delivery: Delivery = isCc(deliveredTokenId) ? 'direct' : 'pending';
    let settledAt: number | null = null;
    let lastIncomingRead = -Infinity;
    for (;;) {
      const state = await swapState(swapId);
      if (DEAD.has(state.status)) throw new SettleError(`swap ${swapId} is ${state.status}`, swapId, state);
      if (delivery === 'pending' && COUNTER_DONE.has(state.status) && now() - lastIncomingRead >= pollMs * INCOMING_POLL_FACTOR) {
        lastIncomingRead = now();
        const ours = (await incoming()).find((t) => t.swapContext?.swapId === swapId);
        if (ours) {
          await accept(ours);
          delivery = 'accepted';
        }
      }
      if (state.status === 'both_claimed') {
        settledAt ??= now();
        if (delivery !== 'pending' || now() - settledAt >= deliveryWaitMs) return { swap: state, delivery };
      } else if (now() >= deadline) {
        throw new SettleError(`timed out waiting for swap ${swapId} to settle`, swapId, state);
      }
      await sleep(pollMs);
    }
  }

  /**
   * The preimage of a swap this account opened in an earlier run, stored by the
   * API at `openSwap`. The API releases it to the sender only once the counter
   * leg is locked too (BUG-137 atomicity gate: before that it would let the main
   * leg be claimed with nothing locked in return), so it is read only when the
   * claim is next, and waited for while the API still answers null.
   */
  async function storedPreimage(swapId: string, deadline: number): Promise<string> {
    for (;;) {
      const stored = await http.get<{ senderPreimage?: string | null; preimage?: string | null }>(`/htlc/${encodeURIComponent(swapId)}/preimage`);
      const preimage = stored.senderPreimage ?? stored.preimage;
      if (preimage) return preimage;
      if (now() >= deadline) throw new SettleError(`swap ${swapId} exists but its preimage is not recoverable`, swapId);
      await sleep(pollMs);
    }
  }

  function assertCantonOrder(order: Order): void {
    if (order.sourceNetwork !== 'canton' || order.targetNetwork !== 'canton') {
      throw new SettleError(`order ${order.id} is ${order.sourceNetwork}→${order.targetNetwork}; only Canton↔Canton settles here`, null, order);
    }
  }

  async function make(orderId: string, opts: SettleOptions = {}): Promise<Settled> {
    const deadline = now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const order = await waitFor(() => swap.get(orderId), (o) => o.status !== 'open', deadline, `order ${orderId} to be taken`, null);
    assertCantonOrder(order);
    let swapId = order.swapId ?? null;
    // A fresh swap keeps its preimage in memory; a resumed one reads it back right before the claim.
    let preimage: string | null = null;
    if (!swapId) {
      if (TERMINAL_ORDER_STATUSES.has(order.status)) throw new SettleError(`order ${orderId} is ${order.status}`, null, order);
      preimage = randomHex(32);
      swapId = await openSwap(order, preimage, await pickTimeout(orderId, opts.timeoutHours));
    }
    await acceptCounter(swapId, deadline);
    // The maker's claim at counter_accepted settles both legs in one transaction;
    // any later status means a claim already happened, and there is only settling to wait for.
    const state = await swapState(swapId);
    if (state.status === 'counter_accepted') {
      preimage ??= await storedPreimage(swapId, deadline);
      await http.post(`/htlc/${encodeURIComponent(swapId)}/claim`, { preimage }).catch((err: unknown) => {
        if (refusalOf(err) !== 'alreadySettled') throw err;
      });
    }
    return finish(swapId, order.targetTokenAddress, deadline, opts.deliveryWaitMs ?? DEFAULT_DELIVERY_WAIT_MS);
  }

  async function take(orderId: string, opts: SettleOptions = {}): Promise<Settled> {
    const deadline = now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
    let order = await swap.get(orderId);
    assertCantonOrder(order);
    if (order.status === 'open') order = await swap.accept(orderId);
    const self = await me();
    if (order.opponentUserId && order.opponentUserId !== self.id) {
      throw new SettleError(`order ${orderId} was taken by another account`, null, order);
    }
    // The maker has 30 minutes from the accept to open the swap before the order is cancelled.
    order = await waitFor(
      () => swap.get(orderId),
      (o) => Boolean(o.swapId) || TERMINAL_ORDER_STATUSES.has(o.status),
      deadline,
      'the maker to open the swap',
      null,
    );
    const swapId = order.swapId;
    if (!swapId) throw new SettleError(`order ${orderId} is ${order.status}`, null, order);
    const state = await waitFor(() => swapState(swapId), (s) => s.status !== 'init_request_created', deadline, 'the maker swap', swapId);
    if (state.status === 'proposal_created') {
      await run('htlc.accept-deposit-counter', {
        swapId,
        counterTokenId: order.targetTokenAddress,
        counterAmount: grossAmount(order.targetAmount, await feeRate()),
      }, true);
    }
    return finish(swapId, order.sourceTokenAddress, deadline, opts.deliveryWaitMs ?? DEFAULT_DELIVERY_WAIT_MS);
  }

  async function acceptIncoming(filter: (transfer: IncomingTransfer) => boolean = () => true) {
    const accepted: IncomingTransfer[] = [];
    const failed: Array<{ transfer: IncomingTransfer; error: unknown }> = [];
    for (const transfer of await incoming()) {
      // Past executeBefore the ledger refuses the accept; the sender reclaims it.
      if (Date.parse(transfer.executeBefore) <= now() || !filter(transfer)) continue;
      try {
        await accept(transfer);
        accepted.push(transfer);
      } catch (error) {
        failed.push({ transfer, error });
      }
    }
    return { accepted, failed };
  }

  async function onboard(): Promise<AccountUser> {
    let user = await me();
    if (!user.partyId) {
      await run('wallet.topology', { publicKey: signer.public_key }, false);
      user = await me();
      if (!user.partyId) throw new Error('the party topology was submitted but the account has no party yet');
    }
    await run('tokens.preapproval', undefined, false);
    return user;
  }

  const legalStatus = () => http.get<LegalStatus>('/legal/consent');

  async function acceptTerms(version: string, documents: ConsentedDocument[]): Promise<void> {
    const user = await me();
    const issuedAt = new Date(now()).toISOString();
    const message = legalConsentMessage({ version, partyId: user.partyId ?? user.id, issuedAt, documents });
    const signature = await signer.signMessage(utf8ToBinaryString(message));
    await http.post('/legal/consent', { version, documents, issuedAt, signature });
  }

  async function balance(instrumentId: string) {
    const { partyId } = await me();
    if (!partyId) throw new Error('the account has no party yet — run onboard()');
    return http.get<{ balance: string; holdingsCount?: number }>(
      `/tokens/balance/${encodeURIComponent(partyId)}/${encodeURIComponent(instrumentId)}`,
    );
  }

  const cashbackClaims = () => http.get<CashbackClaim[]>('/partner/cashback/claims');

  async function collect({ waitMs = DEFAULT_DELIVERY_WAIT_MS }: { waitMs?: number } = {}) {
    const claim = await http.post<CashbackClaim>('/partner/cashback/claim');
    const until = now() + waitMs;
    const accepted: IncomingTransfer[] = [];
    const acceptedCids = new Set<string>();
    for (;;) {
      const payouts = (await cashbackClaims()).find((c) => c.id === claim.id)?.payouts ?? [];
      // A payout is in when the venue says so (a CC payout lands directly) or
      // when this account has accepted its transfer — the venue's own view of a
      // self-custody accept can lag, so ours counts.
      const open = payouts.filter((p) => p.settlementStatus !== 'accepted' && !acceptedCids.has(p.transferInstructionCid ?? ''));
      const waiting = new Set(open.map((p) => p.transferInstructionCid).filter((cid): cid is string => Boolean(cid)));
      if (waiting.size > 0) {
        for (const transfer of await incoming()) {
          if (!waiting.has(transfer.contractId)) continue;
          await accept(transfer);
          accepted.push(transfer);
          acceptedCids.add(transfer.contractId);
        }
      }
      const pending = payouts.filter((p) => p.settlementStatus !== 'accepted' && !acceptedCids.has(p.transferInstructionCid ?? '')).length;
      // Payout legs are written with the claim itself, so an empty list is a claim with nothing in it.
      if (pending === 0 || now() >= until) return { claim, accepted, pending };
      await sleep(pollMs);
    }
  }

  return {
    session,
    swap,
    me,
    onboard,
    legalStatus,
    acceptTerms,
    execute,
    swapState,
    make,
    take,
    incoming,
    accept,
    acceptIncoming,
    send: ({ receiverPartyId, amount, tokenId, description }) =>
      run('tokens.send', { receiverPartyId, amount, ...(tokenId ? { tokenId } : {}), ...(description ? { description } : {}) }, false).then((r) => r.result),
    consolidate,
    balance,
    cashback: {
      summary: () => http.get<CashbackSummary>('/partner/cashback/me'),
      claims: cashbackClaims,
      claim: () => http.post<CashbackClaim>('/partner/cashback/claim'),
      collect,
    },
  };
}

/** CC under the aliases the API uses for it: it is delivered through the preapproval, never as a transfer to accept. */
export function isCc(instrumentId: string): boolean {
  return instrumentId === 'CC' || instrumentId === 'Amulet';
}

/**
 * The amount to lock so the other side receives exactly `net` after the fee,
 * which the ledger deducts from the locked amount (`fee = gross − gross/(1+rate)`).
 * Computed in exact 1e-10 units and rounded UP: the API refuses a counter leg
 * that locks less than the order promises.
 */
export function grossAmount(net: string, feeRate: string): number {
  const units = (decimal: string) => {
    const [whole = '0', fraction = ''] = decimal.trim().split('.');
    return BigInt(whole) * 10n ** 10n + BigInt((fraction + '0000000000').slice(0, 10));
  };
  const ONE = 10n ** 10n;
  const product = units(net) * (ONE + units(feeRate));
  const gross = product / ONE + (product % ONE === 0n ? 0n : 1n);
  const fraction = (gross % ONE).toString().padStart(10, '0').replace(/0+$/, '');
  return Number(`${gross / ONE}${fraction ? `.${fraction}` : ''}`);
}

/** The exact text the API verifies a signed acceptance against (`buildLegalConsentMessage`). */
export function legalConsentMessage(input: { version: string; partyId: string; issuedAt: string; documents: ConsentedDocument[] }): string {
  const documents = [...input.documents]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((d) => `${d.key}@${d.version}`)
    .join(',');
  return [
    'CANCORE_LEGAL_CONSENT_V1',
    `version:${input.version}`,
    `party:${input.partyId}`,
    `issuedAt:${input.issuedAt}`,
    `documents:${documents}`,
  ].join('\n');
}

function utf8ToBinaryString(text: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(text)) out += String.fromCharCode(byte);
  return out;
}

function randomHex(bytes: number): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The hash lock of a preimage: SHA-256 over its UTF-8 text, as the ledger computes it. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
