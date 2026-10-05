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
 * Canton↔Canton orders only, and every one of them settles through
 * allocation-DvP: both legs move in one ledger transaction, with no hash lock
 * and no escrow. There is no HTLC fallback — a stand that will not settle the
 * pair through DvP is a SettleError. An EVM leg is locked by an EVM key, which
 * is not this signer.
 */
import { signLegs, type OperationLeg } from '@cancore/wallet/operations';
import { CancoreApiError, createHttp, type Http } from './http';
import { refusalOf } from './refusal';
import type { SdkErrorCode } from './sdk-error-codes';
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

/** Where an allocation-DvP swap is: proposed, legs funded, settled in one transaction — or expired. */
export type DvpStatus = 'dvp_proposed' | 'dvp_allocated_partial' | 'dvp_allocated' | 'dvp_settled' | 'dvp_expired';

/** `HtlcSwapResponseDto`, the fields a trading program reads. A DvP swap is the same row with a `dvp_*` status. */
export interface HtlcSwap {
  id: string;
  status: HtlcStatus | DvpStatus;
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
  /** The proposal this swap waits on; for DvP, set once the maker has signed it. */
  proposalContractId?: string | null;
}

/** `FullSwapInfoDto` (`GET /htlc/swaps/{id}/full`), the fields DvP settlement reads. */
export interface SwapInfo {
  swap: HtlcSwap;
  /** `SwapLegDto`: a DvP swap's trade legs, plus the platform-fee leg when one is charged. */
  legs: Array<{ role: 'main' | 'counter' | 'fee'; sender: string; receiver: string; tokenId?: string | null; amount?: string | null; lockRef?: string | null }>;
  /** `DvpSwapFactsDto`; null for an HTLC swap. */
  dvp: { tradeCid?: string | null; awaitingApprovalFrom: string[]; allocateBefore?: string | null; settleBefore?: string | null } | null;
}

const isDvp = (swap: HtlcSwap) => swap.status.startsWith('dvp_');

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

/** `FaucetClaimResponseDto` */
export interface FaucetClaim {
  success: boolean;
  amountCc: number;
  recipientParty: string;
  txId: string;
  nextEligibleAt: string;
  remainingPoolCc: number;
}

export interface Executed<TMeta = Record<string, unknown>> {
  meta: TMeta | null;
  /** What the submit answered; null when the operation had nothing to sign. */
  result: unknown;
}

/** How a settled swap's proceeds reached this account. */
export type Delivery =
  /** The holdings landed with the settle itself (every DvP settle, CC or registry token) — nothing to accept. */
  | 'direct'
  /** A registry-token delivery, accepted by this account's signature. */
  | 'accepted'
  /** Not seen within the wait. `acceptIncoming` accepts it whenever it arrives. */
  | 'pending';

export interface Settled {
  swap: HtlcSwap;
  delivery: Delivery;
  /** How it settled: always allocation-DvP for a Canton↔Canton order. */
  flow: 'dvp';
}

export interface SettleOptions {
  /**
   * The `timeoutHours` the maker's proposal request carries; must be one the stand offers
   * for the order. A DvP trade's own windows are the venue's, so this only satisfies the
   * request. Default: the shortest offered of at least 15 minutes, or the longest offered.
   */
  timeoutHours?: number;
  /** Give up waiting on the other side after this long. Default 45 minutes. */
  deadlineMs?: number;
  /** @deprecated DvP settlement delivers the holdings themselves; there is nothing to wait for. */
  deliveryWaitMs?: number;
}

export interface SelfCustodyOptions extends SessionOptions {
  /** Poll interval while waiting on the counterparty or the venue. Default 5 s. */
  pollMs?: number;
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
  /** The API's refusal code, when `cause` is a `CancoreApiError` that carries one. */
  readonly errorCode?: SdkErrorCode;

  constructor(
    readonly operation: string,
    readonly stage: 'prepare' | 'submit',
    readonly cause: unknown,
    readonly meta: Record<string, unknown> | null,
  ) {
    super(`${operation} ${stage} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'CeremonyError';
    this.errorCode = cause instanceof CancoreApiError ? cause.errorCode : undefined;
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
   * The maker's whole side of a Canton↔Canton order, through allocation-DvP:
   * wait until it is taken, record the trade (`POST /htlc/proposals`, `dvp: true`)
   * and sign its proposal, wait for the taker to approve and fund, fund its own
   * leg, then wait for the venue's atomic settle. Resumes an order whose swap
   * already exists, skipping every step already done.
   */
  make(orderId: string, options?: SettleOptions): Promise<Settled>;
  /**
   * The taker's whole side: take the order (unless this account already has),
   * wait for the maker's proposal, sign its approval, fund its own legs (the
   * platform fee among them) once the trade exists, then wait for the settle.
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
  /** Test CC from the dev stand's faucet (`POST /faucet/request`), with the faucet terms signed by this key. */
  faucet(): Promise<FaucetClaim>;
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
/** How long `cashback.collect` waits for payouts by default. */
const DEFAULT_DELIVERY_WAIT_MS = 5 * 60_000;
/**
 * The shortest proposal timeout `make` picks on its own. A DvP trade's own windows
 * are set by the venue, not by this value; `POST /htlc/proposals` still validates
 * `timeoutHours` against the offered list, so one of them is sent.
 */
const MIN_DEFAULT_TIMEOUT_HOURS = 0.25;

type DvpOperation = 'dvpCreateProposal' | 'dvpAcceptProposal' | 'dvpAllocateLeg';

/** `PreparedCommandDto`, the fields a self-custody signer reads. */
interface PreparedCommand {
  commandId: string;
  operationType: DvpOperation;
  actAs: string[];
  commands: unknown[];
  applicationId: string;
  serializedForSigning: string;
  hashForSigning?: string;
  /** Present when the acting party holds its own key: THE thing to sign. */
  preparedTransactionHash?: string;
  /** Every transaction of the ceremony, in submit order — a funding side owes its trade leg and the fee leg. */
  preparedTransactions?: Array<{ preparedTransactionHash: string }>;
}

export function createSelfCustody(options: SelfCustodyOptions): SelfCustodyAccount {
  const { baseUrl, signer, pollMs = 5_000, now = Date.now } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const session = createSession(options);
  const http: Http = createHttp({ baseUrl, request: session.request });
  const orders = createSwapClient(http);
  // Every Canton↔Canton order this account places asks for allocation-DvP: that is the only way it settles.
  const swap: SwapClient = {
    ...orders,
    create: (input) => orders.create(input.sourceNetwork === 'canton' && input.targetNetwork === 'canton' ? { ...input, dvp: true } : input),
  };

  const me = () => http.get<AccountUser>('/auth/me');
  const swapState = (swapId: string) => http.get<HtlcSwap>(`/htlc/${encodeURIComponent(swapId)}`);
  const swapInfo = (swapId: string) => http.get<SwapInfo>(`/htlc/swaps/${encodeURIComponent(swapId)}/full`);
  const incoming = () => http.get<IncomingTransfer[]>('/tokens/transfer-requests/incoming');

  /** Resubmit only what the API says is safe to resubmit: the same signatures after a timeout. */
  async function retrying<T>(send: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send();
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
        const result = await retrying(() => http.post('/wallet/operations/submit', { operationId: prepared.operationId, signatures }));
        return { meta: prepared.meta, result };
      } catch (err) {
        if (rerunOnStalePrepare && attempt === 0 && refusalOf(err) === 'rerunCeremony') continue;
        throw new CeremonyError(type, 'submit', err, prepared.meta as Record<string, unknown> | null);
      }
    }
  }

  const execute = <TMeta = Record<string, unknown>>(type: string, params?: Record<string, unknown>) =>
    run<TMeta>(type, params, false);

  /**
   * One DvP step on this account's key: `POST /canton-wallet/htlc/prepare-command`
   * → sign every prepared transaction → `POST /canton-wallet/htlc/submit-signed`.
   * The backend builds each command from its own record of the swap; the caller
   * names the swap and nothing else. A funding side gets two transactions (its
   * trade leg and the platform fee carved out of it) and signs both here, in one
   * pass on the same key the envelope ceremonies use.
   */
  async function signDvp(operationType: DvpOperation, swapId: string): Promise<void> {
    const meta = { swapId };
    for (let attempt = 0; ; attempt++) {
      let prepared: PreparedCommand;
      try {
        prepared = await http.post('/canton-wallet/htlc/prepare-command', { operationType, params: { swapId } });
      } catch (err) {
        throw new CeremonyError(operationType, 'prepare', err, meta);
      }
      const hashes = prepared.preparedTransactions?.map((t) => t.preparedTransactionHash) ??
        (prepared.preparedTransactionHash ? [prepared.preparedTransactionHash] : []);
      if (hashes.length === 0) {
        // No prepared transaction means the API would submit for this party itself: not a self-custody party.
        throw new CeremonyError(operationType, 'prepare', new Error('the API prepared no transaction for this key to sign'), meta);
      }
      const signed = await signLegs(signer, hashes.map((hash, i) => ({ legId: String(i), hash, kind: 'transfer' as const })));
      const signatures = signed.map((s) => s.signature);
      const body = {
        commandId: prepared.commandId,
        operationType: prepared.operationType,
        actAs: prepared.actAs,
        commands: prepared.commands,
        signature: signatures[0],
        ...(signatures.length > 1 ? { signatures } : {}),
        publicKey: session.publicKey,
        applicationId: prepared.applicationId,
        serializedForSigning: prepared.serializedForSigning,
        ...(prepared.hashForSigning ? { hashForSigning: prepared.hashForSigning } : {}),
      };
      try {
        await retrying(async () => {
          const path = '/canton-wallet/htlc/submit-signed';
          const answer = await http.post<{ success: boolean; error?: string; errorCode?: string }>(path, body);
          // A ledger rejection comes back 200 with success:false — never a pass. Raised as the 400 the
          // same refusal is on the envelope routes, so `refusalOf` reads its code, or its text, alike.
          if (!answer.success) throw new CancoreApiError(400, 'POST', path, { message: answer.error ?? 'submit refused', errorCode: answer.errorCode });
        });
        return;
      } catch (err) {
        if (attempt === 0 && refusalOf(err) === 'rerunCeremony') continue;
        throw new CeremonyError(operationType, 'submit', err, meta);
      }
    }
  }

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

  async function pickTimeout(orderId: string, wanted?: number): Promise<number> {
    const { timeoutHours } = await http.get<{ timeoutHours: number[] }>('/htlc/timeout-options', { orderId });
    if (wanted !== undefined) {
      if (!timeoutHours.includes(wanted)) {
        throw new SettleError(`timeoutHours ${wanted} is not offered for this order (offered: ${timeoutHours.join(', ')})`, null);
      }
      return wanted;
    }
    if (timeoutHours.length === 0) throw new SettleError('the stand offers no timeout for this order', null);
    const safe = timeoutHours.filter((h) => h >= MIN_DEFAULT_TIMEOUT_HOURS);
    return safe.length > 0 ? Math.min(...safe) : Math.max(...timeoutHours);
  }

  function assertCantonOrder(order: Order): void {
    if (order.sourceNetwork !== 'canton' || order.targetNetwork !== 'canton') {
      throw new SettleError(`order ${order.id} is ${order.sourceNetwork}→${order.targetNetwork}; only Canton↔Canton settles here`, null, order);
    }
  }

  /** A 403 from a DvP route: the stand has not opened allocation-DvP to this account. */
  function forbidden(err: unknown, order: Order): SettleError | null {
    if (!(err instanceof CancoreApiError) || err.status !== 403) return null;
    return new SettleError(
      `allocation-DvP is not open to this account on this stand (${err.message}); ` +
        `order ${order.id} is Canton↔Canton and settles only through DvP, never through HTLC`,
      null,
      order,
    );
  }

  /**
   * Refuse before anything is created when the stand will not settle this pair
   * through DvP: `/htlc/dvp/instruments` lists only instruments of pairs the
   * stand has switched on, and sits behind the same access guard as the DvP
   * routes. Without this, an unhonoured `dvp: true` falls through to HTLC.
   */
  async function assertDvpPair(order: Order): Promise<void> {
    let instruments: Array<{ id: string }>;
    try {
      instruments = await http.get<Array<{ id: string }>>('/htlc/dvp/instruments');
    } catch (err) {
      throw forbidden(err, order) ?? err;
    }
    const ids = new Set(instruments.map((i) => i.id));
    const missing = [order.sourceTokenAddress, order.targetTokenAddress].filter((id) => !ids.has(id));
    if (missing.length > 0) {
      throw new SettleError(
        `${order.sourceTokenAddress}/${order.targetTokenAddress} is not enabled for allocation-DvP on this stand ` +
          `(SWAP_FLOW_DVP_PAIRS; not offered: ${missing.join(', ')}); Canton↔Canton orders never fall back to HTLC`,
        null,
        order,
      );
    }
  }

  /** The maker records the trade: `POST /htlc/proposals` with `dvp: true`, which the backend turns into a DvP draft. */
  async function proposeDvp(order: Order, opts: SettleOptions): Promise<string> {
    await assertDvpPair(order);
    const receiver = (order.opponent as { partyId?: string | null } | undefined)?.partyId;
    if (!receiver) throw new SettleError(`order ${order.id} has no counterparty party yet`, null, order);
    let created: HtlcSwap;
    try {
      created = await http.post<HtlcSwap>('/htlc/proposals', {
        orderId: order.id,
        dvp: true,
        tokenId: order.sourceTokenAddress,
        amount: Number(order.sourceAmount),
        receiver,
        // Required by the request's validation and unused by DvP: no hash lock exists in a DvP trade.
        hashLock: await sha256Hex(randomHex(32)),
        timeoutHours: await pickTimeout(order.id, opts.timeoutHours),
      });
    } catch (err) {
      throw forbidden(err, order) ?? err;
    }
    if (!isDvp(created)) {
      throw new SettleError(`order ${order.id}: the venue opened swap ${created.id} as ${created.status}, not as allocation-DvP`, created.id, created);
    }
    return created.id;
  }

  /** Poll the swap until `done`; an expired or non-DvP swap ends the wait with a SettleError. */
  async function waitDvp(swapId: string, done: (info: SwapInfo) => boolean, deadline: number, what: string): Promise<SwapInfo> {
    for (;;) {
      const info = await swapInfo(swapId);
      if (!isDvp(info.swap)) {
        throw new SettleError(`swap ${swapId} is an HTLC swap (${info.swap.status}); this client settles Canton↔Canton only through allocation-DvP`, swapId, info.swap);
      }
      if (info.swap.status === 'dvp_expired') throw new SettleError(`swap ${swapId} is dvp_expired`, swapId, info.swap);
      if (done(info)) return info;
      if (now() >= deadline) throw new SettleError(`timed out waiting for ${what}`, swapId, info.swap);
      await sleep(pollMs);
    }
  }

  const owes = (info: SwapInfo, party: string) => info.legs.some((l) => l.sender === party && !l.lockRef);

  /** Fund every leg this party owes once the trade exists, then wait for the venue's atomic settle. */
  async function fundAndSettle(swapId: string, party: string, info: SwapInfo, deadline: number): Promise<Settled> {
    if (owes(info, party)) await signDvp('dvpAllocateLeg', swapId);
    const settled = await waitDvp(swapId, (i) => i.swap.status === 'dvp_settled', deadline, `swap ${swapId} to settle`);
    // Allocation settlement moves the holdings themselves: there is no transfer left to accept.
    return { swap: settled.swap, delivery: 'direct', flow: 'dvp' };
  }

  async function make(orderId: string, opts: SettleOptions = {}): Promise<Settled> {
    const deadline = now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const order = await waitFor(() => swap.get(orderId), (o) => o.status !== 'open', deadline, `order ${orderId} to be taken`, null);
    assertCantonOrder(order);
    let swapId = order.swapId ?? null;
    if (!swapId) {
      if (TERMINAL_ORDER_STATUSES.has(order.status)) throw new SettleError(`order ${orderId} is ${order.status}`, null, order);
      swapId = await proposeDvp(order, opts);
    }
    const party = await ownParty();
    let info = await waitDvp(swapId, () => true, deadline, `swap ${swapId}`);
    // The drafted row becomes a proposal only with the maker's own signature; a resumed make skips a done step.
    if (!info.swap.proposalContractId && !info.dvp?.tradeCid) await signDvp('dvpCreateProposal', swapId);
    // AUD-2: the taker funds first. Whoever allocates first gives the other side a free option to walk away.
    info = await waitDvp(
      swapId,
      (i) => Boolean(i.dvp?.tradeCid) && i.legs.every((l) => l.sender === party || Boolean(l.lockRef)),
      deadline,
      'the taker to approve and fund its legs',
    );
    return fundAndSettle(swapId, party, info, deadline);
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
    if (!self.partyId) throw new Error('the account has no party yet — run onboard()');
    const party = self.partyId;
    order = await waitFor(
      () => swap.get(orderId),
      (o) => Boolean(o.swapId) || TERMINAL_ORDER_STATUSES.has(o.status),
      deadline,
      'the maker to open the trade',
      null,
    );
    const swapId = order.swapId;
    if (!swapId) throw new SettleError(`order ${orderId} is ${order.status}`, null, order);
    // The maker's signature turns the draft into a proposal; this account's approval completes it.
    let info = await waitDvp(swapId, (i) => Boolean(i.swap.proposalContractId || i.dvp?.tradeCid), deadline, 'the maker to sign the proposal');
    if (!info.dvp?.tradeCid && info.dvp?.awaitingApprovalFrom.includes(party)) await signDvp('dvpAcceptProposal', swapId);
    // The venue turns a fully approved proposal into the trade on its next tick.
    info = await waitDvp(swapId, (i) => Boolean(i.dvp?.tradeCid), deadline, 'the venue to open the trade');
    return fundAndSettle(swapId, party, info, deadline);
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
      await run('wallet.topology', { publicKey: session.publicKey }, false);
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

  async function ownParty(): Promise<string> {
    const { partyId } = await me();
    if (!partyId) throw new Error('the account has no party yet — run onboard()');
    return partyId;
  }

  async function balance(instrumentId: string) {
    return http.get<{ balance: string; holdingsCount?: number }>(
      `/tokens/balance/${encodeURIComponent(await ownParty())}/${encodeURIComponent(instrumentId)}`,
    );
  }

  async function faucet(): Promise<FaucetClaim> {
    const agreementTimestamp = now();
    // The text the app signs. The faucet keeps it as the record of the terms accepted;
    // what it authorizes by is the party in the JWT.
    const message = `CANCORE_FAUCET_TERMS_OF_SERVICE_V1:${await ownParty()}:${agreementTimestamp}`;
    const agreementSignature = await signer.signMessage(utf8ToBinaryString(message));
    return http.post<FaucetClaim>('/faucet/request', { agreementSignature, agreementTimestamp });
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
    faucet,
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
