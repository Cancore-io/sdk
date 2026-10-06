import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { deriveWalletKey, providerFromMnemonic } from '@cancore/wallet';
import { allocationTree, DEV, prepared, proposalAccept, proposalCreate, selfSendLeg, type FixtureLeg } from './dvp-prepared.fixture';
import type { FetchLike } from './http';
import {
  CeremonyError,
  createSelfCustody,
  grossAmount,
  legalConsentMessage,
  SettleError,
  type IncomingTransfer,
  type SelfCustodyOptions,
} from './selfcustody';
import { createSession, expiresWithin, type KeySigner } from './session';

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
  /** What `GET /tokens/transfer/estimate-fee` quotes. Default 0.125. */
  networkFee?: number;
  /** The fee amount the fee-holding refusal names. Default 24.8756218905. */
  refusedFee?: string;
  /** What `GET /htlc/fee-config` answers. */
  feeConfig?: Record<string, unknown>;
  /** The taker funds, the maker never does, and the trade expires: the venue's recovery then `released` the taker's allocations, or they are `stillLocked`. */
  takerFundedThenExpired?: 'released' | 'stillLocked';
  /** The API prepares something other than what the trade says, in this way, for the maker's allocation. */
  tamperMakerAllocation?: 'hash' | 'amount' | 'receiver';
  /** The trade's window closes before anybody funds: the venue marks the swap dvp_expired. */
  expireAfterTrade?: boolean;
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

const FEE_PARTY = 'cancore-fee::1220';
const VENUE = DEV.venue;
// The dev stand's instrument admins: pinned in the SDK, so the venue must name exactly these.
const ADMINS: Record<string, string> = { CC: DEV.dso, CBTC: DEV.cbtcRegistrar };

function venue({
  dvpForbidden = false,
  pairOff = false,
  feeHoldingRequired = false,
  refuseAt = {},
  feeConfig = { feeRate: '0.005', feeRecipient: FEE_PARTY, venue: VENUE, maxFeeRate: '0.01' },
  takerFundedThenExpired,
  tamperMakerAllocation,
  expireAfterTrade = false,
  staleAllocateOnce = false,
  timeoutAllocateOnce = false,
  coded = false,
  failSend = false,
  sendBytes,
  twoHoldings = false,
  accruedHoldingFee = 0,
  balance = 10000,
  networkFee = 0.125,
  refusedFee = '24.8756218905',
  feeDebt = '0',
  legacySignUp = false,
  failActivationOnce = false,
}: VenueOptions = {}) {
  const refusal = (status: number, prose: string, errorCode: string) =>
    coded ? refuse(status, 'refused', errorCode) : refuse(status, prose);
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
  const parties = (): string[] => [...new Set(legs.flatMap((l) => [l.sender, l.receiver]))];

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
    const asLeg = (t: typeof transfer): Leg => ({ legId: `leg-${++seq}`, hash: t.preparedTransactionHash, kind: t.kind, preparedTransaction: t.preparedTransaction });
    if (!twoHoldings) return [asLeg(transfer)];
    return [asLeg(transfer), mode === 'mixed' ? { ...asLeg(fee), preparedTransaction: undefined } : asLeg(fee)];
  }

  async function prepare(owner: Account, type: string, params: Record<string, unknown>): Promise<Response> {
    let legs: Leg[];
    let meta: Record<string, unknown> = {};
    asked.push(type);
    switch (type) {
      case 'wallet.topology': legs = [leg('topology', 34), leg('topology', 34)]; break;
      case 'tokens.preapproval': legs = owner.roles.includes('has-preapproval') ? [] : [leg('setup')]; meta = { alreadyExists: legs.length === 0 }; break;
      case 'tokens.consolidate': legs = []; break;
      case 'tokens.accept': legs = [leg('transfer')]; break;
      case 'tokens.send':
        if (failSend) return refuse(400, 'Insufficient holdings for the transfer');
        legs = sendBytes ? await selfSendLegs(owner.partyId!, String(params.amount), sendBytes) : twoHoldings ? [leg('transfer'), leg('fee')] : [leg('transfer')];
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
    switch (op.type) {
      case 'wallet.topology': caller.partyId = `party-${caller.id}`; break;
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
      { legId: 'leg-fee', role: 'fee', sender: taker, receiver: FEE_PARTY, tokenId: 'CC', amount: '24.8756218905', lockRef: null, status: 'active' },
    ];
    drafter = maker.partyId;
    swap = { id: 's1', status: 'dvp_proposed', sender: maker.partyId, receiver: taker, proposalContractId: null };
    order.swapId = 's1';
    order.status = 'swap_created';
    return json(swap, 201);
  }

  /** `GET /htlc/swaps/s1/full` — and, like the venue's watchers, it moves the trade on between reads. */
  function full(): Response {
    if (!swap) return refuse(404, 'Swap not found');
    // The fee party is ours: the venue approves for it, and it is never awaited.
    const awaiting = tradeCid ? [] : parties().filter((p) => p !== FEE_PARTY && !approvers.has(p));
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
      legs: legs.map(({ legId: _legId, ...l }) => l),
      dvp: { tradeCid, awaitingApprovalFrom: awaiting, allocateBefore: null, settleBefore: null },
      swapStatus: 'incomplete',
    });
  }

  /** `POST /canton-wallet/htlc/prepare-command`, with the refusals the three DvP step handlers raise. */
  async function prepareDvp(caller: Account, body: { operationType: string; params: { swapId?: string } }): Promise<Response> {
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
    if (route === 'GET /tokens/fee-debt') return json({ outstandingCc: feeDebt, entries: [] });
    if (route === `GET /tokens/balance/${caller.partyId}/CC`) {
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
      if (dvpForbidden) return forbidden();
      return json([
        { id: 'CC', symbol: 'CC', admin: ADMINS.CC },
        ...(pairOff ? [] : [{ id: 'CBTC', symbol: 'CBTC', admin: ADMINS.CBTC }]),
      ]);
    }
    if (route === 'GET /htlc/fee-config') return json(feeConfig);
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

  return { fetchImpl, log, asked, proposals, routes, order, incoming, byKey, signUps, htlcOpenedEarlier, legs: () => legs, takes: () => takes };
}

// The dev API host: its network (devnet) chooses the pinned instrument admins.
const baseUrl = 'https://api-dev.cancore.app';
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
  expect(taken).toMatchObject({ swap: { id: 's1', status: 'dvp_settled' }, delivery: 'direct', flow: 'dvp' });
  // The maker recorded the trade once, asking for DvP, with a request the proposal DTO accepts.
  expect(api.proposals).toEqual([expect.objectContaining({
    orderId: 'o1', dvp: true, tokenId: 'CBTC', amount: 0.01, receiver: 'party-taker', timeoutHours: 1,
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
  await Promise.all([maker.onboard(), taker.onboard()]);
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
    expect((error as Error).message).toMatch(/platform fee \(24.8756218905\) needs a holding of its own, and party-taker \(the taker\) keeps its CC in a single holding.*splits that balance/);
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

  test('a fee paid to another party than the one the account pinned is refused', async () => {
    const api = venue({ feeConfig: { feeRate: '0.005', feeRecipient: 'someone-else::1220', venue: VENUE } });
    const { maker, taker } = await tradingPair(api, [62, 63], { feeRecipientPartyId: FEE_PARTY });
    await taker.swap.accept('o1');
    await expect(maker.make('o1')).rejects.toThrow(/pays the platform fee to someone-else::1220, not to this account's feeRecipientPartyId/);
    expect(api.proposals).toEqual([]);
  });

  test.each([
    ['by the text of the message', false, [64, 65]],
    ['by errorCode alone', true, [66, 67]],
  ] as const)('a taker refused at take for want of a fee holding is told to split its own balance (%s)', async (_, coded, accounts) => {
    const api = venue({ refuseAt: { accept: 'feeHolding' }, coded });
    const { taker } = await tradingPair(api, [...accounts]);
    const error = await taker.take('o1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettleError);
    expect((error as Error).message).toMatch(/^taking order o1: the platform fee \(24.8756218905\) needs a holding of its own, and this account keeps its CC in a single holding.*splitForFee\(tokenId, '24.8756218905'\).*then take\(\) again/);
    // autoSplitForFee is off by default: nothing is sent.
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
    expect(selfSends(api)).toEqual([{ type: 'tokens.send', params: { receiverPartyId: 'party-taker', amount: '24.8756218905' } }]);
    expect(api.order.opponent).toEqual({ partyId: 'party-taker' });
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
    const error = await taker.take('o1').catch((e: unknown) => e);
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
    const error = await taker.take('o1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettleError);
    expect((error as Error).message).toMatch(/\(counter, fee\) are still locked after the venue's recovery \(abort refused\).*cannot withdraw.*contact Cancore support with the swap id s1/);
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
  const ti = (contractId: string) => ({ contractId, templateId: 't', instrumentAdmin: 'a', executeBefore: new Date(Date.now() + 60_000).toISOString() });
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/auth/challenge') return json({ challenge: 'Welcome to Cancore 2026-09-28 sig:1' });
    if (path === '/auth/login-signature') return json({ token: jwt('a'), user: {} });
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
      return json({ operationId: 'op', legs: [{ legId: 'l', hash: b64(new Uint8Array(32)), kind: 'transfer' }], meta: null });
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
    const out = handler(init.body ? JSON.parse(String(init.body)) : {});
    return out instanceof Response ? out : json(out);
  };
  return { fetchImpl, hits, signed: () => hits.filter((r) => r.startsWith('POST /wallet/operations')) };
}

const takenOrder = (over: Record<string, unknown> = {}) => ({
  id: 'o1', status: 'accepted', sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceAmount: '0.01',
  targetNetwork: 'canton', targetTokenAddress: 'CC', targetAmount: '5000', initiatorUserId: 'maker',
  opponentUserId: 'me', opponent: { partyId: 'party-taker' }, swapId: null, dvp: true, ...over,
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
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast });
    const error = await acct.send({ receiverPartyId: 'p', amount: 'lots' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CeremonyError);
    expect(error).toMatchObject({ operation: 'tokens.send', stage: 'prepare', meta: null });
    expect((error as CeremonyError).errorCode).toBeUndefined();
    expect(api.hits).not.toContain('POST /wallet/operations/submit');
  });

  test('a coded refusal carries its errorCode on the CeremonyError, for the caller to branch on', async () => {
    const api = stub({ 'POST /wallet/operations/prepare': () => refuse(503, 'hosting unknown', 'PARTY_HOSTING_UNKNOWN') });
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast });
    const error = await acct.send({ receiverPartyId: 'p', amount: '1' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CeremonyError);
    expect(error).toMatchObject({ stage: 'prepare', errorCode: 'PARTY_HOSTING_UNKNOWN', cause: { errorCode: 'PARTY_HOSTING_UNKNOWN' } });
  });
});

test('acceptIncoming skips what expired and what the filter drops, and one refusal does not stop the rest', async () => {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const ti = (contractId: string, executeBefore: string, instrumentId = 'USDCx') =>
    ({ contractId, templateId: 't', instrumentAdmin: 'admin', instrumentId, executeBefore });
  const prepared: string[] = [];
  const api = stub({
    'GET /tokens/transfer-requests/incoming': () => [
      ti('expired', at(-60_000)), ti('refused', at(60_000)), ti('fine', at(60_000)), ti('dust', at(60_000), 'SPAM'),
    ],
    'POST /wallet/operations/prepare': (body) => {
      const cid = String((body.params as Record<string, unknown>).instructionCid);
      prepared.push(cid);
      return cid === 'refused'
        ? refuse(400, 'registry context unavailable')
        : { operationId: `op-${cid}`, legs: [{ legId: 'l', hash: b64(new Uint8Array(32)), kind: 'transfer' }], meta: null };
    },
    'POST /wallet/operations/submit': () => ({ outcome: 'committed' }),
  });
  const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast });
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
