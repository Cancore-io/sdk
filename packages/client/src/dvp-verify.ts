/**
 * Check a prepared DvP transaction before the account's key signs it.
 *
 * The signature covers Canton's hash of the prepared transaction, so a hash the
 * client cannot tie to a transaction it has read is a blank cheque. For every
 * transaction of a DvP step this:
 *
 *  1. recomputes the hash from the transaction bytes (Canton's hashing scheme
 *     v2) and refuses on any difference from the hash it was asked to sign;
 *  2. decodes the transaction and holds it against the trade the account agreed
 *     to — the order's amounts and instruments, the two parties, the venue as
 *     executor, the platform fee within the published rate — and refuses
 *     anything else, including a transaction it cannot read.
 *
 * Nothing here trusts the swap row the API serves: the expectation is built
 * from the order, the instrument list and the fee configuration, and from the
 * account's own party.
 */
import { decodePreparedTransaction, hashPreparedTransaction } from '@canton-network/core-tx-visualizer';
import type { DamlTransaction_Node, PreparedTransaction, Value } from '@canton-network/core-ledger-proto';

export type DvpOperation = 'dvpCreateProposal' | 'dvpAcceptProposal' | 'dvpAllocateLeg';

export interface Instrument {
  id: string;
  admin: string;
}

/** The trade as the account agreed to it. Amounts are decimal strings. */
export interface DvpTerms {
  swapId: string;
  /** The account signing. */
  party: string;
  maker: string;
  taker: string;
  /** What the maker sends: the order's source token and amount. */
  source: Instrument & { amount: string };
  /** What the taker sends: the order's target token and amount, the platform fee included. */
  target: Instrument & { amount: string };
  /** Settlement executor the allocations hand control to. */
  venue: string;
  /** Platform fee receiver and rate; no fee leg is accepted when the receiver is null. */
  feeParty: string | null;
  feeRate: string;
}

export interface PreparedToSign {
  preparedTransactionHash: string;
  preparedTransaction?: string;
}

/** A prepared transaction the account refuses to sign, with the reason. */
export class UnverifiedTransactionError extends Error {
  constructor(operation: DvpOperation, reason: string) {
    super(`refusing to sign ${operation}: ${reason}`);
    this.name = 'UnverifiedTransactionError';
  }
}

/** Verify every transaction of one DvP step; throws UnverifiedTransactionError on the first that does not hold. */
export async function verifyDvpPrepared(operation: DvpOperation, prepared: PreparedToSign[], terms: DvpTerms): Promise<void> {
  const refuse = (reason: string): never => {
    throw new UnverifiedTransactionError(operation, reason);
  };
  if (prepared.length === 0) refuse('the API prepared nothing to sign');
  if (operation !== 'dvpAllocateLeg' && prepared.length > 1) refuse(`expected one transaction, got ${prepared.length}`);
  const funded: TransferLeg[] = [];
  for (const [index, tx] of prepared.entries()) {
    if (!tx.preparedTransaction) refuse(`transaction ${index} came without its bytes, so its hash cannot be checked`);
    let recomputed: string;
    let decoded: PreparedTransaction;
    try {
      decoded = decodePreparedTransaction(tx.preparedTransaction!);
      recomputed = await hashPreparedTransaction(tx.preparedTransaction!, 'base64');
    } catch (err) {
      return refuse(`transaction ${index} cannot be read (${err instanceof Error ? err.message : String(err)})`);
    }
    if (recomputed !== tx.preparedTransactionHash) refuse(`transaction ${index} does not hash to the hash it came with`);
    const actAs = decoded.metadata?.submitterInfo?.actAs ?? [];
    if (actAs.length !== 1 || actAs[0] !== terms.party) refuse(`transaction ${index} acts as ${actAs.join(', ') || 'nobody'}, not as this account`);
    const reason = checkTransaction(operation, decoded, terms, funded);
    if (reason) refuse(`transaction ${index}: ${reason}`);
  }
  // The taker funds its leg and the fee in one step: together they are exactly what the order says it sends.
  const counter = funded.find((l) => l.receiver === terms.maker);
  const fee = funded.find((l) => l.receiver === terms.feeParty);
  if (counter && fee && units(counter.amount) + units(fee.amount) !== units(terms.target.amount)) {
    refuse(`the leg and the fee add up to ${counter.amount} + ${fee.amount}, not the order's ${terms.target.amount}`);
  }
}

interface TransferLeg {
  sender: string;
  receiver: string;
  amount: string;
  instrumentId: { admin: string; id: string };
}

type Nodes = Map<string, DamlTransaction_Node>;

function checkTransaction(operation: DvpOperation, decoded: PreparedTransaction, terms: DvpTerms, funded: TransferLeg[]): string | null {
  const transaction = decoded.transaction;
  if (!transaction || transaction.roots.length !== 1) return 'expected a transaction with exactly one command';
  const nodes: Nodes = new Map(transaction.nodes.map((n) => [n.nodeId, n]));
  const root = nodeType(nodes.get(transaction.roots[0]!));
  switch (operation) {
    case 'dvpCreateProposal': {
      if (root?.oneofKind !== 'create' || !isProposal(root.create.templateId)) return 'it is not the creation of a swap proposal';
      return checkProposal(plain(root.create.argument), terms, [terms.party]);
    }
    case 'dvpAcceptProposal': {
      if (root?.oneofKind !== 'exercise' || !isProposal(root.exercise.templateId) || root.exercise.choiceId !== 'SwapProposal_Accept') {
        return 'it is not an approval of a swap proposal';
      }
      if (root.exercise.actingParties.join() !== terms.party) return 'the approval is not this account’s';
      if (!sameRecord(plain(root.exercise.chosenValue), { approver: terms.party })) return 'the approval names another approver';
      // Accept recreates the proposal: the terms approved are the ones the new proposal carries.
      const recreated = [...nodes.values()].map(nodeType).filter((t) => t?.oneofKind === 'create' && isProposal(t.create.templateId));
      if (recreated.length !== 1 || recreated[0]?.oneofKind !== 'create') return 'it does not carry the proposal it approves';
      const approvers = (plain(recreated[0].create.argument) as { approvers?: unknown })?.approvers;
      if (!Array.isArray(approvers) || !approvers.includes(terms.party)) return 'the recreated proposal does not record this approval';
      return checkProposal(plain(recreated[0].create.argument), terms, approvers as string[]);
    }
    case 'dvpAllocateLeg': {
      if (root?.oneofKind !== 'exercise' || root.exercise.choiceId !== 'AllocationFactory_Allocate' || root.exercise.interfaceId?.entityName !== 'AllocationFactory') {
        return 'it is not a token-standard allocation';
      }
      const arg = plain(root.exercise.chosenValue) as {
        expectedAdmin?: unknown;
        allocation?: { settlement?: { executor?: unknown; settlementRef?: { id?: unknown } }; transferLeg?: unknown };
      };
      const settlement = arg.allocation?.settlement;
      if (settlement?.executor !== terms.venue) return `the allocation hands settlement to ${String(settlement?.executor)}, not to the venue`;
      if (settlement?.settlementRef?.id !== terms.swapId) return 'the allocation is for another trade';
      const leg = arg.allocation?.transferLeg as TransferLeg | undefined;
      const wrong = checkLeg(leg, terms);
      if (wrong) return wrong;
      if (leg!.sender !== terms.party) return 'the allocation spends another party’s holdings';
      if (arg.expectedAdmin !== leg!.instrumentId.admin) return 'the allocation names another instrument admin';
      if (funded.some((l) => l.receiver === leg!.receiver)) return 'the same leg is funded twice';
      funded.push(leg!);
      return null;
    }
  }
}

function checkProposal(arg: unknown, terms: DvpTerms, approvers: string[]): string | null {
  const proposal = arg as { venue?: unknown; swapId?: unknown; approvers?: unknown; transferLegs?: Record<string, TransferLeg> };
  if (proposal?.venue !== terms.venue) return `the proposal names ${String(proposal?.venue)} as venue`;
  if (proposal.swapId !== terms.swapId) return 'the proposal is for another trade';
  if (!Array.isArray(proposal.approvers) || proposal.approvers.join() !== approvers.join()) return 'the proposal carries approvals this account did not give';
  const legs = Object.values(proposal.transferLegs ?? {});
  for (const leg of legs) {
    const wrong = checkLeg(leg, terms);
    if (wrong) return wrong;
  }
  const to = (receiver: string | null) => legs.filter((l) => l.receiver === receiver);
  const [main, counter, fee] = [to(terms.taker), to(terms.maker), terms.feeParty ? to(terms.feeParty) : []];
  if (main.length !== 1 || counter.length !== 1 || fee.length > 1 || legs.length !== 2 + fee.length) {
    return 'the proposal does not carry exactly the order’s two legs and at most one fee leg';
  }
  const sent = units(counter[0]!.amount) + (fee[0] ? units(fee[0].amount) : 0n);
  if (sent !== units(terms.target.amount)) return `the taker's legs add up to more or less than the order's ${terms.target.amount}`;
  return null;
}

/** One leg of the trade, by who it is from and to: the order's main leg, the counter leg, or the platform fee. */
function checkLeg(leg: TransferLeg | undefined, terms: DvpTerms): string | null {
  if (!leg?.instrumentId) return 'a leg cannot be read';
  const is = (i: Instrument) => leg.instrumentId.id === i.id && leg.instrumentId.admin === i.admin;
  const amount = units(leg.amount);
  if (amount < 0n) return `a leg amount (${String(leg.amount)}) cannot be read`;
  const target = units(terms.target.amount);
  const maxFee = ceilDiv(target * units(terms.feeRate), ONE);
  if (leg.sender === terms.maker && leg.receiver === terms.taker) {
    return is(terms.source) && amount === units(terms.source.amount) ? null : `the maker's leg is not the order's ${terms.source.amount} ${terms.source.id}`;
  }
  if (leg.sender === terms.taker && leg.receiver === terms.maker) {
    return is(terms.target) && amount <= target && amount >= target - maxFee ? null : `the taker's leg is not the order's ${terms.target.amount} ${terms.target.id} less the fee`;
  }
  if (terms.feeParty && leg.sender === terms.taker && leg.receiver === terms.feeParty) {
    return is(terms.target) && amount <= maxFee ? null : `the fee leg is above the published rate ${terms.feeRate}`;
  }
  return `a leg from ${leg.sender} to ${leg.receiver} is not part of this trade`;
}

const isProposal = (id: { moduleName: string; entityName: string } | undefined) => id?.moduleName === 'Swap.Trade' && id.entityName === 'SwapProposal';

function nodeType(node: DamlTransaction_Node | undefined) {
  return node?.versionedNode.oneofKind === 'v1' ? node.versionedNode.v1.nodeType : undefined;
}

function sameRecord(a: unknown, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A Daml value as plain JSON: records by label, numbers and parties as strings, None as null. */
function plain(value: Value | undefined): unknown {
  if (!value) return null;
  const sum = value.sum;
  switch (sum.oneofKind) {
    case 'record':
      return Object.fromEntries(sum.record.fields.map((f, i) => [f.label || `#${i}`, plain(f.value)]));
    case 'textMap':
      return Object.fromEntries(sum.textMap.entries.map((e) => [e.key, plain(e.value)]));
    case 'list':
      return sum.list.elements.map(plain);
    case 'optional':
      return sum.optional.value ? plain(sum.optional.value) : null;
    case 'variant':
      return { tag: sum.variant.constructor, value: plain(sum.variant.value) };
    case 'genMap':
      return sum.genMap.entries.map((e) => [plain(e.key), plain(e.value)]);
    case 'enum':
      return sum.enum.constructor;
    case 'party':
      return sum.party;
    case 'numeric':
      return sum.numeric;
    case 'text':
      return sum.text;
    case 'contractId':
      return sum.contractId;
    case 'int64':
    case 'timestamp':
      return String(sum.oneofKind === 'int64' ? sum.int64 : sum.timestamp);
    case 'date':
      return sum.date;
    case 'bool':
      return sum.bool;
    case 'unit':
      return {};
    default:
      throw new Error(`a value of an unknown kind (${String(sum.oneofKind)})`);
  }
}

const ONE = 10n ** 10n;

/** A decimal string in exact 1e-10 units (Daml Numeric 10). */
export function units(decimal: unknown): bigint {
  const text = String(decimal).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return -1n;
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * ONE + BigInt((fraction + '0000000000').slice(0, 10));
}

const ceilDiv = (a: bigint, b: bigint) => a / b + (a % b === 0n ? 0n : 1n);
