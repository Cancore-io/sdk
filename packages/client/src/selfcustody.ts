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
import { DEFAULT_INSTRUMENT_ADMINS, instrumentKey, mergeLists, networkOf, type DvpNetwork } from './dvp-admins';
import { DEFAULT_TRUSTED_PACKAGES, units, verifyDvpPrepared, type DvpOperation, type DvpTerms, type Instrument, type TrustedPackages } from './dvp-verify';

export { DEFAULT_TRUSTED_PACKAGES, type TrustedPackages } from './dvp-verify';
export { API_NETWORKS, DEFAULT_INSTRUMENT_ADMINS, type DvpNetwork } from './dvp-admins';
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
  /** The order this swap settles; `withdrawAllocation` rebuilds the trade the account agreed to from it. */
  orderId?: string | null;
}

/** `FullSwapInfoDto` (`GET /htlc/swaps/{id}/full`), the fields DvP settlement reads. */
export interface SwapInfo {
  swap: HtlcSwap;
  /** `SwapLegDto`: a DvP swap's trade legs, plus the platform-fee leg when one is charged. */
  legs: Array<{
    role: 'main' | 'counter' | 'fee';
    sender: string;
    receiver: string;
    tokenId?: string | null;
    amount?: string | null;
    /** The allocation holding this leg's funds; null until funded. */
    lockRef?: string | null;
    /** `cancelled` once the venue has released the allocation of an expired trade. */
    status?: string;
    /** The id the DvP contract knows this leg by. */
    legId?: string | null;
    /** `withdraw_allocation`: the trade ended unsettled and only this leg's owner can release its allocation. */
    userActionRequired?: 'withdraw_allocation' | null;
  }>;
  /** `DvpSwapFactsDto`; null for an HTLC swap. */
  dvp: { tradeCid?: string | null; awaitingApprovalFrom: string[]; allocateBefore?: string | null; settleBefore?: string | null } | null;
}

const isDvp = (swap: HtlcSwap) => swap.status.startsWith('dvp_');

/** This party's allocations still holding funds: funded (a lock reference) and not released by the venue. */
const lockedLegs = (info: SwapInfo, party: string) =>
  info.legs.filter((l) => l.sender === party && l.lockRef && l.status !== 'cancelled');

const RELEASE =
  'The venue releases a DvP allocation when the trade is not settled by its deadline: its recovery aborts the trade ' +
  '(SwapTrade_Abort), which cancels every allocation still live, a few minutes after the trade\'s settle deadline.';

function lockedNote(info: SwapInfo, party: string): string {
  const locked = lockedLegs(info, party);
  if (locked.length === 0) return '';
  return `; this account's allocation(s) (${locked.map((l) => l.role).join(', ')}) stay locked until then. ${RELEASE}`;
}

/** What an expired trade means for this account's funds, and what to do when they did not come back. */
function expiredMessage(info: SwapInfo, party: string): string {
  const head = `swap ${info.swap.id} is dvp_expired: the trade was not settled in time`;
  const locked = lockedLegs(info, party);
  const released = info.legs.filter((l) => l.sender === party && l.lockRef && l.status === 'cancelled');
  if (locked.length > 0) {
    return `${head}, and this account's allocation(s) (${locked.map((l) => l.role).join(', ')}) are still locked after the venue's recovery ` +
      `(${info.swap.rejectReason ?? 'no reason recorded'}). Only this account's own signature can release them: ` +
      `call withdrawAllocation('${info.swap.id}'), or pass { autoWithdraw: true } to make / take.`;
  }
  if (released.length > 0) return `${head}; this account's allocation(s) (${released.map((l) => l.role).join(', ')}) were released by the venue's recovery`;
  return `${head}; nothing of this account's was locked`;
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
  /**
   * When the trade expires with this account's allocation still locked, withdraw it (one signature per
   * locked leg) before the `SettleError` is thrown. Default false: nothing is signed that was not asked for.
   */
  autoWithdraw?: boolean;
}

export interface SelfCustodyOptions extends SessionOptions {
  /** Poll interval while waiting on the counterparty or the venue. Default 5 s. */
  pollMs?: number;
  /**
   * The venue party every DvP allocation must hand settlement to. Pin it from
   * your own configuration to make it a trust boundary the API cannot move;
   * by default it is read from `GET /htlc/fee-config`.
   */
  venuePartyId?: string;
  /**
   * The highest platform fee rate this account accepts, as a decimal (`'0.01'` is 1%). The rate
   * comes from `GET /htlc/fee-config`; a trade whose rate is above this ceiling is refused before
   * anything is recorded or signed. Default `'0.015'` (1.5%, this SDK's default ceiling).
   */
  maxFeeRate?: string;
  /**
   * The party the platform fee must be paid to. Set it from your own configuration and a trade
   * whose fee receiver (from `GET /htlc/fee-config`) is any other party is refused.
   */
  feeRecipientPartyId?: string;
  /**
   * How far ahead of now a proposal's expiry or an allocation's deadlines may lie — a later one
   * keeps the account's funds locked longer. Default 3 hours.
   */
  maxSettlementWindowMs?: number;
  /**
   * More package ids for the proposal steps' package (`cancore-swap`), by package name. Added to
   * `DEFAULT_TRUSTED_PACKAGES`, never replacing it.
   */
  trustedPackages?: Partial<TrustedPackages>;
  /**
   * The network this account trades on; it chooses which pinned instrument admins are trusted.
   * Derived from `baseUrl` for the Cancore API hosts (`API_NETWORKS`); any other host must say.
   */
  network?: DvpNetwork;
  /**
   * More instrument admins a DvP allocation may run under on this account's network, by
   * instrument id (`Amulet` for CC). Added to `DEFAULT_INSTRUMENT_ADMINS`, never replacing it: a
   * token the SDK does not list for the network yet is refused until its admin is added here.
   */
  instrumentAdmins?: Record<string, string[]>;
}

/** This SDK's default ceiling on the platform fee rate (1.5%): a policy of the SDK, not of the platform. */
export const DEFAULT_MAX_FEE_RATE = '0.015';
const DEFAULT_SETTLEMENT_WINDOW_MS = 3 * 60 * 60_000;

/** A settle that cannot finish: the swap went somewhere it cannot come back from, or time ran out. */
export class SettleError extends Error {
  constructor(
    message: string,
    readonly swapId: string | null,
    readonly last?: HtlcSwap | Order,
    /** The trade expired with this account's allocation still locked: `withdrawAllocation(swapId)` releases it. */
    readonly withdrawable = false,
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
  /**
   * Release this account's own allocation(s) of a trade that ended `dvp_expired` while recovery could not
   * (the abort was refused or the trade was already gone). One prepare → verify → sign → submit per locked
   * leg, each checked to archive only this account's allocation and return its holding to it. Nothing
   * locked is `withdrawn: []`; a trade that is not expired is a `SettleError`.
   */
  withdrawAllocation(swapId: string): Promise<{ swapId: string; withdrawn: string[] }>;
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

/** `PreparedCommandDto`, the fields a self-custody signer reads. */
interface PreparedCommand {
  commandId: string;
  operationType: DvpOperation;
  actAs: string[];
  commands: unknown[];
  applicationId: string;
  serializedForSigning: string;
  hashForSigning?: string;
  /** Present when the acting party holds its own key: THE thing to sign, and the transaction it is the hash of. */
  preparedTransactionHash?: string;
  preparedTransaction?: string;
  /** Every transaction of the ceremony, in submit order — a funding side owes its trade leg and the fee leg. */
  preparedTransactions?: Array<{ preparedTransactionHash: string; preparedTransaction?: string }>;
}

export function createSelfCustody(options: SelfCustodyOptions): SelfCustodyAccount {
  const { baseUrl, signer, pollMs = 5_000, now = Date.now } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const session = createSession(options);
  const http: Http = createHttp({ baseUrl, request: session.request });
  const orders = createSwapClient(http);
  const network = options.network ?? networkOf(baseUrl);
  const admins = mergeLists(
    network ? DEFAULT_INSTRUMENT_ADMINS[network] : {},
    Object.fromEntries(Object.entries(options.instrumentAdmins ?? {}).map(([id, list]) => [instrumentKey(id), list])),
  );
  // Every Canton↔Canton order this account places asks for allocation-DvP: that is the only way it settles.
  const swap: SwapClient = {
    ...orders,
    create: (input) => {
      const canton = input.sourceNetwork === 'canton' && input.targetNetwork === 'canton';
      return canton ? placing(() => orders.create({ ...input, dvp: true })) : orders.create(input);
    },
    async createForPair(input) {
      const pair = await http.get<{ baseToken?: { network?: string }; quoteToken?: { network?: string } }>(
        `/trading-pairs/${encodeURIComponent(input.tradingPairId)}`,
      );
      const canton = pair.baseToken?.network === 'canton' && pair.quoteToken?.network === 'canton';
      return canton ? placing(() => orders.createForPair({ ...input, dvp: true })) : orders.createForPair(input);
    },
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
  async function signDvp(operationType: DvpOperation, swapId: string, terms: DvpTerms, legId?: string): Promise<void> {
    const meta = { swapId };
    for (let attempt = 0; ; attempt++) {
      let prepared: PreparedCommand;
      try {
        prepared = await http.post('/canton-wallet/htlc/prepare-command', { operationType, params: legId ? { swapId, legId } : { swapId } });
      } catch (err) {
        throw new CeremonyError(operationType, 'prepare', err, meta);
      }
      const transactions = prepared.preparedTransactions ??
        (prepared.preparedTransactionHash
          ? [{ preparedTransactionHash: prepared.preparedTransactionHash, preparedTransaction: prepared.preparedTransaction }]
          : []);
      // Nothing is signed that was not read first: the hash recomputed from the bytes, the bytes held to the trade.
      try {
        await verifyDvpPrepared(operationType, transactions, terms);
      } catch (err) {
        throw new CeremonyError(operationType, 'prepare', err, meta);
      }
      const hashes = transactions.map((t) => t.preparedTransactionHash);
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

  /**
   * A DvP refusal that ends the trade before anything is signed, said in words a partner can act
   * on. The stand refuses at the earliest point it can — placing the order, taking it — and again
   * when the trade is recorded, for a gateway that does not check earlier.
   */
  function dvpRefusal(err: unknown, what: string, order?: Order, self?: string): SettleError | null {
    const refusal = refusalOf(err);
    if (refusal === 'dvpNotAllowed' || (err instanceof CancoreApiError && err.status === 403)) {
      return new SettleError(
        `${what}: allocation-DvP is not open to this account on this stand (${(err as Error).message}); ` +
          'a Canton↔Canton order settles only through DvP, never through HTLC',
        null,
        order,
      );
    }
    if (refusal === 'feeHoldingRequired') {
      // The payer is the side owing the leg that delivers to the maker — the taker — and only its own
      // key can split its balance. Nothing was recorded.
      const body = (err as CancoreApiError).body as { payerPartyId?: string; feeAmount?: string } | undefined;
      const fee = `the platform fee${body?.feeAmount ? ` (${body.feeAmount})` : ''} needs a holding of its own`;
      const token = order ? order.targetTokenName || order.targetTokenAddress : 'the order\'s target token';
      const mine = self !== undefined && (body?.payerPartyId === undefined || body.payerPartyId === self);
      return new SettleError(
        mine
          ? `${what}: ${fee}, and this account keeps its ${token} in a single holding. Split that balance into at least two ` +
              'holdings (for example by sending part of it to itself), then take() again.'
          : `${what}: ${fee}, and ${body?.payerPartyId ?? 'the taker'} (the taker) keeps its ${token} in a single holding. ` +
              'The taker splits that balance into at least two holdings (for example by sending part of it to itself); then run make() again.',
        null,
        order,
      );
    }
    return null;
  }

  /** Place a Canton↔Canton order, with a DvP refusal said in words. */
  async function placing(place: () => Promise<Order>): Promise<Order> {
    try {
      return await place();
    } catch (err) {
      throw dvpRefusal(err, 'placing the order') ?? err;
    }
  }

  /**
   * Refuse before anything is created when the stand will not settle this pair
   * through DvP: `/htlc/dvp/instruments` lists only instruments of pairs the
   * stand has switched on, and sits behind the same access guard as the DvP
   * routes. Without this, an unhonoured `dvp: true` falls through to HTLC.
   */
  async function dvpInstruments(order: Order): Promise<{ source: Instrument; target: Instrument }> {
    let instruments: Instrument[];
    try {
      instruments = await http.get<Instrument[]>('/htlc/dvp/instruments');
    } catch (err) {
      throw dvpRefusal(err, `order ${order.id}`, order) ?? err;
    }
    const find = (id: string) => instruments.find((i) => i.id === id);
    const [source, target] = [find(order.sourceTokenAddress), find(order.targetTokenAddress)];
    if (!source || !target) {
      throw new SettleError(
        `${order.sourceTokenAddress}/${order.targetTokenAddress}: this pair is not enabled for DvP on this stand; ` +
          'Canton↔Canton orders never fall back to HTLC',
        null,
        order,
      );
    }
    // The admin is the allocation's trust anchor, so the API's word for it is checked against the SDK's own list.
    if (!network && !options.instrumentAdmins) {
      throw new SettleError(
        `cannot tell which network ${baseUrl} serves, so no instrument admin can be trusted: pass network ('devnet', 'testnet' or 'mainnet')`,
        null,
        order,
      );
    }
    for (const instrument of [source, target]) {
      const pinned = admins[instrumentKey(instrument.id)] ?? [];
      if (pinned.length === 0) {
        throw new SettleError(
          `${instrument.id} admin for ${network ?? 'this network'} not configured — pass instrumentAdmins`,
          null,
          order,
        );
      }
      if (!pinned.includes(instrument.admin)) {
        throw new SettleError(
          `the stand names ${instrument.admin} as the admin of ${instrument.id}, which is not an admin this SDK trusts for it; ` +
            'if it is genuinely the registry of this network, add it with instrumentAdmins',
          null,
          order,
        );
      }
    }
    return { source, target };
  }

  /**
   * The trade this account agreed to, from sources other than the swap row: the
   * order, the stand's instrument list (each instrument's admin) and its fee
   * configuration (rate, receiver and venue). Every prepared transaction is held
   * to it before the key signs.
   */
  async function dvpTerms(order: Order, swapId: string | null, party: string, role: 'maker' | 'taker'): Promise<DvpTerms> {
    const { source, target } = await dvpInstruments(order);
    const config = await http.get<{ feeRate?: string; feeRecipient?: string; venue?: string } | null>('/htlc/fee-config');
    const venue = options.venuePartyId ?? config?.venue;
    const feeRate = config?.feeRate ?? '0';
    const ceiling = options.maxFeeRate ?? DEFAULT_MAX_FEE_RATE;
    if (!(units(feeRate) >= 0n && units(feeRate) <= units(ceiling))) {
      throw new SettleError(`the stand's platform fee rate ${feeRate} is above this account's ceiling ${ceiling} (maxFeeRate)`, swapId, order);
    }
    if (options.feeRecipientPartyId !== undefined && config?.feeRecipient && config.feeRecipient !== options.feeRecipientPartyId) {
      throw new SettleError(`the stand pays the platform fee to ${config.feeRecipient}, not to this account's feeRecipientPartyId`, swapId, order);
    }
    if (!venue) throw new SettleError('the venue party is unknown on this stand, so no allocation can be checked: pass venuePartyId', swapId);
    const other = (role === 'maker' ? order.opponent : order.initiator) as { partyId?: string | null } | undefined;
    if (!other?.partyId) throw new SettleError(`order ${order.id} does not name the counterparty's party`, swapId, order);
    return {
      swapId: swapId ?? '',
      party,
      maker: role === 'maker' ? party : other.partyId,
      taker: role === 'taker' ? party : other.partyId,
      source: { ...source, amount: order.sourceAmount },
      target: { ...target, amount: order.targetAmount },
      venue,
      feeParty: config?.feeRecipient ?? null,
      feeRate,
      packages: { swap: mergeLists(DEFAULT_TRUSTED_PACKAGES.swap, options.trustedPackages?.swap) },
      now: now(),
      maxWindowMs: options.maxSettlementWindowMs ?? DEFAULT_SETTLEMENT_WINDOW_MS,
    };
  }

  /** The maker records the trade: `POST /htlc/proposals` with `dvp: true`, which the backend turns into a DvP draft. */
  async function proposeDvp(order: Order, opts: SettleOptions): Promise<string> {
    // The order's own choice decides the mechanic: one placed without `dvp: true` would be opened as HTLC.
    if (!order.dvp) {
      throw new SettleError(
        `order ${order.id} was placed without dvp: true, so the venue would settle it as HTLC; Canton↔Canton orders settle ` +
          'only through DvP here. Cancel it and place it again with acct.swap.create / createForPair.',
        null,
        order,
      );
    }
    // Everything a later signature will be held to is checked before the trade is recorded:
    // the pair, the venue, and the fee rate against this account's ceiling.
    await dvpTerms(order, null, await ownParty(), 'maker');
    const receiver = (order.opponent as { partyId?: string | null } | undefined)?.partyId;
    if (!receiver) throw new SettleError(`order ${order.id} has no counterparty party yet`, null, order);
    let created: HtlcSwap;
    try {
      created = await http.post<HtlcSwap>('/htlc/proposals', {
        orderId: order.id,
        dvp: true,
        tokenId: order.sourceTokenAddress,
        // A number because the request DTO takes one. Not a precision risk: the backend builds
        // every leg of the trade from the order's own decimal strings, never from this field.
        amount: Number(order.sourceAmount),
        receiver,
        // Required by the request's validation and unused by DvP: no hash lock exists in a DvP trade.
        hashLock: await sha256Hex(randomHex(32)),
        timeoutHours: await pickTimeout(order.id, opts.timeoutHours),
      });
    } catch (err) {
      throw dvpRefusal(err, `order ${order.id}`, order) ?? err;
    }
    if (!isDvp(created)) {
      throw new SettleError(`order ${order.id}: the venue opened swap ${created.id} as ${created.status}, not as allocation-DvP`, created.id, created);
    }
    return created.id;
  }

  /** Poll the swap until `done`; an expired or non-DvP swap ends the wait with a SettleError. */
  async function waitDvp(swapId: string, party: string, done: (info: SwapInfo) => boolean, deadline: number, what: string): Promise<SwapInfo> {
    for (;;) {
      const info = await swapInfo(swapId);
      if (!isDvp(info.swap)) {
        throw new SettleError(`swap ${swapId} is an HTLC swap (${info.swap.status}); this client settles Canton↔Canton only through allocation-DvP`, swapId, info.swap);
      }
      if (info.swap.status === 'dvp_expired') throw new SettleError(expiredMessage(info, party), swapId, info.swap, lockedLegs(info, party).length > 0);
      if (done(info)) return info;
      if (now() >= deadline) throw new SettleError(`timed out waiting for ${what}${lockedNote(info, party)}`, swapId, info.swap);
      await sleep(pollMs);
    }
  }

  const owes = (info: SwapInfo, party: string) => info.legs.some((l) => l.sender === party && !l.lockRef);

  /** Fund every leg this party owes once the trade exists, then wait for the venue's atomic settle. */
  async function fundAndSettle(swapId: string, terms: DvpTerms, info: SwapInfo, deadline: number): Promise<Settled> {
    if (owes(info, terms.party)) await signDvp('dvpAllocateLeg', swapId, terms);
    const settled = await waitDvp(swapId, terms.party, (i) => i.swap.status === 'dvp_settled', deadline, `swap ${swapId} to settle`);
    // Allocation settlement moves the holdings themselves: there is no transfer left to accept.
    return { swap: settled.swap, delivery: 'direct', flow: 'dvp' };
  }

  async function makeOnce(orderId: string, opts: SettleOptions): Promise<Settled> {
    const deadline = now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const order = await waitFor(() => swap.get(orderId), (o) => o.status !== 'open', deadline, `order ${orderId} to be taken`, null);
    assertCantonOrder(order);
    let swapId = order.swapId ?? null;
    if (!swapId) {
      if (TERMINAL_ORDER_STATUSES.has(order.status)) throw new SettleError(`order ${orderId} is ${order.status}`, null, order);
      swapId = await proposeDvp(order, opts);
    }
    const party = await ownParty();
    let info = await waitDvp(swapId, party, () => true, deadline, `swap ${swapId}`);
    const terms = await dvpTerms(order, swapId, party, 'maker');
    // The drafted row becomes a proposal only with the maker's own signature; a resumed make skips a done step.
    if (!info.swap.proposalContractId && !info.dvp?.tradeCid) await signDvp('dvpCreateProposal', swapId, terms);
    // The taker funds first: whoever allocates first gives the other side a free option to walk away.
    info = await waitDvp(
      swapId,
      party,
      (i) => Boolean(i.dvp?.tradeCid) && i.legs.every((l) => l.sender === party || Boolean(l.lockRef)),
      deadline,
      'the taker to approve and fund its legs',
    );
    return fundAndSettle(swapId, terms, info, deadline);
  }

  async function takeOnce(orderId: string, opts: SettleOptions): Promise<Settled> {
    const deadline = now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
    let order = await swap.get(orderId);
    assertCantonOrder(order);
    const self = await me();
    if (order.status === 'open') {
      try {
        order = await swap.accept(orderId);
      } catch (err) {
        throw dvpRefusal(err, `taking order ${orderId}`, order, self.partyId ?? undefined) ?? err;
      }
    }
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
    let info = await waitDvp(swapId, party, (i) => Boolean(i.swap.proposalContractId || i.dvp?.tradeCid), deadline, 'the maker to sign the proposal');
    const terms = await dvpTerms(order, swapId, party, 'taker');
    if (!info.dvp?.tradeCid && info.dvp?.awaitingApprovalFrom.includes(party)) await signDvp('dvpAcceptProposal', swapId, terms);
    // The venue turns a fully approved proposal into the trade on its next tick.
    info = await waitDvp(swapId, party, (i) => Boolean(i.dvp?.tradeCid), deadline, 'the venue to open the trade');
    return fundAndSettle(swapId, terms, info, deadline);
  }

  /** Run a settle; on an expiry that left this account's allocation locked, withdraw it first when asked to. */
  async function autoWithdrawing(opts: SettleOptions, run: () => Promise<Settled>): Promise<Settled> {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof SettleError) || !err.withdrawable || !opts.autoWithdraw || !err.swapId) throw err;
      const { withdrawn } = await withdrawAllocation(err.swapId);
      throw new SettleError(
        `swap ${err.swapId} is dvp_expired: the trade was not settled in time; this account's allocation(s) ` +
          `(${withdrawn.join(', ')}) were withdrawn with its own signature (autoWithdraw)`,
        err.swapId,
        err.last,
      );
    }
  }

  const make = (orderId: string, opts: SettleOptions = {}) => autoWithdrawing(opts, () => makeOnce(orderId, opts));
  const take = (orderId: string, opts: SettleOptions = {}) => autoWithdrawing(opts, () => takeOnce(orderId, opts));

  async function withdrawAllocation(swapId: string): Promise<{ swapId: string; withdrawn: string[] }> {
    const info = await swapInfo(swapId);
    if (!isDvp(info.swap)) throw new SettleError(`swap ${swapId} is an HTLC swap (${info.swap.status}); only a DvP allocation is withdrawn here`, swapId, info.swap);
    // The venue settles or aborts a live trade; only a trade that ended unsettled leaves the owner to act.
    if (info.swap.status !== 'dvp_expired') {
      throw new SettleError(`swap ${swapId} is ${info.swap.status}: an allocation can only be withdrawn once the trade is dvp_expired`, swapId, info.swap);
    }
    const self = await me();
    const party = self.partyId ?? (await ownParty());
    const locked = lockedLegs(info, party);
    if (locked.length === 0) return { swapId, withdrawn: [] };
    if (!info.swap.orderId) throw new SettleError(`swap ${swapId} does not name its order, so the trade this account agreed to cannot be rebuilt`, swapId, info.swap);
    const order = await swap.get(info.swap.orderId);
    assertCantonOrder(order);
    const terms = await dvpTerms(order, swapId, party, order.opponentUserId === self.id ? 'taker' : 'maker');
    const withdrawn: string[] = [];
    for (const leg of locked) {
      if (!leg.legId) throw new SettleError(`swap ${swapId}: a locked ${leg.role} leg does not name its id, so it cannot be withdrawn`, swapId, info.swap);
      await signDvp('dvpWithdrawAllocation', swapId, terms, leg.legId);
      withdrawn.push(leg.role);
    }
    return { swapId, withdrawn };
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
    withdrawAllocation,
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
  const [n, r] = [units(net), units(feeRate)];
  if (n < 0n || r < 0n) throw new RangeError(`grossAmount takes decimals of at most ten places, got ${net} and ${feeRate}`);
  const ONE = 10n ** 10n;
  const product = n * (ONE + r);
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
