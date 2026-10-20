import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { cantonFingerprint, deriveWalletKey, LOGIN_CHALLENGE_PREFIX as WALLET_CHALLENGE_PREFIX, providerFromMnemonic } from '@cancore/wallet';
import { acceptTransferLeg, allocationTree, DEV, factoryTransferLeg, holding, preapprovalProposalLeg, prepared, proposalAccept, proposalCreate, selfSendLeg, withdrawTree, type FixtureLeg } from './dvp-prepared.fixture';
import type { FetchLike } from './http';
import {
  CeremonyError,
  createSelfCustody,
  DEFAULT_FEE_RECIPIENTS,
  ForeignPartyError,
  grossAmount,
  legalConsentMessage,
  SettleError,
  UnexpectedLegError,
  UnverifiedTransactionError,
  type IncomingTransfer,
  type SelfCustodyOptions,
  type ServeEvent,
} from './selfcustody';
import { createSession, expiresWithin, LOGIN_CHALLENGE_PREFIX, type KeySigner } from './session';
import type { SettleRun } from './serve';
import { acceptCounterLeg, amuletInstruction, ESCROW, EXECUTOR, FEE_PARTY, HASH_LOCK, initRequestLeg, iso } from './htlc-prepared.fixture';

/**
 * A fake venue that settles one Canton↔Canton swap the way the API does: every
 * leg it prepares must come back signed by the key of the account that asked,
 * and each submit moves the swap on. Two accounts from one phrase trade against
 * it concurrently, so the maker's and the taker's loops meet in the middle
 * exactly as they would against a stand.
 */
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const FAR = Math.floor(Date.now() / 1000) + 3600;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));
const hex = (text: string) => new Uint8Array(Buffer.from(text, 'hex'));
const jwt = (sub: string, exp = FAR) =>
  `h.${Buffer.from(JSON.stringify({ sub, exp })).toString('base64url')}.s`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refuse = (status: number, message: string, errorCode?: string) =>
  json({ statusCode: status, message, ...(errorCode ? { errorCode, code: errorCode } : {}) }, status);

interface Account { publicKey: string; id: string; partyId: string | null; roles: string[]; status: 'ACTIVE' | 'FAILED' }
interface Leg { legId: string; hash: string; kind: string; preparedTransaction?: string }
interface Pending { type: string; params: Record<string, unknown>; legs: Leg[]; owner: Account }

interface VenueOptions {
  /** The stand has not opened allocation-DvP to these accounts: every DvP route answers 403, as `canUseDvp` does today for non-staff. */
  dvpForbidden?: boolean;
  /** The stand settles CC through DvP but not CBTC: the pair is not enabled for DvP there. */
  pairOff?: boolean;
  /** The maker's proposal is refused: the taker's wallet has no separate holding for the platform fee (an older gateway's point of refusal). */
  feeHoldingRequired?: boolean;
  /** The stand refuses at the earliest point, as the current gateway does: placing a DvP order, or taking one. */
  /**
   * `feeHolding` refuses every take; `feeHoldingUntilSplit` only until the taker has sent itself
   * CC; `feeHoldingOther` names another party as the fee payer.
   */
  refuseAt?: { create?: 'notAllowed'; accept?: 'notAllowed' | 'feeHolding' | 'feeHoldingUntilSplit' | 'feeHoldingOther' };
  /** `tokens.send` is refused at prepare. */
  failSend?: boolean;
  /** What `wallet.topology` prepares instead of its one multihash leg; `leg(kind, bytes)` makes a leg the way the venue does. */
  topologyLegs?: (leg: (kind: string, bytes?: number) => Leg) => Leg[];
  /** The party `wallet.topology` proposes in its meta, instead of the key's own (`honest`). */
  topologyParty?: (honest: string) => unknown;
  /** The party the venue records for the account once the topology is submitted, instead of the key's own. */
  recordedParty?: (honest: string) => string;
  /**
   * `tokens.send` legs carry their transaction bytes: an honest self-send, one that pays a thief, a
   * fee leg taking 5 CC, or bytes for the transfer leg only.
   */
  sendBytes?: 'honest' | 'theft' | 'overcharge' | 'mixed';
  /**
   * The taker's CC already sits in two holdings, so a send pays its network fee in a leg of its
   * own. Default false: one holding, and the API defers the fee to after the transfer commits —
   * the send is the transfer leg alone, `feeDeferred` in its meta (self-custody-cc-send.flow).
   */
  twoHoldings?: boolean;
  /** Holding fee the split's input amulet has accrued: spent at its initial amount, which is this much above its value. */
  accruedHoldingFee?: number;
  /** The account's outstanding fee debt (`GET /tokens/fee-debt`). Default '0'. */
  feeDebt?: string;
  /** The taker's CC balance (`GET /tokens/balance`). Default 10000. */
  balance?: number;
  /** What `GET /tokens/transfer/estimate-fee` quotes, and what a fee leg pays. Default 0.125. */
  networkFee?: number;
  /** A send to another party is prepared for these terms instead of the ones asked for: what a hostile venue would have the key sign. */
  sendAs?: { receiverPartyId?: string; amount?: string };
  /** `tokens.send` to another party answers legs without their bytes, as a gateway older than the bytes does. */
  sendWithoutBytes?: boolean;
  /** The provider the preapproval proposal names, instead of the venue. */
  preapprovalProvider?: string;
  /** The `splice-wallet` package id the preapproval proposal is created from, instead of a released one. */
  proposalPackageId?: string;
  /** `tokens.consolidate` has something to merge: 'honest' merges into one holding, 'theft' pays the balance away. */
  merge?: 'honest' | 'theft';
  /** `tokens.send-fee` is refused at prepare. */
  failSendFee?: boolean;
  /** The fee amount the fee-holding refusal names. Default 24.8756218905. */
  refusedFee?: string;
  /** What `GET /htlc/fee-config` answers without `orderId`: the public (retail) pool's configuration. */
  feeConfig?: Record<string, unknown>;
  /** The pool the order lands in at accept; a partner order pays its fee to the partner fee party. Default retail. */
  pool?: 'retail' | 'partner';
  /** What `GET /htlc/fee-config?orderId=` answers for a partner order. */
  partnerFeeConfig?: Record<string, unknown>;
  /** A backend older than the per-order fee config: its handler takes no query, so it ignores `orderId` and answers its one (retail) pool. */
  legacyFeeConfig?: boolean;
  /** `GET /htlc/fee-config?orderId=` refuses with this status (401 no session, 404 not a party of the order, 503 config unavailable). */
  feeConfigRefusal?: number;
  /** The venue drafts the fee leg to this party instead of the order's pool fee party. */
  feeLegTo?: string;
  /** The taker funds, the maker never does, and the trade expires: the venue's recovery then `released` the taker's allocations, or they are `stillLocked`. */
  takerFundedThenExpired?: 'released' | 'stillLocked';
  /** The API prepares something other than what the trade says, in this way, for the maker's allocation. */
  tamperMakerAllocation?: 'hash' | 'amount' | 'receiver';
  /** The trade's window closes before anybody funds: the venue marks the swap dvp_expired. */
  expireAfterTrade?: boolean;
  /** Legs (by id) whose allocation is off the ledger while the venue's row still says locked: prepare answers "nothing left to withdraw". */
  archivedUnmarked?: string[];
  /** Legs (by id) whose withdraw the venue cannot prepare right now. */
  withdrawRefuses?: string[];
  /** The taker's first allocation submit finds its prepared stash already gone (success:false, as submit-signed answers). */
  staleAllocateOnce?: boolean;
  /** The taker's first allocation submit times out; the same signatures are safe to send again. */
  timeoutAllocateOnce?: boolean;
  /** The refusals the SDK acts on carry their errorCode and a text that names no condition, as the registry gateway sends them. */
  coded?: boolean;
  /** An older gateway: its sign-up DTO has no `inviteCode`, so its validation pipe refuses the field. */
  legacySignUp?: boolean;
  /** The first sign-up's activation fails: the account comes back FAILED, as the API answers it. */
  failActivationOnce?: boolean;
}

/** A DvP leg as the venue keeps it (`swap_legs`), keyed like the trade's TextMap. */
interface DvpLeg { legId: string; role: 'main' | 'counter' | 'fee'; sender: string; receiver: string; tokenId: string; amount: string; lockRef: string | null; status: string }
/** One prepared DvP command: what the submit must come back signed for. */
interface PreparedDvp { owner: Account; operationType: string; swapId: string; hashes: string[]; legIds: string[] }

// The dev stand's fee parties: pinned in the SDK, so the venue must name one of these.
const [FEE_PARTY, PARTNER_FEE_PARTY] = DEFAULT_FEE_RECIPIENTS.devnet as [string, string];
const VENUE = DEV.venue;
// The dev stand's instrument admins: pinned in the SDK, so the venue must name exactly these.
const ADMINS: Record<string, string> = { CC: DEV.dso, CBTC: DEV.cbtcRegistrar };

function venue({
  dvpForbidden = false,
  pairOff = false,
  feeHoldingRequired = false,
  refuseAt = {},
  feeConfig = { feeRate: '0.005', feeRecipient: FEE_PARTY, venue: VENUE, maxFeeRate: '0.01' },
  pool = 'retail',
  partnerFeeConfig = { feeRate: '0.005', feeRecipient: PARTNER_FEE_PARTY, venue: VENUE, maxFeeRate: '0.01' },
  legacyFeeConfig = false,
  feeConfigRefusal,
  feeLegTo,
  takerFundedThenExpired,
  archivedUnmarked = [],
  withdrawRefuses = [],
  tamperMakerAllocation,
  expireAfterTrade = false,
  staleAllocateOnce = false,
  timeoutAllocateOnce = false,
  coded = false,
  failSend = false,
  topologyLegs,
  topologyParty,
  recordedParty,
  sendBytes,
  twoHoldings = false,
  accruedHoldingFee = 0,
  balance = 10000,
  networkFee = 0.125,
  refusedFee = '24.8756218905',
  feeDebt = '0',
  sendAs,
  sendWithoutBytes = false,
  preapprovalProvider,
  proposalPackageId,
  merge,
  failSendFee = false,
  legacySignUp = false,
  failActivationOnce = false,
}: VenueOptions = {}) {
  const refusal = (status: number, prose: string, errorCode: string) =>
    coded ? refuse(status, 'refused', errorCode) : refuse(status, prose);
  let currentFeeConfig = feeConfig;
  let instrumentsOff = false;
  let feeConfigDown = false;
  const accounts = new Map<string, Account>(); // by bearer token
  const byKey = new Map<string, Account>();
  /** Invite code → the public key that redeemed it (`invite_codes.used_by_public_key`), null while unused. */
  const invites = new Map<string, string | null>([['ABCD-EFGH-JKMN', null]]);
  let failActivation = failActivationOnce;
  /** Every sign-up body the API received. */
  const signUps: Array<Record<string, unknown>> = [];
  const pending = new Map<string, Pending>();
  /** Every envelope operation submitted, and every DvP step submitted (`dvp:<operationType>` by `<account>`). */
  const log: Array<{ type: string; params: Record<string, unknown> }> = [];
  /** Every envelope operation asked for, refused or not. */
  const asked: string[] = [];
  /** Every request body `POST /htlc/proposals` received. */
  const proposals: Array<Record<string, unknown>> = [];
  const routes = new Set<string>();
  /** The `orderId` of every `GET /htlc/fee-config`, null when it asked without one. */
  const feeAsked: Array<string | null> = [];
  /** The configuration of the pool the order is in. */
  const poolConfig = () => (pool === 'partner' && !legacyFeeConfig ? partnerFeeConfig : currentFeeConfig);
  const challenges = new Set<string>();
  const order = {
    id: 'o1', status: 'open', sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceAmount: '0.01',
    targetNetwork: 'canton', targetTokenAddress: 'CC', targetAmount: '5000',
    initiatorUserId: 'maker', opponentUserId: null as string | null, opponent: null as { partyId: string } | null,
    initiator: null as { partyId: string } | null, swapId: null as string | null, dvp: true,
  };
  let swap: Record<string, unknown> | null = null;
  let legs: DvpLeg[] = [];
  let drafter: string | null = null;
  let tradeCid: string | null = null;
  const approvers = new Set<string>();
  const preparedDvp = new Map<string, PreparedDvp>();
  let staleAllocate = staleAllocateOnce;
  let timeoutAllocate = timeoutAllocateOnce;
  const incoming: IncomingTransfer[] = [];
  /** Sends whose network fee was deferred and is still owed, by update id. */
  const deferred = new Set<string>();
  let seq = 0;
  let takes = 0;

  const verify = (owner: Account, leg: Leg, signature: string) => {
    const ok = ed25519.verify(unb64(signature), unb64(leg.hash), hex(owner.publicKey));
    if (!ok) throw new Error(`leg ${leg.legId} (${leg.kind}) is not signed by ${owner.id}`);
  };
  const leg = (kind: string, bytes = 32): Leg => {
    const raw = new Uint8Array(bytes).map(() => Math.floor(Math.random() * 256));
    if (kind === 'topology') raw.set([0x12, 0x20]);
    return { legId: `leg-${++seq}`, hash: b64(raw), kind };
  };
  const forbidden = () => refuse(403, 'Allocation-DvP is not open to this account on this stand.');
  /** The party of a key as the API names one: `<hint>::<fingerprint of the key>`. */
  const partyOf = (owner: Account) => `party-${owner.id}::${cantonFingerprint(owner.publicKey)}`;
  const parties = (): string[] => [...new Set(legs.flatMap((l) => [l.sender, l.receiver]))];

  const asLeg = (t: { kind: string; preparedTransactionHash: string; preparedTransaction: string }): Leg =>
    ({ legId: `leg-${++seq}`, hash: t.preparedTransactionHash, kind: t.kind, preparedTransaction: t.preparedTransaction });
  const feeLeg = (party: string) => selfSendLeg({
    party, kind: 'fee', receiver: DEV.venue, input: '10', ids: 'b', outputs: [{ owner: DEV.venue, amount: String(networkFee) }, { owner: party, amount: (10 - networkFee).toFixed(10) }],
  });

  /** A send to another party as the participant prepares it: CC through the receiver's preapproval, a registry token as an offer; a fee leg when a second holding can fund one. */
  async function sendLegs(party: string, params: Record<string, unknown>): Promise<Leg[]> {
    const [receiver, amount] = [String(sendAs?.receiverPartyId ?? params.receiverPartyId), String(sendAs?.amount ?? params.amount)];
    if (sendWithoutBytes) return twoHoldings ? [leg('transfer'), leg('fee')] : [leg('transfer')];
    const change = (balance - Number(amount)).toFixed(10);
    const transfer = params.tokenId && params.tokenId !== 'CC'
      ? await factoryTransferLeg({
        party, receiver, instrument: { id: String(params.tokenId), admin: DEV.cbtcRegistrar }, amount, input: String(balance),
        outputs: [{ owner: party, amount, lockedTo: DEV.cbtcRegistrar }, { owner: party, amount: change }],
      })
      : await selfSendLeg({ party, kind: 'transfer', receiver, input: String(balance), ids: 'a', outputs: [{ owner: receiver, amount }, { owner: party, amount: change }] });
    return twoHoldings ? [asLeg(transfer), asLeg(await feeLeg(party))] : [asLeg(transfer)];
  }

  /** A CC self-send as the participant prepares it: the transfer (the split and its change) and the network-fee leg to the dev participant party. */
  async function selfSendLegs(party: string, amount: string, mode: NonNullable<VenueOptions['sendBytes']>): Promise<Leg[]> {
    const change = (balance - Number(amount)).toFixed(10);
    const transfer = await selfSendLeg({
      party, kind: 'transfer', receiver: party, input: (balance + accruedHoldingFee).toFixed(10), ids: 'a',
      outputs: [{ owner: mode === 'theft' ? 'thief::1220' : party, amount }, { owner: party, amount: change }],
    });
    const fee = await selfSendLeg({
      party, kind: 'fee', receiver: DEV.venue, input: '10', ids: 'b',
      outputs: mode === 'overcharge' ? [{ owner: DEV.venue, amount: '5' }, { owner: party, amount: '5' }] : [{ owner: DEV.venue, amount: '0.125' }, { owner: party, amount: '9.875' }],
    });
    if (!twoHoldings) return [asLeg(transfer)];
    return [asLeg(transfer), mode === 'mixed' ? { ...asLeg(fee), preparedTransaction: undefined } : asLeg(fee)];
  }

  async function prepare(owner: Account, type: string, params: Record<string, unknown>): Promise<Response> {
    let legs: Leg[];
    let meta: Record<string, unknown> = {};
    asked.push(type);
    switch (type) {
      // One leg: the multihash of the party's topology transactions (wallet-topology.operation).
      case 'wallet.topology':
        legs = topologyLegs ? topologyLegs(leg) : [leg('topology', 34)];
        meta = { partyId: topologyParty ? topologyParty(partyOf(owner)) : partyOf(owner) };
        break;
      case 'tokens.preapproval':
        legs = owner.roles.includes('has-preapproval') ? [] : [asLeg(await preapprovalProposalLeg({ party: owner.partyId!, provider: preapprovalProvider, packageId: proposalPackageId }))];
        meta = { alreadyExists: legs.length === 0 };
        break;
      // The fee of a send that could not carry one (tokens-send-fee.operation): one fee leg, or none when nothing is owed.
      case 'tokens.send-fee':
        if (failSendFee) return refuse(409, 'The deferred fee was already settled', 'DEFERRED_FEE_ALREADY_SETTLED');
        legs = deferred.delete(String(params.sourceUpdateId)) ? [asLeg(await feeLeg(owner.partyId!))] : [];
        meta = { nothingToCharge: legs.length === 0 };
        break;
      case 'tokens.consolidate':
        legs = merge ? [asLeg(await selfSendLeg({
          party: owner.partyId!, kind: 'transfer', receiver: owner.partyId!, input: String(balance), ids: 'a',
          outputs: merge === 'theft' ? [{ owner: owner.partyId!, amount: '1' }] : [{ owner: owner.partyId!, amount: String(balance) }],
        }))] : [];
        meta = { nothingToMerge: legs.length === 0, mergedCount: legs.length === 0 ? 0 : 3 };
        break;
      case 'tokens.accept': legs = [leg('transfer')]; break;
      case 'tokens.send':
        if (failSend) return refuse(400, 'Insufficient holdings for the transfer');
        legs = sendBytes ? await selfSendLegs(owner.partyId!, String(params.amount), sendBytes)
          : params.receiverPartyId === owner.partyId ? (twoHoldings ? [leg('transfer'), leg('fee')] : [leg('transfer')])
            : await sendLegs(owner.partyId!, params);
        meta = twoHoldings
          ? { fee: { recipientPartyId: DEV.venue, amount: 0.125 }, feeDeferred: null }
          : { fee: null, feeDeferred: { amount: 0.125, recipientPartyId: DEV.venue } };
        break;
      // htlc.* among them: a Canton↔Canton order never reaches the HTLC ceremonies.
      default: return refuse(400, `unknown operation ${type}`);
    }
    const operationId = `op-${++seq}`;
    pending.set(operationId, { type, params, legs, owner });
    return json({ operationId, legs, meta });
  }

  function submit(caller: Account, operationId: string, signatures: Array<{ legId: string; signature: string }>): Response {
    const op = pending.get(operationId);
    if (!op || op.owner !== caller) return refuse(404, 'unknown operation');
    for (const l of op.legs) verify(caller, l, signatures.find((s) => s.legId === l.legId)?.signature ?? '');
    pending.delete(operationId);
    log.push({ type: op.type, params: op.params });
    // A send answers the update it committed in; one that deferred its fee is owed it from then on.
    if (op.type === 'tokens.send') {
      const updateId = `update-${++seq}`;
      if (!twoHoldings) deferred.add(updateId);
      return json({ updateId, outcome: 'committed', transferKind: 'direct' });
    }
    switch (op.type) {
      case 'wallet.topology': caller.partyId = recordedParty ? recordedParty(partyOf(caller)) : partyOf(caller); break;
      case 'tokens.preapproval': caller.roles.push('has-preapproval'); break;
      case 'tokens.accept': incoming.splice(incoming.findIndex((t) => t.contractId === op.params.instructionCid), 1); break;
    }
    return json({ ok: true });
  }

  /** `POST /htlc/proposals` for a DvP order: record the trade (`draft`), with the fee carved out of the leg to the maker. */
  function propose(body: Record<string, unknown>): Response {
    proposals.push(body);
    if (body.dvp !== true || body.orderId !== 'o1') return refuse(400, 'the fake venue settles order o1 through DvP only');
    // CreateProposalDto validation runs on the DvP path too.
    if (typeof body.hashLock !== 'string' || typeof body.amount !== 'number' || typeof body.tokenId !== 'string' ||
      typeof body.receiver !== 'string' || ![1, 2, 4].includes(Number(body.timeoutHours))) {
      return refuse(400, 'CreateProposalDto validation failed');
    }
    if (dvpForbidden) return forbidden();
    if (feeHoldingRequired) {
      const payerPartyId = order.opponent!.partyId;
      const prose = `Party ${payerPartyId} needs a separate holding for the platform fee: it must split its balance into at least two holdings, then the trade can be opened.`;
      return json({ statusCode: 409, message: coded ? 'refused' : prose, payerPartyId, feeAmount: '24.8756218905', ...(coded ? { errorCode: 'DVP_FEE_HOLDING_REQUIRED', code: 'DVP_FEE_HOLDING_REQUIRED' } : {}) }, 409);
    }
    const maker = [...byKey.values()].find((a) => a.id === order.initiatorUserId)!;
    order.initiator = { partyId: maker.partyId! };
    const taker = order.opponent!.partyId;
    legs = [
      { legId: 'leg-main', role: 'main', sender: maker.partyId!, receiver: taker, tokenId: 'CBTC', amount: '0.01', lockRef: null, status: 'active' },
      { legId: 'leg-counter', role: 'counter', sender: taker, receiver: maker.partyId!, tokenId: 'CC', amount: '4975.1243781095', lockRef: null, status: 'active' },
      { legId: 'leg-fee', role: 'fee', sender: taker, receiver: feeLegTo ?? String(poolConfig().feeRecipient), tokenId: 'CC', amount: '24.8756218905', lockRef: null, status: 'active' },
    ];
    drafter = maker.partyId;
    swap = { id: 's1', status: 'dvp_proposed', sender: maker.partyId, receiver: taker, proposalContractId: null, orderId: 'o1' };
    order.swapId = 's1';
    order.status = 'swap_created';
    return json(swap, 201);
  }

  /** `GET /htlc/swaps/s1/full` — and, like the venue's watchers, it moves the trade on between reads. */
  function full(): Response {
    if (!swap) return refuse(404, 'Swap not found');
    // The fee party is ours: the venue approves for it, and it is never awaited.
    const awaiting = tradeCid ? [] : parties().filter((p) => !legs.some((l) => l.role === 'fee' && l.receiver === p) && !approvers.has(p));
    if (!tradeCid && awaiting.length === 0) {
      tradeCid = 'trade-1';
      // The window closed before anybody got to fund: recovery marks the swap expired.
      if (expireAfterTrade) swap.status = 'dvp_expired';
    } else if (takerFundedThenExpired && legs.some((l) => l.lockRef) && swap.status !== 'dvp_expired') {
      // Past the settle deadline the venue's recovery aborts the trade and closes the swap.
      swap.status = 'dvp_expired';
      swap.rejectReason = takerFundedThenExpired === 'released' ? 'aborted 2 allocation(s)' : 'abort refused';
      if (takerFundedThenExpired === 'released') for (const l of legs) if (l.lockRef) l.status = 'cancelled';
    } else if (legs.every((l) => l.lockRef) && swap.status !== 'dvp_expired') {
      swap.status = 'dvp_settled';
    }
    return json({
      swap,
      // Recovery could not sign for a self-custody sender: its still-locked legs are flagged for the owner.
      legs: legs.map((l) => ({ ...l, userActionRequired: swap!.status === 'dvp_expired' && l.lockRef && l.status !== 'cancelled' ? 'withdraw_allocation' : null })),
      dvp: { tradeCid, awaitingApprovalFrom: awaiting, allocateBefore: null, settleBefore: null },
      swapStatus: 'incomplete',
    });
  }

  /** `POST /canton-wallet/htlc/prepare-command`, with the refusals the three DvP step handlers raise. */
  async function prepareDvp(caller: Account, body: { operationType: string; params: { swapId?: string; legId?: string } }): Promise<Response> {
    if (dvpForbidden) return forbidden();
    const party = caller.partyId!;
    const swapId = String(body.params?.swapId);
    if (!swap || swapId !== swap.id) return refuse(404, `Swap ${swapId} not found`);
    let owed: DvpLeg[] = [];
    switch (body.operationType) {
      case 'dvpCreateProposal':
        if (swap.proposalContractId) return refuse(400, `swap ${swapId} already has a proposal`);
        if (drafter !== party) return refuse(403, `${party} did not draft swap ${swapId}`);
        break;
      case 'dvpAcceptProposal':
        if (!swap.proposalContractId) return refuse(400, `swap ${swapId} has no proposal recorded yet`);
        if (!parties().includes(party)) return refuse(403, `${party} is not a party to swap ${swapId}`);
        break;
      case 'dvpAllocateLeg':
        if (!tradeCid) return refuse(400, `swap ${swapId} has no trade yet`);
        owed = legs.filter((l) => l.sender === party && !l.lockRef);
        if (owed.length === 0) return refuse(400, `${party} has no unallocated leg on swap ${swapId}`);
        break;
      case 'dvpWithdrawAllocation': {
        // The step's own rules: only an expired trade, and only the caller's own still-locked allocation.
        if (swap.status !== 'dvp_expired') return refuse(400, `swap ${swapId} is ${String(swap.status)}: an allocation can only be withdrawn once the trade has ended without settling (dvp_expired)`);
        const named = legs.find((l) => l.legId === body.params.legId);
        if (!named || named.sender !== party) return refuse(400, `${party} is not the sender of leg ${String(body.params.legId)}`);
        if (!named.lockRef || named.status === 'cancelled' || archivedUnmarked.includes(named.legId)) return refuse(400, `leg ${named.legId} has nothing left to withdraw`);
        if (withdrawRefuses.includes(named.legId)) return refuse(400, 'the registry cannot serve the withdraw context right now');
        owed = [named];
        break;
      }
      default:
        return refuse(400, `unknown operation ${body.operationType}`);
    }
    // What the participant would prepare, built from the swap row: the bytes and the hash of them.
    const asFixture = (l: DvpLeg): FixtureLeg => ({ sender: l.sender, receiver: l.receiver, amount: l.amount, instrumentId: { admin: ADMINS[l.tokenId]!, id: l.tokenId } });
    const terms = Object.fromEntries(legs.map((l) => [l.legId, asFixture(l)]));
    let transactions: Array<{ preparedTransaction: string; preparedTransactionHash: string }>;
    if (body.operationType === 'dvpCreateProposal') {
      transactions = [await prepared(party, [proposalCreate('0', { venue: VENUE, swapId, legs: terms, approvers: [party] })])];
    } else if (body.operationType === 'dvpAcceptProposal') {
      transactions = [await prepared(party, [
        proposalAccept('0', party, ['1']),
        proposalCreate('1', { venue: VENUE, swapId, legs: terms, approvers: [...approvers, party] }),
      ])];
    } else if (body.operationType === 'dvpWithdrawAllocation') {
      transactions = await Promise.all(owed.map(async (l) => {
        const tree = withdrawTree({ executor: VENUE, swapId, legId: l.legId, leg: asFixture(l) });
        return prepared(party, tree.nodes, tree.inputs);
      }));
    } else {
      transactions = await Promise.all(owed.map(async (l) => {
        const tampered = l.role === 'main' ? tamperMakerAllocation : undefined;
        const leg = asFixture(l);
        if (tampered === 'amount') leg.amount = '1';
        if (tampered === 'receiver') leg.receiver = 'thief::1220';
        const tree = (fixtureLeg: FixtureLeg) => allocationTree({ executor: VENUE, swapId, legId: l.legId, leg: fixtureLeg, balance: '10000' });
        const honest = tree(leg);
        const tx = await prepared(party, honest.nodes, honest.inputs);
        if (tampered !== 'hash') return tx;
        const swapped = tree({ ...leg, receiver: 'thief::1220' });
        const other = await prepared(party, swapped.nodes, swapped.inputs);
        return { ...tx, preparedTransactionHash: other.preparedTransactionHash };
      }));
    }
    const hashes = transactions.map((t) => t.preparedTransactionHash);
    const commandId = `${body.operationType}-${++seq}`;
    preparedDvp.set(commandId, { owner: caller, operationType: body.operationType, swapId, hashes, legIds: owed.map((l) => l.legId) });
    return json({
      commandId,
      operationType: body.operationType,
      actAs: [party],
      commands: [{ ExerciseCommand: { choice: body.operationType } }],
      applicationId: 'cancore',
      serializedForSigning: 'ab',
      hashForSigning: 'cd',
      preparedTransactionHash: transactions[0]!.preparedTransactionHash,
      preparedTransaction: transactions[0]!.preparedTransaction,
      // Only a ceremony of several transactions lists them all.
      ...(transactions.length > 1 ? { preparedTransactions: transactions } : {}),
    });
  }

  /** `POST /canton-wallet/htlc/submit-signed`: every hash signed by the key of the party that prepared it. */
  function submitDvp(caller: Account, body: Record<string, unknown>): Response {
    for (const field of ['commandId', 'actAs', 'commands', 'signature', 'publicKey', 'applicationId']) {
      if (body[field] === undefined) return refuse(400, `${field} should not be empty`);
    }
    const op = preparedDvp.get(String(body.commandId));
    if (!op) return json({ success: false, error: 'Command not found or expired. Please prepare again.' });
    if (op.owner !== caller) return json({ success: false, error: 'This command was prepared by another party' });
    if (body.publicKey !== caller.publicKey) return refuse(400, 'publicKey is not this account’s');
    const signatures = (body.signatures as string[] | undefined) ?? [String(body.signature)];
    if (signatures.length !== op.hashes.length) throw new Error(`${op.operationType}: ${signatures.length} signatures for ${op.hashes.length} transactions`);
    op.hashes.forEach((hash, i) => verify(caller, { legId: String(i), hash, kind: 'transfer' }, signatures[i]!));
    if (op.operationType === 'dvpAllocateLeg' && timeoutAllocate) {
      timeoutAllocate = false;
      // The stash is kept for the retry: the same signatures go through.
      return json({ success: false, error: 'submission timed out — safe to retry with the same signature', ...(coded ? { errorCode: 'SUBMISSION_TIMEOUT_RETRYABLE' } : {}) });
    }
    preparedDvp.delete(String(body.commandId));
    if (op.operationType === 'dvpAllocateLeg' && staleAllocate) {
      staleAllocate = false;
      return json(coded
        ? { success: false, error: 'refused', errorCode: 'PREPARED_SUBMISSION_EXPIRED' }
        : { success: false, error: 'No pending interactive submission found for this command' });
    }
    log.push({ type: `dvp:${op.operationType}`, params: { by: caller.id, swapId: op.swapId, legIds: op.legIds } });
    switch (op.operationType) {
      case 'dvpCreateProposal': swap!.proposalContractId = 'proposal-1'; approvers.add(caller.partyId!); break;
      case 'dvpAcceptProposal': swap!.proposalContractId = `proposal-${approvers.size + 1}`; approvers.add(caller.partyId!); break;
      case 'dvpWithdrawAllocation':
        for (const id of op.legIds) legs.find((l) => l.legId === id)!.status = 'cancelled';
        break;
      case 'dvpAllocateLeg':
        for (const id of op.legIds) legs.find((l) => l.legId === id)!.lockRef = `alloc-${id}`;
        swap!.status = legs.every((l) => l.lockRef) ? 'dvp_allocated' : 'dvp_allocated_partial';
        break;
    }
    return json({ success: true, transactionId: `tx-${++seq}`, swapId: op.swapId });
  }

  const fetchImpl: FetchLike = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const bearer = (init.headers as Record<string, string>).authorization?.replace('Bearer ', '');
    const caller = bearer ? accounts.get(bearer) : undefined;
    const route = `${init.method} ${pathname}`;
    if (route === 'POST /orders/o1/accept') takes++;
    routes.add(`${String(init.method).toLowerCase()} ${pathname.replace(/\/(o1|s1)(?=\/|$)/, '/{id}')}`);

    if (route === 'POST /auth/challenge' || route === 'POST /auth/register-challenge') {
      const challenge = `Welcome to Cancore 2026-09-28 sig:${++seq}`;
      challenges.add(challenge);
      return json({ challenge, expiresAt: Date.now() + 300_000 });
    }
    if (route === 'POST /auth/register') {
      signUps.push(body);
      // The whitelisting pipe runs before the handler, so the challenge is not spent.
      if (legacySignUp && 'inviteCode' in body) {
        return json({ statusCode: 400, message: 'Validation failed', errors: ['property inviteCode should not exist'] }, 400);
      }
    }
    if (route === 'POST /auth/login-signature' || route === 'POST /auth/register') {
      if (!challenges.delete(body.challenge)) return refuse(401, 'unknown challenge');
      if (!ed25519.verify(hex(body.signature), new TextEncoder().encode(body.challenge), hex(body.publicKey))) return refuse(401, 'bad signature');
      let account = byKey.get(body.publicKey);
      if (route === 'POST /auth/register') {
        // A FAILED sign-up under this key is cleaned up for the retry (reconcileFailedEmailless).
        if (account?.status === 'FAILED') account = undefined;
        if (account || body.signingMethod !== 'passkey' || !body.partyName) return refuse(400, 'bad registration');
        account = { publicKey: body.publicKey, id: body.partyName, partyId: null, roles: ['user'], status: 'ACTIVE' };
        if (body.inviteCode) {
          // Redeemed with the account; a code this key redeemed before is granted again (CAN-1593 F-5).
          if (!invites.has(body.inviteCode)) return refuse(404, 'Invalid invite code');
          const usedBy = invites.get(body.inviteCode);
          if (usedBy && usedBy !== body.publicKey) return refuse(409, 'Invite code already used');
          invites.set(body.inviteCode, body.publicKey);
          account.roles.push('partner-bot');
        }
        if (failActivation) {
          failActivation = false;
          account.status = 'FAILED';
        }
        byKey.set(body.publicKey, account);
      }
      if (!account) return refuse(404, 'ACCOUNT_NOT_FOUND');
      const token = jwt(account.id);
      accounts.set(token, account);
      return json({ token, refreshToken: `r-${token}`, user: account });
    }
    if (!caller) return refuse(401, 'Unauthorized');
    if (route === 'POST /auth/redeem-invite') {
      if (!invites.has(body.code)) return refuse(404, 'unknown code');
      invites.set(body.code, caller.publicKey);
      caller.roles.push('partner-bot');
      return json({ success: true, role: 'partner-bot' });
    }
    if (route === 'GET /auth/me') return json(caller);
    if (route === 'POST /wallet/operations/prepare') return prepare(caller, body.type, body.params ?? {});
    if (route === 'POST /wallet/operations/submit') return submit(caller, body.operationId, body.signatures);
    if ((route === 'POST /orders' || route === 'POST /orders/pair') && body.dvp === true && refuseAt.create) {
      return refusal(403, 'Allocation-DvP is not open to this account on this stand.', 'DVP_NOT_ALLOWED');
    }
    if (route === 'POST /orders/o1/accept' && refuseAt.accept === 'notAllowed') {
      return refusal(403, 'Allocation-DvP is not open to this account on this stand.', 'DVP_NOT_ALLOWED');
    }
    const selfSent = (party: string | null) => log.some((e) => e.type === 'tokens.send' && e.params.receiverPartyId === party);
    if (route === 'GET /tokens/transfer/estimate-fee') return json({ networkFee, networkFeeToken: 'CC' });
    if (route === 'GET /tokens/cc-preapproval') {
      const has = caller.roles.includes('has-preapproval');
      return json({ hasPreapproval: has, partyId: caller.partyId, configured: true, eligibleToSetup: !has, requiredBalance: '1', currentBalance: '0' });
    }
    if (route === 'GET /tokens/fee-debt') return json({ outstandingCc: feeDebt, entries: [] });
    if (route === `GET /tokens/balance/${encodeURIComponent(caller.partyId ?? '')}/CC`) {
      return json({ partyId: caller.partyId, instrumentId: 'CC', balance, holdingsCount: selfSent(caller.partyId) ? 2 : 1 });
    }
    const feeRefusal = refuseAt.accept === 'feeHolding' || (refuseAt.accept === 'feeHoldingUntilSplit' && !selfSent(caller.partyId)) || refuseAt.accept === 'feeHoldingOther';
    if (route === 'POST /orders/o1/accept' && feeRefusal) {
      const payerPartyId = refuseAt.accept === 'feeHoldingOther' ? 'someone-else::1220' : caller.partyId;
      const prose = `Party ${caller.partyId} needs a separate holding for the platform fee: it must split its balance into at least two holdings, then the trade can be opened.`;
      return json({ statusCode: 409, message: coded ? 'refused' : prose, payerPartyId, feeAmount: refusedFee, ...(coded ? { errorCode: 'DVP_FEE_HOLDING_REQUIRED', code: 'DVP_FEE_HOLDING_REQUIRED' } : {}) }, 409);
    }
    if (route === 'POST /orders') {
      Object.assign(order, body, { dvp: body.dvp === true });
      return json(order, 201);
    }
    if (route === 'GET /orders/o1') return json(order);
    if (route === 'GET /orders/my') {
      const filter = searchParams.get('statusFilter');
      const mine = [order.initiatorUserId, order.opponentUserId].includes(caller.id) && (!filter || filter === order.status);
      return json({ items: mine ? [order] : [], page: Number(searchParams.get('page') ?? 1), pageSize: Number(searchParams.get('pageSize') ?? 20), total: mine ? 1 : 0 });
    }
    if (route === 'GET /htlc/swaps') {
      const filter = searchParams.get('status');
      const mine = swap && [swap.sender, swap.receiver].includes(caller.partyId) && (!filter || filter === swap.status);
      return json(mine ? [swap] : []);
    }
    if (route === 'GET /htlc/s1') return swap ? json(swap) : refuse(404, 'Swap not found');
    if (route === 'POST /orders/o1/accept') {
      order.status = 'accepted';
      order.opponentUserId = caller.id;
      order.opponent = { partyId: caller.partyId! };
      return json(order);
    }
    if (route === 'GET /htlc/timeout-options') {
      return searchParams.get('orderId') === 'o1' ? json({ timeoutHours: [4, 1, 2] }) : refuse(400, 'no order');
    }
    if (route === 'GET /htlc/dvp/instruments') {
      if (dvpForbidden || instrumentsOff) return forbidden();
      return json([
        { id: 'CC', symbol: 'CC', admin: ADMINS.CC },
        ...(pairOff ? [] : [{ id: 'CBTC', symbol: 'CBTC', admin: ADMINS.CBTC }]),
      ]);
    }
    if (route === 'GET /htlc/fee-config') {
      const orderId = searchParams.get('orderId');
      feeAsked.push(orderId);
      if (feeConfigDown) return refuse(503, 'fee config unavailable');
      if (orderId === null || legacyFeeConfig) return json(currentFeeConfig);
      if (feeConfigRefusal) return refuse(feeConfigRefusal, 'refused');
      // Only a party of the order reads its pool's configuration.
      if (orderId !== order.id || ![order.initiatorUserId, order.opponentUserId].includes(caller.id)) return refuse(404, 'Order not found');
      return json(poolConfig());
    }
    if (route === 'POST /htlc/proposals') return propose(body);
    if (route === 'GET /htlc/swaps/s1/full') return full();
    if (route === 'POST /canton-wallet/htlc/prepare-command') return prepareDvp(caller, body);
    if (route === 'POST /canton-wallet/htlc/submit-signed') return submitDvp(caller, body);
    if (route === 'GET /tokens/transfer-requests/incoming') return json(incoming.filter((t) => t.receiver === caller.partyId));
    return refuse(404, `no route ${route}`);
  };

  /** A swap opened by an earlier client as HTLC, before every Canton↔Canton order settled through DvP. */
  function htlcOpenedEarlier(makerParty: string, takerParty: string) {
    swap = { id: 's1', status: 'proposal_created', sender: makerParty, receiver: takerParty, hashLock: '00' };
    order.status = 'swap_created';
    order.swapId = 's1';
  }

  /** The party of the account that signed up under this name (`maker`, `taker`, …). */
  const party = (id: string): string => [...byKey.values()].find((a) => a.id === id)?.partyId ?? `no party for ${id}`;
  return { party, fetchImpl, switchInstrumentsOff: () => { instrumentsOff = true; }, takeFeeConfigDown: () => { feeConfigDown = true; }, setFeeConfig: (next: Record<string, unknown>) => { currentFeeConfig = next; }, log, asked, proposals, routes, feeAsked, order, incoming, byKey, signUps, htlcOpenedEarlier, legs: () => legs, takes: () => takes };
}

// The dev API host: its network (devnet) chooses the pinned instrument admins.
const baseUrl = 'https://api-dev.cancore.app';

/** The accept of the incoming transfer `cid` as the participant prepares it: CBTC from the venue, to `party`. */
async function acceptLegs(party: string, cid: string, over: Partial<Parameters<typeof acceptTransferLeg>[0]> = {}): Promise<Leg[]> {
  const t = await acceptTransferLeg({ party, sender: DEV.venue, instrument: { id: 'CBTC', admin: DEV.cbtcRegistrar }, amount: '1', offerCid: cid, ...over });
  return [{ legId: 'l', hash: t.preparedTransactionHash, kind: t.kind, preparedTransaction: t.preparedTransaction }];
}
// Yield a macrotask per wait: an instantly-resolving sleep would starve jest's own timers.
const fast = { pollMs: 1, sleep: () => new Promise<void>((resolve) => setImmediate(resolve)) };

test('two self-custody accounts from one phrase register, onboard and settle a Canton↔Canton order end to end through DvP', async () => {
  const api = venue();
  const [makerKey, takerKey] = await Promise.all([
    providerFromMnemonic(PHRASE, { account: 0 }),
    providerFromMnemonic(PHRASE, { account: 1 }),
  ]);
  const maker = createSelfCustody({ baseUrl, signer: makerKey, fetchImpl: api.fetchImpl, ...fast });
  const taker = createSelfCustody({ baseUrl, signer: takerKey, fetchImpl: api.fetchImpl, ...fast });

  const registered = await maker.session.register({ partyName: 'maker', inviteCode: 'ABCD-EFGH-JKMN' });
  expect(registered.roles).toContain('partner-bot');
  await taker.session.register({ partyName: 'taker' });
  // The code rides on the maker's sign-up itself; the taker's carries none.
  expect(api.signUps.map((b) => b.inviteCode)).toEqual(['ABCD-EFGH-JKMN', undefined]);
  await Promise.all([maker.onboard(), taker.onboard()]);
  // Onboarding again changes nothing: the party exists and the preapproval too.
  await maker.onboard();
  expect(api.log.filter((e) => e.type === 'wallet.topology')).toHaveLength(2);
  expect(api.log.filter((e) => e.type === 'tokens.preapproval')).toHaveLength(2);

  // A Canton↔Canton order this account places asks for DvP.
  const placed = await maker.swap.create({
    sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceTokenName: 'CBTC', sourceAmount: '0.01',
    targetNetwork: 'canton', targetTokenAddress: 'CC', targetTokenName: 'CC', targetAmount: '5000',
  });
  expect(placed.dvp).toBe(true);

  const [made, taken] = await Promise.all([maker.make('o1'), taker.take('o1')]);

  expect(made).toMatchObject({ swap: { id: 's1', status: 'dvp_settled' }, delivery: 'direct', flow: 'dvp' });
  // CAN-2926: what make reads internally is the maker's to read too.
  await expect(maker.timeoutOptions('o1')).resolves.toEqual([4, 1, 2]);
  await expect(maker.swapInfo('s1')).resolves.toMatchObject({ swap: { id: 's1', status: 'dvp_settled' } });
  await expect(maker.feeConfig('o1')).resolves.toEqual({ feeRate: '0.005', feeRecipient: FEE_PARTY, venue: VENUE, maxFeeRate: '0.01' });
  expect(taken).toMatchObject({ swap: { id: 's1', status: 'dvp_settled' }, delivery: 'direct', flow: 'dvp' });
  // The maker recorded the trade once, asking for DvP, with a request the proposal DTO accepts.
  expect(api.proposals).toEqual([expect.objectContaining({
    orderId: 'o1', dvp: true, tokenId: 'CBTC', amount: 0.01, receiver: api.party('taker'), timeoutHours: 1,
  })]);
  // Every step signed by the side that owes it, in the order the trade needs: the maker's proposal,
  // the taker's approval, the taker's funding (its leg and the fee carved out of it, two signatures
  // checked against the taker's key), and the maker's funding last (AUD-2).
  expect(api.log.filter((e) => e.type.startsWith('dvp:')).map((e) => [e.type, e.params.by, e.params.legIds])).toEqual([
    ['dvp:dvpCreateProposal', 'maker', []],
    ['dvp:dvpAcceptProposal', 'taker', []],
    ['dvp:dvpAllocateLeg', 'taker', ['leg-counter', 'leg-fee']],
    ['dvp:dvpAllocateLeg', 'maker', ['leg-main']],
  ]);
  expect(api.legs().every((l) => l.lockRef)).toBe(true);
  // No HTLC ceremony and no delivery to accept: allocation settlement moves the holdings itself.
  expect(api.asked.filter((t) => t.startsWith('htlc.'))).toEqual([]);
  expect(api.log.filter((e) => e.type === 'tokens.accept')).toEqual([]);

  // Every route the whole flow touched is one the gateway documents, with that method.
  const spec = JSON.parse(readFileSync(join(__dirname, '..', 'spec', 'openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const undocumented = [...api.routes].filter((r) => {
    const [method, path] = r.split(' ') as [string, string];
    return spec.paths[path]?.[method] === undefined;
  });
  // Registration signs the account in, so the flow never needs login-signature.
  expect([...api.routes].sort()).toEqual([
    'get /auth/me',
    'get /htlc/dvp/instruments',
    'get /htlc/fee-config',
    'get /htlc/swaps/{id}/full',
    'get /htlc/timeout-options',
    'get /orders/{id}',
    'post /auth/register',
    'post /auth/register-challenge',
    'post /canton-wallet/htlc/prepare-command',
    'post /canton-wallet/htlc/submit-signed',
    'post /htlc/proposals',
    'post /orders',
    'post /orders/{id}/accept',
    'post /wallet/operations/prepare',
    'post /wallet/operations/submit',
  ]);
  expect(undocumented).toEqual([]);
});

test('an order with an EVM leg is placed as asked — no DvP flag — and make/take still refuse it before anything is signed', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const api = stub({
    'POST /orders': (body) => (sent.push(body), { id: 'o2', ...body }),
    'GET /orders/o1': () => takenOrder({ targetNetwork: 'sepolia' }),
  });
  const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast });
  const offer = {
    sourceNetwork: 'canton', sourceTokenAddress: 'CC', sourceTokenName: 'CC', sourceAmount: '1',
    targetNetwork: 'sepolia', targetTokenAddress: '0x0', targetTokenName: 'USDC', targetAmount: '1',
  };
  await acct.swap.create(offer);
  await acct.swap.create({ ...offer, targetNetwork: 'canton', targetTokenAddress: 'CBTC', dvp: false });
  // EVM leg: untouched. Canton↔Canton: DvP, whatever the caller passed.
  expect(sent.map((b) => b.dvp)).toEqual([undefined, true]);
  await expect(acct.make('o1')).rejects.toThrow(/only Canton↔Canton/);
  await expect(acct.take('o1')).rejects.toThrow(/only Canton↔Canton/);
  expect(api.hits.filter((r) => /dvp|canton-wallet|proposals|wallet\/operations/.test(r))).toEqual([]);
});

test('a pair order asks for DvP when both of the pair’s tokens are on Canton, and only then', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const pair = (quote: string) => ({ id: 'p', baseToken: { network: 'canton' }, quoteToken: { network: quote } });
  const api = stub({
    'GET /trading-pairs/canton-pair': () => pair('canton'),
    'GET /trading-pairs/evm-pair': () => pair('sepolia'),
    'POST /orders/pair': (body) => (sent.push(body), { id: 'o3', ...body }),
  });
  const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast });
  await acct.swap.createForPair({ tradingPairId: 'canton-pair', sourceAmount: '1', targetAmount: '2' });
  await acct.swap.createForPair({ tradingPairId: 'evm-pair', sourceAmount: '1', targetAmount: '2' });
  expect(sent.map((b) => b.dvp)).toEqual([true, undefined]);
});

/** Two accounts of one phrase, signed up and onboarded against `api`; `makerOptions` override the maker's clock and sleep. */
async function tradingPair(api: ReturnType<typeof venue>, accounts: [number, number], makerOptions: Partial<SelfCustodyOptions> = {}, takerOptions: Partial<SelfCustodyOptions> = {}) {
  const [makerKey, takerKey] = await Promise.all(accounts.map((account) => providerFromMnemonic(PHRASE, { account })));
  const maker = createSelfCustody({ baseUrl, signer: makerKey!, fetchImpl: api.fetchImpl, ...fast, ...makerOptions });
  const taker = createSelfCustody({ baseUrl, signer: takerKey!, fetchImpl: api.fetchImpl, ...fast, ...takerOptions });
  await maker.session.register({ partyName: 'maker' });
  await taker.session.register({ partyName: 'taker' });
  // The fake venue is the dev stand. An account pinned to another network, or to none, cannot hold the
  // stand's preapproval to its own pins; those tests are about the trade, so they onboard unread.
  const unread = (o: Partial<SelfCustodyOptions>) => ({ allowUnverified: o.network !== undefined || o.baseUrl !== undefined });
  await Promise.all([maker.onboard(unread(makerOptions)), taker.onboard(unread(takerOptions))]);
  return { maker, taker };
}

const dvpSteps = (api: ReturnType<typeof venue>) => api.log.filter((e) => e.type.startsWith('dvp:')).map((e) => `${e.type}:${e.params.by}`);

describe('the paths where a mistake costs money', () => {
  test('a stand that has not opened DvP to the account ends both sides with a clear error — and no HTLC is opened instead', async () => {
    const api = venue({ dvpForbidden: true });
    const { maker, taker } = await tradingPair(api, [2, 3]);
    await taker.swap.accept('o1');
    const error = await maker.make('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettleError);
    expect((error as Error).message).toMatch(/allocation-DvP is not open to this account.*never through HTLC/);
    expect(api.proposals).toEqual([]);
    expect(api.asked.filter((t) => t.startsWith('htlc.'))).toEqual([]);
    expect(api.order.swapId).toBeNull();
  });

  test.each([
    ['by the text of the message', false, [52, 53]],
    ['by errorCode alone', true, [54, 55]],
  ] as const)('a taker with no separate holding for the fee: the maker is told the taker must split its balance (%s)', async (_, coded, accounts) => {
    const api = venue({ feeHoldingRequired: true, coded });
    const { maker, taker } = await tradingPair(api, [...accounts]);
    await taker.swap.accept('o1');
    const error = await maker.make('o1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettleError);
    expect((error as Error).message).toMatch(new RegExp(`platform fee \\(24.8756218905\\) needs a holding of its own, and ${api.party('taker')} \\(the taker\\) keeps its CC in a single holding.*splits that balance`));
    expect(dvpSteps(api)).toEqual([]);
  });

  test('a fee rate above the account’s pinned ceiling is refused before the trade is recorded', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [58, 59], { maxFeeRate: '0.001' });
    await taker.swap.accept('o1');
    await expect(maker.make('o1')).rejects.toThrow(/fee rate 0.005 is above this account's ceiling 0.001/);
    expect(api.proposals).toEqual([]);
  });

  test('with no options at all, a fee rate the stand sets to 100% is refused before anything is recorded', async () => {
    const api = venue({ feeConfig: { feeRate: '1', feeRecipient: FEE_PARTY, venue: VENUE } });
    const { maker, taker } = await tradingPair(api, [60, 61]);
    await taker.swap.accept('o1');
    await expect(maker.make('o1')).rejects.toThrow(/fee rate 1 is above this account's ceiling 0.015/);
    expect(api.proposals).toEqual([]);
  });

  test.each([
    ['with no options at all', {}, [62, 63]],
    ['with another party added by the account', { feeRecipientPartyId: ['partner-own-fee::1220'] }, [150, 151]],
  ] as const)('a fee the stand pays to a party that is not a Cancore fee party is refused before anything is recorded (%s)', async (_, pins, accounts) => {
    const api = venue({ pool: 'partner', partnerFeeConfig: { feeRate: '0.005', feeRecipient: 'attacker::1220', venue: VENUE } });
    const { maker, taker } = await tradingPair(api, [...accounts], pins);
    await taker.swap.accept('o1');
    await expect(maker.make('o1')).rejects.toThrow(/pays the platform fee to attacker::1220, which is not a fee party this SDK trusts on devnet/);
    expect(api.proposals).toEqual([]);
  });

  test('a fee party the account adds with feeRecipientPartyId is trusted besides the pinned ones', async () => {
    const own = 'partner-own-fee::1220';
    const api = venue({ pool: 'partner', partnerFeeConfig: { feeRate: '0.005', feeRecipient: own, venue: VENUE } });
    const { maker, taker } = await tradingPair(api, [152, 153], { feeRecipientPartyId: own });
    await taker.swap.accept('o1');
    // The maker records and signs the trade; the taker (not pinned to `own`) never funds, so the wait runs out.
    await maker.make('o1', { deadlineMs: 1_000 }).catch(() => undefined);
    expect(dvpSteps(api)).toEqual(['dvp:dvpCreateProposal:maker']);
    expect(api.legs().find((l) => l.role === 'fee')).toMatchObject({ receiver: own });
  });

  test('on a host of unknown network with no fee party passed, any fee receiver the stand names is refused', async () => {
    const api = venue();
    // The admins are passed so the instrument check holds; nothing tells the SDK which fee parties to trust.
    const { maker, taker } = await tradingPair(api, [162, 163], {
      baseUrl: 'https://api.example.test',
      instrumentAdmins: { CC: [ADMINS.CC!], CBTC: [ADMINS.CBTC!] },
    });
    await taker.swap.accept('o1');
    await expect(maker.make('o1')).rejects.toThrow(new RegExp(`pays the platform fee to ${FEE_PARTY}, which is not a fee party this SDK trusts on this network`));
    expect(api.proposals).toEqual([]);
  });

  test('a fee party of another network is refused: devnet’s retail party on a mainnet account', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [154, 155], {
      network: 'mainnet',
      instrumentAdmins: { CC: [ADMINS.CC!], CBTC: [ADMINS.CBTC!] },
    });
    await taker.swap.accept('o1');
    await expect(maker.make('o1')).rejects.toThrow(new RegExp(`pays the platform fee to ${FEE_PARTY}, which is not a fee party this SDK trusts on mainnet`));
    expect(api.proposals).toEqual([]);
  });

  test.each([
    ['a partner order pays the partner fee party', 'partner', PARTNER_FEE_PARTY, [140, 141]],
    ['a retail order pays the retail fee party', 'retail', FEE_PARTY, [142, 143]],
  ] as const)('the fee is held to the order’s own pool: %s', async (_, pool, feeParty, accounts) => {
    const api = venue({ pool });
    const { maker, taker } = await tradingPair(api, [...accounts]);
    await Promise.all([maker.make('o1'), taker.take('o1')]);
    expect(api.legs().find((l) => l.role === 'fee')).toMatchObject({ receiver: feeParty, lockRef: expect.any(String) });
    // Every read of the fee terms asked for this order's pool.
    expect(api.feeAsked.length).toBeGreaterThan(0);
    expect(new Set(api.feeAsked)).toEqual(new Set(['o1']));
  });

  test('a backend older than the per-order fee config ignores orderId, and the trade settles on its one (retail) pool', async () => {
    const api = venue({ legacyFeeConfig: true, pool: 'partner' });
    const { maker, taker } = await tradingPair(api, [144, 145]);
    await Promise.all([maker.make('o1'), taker.take('o1')]);
    expect(api.legs().find((l) => l.role === 'fee')).toMatchObject({ receiver: FEE_PARTY, lockRef: expect.any(String) });
    expect(new Set(api.feeAsked)).toEqual(new Set(['o1']));
  });

  test.each([
    [401, [156, 157]],
    [404, [158, 159]],
    [503, [160, 161]],
  ] as const)('a %s from the order’s fee config propagates: no retry without orderId, nothing recorded', async (status, accounts) => {
    const api = venue({ feeConfigRefusal: status });
    const { maker, taker } = await tradingPair(api, [...accounts]);
    await taker.swap.accept('o1');
    const error = await maker.make('o1').catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'CancoreApiError', status });
    // The session signs in again once on a 401 and repeats the same request; never one without orderId.
    expect(new Set(api.feeAsked)).toEqual(new Set(['o1']));
    expect(api.proposals).toEqual([]);
  });

  test('a fee leg drafted to another party than the order’s pool fee party is refused before anything is signed', async () => {
    const api = venue({ pool: 'partner', feeLegTo: FEE_PARTY });
    const { maker, taker } = await tradingPair(api, [146, 147]);
    await taker.swap.accept('o1');
    const error = await maker.make('o1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CeremonyError);
    expect((error as Error).message).toMatch(new RegExp(`a leg from ${api.party('taker')} to ${FEE_PARTY} is not part of this trade`));
    expect(dvpSteps(api)).toEqual([]);
  });

  test('a pool whose own maxFeeRate is higher does not lift the account’s ceiling', async () => {
    const api = venue({ pool: 'partner', partnerFeeConfig: { feeRate: '0.02', feeRecipient: PARTNER_FEE_PARTY, venue: VENUE, maxFeeRate: '0.05' } });
    const { maker, taker } = await tradingPair(api, [148, 149]);
    await taker.swap.accept('o1');
    await expect(maker.make('o1')).rejects.toThrow(/fee rate 0.02 is above this account's ceiling 0.015/);
    expect(api.proposals).toEqual([]);
  });

  test.each([
    ['by the text of the message', false, [64, 65]],
    ['by errorCode alone', true, [66, 67]],
  ] as const)('a taker refused at take for want of a fee holding is told to split its own balance (%s)', async (_, coded, accounts) => {
    const api = venue({ refuseAt: { accept: 'feeHolding' }, coded });
    const { taker } = await tradingPair(api, [...accounts]);
    const error = await taker.take('o1', { autoSplitForFee: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettleError);
    expect((error as Error).message).toMatch(/^taking order o1: the platform fee \(24.8756218905\) needs a holding of its own, and this account keeps its CC in a single holding.*splitForFee\(tokenId, '24.8756218905'\).*then take\(\) again/);
    // autoSplitForFee: false only reports the refusal: nothing is sent.
    expect(api.asked).not.toContain('tokens.send');
  });

  const selfSends = (api: ReturnType<typeof venue>) => api.log.filter((e) => e.type === 'tokens.send');
  const auto = { autoSplitForFee: true, allowUnverifiedSplit: true };

  test.each([
    ['by the text of the message, blind', false, [72, 73], undefined],
    ['by errorCode alone, blind', true, [74, 75], undefined],
    ['with the send verified from its bytes', true, [88, 89], 'honest'],
  ] as const)('a single-holding taker that opts in splits the fee off itself and the take goes through, end to end (%s)', async (_, coded, accounts, sendBytes) => {
    const api = venue({ refuseAt: { accept: 'feeHoldingUntilSplit' }, coded, sendBytes });
    const { maker, taker } = await tradingPair(api, [...accounts]);
    const [made, taken] = await Promise.all([maker.make('o1'), taker.take('o1', auto)]);
    expect(made.swap.status).toBe('dvp_settled');
    expect(taken.swap.status).toBe('dvp_settled');
    // Exactly the fee, to itself, CC by omission, signed by the taker's key (the venue verifies every leg).
    expect(selfSends(api)).toEqual([{ type: 'tokens.send', params: { receiverPartyId: api.party('taker'), amount: '24.8756218905' } }]);
    expect(api.order.opponent).toEqual({ partyId: api.party('taker') });
  });

  test('autoSplitForFee is on by default: a verifiable split goes through without opting in (CAN-2735)', async () => {
    const api = venue({ refuseAt: { accept: 'feeHoldingUntilSplit' }, coded: true, sendBytes: 'honest' });
    const { maker, taker } = await tradingPair(api, [220, 221]);
    const [, taken] = await Promise.all([maker.make('o1'), taker.take('o1')]);
    expect(taken.swap.status).toBe('dvp_settled');
    expect(selfSends(api)).toHaveLength(1);
  });

  test('a self-send whose bytes pay anyone else is refused before the key signs it', async () => {
    const api = venue({ sendBytes: 'theft', twoHoldings: true });
    const { taker } = await tradingPair(api, [90, 91]);
    await expect(taker.splitForFee('CC', '24.8756218905')).rejects.toThrow(/tokens.send prepare failed: refusing to sign tokens.send: leg 0: node 2 involves thief::1220, who is not part of this send/);
    expect(selfSends(api)).toEqual([]);
    // The bound: the 0.125 quote, no debt, and 1% of the fee (above the 0.1 CC floor) for the holding fee.
    const greedy = venue({ sendBytes: 'overcharge', twoHoldings: true });
    const { taker: other } = await tradingPair(greedy, [98, 99]);
    await expect(other.splitForFee('CC', '24.8756218905')).rejects.toThrow(/the send costs this account more than 0.3737562189 Amulet/);
    expect(selfSends(greedy)).toEqual([]);
  });

  test('a send with bytes for some legs only, or for none, is never signed unless the caller allows it blind', async () => {
    const mixed = venue({ sendBytes: 'mixed', twoHoldings: true });
    const { taker } = await tradingPair(mixed, [100, 101]);
    await expect(taker.splitForFee('CC', '24.8756218905', { allowUnverified: true })).rejects.toThrow(/bytes for 1 of the send's 2 legs; a partly readable send is never signed/);
    expect(selfSends(mixed)).toEqual([]);

    const bare = venue({ refuseAt: { accept: 'feeHoldingUntilSplit' }, coded: true });
    const { taker: blind } = await tradingPair(bare, [102, 103]);
    await expect(blind.splitForFee('CC', '24.8756218905')).rejects.toThrow(/without its transaction bytes, so it cannot be verified/);
    await expect(blind.take('o1', { autoSplitForFee: true })).rejects.toThrow(/splitting 24.8756218905 off failed: .*cannot be verified/);
    expect(selfSends(bare)).toEqual([]);
  });

  test('fee debt the API collects on the split is part of its cost, under maxSplitCost', async () => {
    const indebted = venue({ feeDebt: '3' });
    const { taker } = await tradingPair(indebted, [104, 105]);
    await expect(taker.splitForFee('CC', '24.8756218905', { allowUnverified: true })).rejects.toThrow(/owes 3 CC of fee debt.*above maxSplitCost 2.0000000000 — settle the fee debt first/);
    expect(selfSends(indebted)).toEqual([]);
    const small = venue({ feeDebt: '1.5', sendBytes: 'honest' });
    const { taker: other } = await tradingPair(small, [106, 107]);
    await expect(other.splitForFee('CC', '24.8756218905')).resolves.toEqual({ verified: true });
  });

  test('splitForFee splits whenever it is called, and says whether it read what it signed', async () => {
    const blind = venue();
    const { taker } = await tradingPair(blind, [76, 77]);
    await expect(taker.splitForFee('CC', '24.8756218905', { allowUnverified: true })).resolves.toEqual({ verified: false });
    await expect(taker.splitForFee('CC', '24.8756218905', { allowUnverified: true })).resolves.toEqual({ verified: false });
    expect(selfSends(blind)).toHaveLength(2);

    // One holding: the API defers the network fee, and the send is the transfer alone.
    const read = venue({ sendBytes: 'honest' });
    const { taker: other } = await tradingPair(read, [78, 79]);
    await expect(other.splitForFee('CC', '24.8756218905')).resolves.toEqual({ verified: true });
    // Two holdings already: the network fee rides as a leg of its own, paid to the pinned party.
    const paid = venue({ sendBytes: 'honest', twoHoldings: true });
    const { taker: third } = await tradingPair(paid, [108, 109]);
    await expect(third.splitForFee('CC', '24.8756218905')).resolves.toEqual({ verified: true });
    // A small fee still gets the 0.1 CC floor for the holding fee its input accrued: 1% of 0.5 alone would refuse it.
    const aged = venue({ sendBytes: 'honest', twoHoldings: true, accruedHoldingFee: 0.05 });
    const { taker: fourth } = await tradingPair(aged, [110, 111]);
    await expect(fourth.splitForFee('CC', '0.5')).resolves.toEqual({ verified: true });
  });

  test('splitForFee never sends more than the balance covers with the send’s own network fee, and refuses a registry token', async () => {
    const api = venue();
    const { taker } = await tradingPair(api, [80, 81]);
    // 9999.875 + 0.125 network fee = the whole 10000: nothing would be left as a second holding.
    await expect(taker.splitForFee('CC', '9999.875')).rejects.toThrow(/insufficient balance — 10000 does not cover the fee, the send's network fee 0.125/);
    await expect(taker.splitForFee('CBTC', '0.0001')).rejects.toThrow(/refuses a CBTC send to oneself/);
    await expect(taker.splitForFee('CC', '0')).rejects.toThrow(RangeError);
    expect(api.asked).not.toContain('tokens.send');
  });

  test.each([
    ['negative', -1, /is not a decimal/],
    ['past exponent notation', 1e21, /is not a decimal/],
    ['above maxSplitCost', 30, /network fee estimate 30 is above maxSplitCost 2.0000000000/],
  ] as const)('a network fee estimate that is %s is refused, and nothing is sent', async (_, networkFee, message) => {
    const api = venue({ networkFee });
    const { taker } = await tradingPair(api, [92, 93]);
    await expect(taker.splitForFee('CC', '24.8756218905')).rejects.toThrow(message);
    expect(api.asked).not.toContain('tokens.send');
  });

  test('a split whose change would not cover the trade leg is refused before anything is sent', async () => {
    // 5000.05 − 24.8756218905 − 0.125 = 4975.0493781095 left, short of the 4975.1243781095 leg.
    const api = venue({ refuseAt: { accept: 'feeHoldingUntilSplit' }, coded: true, balance: 5000.05 });
    const { taker } = await tradingPair(api, [94, 95]);
    await expect(taker.take('o1', auto)).rejects.toThrow(/splitting 24.8756218905 off failed: .*insufficient balance — 5000.05 does not cover the fee, the send's network fee 0.125 and the trade leg/);
    expect(api.asked).not.toContain('tokens.send');
    expect(api.takes()).toBe(1);
  });

  test('a fee the venue names above the order × the account’s fee ceiling is never split', async () => {
    // 5000 × 0.015 = 75: a refusal asking for 100 is not the platform fee of this order.
    const api = venue({ refuseAt: { accept: 'feeHoldingUntilSplit' }, coded: true, refusedFee: '100' });
    const { taker } = await tradingPair(api, [96, 97]);
    await expect(taker.take('o1', auto)).rejects.toThrow(/fee holding of 100, more than 5000 × this account's ceiling 0.015.*nothing was split/);
    expect(api.asked).not.toContain('tokens.send');
  });

  test('a split that fails ends the take with a SettleError, and nothing is tried twice', async () => {
    const api = venue({ refuseAt: { accept: 'feeHoldingUntilSplit' }, coded: true, failSend: true });
    const { taker } = await tradingPair(api, [82, 83]);
    const error = await taker.take('o1', auto).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettleError);
    expect((error as Error).message).toMatch(/taking order o1: the platform fee needs a holding of its own, and splitting 24.8756218905 off failed: tokens.send prepare failed: .*Insufficient holdings/);
    expect(api.asked.filter((t) => t === 'tokens.send')).toHaveLength(1);
    expect(api.takes()).toBe(1);
    expect(api.order.status).toBe('open');
  });

  test('a venue that still refuses after the split ends the take: one split, one retry', async () => {
    const api = venue({ refuseAt: { accept: 'feeHolding' }, coded: true });
    const { taker } = await tradingPair(api, [84, 85]);
    const error = await taker.take('o1', auto).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettleError);
    expect((error as Error).message).toMatch(/taking order o1: refused again after splitting 24.8756218905 into a holding of its own/);
    expect(api.takes()).toBe(2);
    expect(selfSends(api)).toHaveLength(1);
  });

  test('when the fee payer is the counterparty, the taker splits nothing and is told who must', async () => {
    const api = venue({ refuseAt: { accept: 'feeHoldingOther' }, coded: true });
    const { taker } = await tradingPair(api, [86, 87]);
    const error = await taker.take('o1', auto).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettleError);
    expect((error as Error).message).toMatch(/someone-else::1220 \(the taker\) keeps its CC in a single holding/);
    expect(api.asked).not.toContain('tokens.send');
  });

  test('a taker the stand does not open DvP to is refused at take, before anything is signed', async () => {
    const api = venue({ refuseAt: { accept: 'notAllowed' }, coded: true });
    const { taker } = await tradingPair(api, [68, 69]);
    await expect(taker.take('o1')).rejects.toThrow(/taking order o1: allocation-DvP is not open to this account/);
    expect(dvpSteps(api)).toEqual([]);
  });

  test('placing a Canton↔Canton order the stand does not open DvP for is a SettleError, not a raw refusal', async () => {
    const api = venue({ refuseAt: { create: 'notAllowed' }, coded: true });
    const { maker } = await tradingPair(api, [70, 71]);
    const offer = {
      sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceTokenName: 'CBTC', sourceAmount: '0.01',
      targetNetwork: 'canton', targetTokenAddress: 'CC', targetTokenName: 'CC', targetAmount: '5000',
    };
    await expect(maker.swap.create(offer)).rejects.toThrow(/placing the order: allocation-DvP is not open to this account/);
  });

  test('an order placed without dvp: true is refused before anything is recorded — it would be opened as HTLC', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [56, 57]);
    await taker.swap.accept('o1');
    api.order.dvp = false;
    await expect(maker.make('o1')).rejects.toThrow(/placed without dvp: true.*place it again/);
    expect(api.proposals).toEqual([]);
  });

  test('a stand that does not settle the pair through DvP is refused before anything is recorded', async () => {
    const api = venue({ pairOff: true });
    const { maker, taker } = await tradingPair(api, [4, 5]);
    await taker.swap.accept('o1');
    await expect(maker.make('o1')).rejects.toThrow(/CBTC\/CC: this pair is not enabled for DvP on this stand.*never fall back to HTLC/);
    expect(api.proposals).toEqual([]);
    expect(api.asked.filter((t) => t.startsWith('htlc.'))).toEqual([]);
  });

  test('a taker whose approval the stand refuses gets a CeremonyError naming the step and the 403', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [6, 7]);
    await taker.swap.accept('o1');
    // The maker records and signs the trade; then the stand closes DvP to the taker.
    const making = maker.make('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    const error = await createSelfCustody({
      baseUrl, signer: await providerFromMnemonic(PHRASE, { account: 7 }), ...fast,
      fetchImpl: async (url, init) => (new URL(url).pathname === '/canton-wallet/htlc/prepare-command'
        ? refuse(403, 'Allocation-DvP is not open to this account on this stand.')
        : api.fetchImpl(url, init)),
    }).take('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CeremonyError);
    expect(error).toMatchObject({ operation: 'dvpAcceptProposal', stage: 'prepare', cause: { status: 403 }, meta: { swapId: 's1' } });
    expect(await making).toBeInstanceOf(SettleError);
    expect(dvpSteps(api)).toEqual(['dvp:dvpCreateProposal:maker']);
  });

  test('a window that closes before anybody funds ends both sides with a SettleError naming the swap — nothing is locked', async () => {
    const api = venue({ expireAfterTrade: true });
    const { maker, taker } = await tradingPair(api, [8, 9]);
    const [made, taken] = await Promise.allSettled([maker.make('o1'), taker.take('o1')]);
    for (const outcome of [made, taken]) {
      expect(outcome.status).toBe('rejected');
      const reason = (outcome as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(SettleError);
      expect(reason).toMatchObject({ swapId: 's1', message: expect.stringMatching(/dvp_expired/), last: { status: 'dvp_expired' } });
    }
    expect(dvpSteps(api)).not.toContain('dvp:dvpAllocateLeg:taker');
    expect(api.legs().some((l) => l.lockRef)).toBe(false);
  });

  test('a swap an earlier client opened as HTLC is refused on both sides, not settled as HTLC', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [10, 11]);
    await taker.swap.accept('o1');
    api.htlcOpenedEarlier((await maker.me()).partyId!, (await taker.me()).partyId!);
    // The HTLC row is served by the full route as-is.
    const spy: FetchLike = async (url, init) => (new URL(url).pathname === '/htlc/swaps/s1/full'
      ? json({ swap: { id: 's1', status: 'proposal_created' }, legs: [], dvp: null })
      : api.fetchImpl(url, init));
    for (const account of [10, 11]) {
      const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE, { account }), fetchImpl: spy, ...fast });
      await expect(account === 10 ? acct.make('o1') : acct.take('o1')).rejects.toThrow(/s1 is an HTLC swap.*only through allocation-DvP/);
    }
    expect(api.asked).not.toContain('htlc.accept-counter');
    expect(dvpSteps(api)).toEqual([]);
  });

  test('a maker restarted after signing the proposal resumes the trade and signs nothing twice', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [12, 13]);
    await taker.swap.accept('o1');
    // The first run dies right after its proposal landed.
    const crashing = createSelfCustody({
      baseUrl, signer: await providerFromMnemonic(PHRASE, { account: 12 }), ...fast,
      fetchImpl: async (url, init) => {
        const answer = await api.fetchImpl(url, init);
        if (new URL(url).pathname === '/canton-wallet/htlc/submit-signed') throw new Error('process died');
        return answer;
      },
    });
    await expect(crashing.make('o1')).rejects.toThrow(/process died/);
    expect(dvpSteps(api)).toEqual(['dvp:dvpCreateProposal:maker']);

    const [made] = await Promise.all([maker.make('o1'), taker.take('o1')]);
    expect(made.swap.status).toBe('dvp_settled');
    expect(api.proposals).toHaveLength(1);
    expect(dvpSteps(api).filter((s) => s === 'dvp:dvpCreateProposal:maker')).toHaveLength(1);
  });
});

describe('what the account signs is what it read', () => {
  test.each([
    ['a hash that is not the hash of the transaction it came with', 'hash', /does not hash to the hash/, [40, 41]],
    ['an allocation of another amount', 'amount', /not the order's 0.01 CBTC/, [42, 43]],
    ['an allocation to another receiver', 'receiver', /not part of this trade/, [44, 45]],
  ] as const)('%s is refused before the key signs anything, and nothing is submitted', async (_, tamper, reason, accounts) => {
    const api = venue({ tamperMakerAllocation: tamper });
    const { maker, taker } = await tradingPair(api, [...accounts]);
    const [made] = await Promise.allSettled([maker.make('o1', { deadlineMs: 3_000 }), taker.take('o1', { deadlineMs: 3_000 })]);
    const error = (made as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(CeremonyError);
    expect(error).toMatchObject({ operation: 'dvpAllocateLeg', stage: 'prepare', message: expect.stringMatching(reason) });
    // The taker's own honest steps went through; the maker's tampered allocation never reached the API.
    expect(dvpSteps(api)).toEqual(['dvp:dvpCreateProposal:maker', 'dvp:dvpAcceptProposal:taker', 'dvp:dvpAllocateLeg:taker']);
  });
});

describe('a taker that funded and a maker that did not', () => {
  test('the trade expires and the taker is told the venue released its allocations', async () => {
    const api = venue({ takerFundedThenExpired: 'released' });
    const { maker, taker } = await tradingPair(api, [46, 47]);
    await taker.swap.accept('o1');
    // The maker records and proposes, then goes away before funding.
    const making = maker.make('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    const error = await taker.take('o1', { autoSplitForFee: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettleError);
    expect(error).toMatchObject({
      swapId: 's1',
      last: { status: 'dvp_expired' },
      message: expect.stringMatching(/dvp_expired.*allocation\(s\) \(counter, fee\) were released by the venue's recovery/),
    });
    expect(dvpSteps(api)).toContain('dvp:dvpAllocateLeg:taker');
    expect(dvpSteps(api)).not.toContain('dvp:dvpAllocateLeg:maker');
    await making;
  });

  test('allocations the recovery could not release are named, with what to do about them', async () => {
    const api = venue({ takerFundedThenExpired: 'stillLocked' });
    const { maker, taker } = await tradingPair(api, [48, 49]);
    await taker.swap.accept('o1');
    const making = maker.make('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    const error = await taker.take('o1', { autoSplitForFee: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettleError);
    expect((error as Error).message).toMatch(/\(counter, fee\) are still locked after the venue's recovery \(abort refused\).*withdrawAllocation\('s1'\).*autoWithdraw/);
    expect(error).toMatchObject({ withdrawable: true });
    await making;
  });

  test('a wait that ends before the deadline says the allocations stay locked until the venue releases them', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [50, 51]);
    await taker.swap.accept('o1');
    const making = maker.make('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    // The maker never funds: an instrumented maker that stops after proposing.
    await making;
    const error = await taker.take('o1', { deadlineMs: 500 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettleError);
    expect((error as Error).message).toMatch(/timed out.*stay locked until then\. The venue releases a DvP allocation.*SwapTrade_Abort/);
  });
});

describe('withdrawing an allocation the venue could not release (BUG-1291)', () => {
  /** The taker funded its leg and the fee, the maker never did, and recovery's abort was refused. */
  async function strandedTaker(accounts: [number, number]) {
    const api = venue({ takerFundedThenExpired: 'stillLocked' });
    const { maker, taker } = await tradingPair(api, accounts);
    await taker.swap.accept('o1');
    const making = maker.make('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    const error = await taker.take('o1', { autoSplitForFee: false }).catch((e: unknown) => e);
    await making;
    return { api, taker, maker, error };
  }

  test('take() leaves the taker able to release its own allocations, one signed withdraw per locked leg', async () => {
    const { api, taker, error } = await strandedTaker([52, 53]);
    expect(error).toMatchObject({ swapId: 's1', withdrawable: true });

    expect(await taker.withdrawAllocation('s1')).toEqual({ swapId: 's1', withdrawn: ['counter', 'fee'], gone: [], failed: [] });

    // Each withdraw was its own prepare → verify → sign → submit, for exactly the leg it names.
    expect(api.log.filter((e) => e.type === 'dvp:dvpWithdrawAllocation').map((e) => [e.params.by, e.params.legIds])).toEqual([
      ['taker', ['leg-counter']],
      ['taker', ['leg-fee']],
    ]);
    expect(api.legs().filter((l) => l.sender === api.party('taker')).map((l) => l.status)).toEqual(['cancelled', 'cancelled']);
    // Nothing is left locked, so a second call signs nothing.
    expect(await taker.withdrawAllocation('s1')).toEqual({ swapId: 's1', withdrawn: [], gone: [], failed: [] });
    expect(api.log.filter((e) => e.type === 'dvp:dvpWithdrawAllocation')).toHaveLength(2);
  });

  test('autoWithdraw releases them before the SettleError is thrown', async () => {
    const api = venue({ takerFundedThenExpired: 'stillLocked' });
    const { maker, taker } = await tradingPair(api, [54, 55]);
    await taker.swap.accept('o1');
    const making = maker.make('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    const error = await taker.take('o1', { autoWithdraw: true }).catch((e: unknown) => e);
    await making;

    expect(error).toBeInstanceOf(SettleError);
    expect(error).toMatchObject({ swapId: 's1', withdrawable: false, message: expect.stringMatching(/dvp_expired.*autoWithdraw: this account's allocation\(s\) \(counter, fee\) were released with its own signature/), withdrawal: { withdrawn: ['counter', 'fee'], gone: [], failed: [] } });
    expect(api.log.filter((e) => e.type === 'dvp:dvpWithdrawAllocation')).toHaveLength(2);
  });

  test('without autoWithdraw nothing is signed that was not asked for', async () => {
    const { api } = await strandedTaker([56, 57]);
    expect(api.log.filter((e) => e.type === 'dvp:dvpWithdrawAllocation')).toEqual([]);
  });

  test('a live trade is refused before anything is prepared', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [58, 59]);
    await taker.swap.accept('o1');
    await maker.make('o1', { deadlineMs: 300 }).catch(() => undefined);
    // The taker funds and waits for a settle that never comes: the trade is live, the venue owns its fate.
    await taker.take('o1', { deadlineMs: 300 }).catch(() => undefined);
    const error = await taker.withdrawAllocation('s1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettleError);
    expect((error as Error).message).toMatch(/only be withdrawn once the trade is dvp_expired/);
    expect(api.asked).not.toContain('dvpWithdrawAllocation');
  });

  test('a leg already gone from the ledger is done, and the next leg is still released', async () => {
    const api = venue({ takerFundedThenExpired: 'stillLocked', archivedUnmarked: ['leg-counter'] });
    const { maker, taker } = await tradingPair(api, [62, 63]);
    await taker.swap.accept('o1');
    const making = maker.make('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    await taker.take('o1').catch((e: unknown) => e);
    await making;

    expect(await taker.withdrawAllocation('s1')).toEqual({ swapId: 's1', withdrawn: ['fee'], gone: ['counter'], failed: [] });
  });

  test('one leg that cannot be withdrawn is reported and does not keep the next one locked', async () => {
    const api = venue({ takerFundedThenExpired: 'stillLocked', withdrawRefuses: ['leg-counter'] });
    const { maker, taker } = await tradingPair(api, [64, 65]);
    await taker.swap.accept('o1');
    const making = maker.make('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    const error = await taker.take('o1', { autoWithdraw: true }).catch((e: unknown) => e);
    await making;

    // The trade's own SettleError is kept, with what the withdraw did attached.
    expect(error).toBeInstanceOf(SettleError);
    expect(error).toMatchObject({ swapId: 's1', last: { status: 'dvp_expired' } });
    const { withdrawal } = error as SettleError;
    // Still withdrawable: a leg is left, and the flag says so.
    expect(error).toMatchObject({ withdrawable: true });
    expect(withdrawal?.withdrawn).toEqual(['fee']);
    expect(withdrawal?.failed).toEqual([expect.objectContaining({ leg: 'counter', error: expect.any(CeremonyError) })]);
    expect((error as Error).message).toMatch(/1 leg\(s\) could not be withdrawn \(counter:.*withdrawAllocation\('s1'\) again/);
  });

  test('the stand no longer listing the pair for DvP does not keep the allocation locked', async () => {
    const api = venue({ takerFundedThenExpired: 'stillLocked' });
    const { maker, taker } = await tradingPair(api, [68, 69]);
    await taker.swap.accept('o1');
    const making = maker.make('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    await taker.take('o1').catch((e: unknown) => e);
    await making;
    api.switchInstrumentsOff();

    expect(await taker.withdrawAllocation('s1')).toEqual({ swapId: 's1', withdrawn: ['counter', 'fee'], gone: [], failed: [] });
  });

  test('a fee-config outage does not keep the allocation locked: the withdraw never asks for it', async () => {
    const api = venue({ takerFundedThenExpired: 'stillLocked' });
    const { maker, taker } = await tradingPair(api, [70, 71]);
    await taker.swap.accept('o1');
    const making = maker.make('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    await taker.take('o1').catch((e: unknown) => e);
    await making;
    api.takeFeeConfigDown();

    expect(await taker.withdrawAllocation('s1')).toEqual({ swapId: 's1', withdrawn: ['counter', 'fee'], gone: [], failed: [] });
  });

  test('the stand’s fee policy changing after the trade does not keep the allocation locked', async () => {
    const api = venue({ takerFundedThenExpired: 'stillLocked' });
    const { maker, taker } = await tradingPair(api, [66, 67]);
    await taker.swap.accept('o1');
    const making = maker.make('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    await taker.take('o1').catch((e: unknown) => e);
    await making;
    // A rate far above this account's ceiling, to another receiver: take() would refuse this stand now.
    api.setFeeConfig({ feeRate: '0.5', feeRecipient: 'someone-else::1220', venue: VENUE, maxFeeRate: '0.9' });

    expect(await taker.withdrawAllocation('s1')).toEqual({ swapId: 's1', withdrawn: ['counter', 'fee'], gone: [], failed: [] });
  });

  test('the party that did not fund has nothing to withdraw', async () => {
    const { maker } = await strandedTaker([60, 61]);
    expect(await maker.withdrawAllocation('s1')).toEqual({ swapId: 's1', withdrawn: [], gone: [], failed: [] });
  });
});

describe('submit refusals of a DvP step, by text and by errorCode alone', () => {
  test.each([
    ['by the text of the message', false, [14, 15]],
    ['by errorCode alone', true, [16, 17]],
  ] as const)('an allocation whose prepared stash expired is prepared and signed again, once (%s)', async (_, coded, accounts) => {
    const api = venue({ staleAllocateOnce: true, coded });
    const { maker, taker } = await tradingPair(api, [...accounts]);
    const [, taken] = await Promise.all([maker.make('o1', { deadlineMs: 3_000 }), taker.take('o1', { deadlineMs: 3_000 })]);
    expect(taken.swap.status).toBe('dvp_settled');
    expect(dvpSteps(api).filter((s) => s === 'dvp:dvpAllocateLeg:taker')).toHaveLength(1);
  });

  test.each([
    ['by the text of the message', false, [18, 19]],
    ['by errorCode alone', true, [20, 21]],
  ] as const)('an allocation submit that timed out is resubmitted with the same signatures (%s)', async (_, coded, accounts) => {
    const api = venue({ timeoutAllocateOnce: true, coded });
    const { maker, taker } = await tradingPair(api, [...accounts]);
    const [made] = await Promise.all([maker.make('o1', { deadlineMs: 3_000 }), taker.take('o1', { deadlineMs: 3_000 })]);
    expect(made.swap.status).toBe('dvp_settled');
    expect(dvpSteps(api).filter((s) => s === 'dvp:dvpAllocateLeg:taker')).toHaveLength(1);
  });
});

describe('a signer that only has signMessage is not handed a challenge that is not one (CAN-2399)', () => {
  // The challenge is the API's to choose, and the fallback signs it raw: 32 bytes of it would be a
  // signature over a transaction hash, and a server can ask for a login whenever it likes (a 401).
  const raw = () => ({ public_key: '00'.repeat(32), signMessage: jest.fn(async () => '00') });
  const answering = (challenge: unknown): FetchLike => async (url) =>
    new URL(url).pathname === '/auth/challenge' ? json({ challenge }) : json({ token: jwt('a'), refreshToken: 'r1', user: {} });

  test.each<[string, unknown]>([
    ['a transaction hash', String.fromCharCode(...new Array<number>(32).fill(0xbb))],
    ['a topology multihash', `\x12\x20${'a'.repeat(32)}`],
    ['32 printable characters', 'x'.repeat(32)],
    ['a challenge with a line break in it', 'Welcome to Cancore 2026-09-28\nsig:1'],
    ['the prefix without its space', 'Welcome to Cancore'],
    ['nothing', ''],
    ['a value that is not a string', { toString: () => 'Welcome to Cancore 2026-09-28 sig:1' }],
  ])('%s is not signed', async (_what, challenge) => {
    const signer = raw();

    await expect(createSession({ baseUrl, signer, fetchImpl: answering(challenge) }).login()).rejects.toThrow(/not a Cancore login challenge/);
    expect(signer.signMessage).not.toHaveBeenCalled();
  });

  test('signing up is the same door: a register challenge that is not one is not signed either', async () => {
    const signer = raw();
    const fetchImpl: FetchLike = async (url) =>
      new URL(url).pathname === '/auth/register-challenge' ? json({ challenge: 'x'.repeat(32) }) : json({ token: jwt('a'), user: {} });

    await expect(createSession({ baseUrl, signer, fetchImpl }).register({ partyName: 'bot' })).rejects.toThrow(/not a Cancore login challenge/);
    expect(signer.signMessage).not.toHaveBeenCalled();
  });

  test('the prefix is the one the wallet\'s own signChallenge holds a challenge to', () => {
    expect(LOGIN_CHALLENGE_PREFIX).toBe(WALLET_CHALLENGE_PREFIX);
  });

  test('a real challenge is signed, as before', async () => {
    const signer = raw();

    await createSession({ baseUrl, signer, fetchImpl: answering('Welcome to Cancore 2026-09-28 sig:1') }).login();
    expect(signer.signMessage).toHaveBeenCalledWith('Welcome to Cancore 2026-09-28 sig:1');
  });

  test('a signer with its own signChallenge is asked as before: the check is its own', async () => {
    const signer = { ...raw(), signChallenge: jest.fn(async () => '00') };

    await createSession({ baseUrl, signer, fetchImpl: answering('anything') }).login();
    expect(signer.signChallenge).toHaveBeenCalledWith('anything');
    expect(signer.signMessage).not.toHaveBeenCalled();
  });
});

test('the session renews an expiring token and signs in again after a 401', async () => {
  const signer = await providerFromMnemonic(PHRASE);
  const seen: string[] = [];
  let expiring = true;
  let revoked = false;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const auth = (init.headers as Record<string, string>).authorization ?? '';
    seen.push(path);
    if (path === '/auth/challenge') return json({ challenge: 'Welcome to Cancore 2026-09-28 sig:1' });
    if (path === '/auth/login-signature') {
      const token = jwt('a', expiring ? Math.floor(Date.now() / 1000) + 30 : FAR);
      expiring = false;
      return json({ token, refreshToken: 'r1', user: {} });
    }
    if (path === '/auth/refresh') return json({ token: jwt('a'), refreshToken: 'r2' });
    if (revoked) {
      revoked = false;
      return refuse(401, 'Unauthorized');
    }
    return json({ ok: auth.startsWith('Bearer h.') });
  };
  const session = createSession({ baseUrl, signer, fetchImpl });
  await session.login();
  // The token dies in 30 s — inside the renewal margin, so it is refreshed first.
  expect(await (await session.request(`${baseUrl}/x`, { method: 'GET', headers: {} })).json()).toEqual({ ok: true });
  expect(seen).toEqual(['/auth/challenge', '/auth/login-signature', '/auth/refresh', '/x']);

  revoked = true;
  seen.length = 0;
  await session.request(`${baseUrl}/y`, { method: 'GET', headers: {} });
  expect(seen).toEqual(['/y', '/auth/challenge', '/auth/login-signature', '/y']);
});

test('a submit that timed out is resubmitted with the same signatures; a plain execute never re-prepares', async () => {
  const signer = await providerFromMnemonic(PHRASE);
  const submits: string[] = [];
  let prepares = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/auth/challenge') return json({ challenge: 'Welcome to Cancore 2026-09-28 sig:1' });
    if (path === '/auth/login-signature') return json({ token: jwt('a'), user: {} });
    const body = JSON.parse(String(init.body));
    if (path === '/wallet/operations/prepare') {
      prepares++;
      return json({ operationId: `op${prepares}`, legs: [{ legId: 'l', hash: b64(new Uint8Array(32)), kind: 'transfer' }], meta: null });
    }
    submits.push(`${body.operationId}:${body.signatures[0].signature.slice(0, 8)}`);
    if (submits.length === 1) return refuse(400, 'submission timed out — safe to retry with the same signature');
    if (submits.length === 2) return refuse(400, 'No pending submission found for this key');
    return json({ ok: true });
  };
  const acct = createSelfCustody({ baseUrl, signer, fetchImpl, ...fast });
  // `execute` does not re-run a stale prepare — only the accept ceremonies may.
  await expect(acct.execute('htlc.accept-counter', { swapId: 's' })).rejects.toThrow(/No pending/);
  expect(submits[0]).toBe(submits[1]);
  expect(prepares).toBe(1);
});

test('a timed-out submit is resubmitted on the code alone, and a code with another condition’s text is not', async () => {
  const signer = await providerFromMnemonic(PHRASE);
  const run = async (errorCode: string) => {
    const submits: string[] = [];
    let prepares = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/auth/challenge') return json({ challenge: 'Welcome to Cancore 2026-09-28 sig:1' });
      if (path === '/auth/login-signature') return json({ token: jwt('a'), user: {} });
      const body = JSON.parse(String(init.body));
      if (path === '/wallet/operations/prepare') {
        prepares++;
        return json({ operationId: 'op1', legs: [{ legId: 'l', hash: b64(new Uint8Array(32)), kind: 'transfer' }], meta: null });
      }
      submits.push(body.signatures[0].signature);
      // The text is the old retry phrase on both runs: only the code tells them apart.
      return submits.length === 1 ? refuse(400, 'submission timed out — safe to retry', errorCode) : json({ ok: true });
    };
    const acct = createSelfCustody({ baseUrl, signer, fetchImpl, ...fast });
    const outcome = await acct.execute('tokens.accept', {}).then(() => 'done', () => 'refused');
    return { outcome, submits, prepares };
  };

  const retryable = await run('SUBMISSION_TIMEOUT_RETRYABLE');
  expect(retryable.outcome).toBe('done');
  expect(retryable.submits).toHaveLength(2);
  expect(retryable.submits[0]).toBe(retryable.submits[1]);
  // The server re-stashed the signed transaction: the same one goes again, nothing is prepared anew.
  expect(retryable.prepares).toBe(1);

  const other = await run('KEY_IN_USE');
  expect(other.outcome).toBe('refused');
  expect(other.submits).toHaveLength(1);
});

test('collect accepts exactly the claim’s own payouts, and nothing else in the inbox', async () => {
  const signer = await providerFromMnemonic(PHRASE);
  const accepted: string[] = [];
  const me = `party-me::${cantonFingerprint(signer.public_key)}`;
  const ti = (contractId: string) => ({ contractId, templateId: 't', instrumentAdmin: DEV.cbtcRegistrar, instrumentId: 'CBTC', executeBefore: new Date(Date.now() + 60_000).toISOString() });
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/auth/challenge') return json({ challenge: 'Welcome to Cancore 2026-09-28 sig:1' });
    if (path === '/auth/login-signature') return json({ token: jwt('a'), user: {} });
    if (path === '/auth/me') return json({ id: 'me', partyId: me });
    if (path === '/partner/cashback/claim') return json({ id: 'c1', status: 'settling' });
    if (path === '/partner/cashback/claims') {
      return json([{ id: 'c1', status: 'settling', payouts: [
        { id: 'p1', tokenId: 'CC', settlementStatus: 'accepted', transferInstructionCid: null },
        { id: 'p2', tokenId: 'USDCx', settlementStatus: 'pending', transferInstructionCid: 'ti-cashback' },
      ] }]);
    }
    if (path === '/tokens/transfer-requests/incoming') return json([ti('ti-cashback'), ti('ti-unrelated')]);
    const body = JSON.parse(String(init.body));
    if (path === '/wallet/operations/prepare') {
      accepted.push(body.params.instructionCid);
      return json({ operationId: 'op', legs: await acceptLegs(me, body.params.instructionCid), meta: null });
    }
    return json({ ok: true });
  };
  const acct = createSelfCustody({ baseUrl, signer, fetchImpl, ...fast });
  const { pending } = await acct.cashback.collect();
  expect(accepted).toEqual(['ti-cashback']);
  expect(pending).toBe(0);
});

test('acceptTerms signs the exact text the API verifies', async () => {
  const signer = await providerFromMnemonic(PHRASE);
  let posted: Record<string, string> | undefined;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/auth/challenge') return json({ challenge: 'Welcome to Cancore 2026-09-28 sig:1' });
    if (path === '/auth/login-signature') return json({ token: jwt('a'), user: {} });
    if (path === '/auth/me') return json({ id: 'u1', partyId: 'p::1220' });
    posted = JSON.parse(String(init.body));
    return json({});
  };
  const acct = createSelfCustody({ baseUrl, signer, fetchImpl, now: () => Date.parse('2026-09-28T10:00:00.000Z') });
  const documents = [{ key: 'terms-of-use', version: '2026-08-01', url: '/legal/terms-of-use' }, { key: 'privacy', version: '2026-08-01', url: '/legal/privacy' }];
  await acct.acceptTerms('2026-08-01', documents);
  const message = legalConsentMessage({ version: '2026-08-01', partyId: 'p::1220', issuedAt: '2026-09-28T10:00:00.000Z', documents });
  expect(message).toBe(
    'CANCORE_LEGAL_CONSENT_V1\nversion:2026-08-01\nparty:p::1220\nissuedAt:2026-09-28T10:00:00.000Z\ndocuments:privacy@2026-08-01,terms-of-use@2026-08-01',
  );
  expect(ed25519.verify(hex(posted!.signature!), new TextEncoder().encode(message), hex(signer.public_key))).toBe(true);
});

test('grossAmount refuses an amount it cannot hold exactly, instead of truncating it', () => {
  expect(() => grossAmount('1.00000000001', '0.005')).toThrow(RangeError);
});

test('grossAmount covers the net after the fee, in exact 1e-10 units rounded up', () => {
  expect(grossAmount('100', '0.005')).toBe(100.5);
  expect(grossAmount('5000', '0.0050000000')).toBe(5025);
  expect(grossAmount('0.0000000001', '0.01')).toBe(0.0000000002);
  expect(grossAmount('0.3', '0')).toBe(0.3);
  // The API's own check: gross ≥ net × (1 + rate) − 1e-8.
  for (const [net, rate] of [['123.4567891234', '0.0075'], ['0.00012345', '0.01'], ['99999.9999999999', '0.005']] as const) {
    expect(grossAmount(net, rate)).toBeGreaterThanOrEqual(parseFloat(net) * (1 + parseFloat(rate)) - 1e-8);
  }
});

test('expiresWithin reads exp from a JWT and leaves an unreadable one to the 401 path', () => {
  expect(expiresWithin(jwt('a', 1000), 60_000, 1000 * 1000 - 30_000)).toBe(true);
  expect(expiresWithin(jwt('a', 1000), 60_000, 1000 * 1000 - 120_000)).toBe(false);
  expect(expiresWithin('not-a-jwt', 60_000, 0)).toBe(false);
});

describe('what onboard() lets the key sign for the party (CAN-2399)', () => {
  // The leg's `kind` is the venue's word, and a topology leg is signed raw. The rule is the wallet's
  // (@cancore/wallet/operations); what is pinned here is that this client tells it which operation it asked for.
  test.each([
    ['a 32-byte hash called a topology leg', (leg) => [leg('topology', 32)]],
    ['35 bytes called a topology leg', (leg) => [leg('topology', 35)]],
    ['two topology legs', (leg) => [leg('topology', 34), leg('topology', 34)]],
    // Only the operation says this one is wrong: a transfer is a perfectly good leg — of a send.
    ['a transfer where the topology leg should be', (leg) => [leg('transfer')]],
    ['a topology leg and a transfer beside it', (leg) => [leg('topology', 34), leg('transfer')]],
  ] as Array<[string, NonNullable<VenueOptions['topologyLegs']>]>)('%s: nothing is signed and no party is made', async (_what, topologyLegs) => {
    const api = venue({ topologyLegs });
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE, { account: 50 }), fetchImpl: api.fetchImpl, ...fast });
    await acct.session.register({ partyName: 'onboarder' });

    const error = await acct.onboard().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CeremonyError);
    expect(error).toMatchObject({ operation: 'wallet.topology', stage: 'prepare' });
    expect((error as CeremonyError).cause).toBeInstanceOf(UnexpectedLegError);
    expect((error as Error).message).toMatch(/nothing was signed/);
    // The venue was asked, and no operation of any kind came back signed.
    expect(api.asked).toEqual(['wallet.topology']);
    expect(api.log).toEqual([]);
    expect((await acct.me()).partyId ?? null).toBeNull();
  });

  // Every envelope ceremony names its operation, so a raw-signed leg is refused in each of them — and
  // as a CeremonyError at `prepare`, which is what the guides tell a partner to watch for.
  const MULTIHASH = b64(new Uint8Array([0x12, 0x20, ...new Uint8Array(32).fill(0xaa)]));
  const hostile = (partyId = 'party-me') => stub({
    'GET /auth/me': () => ({ id: 'me', partyId }),
    'GET /tokens/transfer-requests/incoming': () => [
      { contractId: 'c1', templateId: 't', instrumentAdmin: 'admin', instrumentId: 'USDCx', executeBefore: new Date(Date.now() + 60_000).toISOString() },
    ],
    'POST /wallet/operations/prepare': () => ({ operationId: 'op', legs: [{ legId: 't', hash: MULTIHASH, kind: 'topology' }], meta: {} }),
    'POST /wallet/operations/submit': () => ({ ok: true }),
  });
  const refusedAtPrepare = (error: unknown, operation: string) => {
    expect(error).toBeInstanceOf(CeremonyError);
    expect(error).toMatchObject({ operation, stage: 'prepare' });
    expect((error as CeremonyError).cause).toBeInstanceOf(UnexpectedLegError);
  };

  test.each([
    ['send', 'tokens.send', (acct: ReturnType<typeof createSelfCustody>) => acct.send({ receiverPartyId: 'p::1220', amount: '1' })],
    ['consolidate', 'tokens.consolidate', (acct: ReturnType<typeof createSelfCustody>) => acct.consolidate()],
    ['onboard, at the preapproval', 'tokens.preapproval', (acct: ReturnType<typeof createSelfCustody>) => acct.onboard()],
  ] as const)('%s answered with a well-formed topology leg signs nothing', async (_what, operation, call) => {
    const signer = await providerFromMnemonic(PHRASE, { account: 56 });
    // The account's party is its key's: onboard() gets as far as the preapproval only then.
    const api = hostile(`party-me::${cantonFingerprint(signer.public_key)}`);
    const acct = createSelfCustody({ baseUrl, signer, fetchImpl: api.fetchImpl, ...fast, maxFee: '2' });

    refusedAtPrepare(await call(acct).catch((e: unknown) => e), operation);
    expect(api.hits).not.toContain('POST /wallet/operations/submit');
  });

  test('accepting an incoming transfer answered with a topology leg signs nothing, and says so per transfer', async () => {
    const api = hostile();
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE, { account: 57 }), fetchImpl: api.fetchImpl, ...fast });

    const { accepted, failed } = await acct.acceptIncoming();

    expect(accepted).toEqual([]);
    refusedAtPrepare(failed[0]!.error, 'tokens.accept');
    expect(api.hits).not.toContain('POST /wallet/operations/submit');
  });

  test('the one multihash leg the venue really prepares is signed, and the party exists', async () => {
    const api = venue();
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE, { account: 51 }), fetchImpl: api.fetchImpl, ...fast });
    await acct.session.register({ partyName: 'onboarder' });

    await acct.onboard();

    expect(api.log.map((e) => e.type)).toEqual(['wallet.topology', 'tokens.preapproval']);
  });
});

describe('whose party onboard() brings into being (CAN-2249)', () => {
  // A topology is a multihash the key cannot read. What it can hold the API to is the party's name: the
  // party is `<hint>::<fingerprint of this key>`, whole, or the key signs nothing — and the party the
  // account ends up with is the address its owner is about to fund.
  const OTHER = `1220${'cd'.repeat(32)}`;
  const onboarder = async (options: VenueOptions, account: number) => {
    const api = venue(options);
    const signer = await providerFromMnemonic(PHRASE, { account });
    const acct = createSelfCustody({ baseUrl, signer, fetchImpl: api.fetchImpl, ...fast });
    await acct.session.register({ partyName: 'onboarder' });
    return { api, acct, own: `party-onboarder::${cantonFingerprint(signer.public_key)}` };
  };

  test.each([
    ["another key's party", () => `party-onboarder::${OTHER}`],
    // What a check of the first namespace alone lets through.
    ['its own namespace with something after it', (honest: string) => `${honest}::${OTHER}`],
    ['its own namespace in upper case', (honest: string) => honest.replace(/::.*/, (ns) => ns.toUpperCase())],
    ['a hint that carries a line of its own', (honest: string) => `x\nparty:mallory::${honest.split('::')[1]}`],
    ['no party at all', () => undefined],
    ['a party that is not a string', (honest: string) => ({ toString: () => honest })],
  ] as Array<[string, NonNullable<VenueOptions['topologyParty']>]>)('the API proposes %s: nothing is signed', async (_what, topologyParty) => {
    const { api, acct } = await onboarder({ topologyParty }, 52);

    const error = await acct.onboard().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CeremonyError);
    expect(error).toMatchObject({ operation: 'wallet.topology', stage: 'prepare' });
    expect((error as CeremonyError).cause).toBeInstanceOf(ForeignPartyError);
    expect((error as CeremonyError).cause).toMatchObject({ when: 'proposes' });
    expect((error as Error).message).toMatch(/not the party of this account's key.*nothing was signed/);
    // Whatever the API put in the id, the message is one line.
    expect((error as Error).message).not.toMatch(/[\r\n]/);
    // Asked, refused, and no operation came back signed: the account still has no party.
    expect(api.asked).toEqual(['wallet.topology']);
    expect(api.log).toEqual([]);
  });

  test.each([
    ["another key's party", () => `party-onboarder::${OTHER}`],
    // What a check of the first namespace alone lets through.
    ['its own namespace with something after it', (honest: string) => `${honest}::${OTHER}`],
  ] as Array<[string, NonNullable<VenueOptions['recordedParty']>]>)('the API proposes the key\'s party and then records %s: the caller is told not to fund it', async (_what, recordedParty) => {
    const { api, acct, own } = await onboarder({ recordedParty }, 53);

    const error = await acct.onboard().catch((e: unknown) => e);

    // The topology it signed was for its own party; what the account now shows is not that.
    expect(error).toBeInstanceOf(ForeignPartyError);
    expect(error).toMatchObject({ name: 'ForeignPartyError', when: 'records', partyId: recordedParty(own) });
    expect((error as Error).message).toMatch(/not the party of its key.*do not fund it for a program that holds only this key/);
    // And it stops there: no preapproval is set up for a party that is not the key's.
    expect(api.asked).toEqual(['wallet.topology']);

    // Asked again, it says so again: the party is there now, and it is still not this key's.
    await expect(acct.onboard()).rejects.toBeInstanceOf(ForeignPartyError);
    expect(api.asked).toEqual(['wallet.topology']);
  });

  test('an account that already has a party is held to the key too: the usual case is a bot made in the wallet', async () => {
    // Nothing to sign and nothing to propose — the party is simply there. It is the address onboard()
    // hands back to be funded, so it is read on every call, not only when this call made it.
    const signer = await providerFromMnemonic(PHRASE, { account: 58 });
    const api = stub({ 'GET /auth/me': () => ({ id: 'me', partyId: `party-me::${OTHER}` }) });
    const acct = createSelfCustody({ baseUrl, signer, fetchImpl: api.fetchImpl, ...fast });

    const error = await acct.onboard().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForeignPartyError);
    expect(error).toMatchObject({ when: 'records', partyId: `party-me::${OTHER}` });
    expect(api.signed()).toEqual([]);
  });

  test('execute() is the same door: a topology asked for by name is held to the key as well', async () => {
    const signer = await providerFromMnemonic(PHRASE, { account: 59 });
    const own = `party-me::${cantonFingerprint(signer.public_key)}`;
    const MULTIHASH = Buffer.from(`1220${'aa'.repeat(32)}`, 'hex').toString('base64');
    for (const meta of [{ partyId: `party-me::${OTHER}` }, {}, null]) {
      const api = stub({
        'GET /auth/me': () => ({ id: 'me', partyId: null }),
        'POST /wallet/operations/prepare': () => ({ operationId: 'op', legs: [{ legId: 't', hash: MULTIHASH, kind: 'topology' }], meta }),
        'POST /wallet/operations/submit': () => ({ ok: true }),
      });
      const acct = createSelfCustody({ baseUrl, signer, fetchImpl: api.fetchImpl, ...fast });

      const error = await acct.execute('wallet.topology', { publicKey: signer.public_key }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CeremonyError);
      expect((error as CeremonyError).cause).toMatchObject({ name: 'ForeignPartyError', when: 'proposes' });
      expect(api.hits).not.toContain('POST /wallet/operations/submit');
    }
    // And the key's own party goes through, as before.
    const api = stub({
      'POST /wallet/operations/prepare': () => ({ operationId: 'op', legs: [{ legId: 't', hash: MULTIHASH, kind: 'topology' }], meta: { partyId: own } }),
      'POST /wallet/operations/submit': () => ({ ok: true }),
    });
    await createSelfCustody({ baseUrl, signer, fetchImpl: api.fetchImpl, ...fast }).execute('wallet.topology', { publicKey: signer.public_key });
    expect(api.hits).toContain('POST /wallet/operations/submit');
  });

  test('what the error shows of the API\'s text: one line, cut, and nothing outside printable ASCII', () => {
    const shown = (partyId: unknown) => new ForeignPartyError(partyId, 'records').message;

    // A line or paragraph separator, a bidi override: escaped, so the line stays one line and reads as written.
    expect(shown('a\u2028b\u202ec\u0085d\ne::1220')).toContain('"a\\u2028b\\u202ec\\u0085d\\ne::1220"');
    expect(shown('a\u2028b\u202ec\u0085d\ne::1220')).toMatch(/^[\x20-\x7e]+$/);
    // Cut: the API cannot fill a log with it.
    expect(shown('x'.repeat(5000))).toContain(`"${'x'.repeat(120)}"`);
    expect(shown('x'.repeat(5000)).length).toBeLessThan(400);
    // Not a string: its type is said, its contents are not asked for.
    expect(shown({ toString: () => 'party::1220' })).toContain('a value of type object');
    expect(shown(undefined)).toContain('a value of type undefined');
  });

  test('the key\'s own party is made, and it is what onboard() answers', async () => {
    const { api, acct, own } = await onboarder({}, 54);

    const user = await acct.onboard();

    expect(user.partyId).toBe(own);
    expect(api.log.map((e) => e.type)).toEqual(['wallet.topology', 'tokens.preapproval']);

    // Called again — every process does, as its first line — the party is there, and it is the key's.
    await expect(acct.onboard()).resolves.toMatchObject({ partyId: own });
    expect(api.asked).toEqual(['wallet.topology', 'tokens.preapproval', 'tokens.preapproval']);
  });
});

describe('what the key signs outside a trade is read first (CAN-2249)', () => {
  // The threat: the API is hostile, and the key is about to pay out a bot's budget. Every ceremony
  // below is prepared by the fake venue the way the dev participant prepares it — or the way a venue
  // that wants the money would.
  const OWNER = 'party-owner::1220bb';
  const MALLORY = 'mallory::1220ff';
  const account = async (options: VenueOptions, n: number, over: Partial<SelfCustodyOptions> = {}) => {
    const api = venue(options);
    // Every account here names its fee ceiling, as a caller must: the SDK ships none (the fake venue charges 0.125 CC).
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE, { account: n }), fetchImpl: api.fetchImpl, ...fast, maxFee: '2', ...over });
    await acct.session.register({ partyName: 'bot' });
    return { api, acct };
  };
  const onboarded = async (options: VenueOptions, n: number, over: Partial<SelfCustodyOptions> = {}) => {
    const made = await account(options, n, over);
    await made.acct.onboard();
    return made;
  };
  const submitted = (api: ReturnType<typeof venue>) => api.log.map((e) => e.type).filter((t) => t.startsWith('tokens.') && t !== 'tokens.preapproval');
  const unread = async (run: Promise<unknown>, operation: string, reason: RegExp) => {
    const error = await run.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CeremonyError);
    expect(error).toMatchObject({ operation, stage: 'prepare' });
    expect((error as CeremonyError).cause).toBeInstanceOf(UnverifiedTransactionError);
    expect((error as Error).message).toMatch(reason);
  };

  test('a CC send to the owner — a bot\'s withdrawal — is read and signed, and the fee the API deferred is paid right after', async () => {
    const { api, acct } = await onboarded({}, 60);

    const out = await acct.send({ receiverPartyId: OWNER, amount: '100' });

    expect(out).toMatchObject({ outcome: 'committed', deferredFee: 'paid' });
    expect(submitted(api)).toEqual(['tokens.send', 'tokens.send-fee']);
    // The fee is paid for the send it belongs to.
    expect(api.log.at(-1)!.params).toEqual({ sourceUpdateId: (out as { updateId: string }).updateId });
  });

  test('with a second holding the fee rides on the send itself: one ceremony, nothing deferred', async () => {
    const { api, acct } = await onboarded({ twoHoldings: true }, 61);

    const out = await acct.send({ receiverPartyId: OWNER, amount: '100' });

    expect(out).not.toHaveProperty('deferredFee');
    expect(submitted(api)).toEqual(['tokens.send']);
  });

  test.each([
    ['another receiver', { receiverPartyId: MALLORY }, /sends to mallory::1220ff, not to party-owner::1220bb, the receiver this send was asked for/],
    ['a larger amount', { amount: '9000' }, /is given 9000 Amulet, not the 100 this send was asked for/],
  ])('a venue that prepares the send for %s gets no signature', async (_what, sendAs, reason) => {
    const { api, acct } = await onboarded({ sendAs }, 62);

    await unread(acct.send({ receiverPartyId: OWNER, amount: '100' }), 'tokens.send', reason);
    expect(submitted(api)).toEqual([]);
  });

  test('a registry token is read the same way: the amount locked under an offer to the receiver named', async () => {
    const { api, acct } = await onboarded({ twoHoldings: true }, 63);
    await acct.send({ receiverPartyId: OWNER, amount: '0.5', tokenId: 'CBTC' });
    expect(submitted(api)).toEqual(['tokens.send']);

    const hostile = await onboarded({ twoHoldings: true, sendAs: { receiverPartyId: MALLORY } }, 64);
    await unread(hostile.acct.send({ receiverPartyId: OWNER, amount: '0.5', tokenId: 'CBTC' }), 'tokens.send', /leg 0 sends to mallory::1220ff/);
    expect(submitted(hostile.api)).toEqual([]);
  });

  test('the network fee is bounded: maxFee, the account\'s or the call\'s', async () => {
    const options = { twoHoldings: true, networkFee: 5 };
    const { api, acct } = await onboarded(options, 65);
    await unread(acct.send({ receiverPartyId: OWNER, amount: '100' }), 'tokens.send', /costs this account 105 Amulet, more than the 100 it sends and the fee it allows/);
    expect(submitted(api)).toEqual([]);

    await acct.send({ receiverPartyId: OWNER, amount: '100', maxFee: '5' });
    expect(submitted(api)).toEqual(['tokens.send']);

    const raised = await onboarded(options, 66, { maxFee: '5' });
    await raised.acct.send({ receiverPartyId: OWNER, amount: '100' });
    expect(submitted(raised.api)).toEqual(['tokens.send']);
  });

  test('the SDK has no fee ceiling of its own: a ceremony nobody put one on is refused, and the refusal says what to pass', async () => {
    const noCeiling = /no ceiling was set on its network fee, and the SDK has none of its own.*Pass maxFee — to createSelfCustody, or to this call/;
    const { api, acct } = await onboarded({ twoHoldings: true, merge: 'honest' }, 80, { maxFee: undefined });

    await unread(acct.send({ receiverPartyId: OWNER, amount: '100' }), 'tokens.send', noCeiling);
    await unread(acct.consolidate(), 'tokens.consolidate', noCeiling);
    expect(submitted(api)).toEqual([]);
    // Known before the API is asked for anything: no prepared operation is left behind.
    expect(api.asked.filter((type) => type === 'tokens.send' || type === 'tokens.consolidate')).toEqual([]);

    // The call's own ceiling is enough, and so is the account's ceiling on a split's cost.
    await acct.send({ receiverPartyId: OWNER, amount: '100', maxFee: '1' });
    expect(submitted(api)).toEqual(['tokens.send']);
    const split = await onboarded({ twoHoldings: true }, 81, { maxFee: undefined, maxSplitCost: '1' });
    await split.acct.send({ receiverPartyId: OWNER, amount: '100' });
    expect(submitted(split.api)).toEqual(['tokens.send']);
  });

  test('allowUnverified reads nothing, so it asks for no ceiling — on the send or on the fee the API deferred', async () => {
    // One holding: the send defers its fee, and both ceremonies are signed as they came.
    const { api, acct } = await onboarded({}, 82, { maxFee: undefined });

    const out = await acct.send({ receiverPartyId: OWNER, amount: '100', allowUnverified: true });

    expect(out).toMatchObject({ outcome: 'committed', deferredFee: 'paid' });
    expect(submitted(api)).toEqual(['tokens.send', 'tokens.send-fee']);
  });

  test('a deferred fee that is not paid does not turn a committed send into an error: it stays owed, and says why', async () => {
    // The API refuses the fee ceremony.
    const refused = await onboarded({ failSendFee: true }, 67);
    const first = await refused.acct.send({ receiverPartyId: OWNER, amount: '100' }) as { deferredFee: string; feeError: unknown; outcome: string };
    expect(first).toMatchObject({ outcome: 'committed', deferredFee: 'owed' });
    expect(first.feeError).toBeInstanceOf(CeremonyError);
    expect(submitted(refused.api)).toEqual(['tokens.send']);

    // The API prepares a fee above the ceiling: read, refused, not signed.
    const dear = await onboarded({ networkFee: 5 }, 68);
    const second = await dear.acct.send({ receiverPartyId: OWNER, amount: '100' }) as { deferredFee: string; feeError: CeremonyError };
    expect(second.deferredFee).toBe('owed');
    expect(second.feeError.cause).toBeInstanceOf(UnverifiedTransactionError);
    expect(second.feeError.message).toMatch(/the fee costs this account 5 CC, more than the fee it allows/);
    expect(submitted(dear.api)).toEqual(['tokens.send']);
  });

  test('a send that came without its bytes is refused, unless the caller says to sign it unread', async () => {
    const { api, acct } = await onboarded({ sendWithoutBytes: true, twoHoldings: true }, 69);

    await unread(acct.send({ receiverPartyId: OWNER, amount: '100' }), 'tokens.send', /without its transaction bytes, so it cannot be read/);
    expect(submitted(api)).toEqual([]);

    await acct.send({ receiverPartyId: OWNER, amount: '100', allowUnverified: true });
    expect(submitted(api)).toEqual(['tokens.send']);
  });

  test('allowUnverified reads nothing: what the venue prepared is signed as it came, as before 0.9.0', async () => {
    const { api, acct } = await onboarded({ sendAs: { receiverPartyId: MALLORY }, twoHoldings: true }, 70);

    await acct.send({ receiverPartyId: OWNER, amount: '100', allowUnverified: true });

    expect(submitted(api)).toEqual(['tokens.send']);
  });

  test('a send to the account itself is read as the split it is', async () => {
    const { api, acct } = await onboarded({ sendBytes: 'honest', twoHoldings: true }, 78);
    await acct.send({ receiverPartyId: api.party('bot'), amount: '25' });
    expect(submitted(api)).toEqual(['tokens.send']);

    const theft = await onboarded({ sendBytes: 'theft', twoHoldings: true }, 79);
    await unread(theft.acct.send({ receiverPartyId: theft.api.party('bot'), amount: '25' }), 'tokens.send', /thief::1220/);
    expect(submitted(theft.api)).toEqual([]);
  });

  test('a merge is read: nothing is paid away under the name of tidying up', async () => {
    const honest = await onboarded({ merge: 'honest' }, 71);
    await expect(honest.acct.consolidate()).resolves.toBe(3);
    expect(submitted(honest.api)).toEqual(['tokens.consolidate']);

    const theft = await onboarded({ merge: 'theft' }, 72);
    await unread(theft.acct.consolidate(), 'tokens.consolidate', /the merge costs this account 9999 Amulet, more than the fee it allows/);
    expect(submitted(theft.api)).toEqual([]);

    // Nothing to merge is nothing to read.
    const compact = await onboarded({}, 73);
    await expect(compact.acct.consolidate()).resolves.toBe(0);
  });

  test('the preapproval step of onboard() is read: a proposal to a provider the SDK does not pin is not signed', async () => {
    const { api, acct } = await account({ preapprovalProvider: MALLORY }, 74);

    await unread(acct.onboard(), 'tokens.preapproval', /names mallory::1220ff as provider, which is neither this account nor a pinned venue/);
    // The party was made — that step is the key's own — and the preapproval was asked for and left unsigned.
    expect(api.asked).toEqual(['wallet.topology', 'tokens.preapproval']);
    expect(api.log.map((e) => e.type)).toEqual(['wallet.topology']);

    await acct.onboard({ allowUnverified: true });
    expect(api.log.map((e) => e.type)).toEqual(['wallet.topology', 'tokens.preapproval']);
  });

  describe('preapproval() and enablePreapproval() on their own', () => {
    const withParty = async (options: VenueOptions, n: number) => {
      const made = await account(options, n);
      await made.acct.execute('wallet.topology', { publicKey: made.acct.session.publicKey });
      return made;
    };

    test('preapproval() reports none, enablePreapproval() creates one, and preapproval() then reports it', async () => {
      const { api, acct } = await withParty({}, 76);
      const party = (await acct.me()).partyId;

      expect(await acct.preapproval()).toMatchObject({ hasPreapproval: false, partyId: party, eligibleToSetup: true });
      await acct.enablePreapproval();
      expect(api.log.map((e) => e.type)).toEqual(['wallet.topology', 'tokens.preapproval']);
      expect(await acct.preapproval()).toMatchObject({ hasPreapproval: true, partyId: party, eligibleToSetup: false });
    });

    test('enablePreapproval() on an account that already has one signs nothing', async () => {
      const { api, acct } = await onboarded({}, 77);
      await acct.enablePreapproval();
      // Asked again, prepared with no legs, so nothing new is signed.
      expect(api.asked.filter((t) => t === 'tokens.preapproval')).toHaveLength(2);
      expect(api.log.filter((e) => e.type === 'tokens.preapproval')).toHaveLength(1);
    });

    test('enablePreapproval() reads what it signs: a proposal to an unpinned provider is not signed', async () => {
      const { api, acct } = await withParty({ preapprovalProvider: MALLORY }, 78);

      await unread(acct.enablePreapproval(), 'tokens.preapproval', /names mallory::1220ff as provider/);
      expect(api.log.map((e) => e.type)).toEqual(['wallet.topology']);
      expect(await acct.preapproval()).toMatchObject({ hasPreapproval: false });
    });
  });

  test('an account of a network the SDK has no pins for refuses rather than signs unread', async () => {
    const { api, acct } = await account({}, 75, { baseUrl: 'https://api.example' });
    await acct.onboard({ allowUnverified: true });

    const error = await acct.send({ receiverPartyId: OWNER, amount: '100' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CeremonyError);
    expect((error as Error).message).toMatch(/no pinned CC admin for this network to verify against: pass network or instrumentAdmins/);
    expect(submitted(api)).toEqual([]);
  });

  describe('accepting an incoming transfer', () => {
    const inbox = async (legsFor: (me: string, cid: string) => Promise<Leg[]>, n: number, over: Partial<SelfCustodyOptions> = {}) => {
      const signer = await providerFromMnemonic(PHRASE, { account: n });
      const me = `party-me::${cantonFingerprint(signer.public_key)}`;
      const asked: Array<Record<string, unknown>> = [];
      const api = stub({
        'GET /auth/me': () => ({ id: 'me', partyId: me }),
        'GET /tokens/transfer-requests/incoming': () => [
          { contractId: 'ti-1', templateId: 't', instrumentAdmin: DEV.cbtcRegistrar, instrumentId: 'CBTC', executeBefore: new Date(Date.now() + 60_000).toISOString() },
        ],
        'POST /wallet/operations/prepare': async (body) => {
          asked.push(body.params as Record<string, unknown>);
          return { operationId: 'op', legs: await legsFor(me, 'ti-1'), meta: null };
        },
        'POST /wallet/operations/submit': () => ({ outcome: 'committed' }),
      });
      return { api, asked, acct: createSelfCustody({ baseUrl, signer, fetchImpl: api.fetchImpl, ...fast, ...over }) };
    };

    test('the accept of the transfer shown is read and signed — and asks for no fee leg unless the call brings a budget for one', async () => {
      const { api, asked, acct } = await inbox(acceptLegs, 76, { maxFee: '100' });

      const { accepted, failed } = await acct.acceptIncoming();

      expect([accepted.length, failed.length]).toEqual([1, 0]);
      // The account's own maxFee is for what the account starts — a send, a merge. It is not spent on a list the API supplies.
      expect(asked[0]).toMatchObject({ instructionCid: 'ti-1' });
      expect(asked[0]).not.toHaveProperty('withFeeLeg');
      expect(api.hits).toContain('POST /wallet/operations/submit');
    });

    test.each([
      ['the accept of another transfer', (me: string) => acceptLegs(me, 'ti-other'), /accepts another transfer than the one it was asked for/],
      ['an accept that spends a holding of the account', (me: string, cid: string) => acceptLegs(me, cid, { alsoSpend: holding('d0'.repeat(34), me, { id: 'CBTC', admin: DEV.cbtcRegistrar }, '3') }), /spends this account's own holding/],
      ['an accept addressed to somebody else', (me: string, cid: string) => acceptLegs(me, cid, { receiver: MALLORY }), /accepts a transfer that is not to this account/],
    ])('%s is not signed, and the inbox says which transfer failed', async (_what, legsFor, reason) => {
      const { api, acct } = await inbox(legsFor, 77);

      const { accepted, failed } = await acct.acceptIncoming();

      expect(accepted).toEqual([]);
      expect((failed[0]!.error as CeremonyError).cause).toBeInstanceOf(UnverifiedTransactionError);
      expect((failed[0]!.error as Error).message).toMatch(reason);
      expect(api.hits).not.toContain('POST /wallet/operations/submit');
    });
  });
});

describe('the network fee: one ceiling for a send, one budget for an inbox (CAN-2249, CAN-2423)', () => {
  // What the security review of the wiring found: a ceiling held per ceremony is a ceiling the API
  // multiplies — by a second ceremony of the same send, or by the length of a list it supplies itself.
  const OWNER = 'party-owner::1220bb';
  const MALLORY = 'mallory::1220ff';
  let n = 0;
  const L = (t: { kind: string; preparedTransactionHash: string; preparedTransaction: string }): Leg =>
    ({ legId: `fee-${++n}`, hash: t.preparedTransactionHash, kind: t.kind, preparedTransaction: t.preparedTransaction });
  const who = async (account: number) => {
    const signer = await providerFromMnemonic(PHRASE, { account });
    return { signer, me: `party-me::${cantonFingerprint(signer.public_key)}` };
  };
  const feeLegOf = async (me: string, amount: string) => L(await selfSendLeg({
    party: me, kind: 'fee', receiver: DEV.venue, input: '100', ids: 'b', outputs: [{ owner: DEV.venue, amount }, { owner: me, amount: (100 - Number(amount)).toFixed(10) }],
  }));
  const transferOf = async (me: string) => L(await selfSendLeg({
    party: me, kind: 'transfer', receiver: OWNER, input: '10000', ids: 'a', outputs: [{ owner: OWNER, amount: '100' }, { owner: me, amount: '9900' }],
  }));
  /** A venue whose send carries a fee leg of `first` AND defers a fee of `second` to a ceremony of its own. */
  const twice = async (account: number, first: string | null, second: string | null, over: Partial<SelfCustodyOptions> = {}, sendAnswer: unknown = { updateId: 'u1', outcome: 'committed' }) => {
    const { signer, me } = await who(account);
    const submitted: string[] = [];
    const api = stub({
      'GET /auth/me': () => ({ id: 'me', partyId: me }),
      'POST /wallet/operations/prepare': async (body) => (body.type === 'tokens.send'
        ? { operationId: 'send', legs: [await transferOf(me), ...(first ? [await feeLegOf(me, first)] : [])], meta: { feeDeferred: { amount: Number(second ?? 0) } } }
        : { operationId: 'fee', legs: second ? [await feeLegOf(me, second)] : [], meta: {} }),
      'POST /wallet/operations/submit': (body) => { submitted.push(String(body.operationId)); return body.operationId === 'send' ? sendAnswer : { outcome: 'committed' }; },
    });
    return { submitted, acct: createSelfCustody({ baseUrl, signer, fetchImpl: api.fetchImpl, ...fast, maxFee: '2', ...over }) };
  };
  type Sent = { outcome: string; deferredFee?: string; feeError?: CeremonyError };

  test('a fee the API deferred is held to what the send left of its ceiling, not to a ceiling of its own', async () => {
    // The send's own fee leg takes the whole 2 CC; the ceremony after it asks for 2 more.
    const greedy = await twice(601, '2', '2');
    const out = await greedy.acct.send({ receiverPartyId: OWNER, amount: '100' }) as Sent;
    expect(out).toMatchObject({ outcome: 'committed', deferredFee: 'owed' });
    expect(out.feeError!.cause).toBeInstanceOf(UnverifiedTransactionError);
    expect(out.feeError!.message).toMatch(/the fee costs this account 2 CC, more than the fee it allows/);
    expect(greedy.submitted).toEqual(['send']);

    // 0.5 on the send and 1.5 after it is 2: both are signed. And the call's own ceiling is the one that counts.
    const honest = await twice(602, '0.5', '1.5');
    expect(await honest.acct.send({ receiverPartyId: OWNER, amount: '100' })).toMatchObject({ deferredFee: 'paid' });
    expect(honest.submitted).toEqual(['send', 'fee']);
    const raised = await twice(603, '2', '2');
    expect(await raised.acct.send({ receiverPartyId: OWNER, amount: '100', maxFee: '4' })).toMatchObject({ deferredFee: 'paid' });
    const lowered = await twice(604, null, '2');
    expect(await lowered.acct.send({ receiverPartyId: OWNER, amount: '100', maxFee: '1' })).toMatchObject({ deferredFee: 'owed' });
  });

  test('the one ceiling counts everything the send cost: a burn on the transfer itself, and a send to oneself', async () => {
    /** A send whose transfer leg alone costs `burn` beyond the amount (an old input's holding fee), then a deferred fee of `second`. */
    const burning = async (account: number, toSelf: boolean, burn: string, second: string) => {
      const { signer, me } = await who(account);
      const [receiver, amount] = toSelf ? [me, '25'] : [OWNER, '100'];
      const change = (10000 - Number(amount) - Number(burn)).toFixed(10);
      const api = stub({
        'GET /auth/me': () => ({ id: 'me', partyId: me }),
        'POST /wallet/operations/prepare': async (body) => (body.type === 'tokens.send'
          ? { operationId: 'send', legs: [L(await selfSendLeg({ party: me, kind: 'transfer', receiver, input: '10000', ids: 'a', outputs: [{ owner: receiver, amount }, { owner: me, amount: change }] }))], meta: { feeDeferred: { amount: 1 } } }
          : { operationId: 'fee', legs: [await feeLegOf(me, second)], meta: {} }),
        'POST /wallet/operations/submit': (body) => (body.operationId === 'send' ? { updateId: 'u1', outcome: 'committed' } : { outcome: 'committed' }),
      });
      return (createSelfCustody({ baseUrl, signer, fetchImpl: api.fetchImpl, ...fast, maxFee: '2' }).send({ receiverPartyId: receiver, amount }) as Promise<Sent>).then((out) => out.deferredFee, (e: Error) => e.message);
    };
    // 0.5 burnt on the way leaves 1.5 of a ceiling of 2 — to another party, and to oneself.
    expect(await burning(650, false, '0.5', '1.5')).toBe('paid');
    expect(await burning(651, false, '0.5', '1.6')).toBe('owed');
    expect(await burning(652, true, '0.5', '1.5')).toBe('paid');
    expect(await burning(653, true, '0.5', '1.6')).toBe('owed');
    // And a send to oneself that costs more than the ceiling by itself is not signed at all.
    expect(await burning(654, true, '2.5', '0')).toMatch(/the send costs this account more than 2 Amulet/);
  });

  test('a merge is held to its call\'s ceiling when the call names one', async () => {
    const { signer, me } = await who(655);
    let submitted = 0;
    const api = stub({
      'GET /auth/me': () => ({ id: 'me', partyId: me }),
      'POST /wallet/operations/prepare': async () => ({
        operationId: 'merge', meta: { mergedCount: 3 },
        legs: [L(await selfSendLeg({ party: me, kind: 'transfer', receiver: me, input: '19.5', ids: 'a', outputs: [{ owner: me, amount: '19.5' }] })), await feeLegOf(me, '2')],
      }),
      'POST /wallet/operations/submit': () => { submitted++; return { outcome: 'committed' }; },
    });
    const acct = createSelfCustody({ baseUrl, signer, fetchImpl: api.fetchImpl, ...fast, maxFee: '1' });

    await expect(acct.consolidate()).rejects.toThrow(/the merge costs this account 2 Amulet, more than the fee it allows/);
    await expect(acct.consolidate('CC', { maxFee: '2' })).resolves.toBe(3);
    // A ceiling of nothing on the call is a ceiling, not the lack of one: the account's is not used in its place.
    await expect(acct.consolidate('CC', { maxFee: '0' })).rejects.toThrow(/the merge costs this account 2 Amulet/);
    // Nor is an empty one: a call that names a ceiling it cannot read is refused on that, not handed the account's.
    await expect(acct.consolidate('CC', { maxFee: '' })).rejects.toThrow(/the fee bound is not a decimal of at most ten places/);
    expect(submitted).toBe(1);
  });

  test('what `deferredFee` says is what happened: nothing asked, nothing named to pay for, a submit nobody saw land', async () => {
    // The API deferred a fee and then asks for nothing: nothing was signed, so nothing was "paid".
    const nothing = await twice(605, null, null);
    expect(await nothing.acct.send({ receiverPartyId: OWNER, amount: '100' })).toMatchObject({ outcome: 'committed', deferredFee: 'waived' });
    expect(nothing.submitted).toEqual(['send']);

    // The send's answer names no update: there is nothing to pay the fee for, and the caller is told.
    const unnamed = await twice(606, null, '1', {}, { outcome: 'committed' });
    const silent = await unnamed.acct.send({ receiverPartyId: OWNER, amount: '100' }) as Sent;
    expect(silent.deferredFee).toBe('owed');
    expect(String(silent.feeError)).toMatch(/named no update of the send to pay it for/);
    expect(unnamed.submitted).toEqual(['send']);

    // The fee was signed and its submit timed out: 'owed' means not seen paid — the stage says it may have landed.
    const { signer, me } = await who(607);
    const api = stub({
      'GET /auth/me': () => ({ id: 'me', partyId: me }),
      'POST /wallet/operations/prepare': async (body) => (body.type === 'tokens.send'
        ? { operationId: 'send', legs: [await transferOf(me)], meta: { feeDeferred: { amount: 1 } } }
        : { operationId: 'fee', legs: [await feeLegOf(me, '1')], meta: {} }),
      'POST /wallet/operations/submit': (body) => (body.operationId === 'send' ? { updateId: 'u1', outcome: 'committed' } : refuse(400, 'the ledger did not answer')),
    });
    const lost = await createSelfCustody({ baseUrl, signer, fetchImpl: api.fetchImpl, ...fast, maxFee: '2' }).send({ receiverPartyId: OWNER, amount: '100' }) as Sent;
    expect(lost).toMatchObject({ outcome: 'committed', deferredFee: 'owed' });
    expect(lost.feeError).toMatchObject({ operation: 'tokens.send-fee', stage: 'submit' });
  });

  /** An inbox of `count` transfers nobody sent: the API makes them up, and prepares a 2 CC fee leg whenever it is asked for one — or always. */
  const madeUp = async (account: number, count: number, uninvited = false, over: Partial<SelfCustodyOptions> = {}, submitFails = false) => {
    const { signer, me } = await who(account);
    const asked: Array<Record<string, unknown>> = [];
    let feeLegsSigned = 0;
    const api = stub({
      'GET /auth/me': () => ({ id: 'me', partyId: me }),
      'GET /tokens/transfer-requests/incoming': () => Array.from({ length: count }, (_, i) => (
        { contractId: `ti-${i}`, templateId: 't', instrumentAdmin: DEV.cbtcRegistrar, instrumentId: 'CBTC', executeBefore: new Date(Date.now() + 60_000).toISOString() })),
      'POST /wallet/operations/prepare': async (body) => {
        const params = body.params as { instructionCid: string; withFeeLeg?: boolean };
        asked.push(params);
        return { operationId: params.instructionCid, legs: [...await acceptLegs(me, params.instructionCid), ...(params.withFeeLeg || uninvited ? [await feeLegOf(me, '2')] : [])], meta: null };
      },
      'POST /wallet/operations/submit': (body) => {
        feeLegsSigned += (body.signatures as unknown[]).length - 1;
        return submitFails ? refuse(400, 'the ledger did not answer') : { outcome: 'committed' };
      },
    });
    return { asked, fees: () => feeLegsSigned, acct: createSelfCustody({ baseUrl, signer, fetchImpl: api.fetchImpl, ...fast, ...over }) };
  };

  test('a fee is spent when the key signs it, not when the API says so: an inbox whose every submit fails gets one budget too', async () => {
    // The signatures leave with the submit. An API that takes them and answers with an error has the fee leg all the same.
    const lying = await madeUp(640, 10, false, {}, true);

    const { accepted, failed } = await lying.acct.acceptIncoming(undefined, { maxFee: '2' });

    expect([accepted.length, failed.length]).toEqual([0, 10]);
    expect(lying.fees()).toBe(1);
    expect(lying.asked.map((params) => params.withFeeLeg ?? false)).toEqual([true, ...Array.from({ length: 9 }, () => false)]);
  });

  test('a filter that throws on what the API listed fails that transfer, and keeps what was accepted', async () => {
    const inbox = await madeUp(641, 3);

    const { accepted, failed } = await inbox.acct.acceptIncoming((t) => { if (t.contractId === 'ti-1') throw new Error('not a transfer I know'); return true; });

    expect(accepted.map((t) => t.contractId)).toEqual(['ti-0', 'ti-2']);
    expect(failed.map((f) => [f.transfer.contractId, String(f.error)])).toEqual([['ti-1', 'Error: not a transfer I know']]);
  });

  test('a budget of nothing asks for no fee leg, in one accept as in an inbox; a budget that is not a number is refused outright', async () => {
    const none = await madeUp(642, 1);
    const [transfer] = await none.acct.incoming();
    await none.acct.accept(transfer!, { maxFee: '0' });
    expect(none.asked[0]).not.toHaveProperty('withFeeLeg');

    for (const maxFee of ['', '-1', '1e3', 'lots']) {
      await expect(none.acct.accept(transfer!, { maxFee })).rejects.toThrow(RangeError);
      await expect(none.acct.acceptIncoming(undefined, { maxFee })).rejects.toThrow(RangeError);
    }
    expect(none.asked).toHaveLength(1);
  });

  test('unread, a budget is spent whole by the first accept — and nothing after it is under any budget', async () => {
    const blind = await madeUp(643, 3);
    await blind.acct.acceptIncoming(undefined, { maxFee: '2', allowUnverified: true });
    // What the fee leg took was not read, so the whole budget counts as gone: the rest ask for none.
    expect(blind.asked.map((params) => params.withFeeLeg ?? false)).toEqual([true, false, false]);
  });

  test('an inbox the API fills pays no fee unless the call brings a budget — and then that budget, whatever the list holds', async () => {
    // Twenty made-up transfers, and an account with a generous ceiling of its own: no fee leg is asked for, none is signed.
    const quiet = await madeUp(610, 20, false, { maxFee: '100' });
    const first = await quiet.acct.acceptIncoming();
    expect([first.accepted.length, first.failed.length, quiet.fees()]).toEqual([20, 0, 0]);
    expect(quiet.asked.some((params) => 'withFeeLeg' in params)).toBe(false);

    // The same list with a budget of 5 CC for the call: two fees of 2 CC are signed, and the third does not fit.
    const paying = await madeUp(611, 20);
    const second = await paying.acct.acceptIncoming(undefined, { maxFee: '5' });
    expect(paying.fees()).toBe(2);
    expect(second.accepted).toHaveLength(2);
    expect(second.failed).toHaveLength(18);
    expect((second.failed[0]!.error as Error).message).toMatch(/the accept costs this account 2 CC of fee, more than the fee it allows/);

    // A budget the fees divide evenly: once it is spent, the rest are accepted without a fee leg.
    const exact = await madeUp(612, 5);
    const third = await exact.acct.acceptIncoming(undefined, { maxFee: '4' });
    expect([third.accepted.length, third.failed.length, exact.fees()]).toEqual([5, 0, 2]);
    expect(exact.asked.map((params) => params.withFeeLeg ?? false)).toEqual([true, true, false, false, false]);

    // A fee leg nobody asked for is not signed, whatever the account's own ceiling is.
    const pushy = await madeUp(613, 3, true, { maxFee: '100' });
    const fourth = await pushy.acct.acceptIncoming();
    expect([fourth.accepted.length, fourth.failed.length, pushy.fees()]).toEqual([0, 3, 0]);
    await expect(pushy.acct.acceptIncoming(undefined, { maxFee: 'lots' })).rejects.toThrow(RangeError);
  });

  test('one accept pays its fee out of the ceiling its own call names', async () => {
    const one = await madeUp(614, 1);
    const [transfer] = await one.acct.incoming();
    await one.acct.accept(transfer!, { maxFee: '2' });
    expect(one.asked[0]).toMatchObject({ withFeeLeg: true });
    expect(one.fees()).toBe(1);

    const dear = await madeUp(615, 1);
    const [other] = await dear.acct.incoming();
    await expect(dear.acct.accept(other!, { maxFee: '1' })).rejects.toThrow(/the accept costs this account 2 CC of fee, more than the fee it allows/);
    expect(dear.fees()).toBe(0);
  });

  test('the party a ceremony is read for is this key\'s own, whatever /auth/me says', async () => {
    // The API names another party as the account's and prepares a send acting as it.
    const { signer } = await who(616);
    let submitted = 0;
    const api = stub({
      'GET /auth/me': () => ({ id: 'me', partyId: MALLORY }),
      'POST /wallet/operations/prepare': async () => ({ operationId: 'send', legs: [await transferOf(MALLORY)], meta: {} }),
      'POST /wallet/operations/submit': () => { submitted++; return { outcome: 'committed' }; },
    });
    const error = await createSelfCustody({ baseUrl, signer, fetchImpl: api.fetchImpl, ...fast, maxFee: '2' }).send({ receiverPartyId: OWNER, amount: '100' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CeremonyError);
    expect((error as CeremonyError).cause).toBeInstanceOf(ForeignPartyError);
    expect(submitted).toBe(0);
  });

  test('only `allowUnverified: true` switches the reading off', async () => {
    for (const [account, value] of [[620, 'false'], [621, 1], [622, 'true']] as const) {
      const api = venue({ twoHoldings: true, sendAs: { receiverPartyId: MALLORY } });
      const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE, { account }), fetchImpl: api.fetchImpl, ...fast, maxFee: '2' });
      await acct.session.register({ partyName: 'bot' });
      await acct.onboard();
      // A config value that is merely truthy is not the caller saying "sign it unread".
      await expect(acct.send({ receiverPartyId: OWNER, amount: '100', allowUnverified: value as unknown as boolean })).rejects.toThrow(/sends to mallory::1220ff/);
      expect(api.log.map((e) => e.type)).not.toContain('tokens.send');
    }
  });

  test('a splice-wallet id the caller adds is trusted next to the released ones, never instead of them', async () => {
    const custom = 'ab'.repeat(32);
    const onboardWith = async (account: number, options: VenueOptions, over: Partial<SelfCustodyOptions> = {}) => {
      const api = venue(options);
      const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE, { account }), fetchImpl: api.fetchImpl, ...fast, ...over });
      await acct.session.register({ partyName: 'bot' });
      return { api, done: await acct.onboard().then(() => 'onboarded', (e: Error) => e.message) };
    };

    // A proposal from a package no release of Splice has: refused, and the refusal does not send the reader to the id it quotes.
    const unknown = await onboardWith(630, { proposalPackageId: custom });
    expect(unknown.done).toMatch(/untrusted package \(splice-wallet (ab){32}\).*never from this message/);
    expect(unknown.api.log.map((e) => e.type)).toEqual(['wallet.topology']);
    // Added by the caller, it is signed; and adding it took none of the released ids away.
    expect((await onboardWith(631, { proposalPackageId: custom }, { trustedPackages: { wallet: { 'splice-wallet': [custom] } } })).done).toBe('onboarded');
    expect((await onboardWith(632, {}, { trustedPackages: { wallet: { 'splice-wallet': [custom] } } })).done).toBe('onboarded');
    expect((await onboardWith(633, {}, { trustedPackages: { wallet: { 'splice-wallet': [] } } })).done).toBe('onboarded');
  });
});

describe('signing up with an invite code', () => {
  const CODE = 'ABCD-EFGH-JKMN';

  test('an emailless partner whose sign-up came back FAILED signs up again with the same key and code, and gets the role', async () => {
    const api = venue({ failActivationOnce: true });
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE, { account: 36 }), fetchImpl: api.fetchImpl, ...fast });
    const first = await acct.session.register({ inviteCode: CODE });
    expect(first.status).toBe('FAILED');
    const second = await acct.session.register({ inviteCode: CODE });
    expect(second).toMatchObject({ status: 'ACTIVE', roles: expect.arrayContaining(['partner-bot']) });
    // Both requests are the same sign-up: one key, one code, one party name, no email — and no separate redeem.
    const [a, b] = api.signUps;
    expect({ ...a, challenge: '', signature: '' }).toEqual({ ...b, challenge: '', signature: '' });
    expect(a).toMatchObject({ inviteCode: CODE, publicKey: acct.session.publicKey });
    expect(a).not.toHaveProperty('email');
    expect([...api.routes]).not.toContain('post /auth/redeem-invite');

    // The code is this key's now: another key presenting it is refused.
    const other = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE, { account: 37 }), fetchImpl: api.fetchImpl, ...fast });
    await expect(other.session.register({ inviteCode: CODE })).rejects.toMatchObject({ status: 409 });
  });

  test('a gateway whose sign-up does not take the code yet: signs up without it, then redeems it', async () => {
    const api = venue({ legacySignUp: true });
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE, { account: 38 }), fetchImpl: api.fetchImpl, ...fast });
    const user = await acct.session.register({ inviteCode: CODE });
    expect(user.roles).toContain('partner-bot');
    expect(api.signUps.map((b) => b.inviteCode)).toEqual([CODE, undefined]);
    expect([...api.routes]).toContain('post /auth/redeem-invite');
  });

  test('a code the API does not know is refused — never dropped for a sign-up without the role', async () => {
    const api = venue();
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE, { account: 39 }), fetchImpl: api.fetchImpl, ...fast });
    await expect(acct.session.register({ inviteCode: 'ZZZZ-ZZZZ-ZZZZ' })).rejects.toMatchObject({ status: 404 });
    expect(api.signUps).toHaveLength(1);
    expect([...api.routes]).not.toContain('post /auth/redeem-invite');
  });
});

/** A signed-in API that answers only the routes a test names, and records every route asked for. */
function stub(handlers: Record<string, (body: Record<string, unknown>) => unknown>) {
  const hits: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const route = `${init.method} ${new URL(url).pathname}`;
    hits.push(route);
    if (route === 'POST /auth/challenge') return json({ challenge: 'Welcome to Cancore 2026-09-28 sig:1' });
    if (route === 'POST /auth/login-signature') return json({ token: jwt('a'), user: {} });
    const handler = handlers[route];
    if (!handler) return refuse(404, `no route ${route}`);
    const out = await handler(init.body ? JSON.parse(String(init.body)) : {});
    return out instanceof Response ? out : json(out);
  };
  return { fetchImpl, hits, signed: () => hits.filter((r) => r.startsWith('POST /wallet/operations')) };
}

const takenOrder = (over: Record<string, unknown> = {}) => ({
  id: 'o1', status: 'accepted', sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceAmount: '0.01',
  targetNetwork: 'canton', targetTokenAddress: 'CC', targetAmount: '5000', initiatorUserId: 'maker',
  opponentUserId: 'me', opponent: { partyId: 'party-taker' }, swapId: null, dvp: true, ...over,
});

describe('a 403 that is not a DvP refusal reaches the caller as the API said it (CAN-2400)', () => {
  // `take`, `swap.create` and `swap.createForPair` used to call every 403 "allocation-DvP is not open
  // to this account", and people asked for an allowlist entry they did not need.
  const OTHER_403: Array<[string, string, string | undefined]> = [
    ['self-trade inside one owner\'s family', 'Self-trade is not allowed: the order initiator and acceptor belong to the same person.', undefined],
    ['documents not accepted', 'The platform documents must be accepted before trading.', undefined],
    // A code a newer gateway serves and this client does not know yet: read as no code at all.
    ['a bot account its owner stopped', 'This bot account was stopped by its owner: it cannot make or take orders until the owner resumes it', 'ACCOUNT_STOPPED'],
    ['a 403 that says nothing', 'Forbidden', undefined],
  ];
  const offer = {
    sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceTokenName: 'CBTC', sourceAmount: '0.01',
    targetNetwork: 'canton', targetTokenAddress: 'CC', targetTokenName: 'CC', targetAmount: '5000',
  };
  const account = async (handlers: Parameters<typeof stub>[0]) => {
    const api = stub(handlers);
    return { api, acct: createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast }) };
  };
  const asTheApiSaidIt = (error: unknown, message: string) => {
    expect(error).toMatchObject({ name: 'CancoreApiError', status: 403 });
    expect(error).not.toBeInstanceOf(SettleError);
    expect((error as Error).message).toContain(message);
    expect((error as Error).message).not.toMatch(/allocation-DvP/i);
  };

  test.each(OTHER_403)('%s, at take', async (_what, message, errorCode) => {
    const { api, acct } = await account({
      'GET /orders/o1': () => takenOrder({ status: 'open', opponentUserId: null, opponent: null }),
      'GET /auth/me': () => ({ id: 'me', partyId: 'party-me' }),
      'POST /orders/o1/accept': () => refuse(403, message, errorCode),
    });

    asTheApiSaidIt(await acct.take('o1').catch((e: unknown) => e), message);
    expect(api.signed()).toEqual([]);
  });

  test.each(OTHER_403)('%s, at placing an order', async (_what, message, errorCode) => {
    const { api, acct } = await account({ 'POST /orders': () => refuse(403, message, errorCode) });

    asTheApiSaidIt(await acct.swap.create(offer).catch((e: unknown) => e), message);
    expect(api.signed()).toEqual([]);
  });

  test.each(OTHER_403)('%s, at placing a pair order', async (_what, message, errorCode) => {
    const { api, acct } = await account({
      'GET /trading-pairs/p1': () => ({ id: 'p1', baseToken: { network: 'canton' }, quoteToken: { network: 'canton' } }),
      'POST /orders/pair': () => refuse(403, message, errorCode),
    });

    asTheApiSaidIt(await acct.swap.createForPair({ tradingPairId: 'p1', sourceAmount: '1', targetAmount: '2' }).catch((e: unknown) => e), message);
    expect(api.signed()).toEqual([]);
  });

  test.each([
    ['by its code', 'refused', 'DVP_NOT_ALLOWED'],
    // A gateway that serves no codes yet names the refusal only in its message.
    ['by its words alone', 'Allocation-DvP is not open to this account on this stand. A DvP trade needs a self-custody, staff/bot or allowlisted party on at least one side.', undefined],
  ])('the DvP refusal itself is still said in words, %s', async (_how, message, errorCode) => {
    const { acct } = await account({
      'GET /orders/o1': () => takenOrder({ status: 'open', opponentUserId: null, opponent: null }),
      'GET /auth/me': () => ({ id: 'me', partyId: 'party-me' }),
      'POST /orders/o1/accept': () => refuse(403, message, errorCode),
      'POST /orders': () => refuse(403, message, errorCode),
    });

    const taken = await acct.take('o1').catch((e: unknown) => e);
    expect(taken).toBeInstanceOf(SettleError);
    expect((taken as Error).message).toMatch(/taking order o1: allocation-DvP is not open to this account/);
    await expect(acct.swap.create(offer)).rejects.toThrow(/placing the order: allocation-DvP is not open to this account/);
  });
});

describe('refusals that come before anything is signed', () => {
  test.each([{ sourceNetwork: 'sepolia' }, { targetNetwork: 'sepolia' }])('an order that is not Canton on both sides: %o', async (side) => {
    const api = stub({ 'GET /orders/o1': () => takenOrder(side) });
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast });
    await expect(acct.make('o1')).rejects.toThrow(/only Canton↔Canton/);
    await expect(acct.take('o1')).rejects.toThrow(/only Canton↔Canton/);
    expect(api.signed()).toEqual([]);
  });

  test('an order another account took', async () => {
    const api = stub({
      'GET /orders/o1': () => takenOrder({ opponentUserId: 'someone-else' }),
      'GET /auth/me': () => ({ id: 'me', partyId: 'party-me' }),
    });
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast });
    await expect(acct.take('o1')).rejects.toThrow(/taken by another account/);
    expect(api.signed()).toEqual([]);
  });

  test('a timeout the stand does not offer for the order', async () => {
    const api = stub({
      'GET /orders/o1': () => takenOrder(),
      'GET /htlc/dvp/instruments': () => [{ id: 'CBTC', admin: DEV.cbtcRegistrar }, { id: 'CC', admin: DEV.dso }],
      'GET /auth/me': () => ({ id: 'me', partyId: 'party-maker' }),
      'GET /htlc/fee-config': () => ({ feeRate: '0', venue: 'venue::1220' }),
      'GET /htlc/timeout-options': () => ({ timeoutHours: [1, 2] }),
    });
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast });
    await expect(acct.make('o1', { timeoutHours: 3 })).rejects.toThrow(/timeoutHours 3 is not offered.*1, 2/);
    expect(api.signed()).toEqual([]);
  });

  test('an order nobody takes: the wait ends at the deadline with the last state it saw', async () => {
    const api = stub({ 'GET /orders/o1': () => takenOrder({ status: 'open', opponentUserId: null, opponent: null }) });
    let clock = 0;
    const acct = createSelfCustody({
      baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast, now: () => (clock += 60_000),
    });
    const error = await acct.make('o1', { deadlineMs: 10 * 60_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettleError);
    expect(error).toMatchObject({ message: expect.stringMatching(/order o1 to be taken/), last: { status: 'open' } });
    expect(api.signed()).toEqual([]);
  });

  test('a prepare the API refuses surfaces as a CeremonyError naming the operation and the stage', async () => {
    const api = stub({ 'POST /wallet/operations/prepare': () => refuse(400, 'amount must be a number string') });
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast, maxFee: '2' });
    const error = await acct.send({ receiverPartyId: 'p', amount: 'lots' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CeremonyError);
    expect(error).toMatchObject({ operation: 'tokens.send', stage: 'prepare', meta: null });
    expect((error as CeremonyError).errorCode).toBeUndefined();
    expect(api.hits).not.toContain('POST /wallet/operations/submit');
  });

  test('a coded refusal carries its errorCode on the CeremonyError, for the caller to branch on', async () => {
    const api = stub({ 'POST /wallet/operations/prepare': () => refuse(503, 'hosting unknown', 'PARTY_HOSTING_UNKNOWN') });
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast, maxFee: '2' });
    const error = await acct.send({ receiverPartyId: 'p', amount: '1' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CeremonyError);
    expect(error).toMatchObject({ stage: 'prepare', errorCode: 'PARTY_HOSTING_UNKNOWN', cause: { errorCode: 'PARTY_HOSTING_UNKNOWN' } });
  });
});

test('acceptIncoming skips what expired and what the filter drops, and one refusal does not stop the rest', async () => {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const ti = (contractId: string, executeBefore: string, instrumentId = 'CBTC') =>
    ({ contractId, templateId: 't', instrumentAdmin: DEV.cbtcRegistrar, instrumentId, executeBefore });
  const prepared: string[] = [];
  const signer = await providerFromMnemonic(PHRASE);
  const me = `party-me::${cantonFingerprint(signer.public_key)}`;
  const api = stub({
    'GET /auth/me': () => ({ id: 'me', partyId: me }),
    'GET /tokens/transfer-requests/incoming': () => [
      ti('expired', at(-60_000)), ti('refused', at(60_000)), ti('fine', at(60_000)), ti('dust', at(60_000), 'SPAM'),
    ],
    'POST /wallet/operations/prepare': (body) => {
      const cid = String((body.params as Record<string, unknown>).instructionCid);
      prepared.push(cid);
      return cid === 'refused'
        ? refuse(400, 'registry context unavailable')
        : acceptLegs(me, cid).then((legs) => ({ operationId: `op-${cid}`, legs, meta: null }));
    },
    'POST /wallet/operations/submit': () => ({ outcome: 'committed' }),
  });
  const acct = createSelfCustody({ baseUrl, signer, fetchImpl: api.fetchImpl, ...fast });
  const { accepted, failed } = await acct.acceptIncoming((t) => t.instrumentId !== 'SPAM');
  expect(accepted.map((t) => t.contractId)).toEqual(['fine']);
  expect(failed.map((f) => f.transfer.contractId)).toEqual(['refused']);
  expect(failed[0]!.error).toBeInstanceOf(CeremonyError);
  expect(prepared).toEqual(['refused', 'fine']);
});

describe('the instrument admin is the SDK’s to pin, not the API’s to name', () => {
  const ROGUE = 'cbtc-network::1220aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const api = (proposed: unknown[]) => stub({
    'GET /orders/o1': () => takenOrder(),
    'GET /htlc/timeout-options': () => ({ timeoutHours: [1] }),
    'GET /htlc/dvp/instruments': () => [{ id: 'CBTC', admin: ROGUE }, { id: 'CC', admin: DEV.dso }],
    'GET /auth/me': () => ({ id: 'me', partyId: 'party-maker' }),
    'GET /htlc/fee-config': () => ({ feeRate: '0', venue: 'venue::1220' }),
    'POST /htlc/proposals': (body) => (proposed.push(body), refuse(400, 'the test stops at the proposal')),
  });

  test('an admin the SDK does not list for the instrument is refused before anything is recorded', async () => {
    const proposed: unknown[] = [];
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api(proposed).fetchImpl, ...fast });
    await expect(acct.make('o1')).rejects.toThrow(/names cbtc-network::1220a+ as the admin of CBTC, which is not an admin this SDK trusts/);
    expect(proposed).toEqual([]);
  });

  test('an admin added with instrumentAdmins is trusted, next to the defaults rather than instead of them', async () => {
    const proposed: unknown[] = [];
    const acct = createSelfCustody({
      baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api(proposed).fetchImpl, ...fast,
      // Only CBTC is named: CC keeps its pinned DSO, which the stub still answers with.
      instrumentAdmins: { CBTC: [ROGUE] },
    });
    await expect(acct.make('o1')).rejects.toMatchObject({ status: 400 });
    expect(proposed).toHaveLength(1);
  });
});

describe('the network decides which admins are trusted', () => {
  const api = (cbtcAdmin: string) => stub({
    'GET /orders/o1': () => takenOrder(),
    'GET /htlc/dvp/instruments': () => [{ id: 'CBTC', admin: cbtcAdmin }, { id: 'CC', admin: DEV.dso }],
    'GET /auth/me': () => ({ id: 'me', partyId: 'party-maker' }),
  });
  const account = async (url: string, cbtcAdmin = DEV.cbtcRegistrar, over: Partial<SelfCustodyOptions> = {}) =>
    createSelfCustody({ baseUrl: url, signer: await providerFromMnemonic(PHRASE), fetchImpl: api(cbtcAdmin).fetchImpl, ...fast, ...over });

  test('a host the SDK does not know, with no network given, trusts no admin', async () => {
    await expect((await account('https://api.example')).make('o1')).rejects.toThrow(/cannot tell which network https:\/\/api.example serves.*pass network/);
  });
  test('a devnet admin is not trusted on mainnet', async () => {
    await expect((await account('https://api.cancore.io')).make('o1')).rejects.toThrow(/as the admin of CBTC, which is not an admin this SDK trusts/);
  });
  test('CC on testnet: its admin is not configured, and the error says how to configure it', async () => {
    const testnetCbtc = 'cbtc-network::12201b1741b63e2494e4214cf0bedc3d5a224da53b3bf4d76dba468f8e97eb15508f';
    await expect((await account('https://api-testnet.cancore.app', testnetCbtc)).make('o1')).rejects.toThrow(/CC admin for testnet not configured — pass instrumentAdmins/);
  });
  test('the network option speaks for a host the SDK does not know', async () => {
    await expect((await account('https://api.example', DEV.cbtcRegistrar, { network: 'mainnet' })).make('o1')).rejects.toThrow(/not an admin this SDK trusts/);
  });
});

describe('the timeout the maker’s proposal request carries', () => {
  // What dev offered for an order on 2026-10-02 (`GET /htlc/timeout-options`).
  const OFFERED_ON_DEV = [0.01667, 0.0833, 0.1667, 0.25, 0.5, 1, 3, 6, 24];

  test.each<[string, number[], number | undefined, number]>([
    ['by default, the shortest that leaves the counter leg time to settle', OFFERED_ON_DEV, undefined, 0.25],
    ['by default, with only short ones offered, the longest of them', [0.01667, 0.0833, 0.1667], undefined, 0.1667],
    ['asked for explicitly, exactly that one — even one the default would not pick', OFFERED_ON_DEV, 0.01667, 0.01667],
  ])('%s', async (_name, offered, timeoutHours, expected) => {
    const asked: unknown[] = [];
    const api = stub({
      'GET /orders/o1': () => takenOrder(),
      'GET /htlc/timeout-options': () => ({ timeoutHours: offered }),
      'GET /htlc/dvp/instruments': () => [{ id: 'CBTC', admin: DEV.cbtcRegistrar }, { id: 'CC', admin: DEV.dso }],
      'GET /auth/me': () => ({ id: 'me', partyId: 'party-maker' }),
      'GET /htlc/fee-config': () => ({ feeRate: '0', venue: 'venue::1220' }),
      'POST /htlc/proposals': (body) => {
        asked.push(body.timeoutHours);
        return refuse(400, 'the test stops at the proposal');
      },
    });
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast });
    await expect(acct.make('o1', { timeoutHours })).rejects.toMatchObject({ status: 400 });
    expect(asked).toEqual([expected]);
  });
});

describe('signing in right after sign-up', () => {
  /** A gateway whose challenge answers the first `falseNotFounds` requests with the false "no account" 404. */
  function gateway(falseNotFounds: number) {
    const seen: string[] = [];
    const pauses: number[] = [];
    let left = falseNotFounds;
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      seen.push(path);
      if (path === '/auth/challenge') {
        return left-- > 0
          ? refuse(404, 'No Cancore account is linked to this wallet. Sign up to create one first.', 'ACCOUNT_NOT_FOUND')
          : json({ challenge: 'Welcome to Cancore 2026-10-02 sig:1' });
      }
      if (path === '/auth/login-signature') return json({ token: jwt('u1'), user: { id: 'u1' } });
      if (path === '/auth/me') return json({ id: 'u1', partyId: 'p::1220' });
      return refuse(404, `no route ${path}`);
    };
    return { fetchImpl, seen, pauses, sleep: async (ms: number) => void pauses.push(ms) };
  }

  test('a false 404 ACCOUNT_NOT_FOUND from the challenge is asked again, and the first request goes through', async () => {
    const g = gateway(1);
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: g.fetchImpl, sleep: g.sleep });
    await expect(acct.me()).resolves.toMatchObject({ id: 'u1' });
    expect(g.seen).toEqual(['/auth/challenge', '/auth/challenge', '/auth/login-signature', '/auth/me']);
    expect(g.pauses).toEqual([1_000]);
  });

  test('three in a row is an account that does not exist: the 404 surfaces', async () => {
    const g = gateway(3);
    const session = createSession({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: g.fetchImpl, sleep: g.sleep });
    await expect(session.login()).rejects.toMatchObject({ status: 404, errorCode: 'ACCOUNT_NOT_FOUND' });
    expect(g.seen).toEqual(['/auth/challenge', '/auth/challenge', '/auth/challenge']);
    expect(g.pauses).toEqual([1_000, 2_000]);
  });
});

test('a signer without public_key is refused up front, naming the field it needs', () => {
  // The raw key material calls it publicKeyHex; the signer the session takes calls it public_key.
  const { publicKeyHex } = deriveWalletKey(PHRASE);
  const wrong = { publicKeyHex, signMessage: async () => '00' } as unknown as KeySigner;
  expect(() => createSelfCustody({ baseUrl, signer: wrong })).toThrow(/signer\.public_key.*publicKeyHex/s);
});

test('faucet signs the faucet terms for this account’s party and asks for test CC', async () => {
  const signer = await providerFromMnemonic(PHRASE);
  let posted: Record<string, unknown> | undefined;
  const claim = { success: true, amountCc: 1000, recipientParty: 'p::1220', txId: 'tx', nextEligibleAt: '2026-10-04T10:00:00Z', remainingPoolCc: 199000 };
  const api = stub({
    'GET /auth/me': () => ({ id: 'u1', partyId: 'p::1220' }),
    'POST /faucet/request': (body) => {
      posted = body;
      return claim;
    },
  });
  const at = Date.parse('2026-10-02T10:00:00.000Z');
  const acct = createSelfCustody({ baseUrl, signer, fetchImpl: api.fetchImpl, ...fast, now: () => at });
  await expect(acct.faucet()).resolves.toEqual(claim);
  expect(posted).toEqual({ agreementSignature: expect.any(String), agreementTimestamp: at });
  const message = `CANCORE_FAUCET_TERMS_OF_SERVICE_V1:p::1220:${at}`;
  expect(ed25519.verify(hex(String(posted!.agreementSignature)), new TextEncoder().encode(message), hex(signer.public_key))).toBe(true);
});

/** A socket the test drives: `emit` delivers to whatever `serve` subscribed. */
function fakeSocket() {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on: (event: string, handler: (payload: unknown) => void) => handlers.set(event, (handlers.get(event) ?? new Set()).add(handler)),
    off: (event: string, handler: (payload: unknown) => void) => handlers.get(event)?.delete(handler),
    emit: (event: string, payload: unknown) => handlers.get(event)?.forEach((handler) => handler(payload)),
    listeners: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
  };
}

/** Resolve once `check` holds, yielding a macrotask between looks. */
async function until(check: () => boolean, budgetMs = 10_000): Promise<void> {
  const end = Date.now() + budgetMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('serve(): an untake during the fee split matches what is sent', () => {
  test('the first accept is refused for a fee holding; an untake during the split reports in flight, and the second accept goes out', async () => {
    const api = venue({ refuseAt: { accept: 'feeHoldingUntilSplit' }, coded: true, sendBytes: 'honest' });
    let refused = false;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let atSplit!: () => void;
    const reachedSplit = new Promise<void>((r) => (atSplit = r));
    const fetchImpl: typeof api.fetchImpl = async (url, init) => {
      const path = new URL(url).pathname;
      if (init.method === 'POST' && path === '/wallet/operations/prepare' && refused) {
        atSplit();
        await held;
      }
      const res = await api.fetchImpl(url, init);
      if (init.method === 'POST' && path === '/orders/o1/accept' && !res.ok) refused = true;
      return res;
    };
    const { maker, taker } = await tradingPair(api, [78, 79], {}, { fetchImpl });
    await maker.swap.create({
      sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceTokenName: 'CBTC', sourceAmount: '0.01',
      targetNetwork: 'canton', targetTokenAddress: 'CC', targetTokenName: 'CC', targetAmount: '5000',
    });
    const handle = taker.serve({ reconcileMs: 3_600_000 });
    handle.take('o1');
    await reachedSplit;
    // The first accept went out: the take is in flight, and so the untake must say so.
    expect(handle.untake('o1')).toBe(false);
    release();
    await until(() => api.takes() === 2);
    expect(api.order.status).not.toBe('open');
    await handle.stop();
  });
});

describe('serve(): which accept failures prove nothing was accepted', () => {
  test.each([
    ['a 403 refusal ends the take: untake confirms it is off', 'notAllowed' as const, true],
    ['a 409 is not proof (it may be our own accept, read late): untake reports it may be a trade', 'conflict' as const, false],
    ['the fee-holding 409 comes before the venue claims the order: one the take cannot meet ends it, untake confirms it is off', 'feeHoldingOther' as const, true],
    ['the same refusal told in prose only, with no error code', 'feeHoldingProse' as const, true],
    ['a 408 is not proof (a proxy answers it while the venue may still work on the accept): untake reports it may be a trade', 'timeout' as const, false],
  ])('%s', async (_, refusal, untaken) => {
    const api = venue(
      refusal === 'notAllowed' ? { refuseAt: { accept: 'notAllowed' } }
        : refusal === 'feeHoldingOther' ? { refuseAt: { accept: 'feeHoldingOther' }, coded: true }
          : refusal === 'feeHoldingProse' ? { refuseAt: { accept: 'feeHoldingOther' } } : {},
    );
    let failed = false;
    const fetchImpl: typeof api.fetchImpl = async (url, init) => {
      const accept = init.method === 'POST' && new URL(url).pathname === '/orders/o1/accept';
      const res = refusal === 'conflict' && accept
        ? json({ message: 'Order already accepted' }, 409)
        : refusal === 'timeout' && accept ? json({ message: 'stream timeout' }, 408) : await api.fetchImpl(url, init);
      if (accept) failed = true;
      return res;
    };
    const { maker, taker } = await tradingPair(api, [80, 81], {}, { fetchImpl });
    await maker.swap.create({
      sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceTokenName: 'CBTC', sourceAmount: '0.01',
      targetNetwork: 'canton', targetTokenAddress: 'CC', targetTokenName: 'CC', targetAmount: '5000',
    });
    const events: ServeEvent[] = [];
    const handle = taker.serve({ reconcileMs: 3_600_000, onEvent: (e) => events.push(e) });
    handle.take('o1');
    await until(() => failed && events.some((e) => e.type === 'error'));
    expect(handle.untake('o1')).toBe(untaken);
    expect(handle.mayBeTrade('o1')).toBe(!untaken);
    await handle.stop();
  });
});

describe('serve(): a 400 after a lost accept answer does not drop the take (F128-ACCEPT-400-1)', () => {
  test('first accept times out unapplied-looking, the order still reads open, the second accept lands but answers 400; untake reports a trade, and the trade settles', async () => {
    const api = venue();
    let posts = 0;
    const fetchImpl: typeof api.fetchImpl = async (url, init) => {
      if (init.method === 'POST' && new URL(url).pathname === '/orders/o1/accept') {
        posts++;
        // First attempt: the server is still in its handler when the client gives up; nothing visible yet.
        if (posts === 1) throw new TypeError('fetch failed');
        // Second attempt: the first one commits now (we become the taker), and this one is refused as not open.
        if (posts === 2) {
          await api.fetchImpl(url, init);
          return new Response(JSON.stringify({ statusCode: 400, message: 'Order is not open' }), { status: 400 });
        }
      }
      return api.fetchImpl(url, init);
    };
    const { maker, taker } = await tradingPair(api, [80, 81], {}, { fetchImpl });
    await maker.swap.create({
      sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceTokenName: 'CBTC', sourceAmount: '0.01',
      targetNetwork: 'canton', targetTokenAddress: 'CC', targetTokenName: 'CC', targetAmount: '5000',
    });
    const events: ServeEvent[] = [];
    const handle = taker.serve({ reconcileMs: 5, onEvent: (e) => events.push(e) });
    handle.take('o1');
    await until(() => posts >= 2 && events.filter((e) => e.type === 'error').length >= 2);
    // What a pause does now: the take must still be reported as a possible trade.
    expect(handle.untake('o1')).toBe(false);
    expect(api.order.opponentUserId).toBeTruthy();
    await handle.stop();
  });
});

describe('take: onAccepted marks the trade', () => {
  test('called once this account holds the order', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [72, 73]);
    await maker.swap.create({
      sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceTokenName: 'CBTC', sourceAmount: '0.01',
      targetNetwork: 'canton', targetTokenAddress: 'CC', targetTokenName: 'CC', targetAmount: '5000',
    });
    const mine = jest.fn();
    // The take runs past the accept; only the hook matters here, so the rest is left to fail or hang.
    void taker.take('o1', { deadlineMs: 50, onAccepted: mine } as never).catch(() => undefined);
    await until(() => mine.mock.calls.length > 0);
    expect(mine).toHaveBeenCalledTimes(1);
  });
});

describe('serve(): an untake is honoured up to the accept request itself', () => {
  test('the take preflight GET is held past serve.look, untake lands, and no POST accept is ever sent', async () => {
    const api = venue();
    // The taker's reads of the order: the first is serve.look, the second takeOnce's own preflight, held here.
    let reads = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let atPreflight!: () => void;
    const reachedPreflight = new Promise<void>((r) => (atPreflight = r));
    const fetchImpl: typeof api.fetchImpl = async (url, init) => {
      if (init.method === 'GET' && new URL(url).pathname === '/orders/o1' && ++reads === 2) {
        atPreflight();
        await held;
      }
      return api.fetchImpl(url, init);
    };
    const { maker, taker } = await tradingPair(api, [70, 71], {}, { fetchImpl });
    await maker.swap.create({
      sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceTokenName: 'CBTC', sourceAmount: '0.01',
      targetNetwork: 'canton', targetTokenAddress: 'CC', targetTokenName: 'CC', targetAmount: '5000',
    });
    const events: ServeEvent[] = [];
    const handle = taker.serve({ reconcileMs: 3_600_000, onEvent: (e) => events.push(e) });
    handle.take('o1');
    await reachedPreflight;
    // What the daemon's pause does: the accept has not been sent yet, so the take is called off.
    expect(handle.untake('o1')).toBe(true);
    release();
    await until(() => reads >= 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.takes()).toBe(0);
    expect(api.order.status).toBe('open');
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    await handle.stop();
  });
});

describe('serve(): untake of a take this account has already accepted (V3)', () => {
  test('the order was accepted by this account outside serve before the queued take ran: untake reports a trade', async () => {
    const api = venue();
    let reads = 0;
    const fetchImpl: typeof api.fetchImpl = async (url, init) => {
      if (init.method === 'GET' && new URL(url).pathname === '/orders/o1') reads++;
      return api.fetchImpl(url, init);
    };
    const { maker, taker } = await tradingPair(api, [84, 85], {}, { fetchImpl });
    await maker.swap.create({
      sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceTokenName: 'CBTC', sourceAmount: '0.01',
      targetNetwork: 'canton', targetTokenAddress: 'CC', targetTokenName: 'CC', targetAmount: '5000',
    });
    // Accepted by this same account elsewhere (the web app) after the daemon's gate read the order open.
    await taker.swap.accept('o1');
    const handle = taker.serve({ reconcileMs: 3_600_000 });
    reads = 0;
    handle.take('o1');
    // serve's look, the take's own read, then its wait for the maker: the accept was never this loop's to send,
    // but the trade is this account's and in progress.
    await until(() => reads >= 3);
    expect(handle.untake('o1')).toBe(false);
    expect(api.takes()).toBe(1);
    await handle.stop();
  });
});

describe('serve(): the maker runs nothing but serve()', () => {
  test('an order taken while serve runs is settled on the maker side, triggered by the realtime event alone', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [60, 61]);
    await maker.swap.create({
      sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceTokenName: 'CBTC', sourceAmount: '0.01',
      targetNetwork: 'canton', targetTokenAddress: 'CC', targetTokenName: 'CC', targetAmount: '5000',
    });
    const socket = fakeSocket();
    const events: ServeEvent[] = [];
    // The poll runs once at start (the order is still open) and not again within the test.
    const handle = maker.serve({ socket, reconcileMs: 3_600_000, onEvent: (e) => events.push(e) });
    await until(() => api.routes.has('get /htlc/swaps'));

    const taking = taker.take('o1');
    await until(() => api.order.status === 'accepted');
    // The broadcast reaches every client; serve keeps its own orders only.
    socket.emit('order:updated', { ...api.order, id: 'not-mine', initiatorUserId: 'someone', opponentUserId: 'else' });
    socket.emit('order:updated', { ...api.order });

    await until(() => events.some((e) => e.type === 'settled'));
    expect(await taking).toMatchObject({ swap: { status: 'dvp_settled' } });
    expect(events).toEqual([expect.objectContaining({ type: 'settled', orderId: 'o1', swapId: 's1' })]);
    expect(dvpSteps(api)).toEqual([
      'dvp:dvpCreateProposal:maker', 'dvp:dvpAcceptProposal:taker', 'dvp:dvpAllocateLeg:taker', 'dvp:dvpAllocateLeg:maker',
    ]);
    await handle.stop();
    expect(socket.listeners()).toBe(0);
  });

  test('with no event at all, the reconcile poll finds the taken order and settles it', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [62, 63]);
    const events: ServeEvent[] = [];
    const handle = maker.serve({ reconcileMs: 5, onEvent: (e) => events.push(e) });
    const [taken] = await Promise.all([taker.take('o1'), until(() => events.some((e) => e.type === 'settled'))]);
    await handle.stop();
    expect(taken.swap.status).toBe('dvp_settled');
    expect(events.filter((e) => e.type === 'settled')).toHaveLength(1);
    // Polled many times over, each step was still signed exactly once.
    expect(dvpSteps(api)).toEqual([
      'dvp:dvpCreateProposal:maker', 'dvp:dvpAcceptProposal:taker', 'dvp:dvpAllocateLeg:taker', 'dvp:dvpAllocateLeg:maker',
    ]);
  });

  test('a burst of events for one swap runs one handler, and signs each step once', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [64, 65]);
    await taker.swap.accept('o1');
    const socket = fakeSocket();
    const events: ServeEvent[] = [];
    const handle = maker.serve({ socket, reconcileMs: 3_600_000, onEvent: (e) => events.push(e) });
    for (let i = 0; i < 5; i++) {
      socket.emit('order:updated', { ...api.order });
      socket.emit('swap:updated', { swapId: 's1', orderId: 'o1', status: 'dvp_proposed', timestamp: '' });
    }
    // make() called directly while serve has the order joins the same run.
    const [direct] = await Promise.all([maker.make('o1'), taker.take('o1')]);
    await until(() => events.some((e) => e.type === 'settled'));
    await handle.stop();
    expect(direct.swap.status).toBe('dvp_settled');
    expect(api.proposals).toHaveLength(1);
    expect(dvpSteps(api).filter((s) => s.endsWith(':maker'))).toEqual(['dvp:dvpCreateProposal:maker', 'dvp:dvpAllocateLeg:maker']);
    expect(events.filter((e) => e.type === 'settled')).toHaveLength(1);
  });

  test('a trade that expired with this account’s allocation locked is withdrawn by serve, once', async () => {
    const api = venue({ takerFundedThenExpired: 'stillLocked' });
    const { maker, taker } = await tradingPair(api, [66, 67]);
    await taker.swap.accept('o1');
    const making = maker.make('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    // take() without autoWithdraw leaves the taker's two legs locked.
    expect(await taker.take('o1').catch((e: unknown) => e)).toMatchObject({ withdrawable: true });
    await making;

    const events: ServeEvent[] = [];
    const handle = taker.serve({ reconcileMs: 5, onEvent: (e) => events.push(e) });
    await until(() => events.some((e) => e.type === 'withdrawn'));
    // Several more polls: the swap is still listed as dvp_expired, and nothing is signed again.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await handle.stop();
    expect(events.filter((e) => e.type === 'withdrawn')).toEqual([
      expect.objectContaining({ orderId: 'o1', swapId: 's1', withdrawal: { swapId: 's1', withdrawn: ['counter', 'fee'], gone: [], failed: [] } }),
    ]);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(api.log.filter((e) => e.type === 'dvp:dvpWithdrawAllocation').map((e) => e.params.legIds)).toEqual([['leg-counter'], ['leg-fee']]);
    expect(api.legs().filter((l) => l.sender === api.party('taker')).map((l) => l.status)).toEqual(['cancelled', 'cancelled']);
  });

  test('one poll over an expired swap still locked reads /auth/me once: look and locked check share it', async () => {
    const api = venue({ takerFundedThenExpired: 'stillLocked' });
    const { maker, taker } = await tradingPair(api, [70, 71]);
    await taker.swap.accept('o1');
    const making = maker.make('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    expect(await taker.take('o1').catch((e: unknown) => e)).toMatchObject({ withdrawable: true });
    await making;

    let meCalls = 0;
    const fetchImpl = api.fetchImpl;
    const counted = createSelfCustody({ baseUrl, signer: (await providerFromMnemonic(PHRASE, { account: 71 }))!, fetchImpl: async (url, init) => {
      if (new URL(url).pathname === '/auth/me') meCalls++;
      return fetchImpl(url, init);
    }, ...fast });
    await counted.session.login();
    // The order ended while no loop ran (a restart): the poll finds it terminal and checks the swap.
    Object.assign(api.order, { status: 'cancelled' });
    meCalls = 0;
    const events: ServeEvent[] = [];
    // One poll only; autoWithdraw off, so nothing but the look and the locked check reads the account.
    const handle = counted.serve({ reconcileMs: 3_600_000, autoWithdraw: false, onEvent: (e) => events.push(e) });
    await until(() => events.some((e) => e.type === 'expired'));
    await handle.stop();
    expect(meCalls).toBe(1);
  });

  test('handle.take(orderId) takes an open order and settles the taker side', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [68, 69]);
    const events: ServeEvent[] = [];
    const [makerLoop, takerLoop] = [maker.serve({ reconcileMs: 5 }), taker.serve({ reconcileMs: 5, onEvent: (e) => events.push(e) })];
    takerLoop.take('o1');
    await until(() => events.some((e) => e.type === 'settled'));
    await Promise.all([makerLoop.stop(), takerLoop.stop()]);
    expect(api.takes()).toBe(1);
    expect(api.legs().every((l) => l.lockRef)).toBe(true);
  });
});

describe('stopping a settle: an abort signs nothing new and ends every wait', () => {
  test('a make waiting for its order to be taken ends on abort with a SettleError', async () => {
    const api = venue();
    const { maker } = await tradingPair(api, [70, 71]);
    const controller = new AbortController();
    const making = maker.make('o1', { signal: controller.signal }).catch((e: unknown) => e);
    await until(() => api.routes.has('get /orders/{id}'));
    controller.abort();
    expect(await making).toMatchObject({ name: 'SettleError', message: expect.stringMatching(/^aborted while waiting for order o1 to be taken/) });
  });

  test('an aborted make whose next step is ready signs it not: no proposal, no signature', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [72, 73]);
    await taker.swap.accept('o1');
    expect(await maker.make('o1', { signal: AbortSignal.abort() }).catch((e: unknown) => e)).toMatchObject({
      name: 'SettleError',
      message: expect.stringMatching(/^aborted before recording the trade/),
    });
    expect(api.proposals).toEqual([]);
    expect(dvpSteps(api)).toEqual([]);
  });

  test('an aborted take does not take the order', async () => {
    const api = venue();
    const { taker } = await tradingPair(api, [74, 75]);
    expect(await taker.take('o1', { signal: AbortSignal.abort() }).catch((e: unknown) => e)).toMatchObject({ message: expect.stringMatching(/^aborted before taking the order/) });
    expect(api.takes()).toBe(0);
    expect(api.order.status).toBe('open');
  });

  test('a make joining one in flight: its own signal ends its own wait, and the run in flight goes on to settle', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [76, 77]);
    const running = maker.make('o1');
    const controller = new AbortController();
    const joined = maker.make('o1', { signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    expect(await joined).toMatchObject({ name: 'SettleError', message: expect.stringMatching(/already in flight \(it goes on\)/) });
    const [made] = await Promise.all([running, taker.take('o1')]);
    expect(made.swap.status).toBe('dvp_settled');
    expect(api.proposals).toHaveLength(1);
  });

  test('a make waiting for the taker to fund ends on abort within a poll, and signs nothing more', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [78, 79]);
    await taker.swap.accept('o1');
    const controller = new AbortController();
    // The default deadline is 45 minutes: only the abort can end this wait inside the test.
    const making = maker.make('o1', { signal: controller.signal }).catch((e: unknown) => e);
    await until(() => dvpSteps(api).includes('dvp:dvpCreateProposal:maker'));
    controller.abort();
    const outcome = await Promise.race([making, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2_000))]);
    expect(outcome).toMatchObject({ name: 'SettleError', swapId: 's1', message: expect.stringMatching(/^aborted while waiting for the taker to approve and fund its legs/) });
    expect(dvpSteps(api)).toEqual(['dvp:dvpCreateProposal:maker']);
  });

  test('every step of make and take runs inside the gate serve passes — the take, the trade, each signature', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [80, 81]);
    /** What `side` did while its gate held a slot: its DvP signatures, plus the trade it recorded or the order it took. */
    const gated = (side: 'maker' | 'taker', seen: string[]): SettleRun => ({
      gate: async (run) => {
        const [logAt, proposalsAt, takesAt] = [api.log.length, api.proposals.length, api.takes()];
        const result = await run();
        if (side === 'maker' && api.proposals.length > proposalsAt) seen.push('recording the trade');
        if (side === 'taker' && api.takes() > takesAt) seen.push('taking the order');
        seen.push(...api.log.slice(logAt).map((e) => `${e.type}:${e.params.by}`).filter((s) => s.endsWith(`:${side}`)));
        return result;
      },
    });
    const [makerSteps, takerSteps]: [string[], string[]] = [[], []];
    const [made, taken] = await Promise.all([maker.make('o1', gated('maker', makerSteps)), taker.take('o1', gated('taker', takerSteps))]);
    expect([made.swap.status, taken.swap.status]).toEqual(['dvp_settled', 'dvp_settled']);
    expect(makerSteps).toEqual(['recording the trade', 'dvp:dvpCreateProposal:maker', 'dvp:dvpAllocateLeg:maker']);
    expect(takerSteps).toEqual(['taking the order', 'dvp:dvpAcceptProposal:taker', 'dvp:dvpAllocateLeg:taker']);
  });

  test('an autoWithdraw stopped while it waits for its slot signs no withdraw, and the allocation stays withdrawable', async () => {
    const api = venue({ takerFundedThenExpired: 'stillLocked' });
    const { maker, taker } = await tradingPair(api, [82, 83]);
    await taker.swap.accept('o1');
    const making = maker.make('o1', { deadlineMs: 3_000 }).catch((e: unknown) => e);
    const controller = new AbortController();
    // serve stopped while the withdraw waits for a slot: the first gate call once the taker's legs are locked is the withdraw's.
    const opts: SettleRun = {
      autoWithdraw: true,
      signal: controller.signal,
      gate: (run) => {
        if (api.legs().some((l) => l.sender === api.party('taker') && l.lockRef)) controller.abort();
        return run();
      },
    };
    const error = await taker.take('o1', opts).catch((e: unknown) => e);
    await making;
    expect(error).toBeInstanceOf(SettleError);
    expect(error).toMatchObject({ swapId: 's1', withdrawable: true, message: expect.stringMatching(/dvp_expired/) });
    expect((error as SettleError).withdrawal).toBeUndefined();
    expect(api.log.filter((e) => e.type === 'dvp:dvpWithdrawAllocation')).toEqual([]);
  });
});

test('session.token() renews an expiring token before handing it out, and reuses a fresh one', async () => {
  const signer = await providerFromMnemonic(PHRASE);
  const renewed = jwt('a');
  const seen: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    const path = new URL(url).pathname;
    seen.push(path);
    if (path === '/auth/challenge') return json({ challenge: 'Welcome to Cancore 2026-09-28 sig:1' });
    if (path === '/auth/login-signature') return json({ token: jwt('a', Math.floor(Date.now() / 1000) + 30), refreshToken: 'r1', user: {} });
    if (path === '/auth/refresh') return json({ token: renewed, refreshToken: 'r2' });
    return refuse(404, 'Not found');
  };
  const session = createSession({ baseUrl, signer, fetchImpl });
  await session.login();
  expect(await session.token()).toBe(renewed);
  expect(await session.token()).toBe(renewed);
  expect(seen).toEqual(['/auth/challenge', '/auth/login-signature', '/auth/refresh']);
});

describe('self-custody HTLC: Flow B, accept-counter and refund sign only what they read (CAN-2929)', () => {
  const HOUR = 3_600_000;
  const CC = { id: 'Amulet', admin: DEV.dso };
  const MALLORY = 'mallory::1220ff';
  type Leg = { kind: string; preparedTransaction: string; preparedTransactionHash: string };
  const asLegs = (legs: Leg[]) => legs.map((l, i) => ({ legId: `l${i}`, hash: l.preparedTransactionHash, kind: l.kind, preparedTransaction: l.preparedTransaction }));

  async function account(seed: number, legsFor: (party: string, type: string, params: Record<string, unknown>) => Promise<Leg[]>) {
    const signer = await providerFromMnemonic(PHRASE, { account: seed });
    const party = `party-me::${cantonFingerprint(signer.public_key)}`;
    const asked: Array<{ type: string; params: Record<string, unknown> }> = [];
    const api = stub({
      'GET /auth/me': () => ({ id: 'me', partyId: party }),
      'POST /wallet/operations/prepare': async (body) => {
        const { type, params } = body as { type: string; params: Record<string, unknown> };
        asked.push({ type, params });
        return { operationId: 'op1', legs: asLegs(await legsFor(party, type, params)), meta: { swapId: 's1' } };
      },
      'POST /wallet/operations/submit': () => ({ ok: true }),
      'POST /htlc/s1/refund': () => ({ id: 's1', status: 'htlc_refunded' }),
    });
    const acct = createSelfCustody({ baseUrl, signer, fetchImpl: api.fetchImpl, ...fast, maxFee: '0.5' });
    return { acct, api, party, asked };
  }

  const request = (party: string, over: Record<string, unknown> = {}) => ({
    party, receiver: 'party-taker::1220bb', amount: '10', instrument: CC, hashLock: HASH_LOCK, timeout: iso(Date.now() + 2 * HOUR),
    escrow: ESCROW, executor: EXECUTOR, fee: FEE_PARTY, maxFeeRate: '0.01', provider: null, description: '', ...over,
  });
  const deposit = (party: string, receiver = ESCROW) => factoryTransferLeg({
    party, receiver, instrument: CC, amount: '10', input: '25', offerContract: amuletInstruction,
    outputs: [{ owner: party, amount: '10', lockedTo: DEV.dso }, { owner: party, amount: '15' }],
  });
  const open = { tokenId: 'CC', amount: '10', receiver: 'party-taker::1220bb', hashLock: HASH_LOCK, timeoutHours: 2 };

  test('openHtlc reads both transactions, signs them, and never sends an encrypted preimage', async () => {
    const { acct, api, asked } = await account(61, async (party) => [await initRequestLeg(request(party)), await deposit(party)]);

    await expect(acct.openHtlc(open)).resolves.toMatchObject({ swapId: 's1' });

    expect(asked).toEqual([{ type: 'htlc.flow-b-create', params: { tokenId: 'CC', amount: 10, receiver: 'party-taker::1220bb', hashLock: HASH_LOCK, timeoutHours: 2 } }]);
    expect(JSON.stringify(asked)).not.toMatch(/encryptedPreimage/);
    expect(api.hits).toContain('POST /wallet/operations/submit');
  });

  test('openHtlc refuses a request to another receiver, or a deposit to another escrow, before signing', async () => {
    for (const legs of [
      async (party: string) => [await initRequestLeg(request(party, { receiver: MALLORY })), await deposit(party)],
      async (party: string) => [await initRequestLeg(request(party)), await deposit(party, MALLORY)],
    ]) {
      const { acct, api } = await account(62, legs);
      const error = await acct.openHtlc(open).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CeremonyError);
      expect((error as CeremonyError).cause).toBeInstanceOf(UnverifiedTransactionError);
      expect(api.hits).not.toContain('POST /wallet/operations/submit');
    }
  });

  const counter = (party: string, over: Record<string, unknown> = {}) => ({
    party, sender: 'party-taker::1220bb', amount: '5000', instrument: CC, hashLock: HASH_LOCK, timeout: iso(Date.now() + 2 * HOUR),
    escrow: ESCROW, executor: EXECUTOR, fee: FEE_PARTY, feeAmount: null, provider: null, description: '', ...over,
  });
  const expectation = { amount: '5000', tokenId: 'CC', hashLock: HASH_LOCK, minTimeout: Date.now() + HOUR };

  test('acceptCounter signs the accept that matches what the account expects', async () => {
    const { acct, api, asked } = await account(63, async (party) => [await acceptCounterLeg(counter(party))]);

    await acct.acceptCounter('s1', expectation);

    expect(asked).toEqual([{ type: 'htlc.accept-counter', params: { swapId: 's1' } }]);
    expect(api.hits).toContain('POST /wallet/operations/submit');
  });

  test('acceptCounter refuses a counter that times out inside the claim margin, before signing', async () => {
    const { acct, api } = await account(64, async (party) => [await acceptCounterLeg(counter(party, { timeout: iso(Date.now() + 10 * 60_000) }))]);

    const error = await acct.acceptCounter('s1', expectation).catch((e: unknown) => e);

    expect((error as CeremonyError).cause).toBeInstanceOf(UnverifiedTransactionError);
    expect(api.hits).not.toContain('POST /wallet/operations/submit');
  });

  test('refund asks the venue to refund the swap and signs nothing', async () => {
    const { acct, api } = await account(65, async () => []);

    await expect(acct.refund('s1')).resolves.toMatchObject({ id: 's1', status: 'htlc_refunded' });

    expect(api.signed()).toEqual([]);
  });
});
