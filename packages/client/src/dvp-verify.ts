/**
 * Check a prepared DvP transaction before the account's key signs it.
 *
 * The signature covers Canton's hash of the prepared transaction, so a hash the
 * client cannot tie to a transaction it has read is a blank cheque. For every
 * transaction of a DvP step this:
 *
 *  1. recomputes the hash from the transaction bytes (Canton's hashing scheme
 *     v2) and refuses on any difference from the hash it was asked to sign;
 *  2. walks the WHOLE transaction tree, not just its root: every node must come
 *     from a trusted package and be one the step is made of, and in an
 *     allocation no node may create a holding for anyone but the signer or spend
 *     more of the signer's holdings than the leg locks;
 *  3. holds the command against the trade the account agreed to — the order's
 *     amounts and instruments, the two parties, the venue as executor, the
 *     platform fee within the published rate — and refuses anything else,
 *     including a transaction it cannot read.
 *
 * Nothing here trusts the swap row the API serves: the expectation is built
 * from the order, the instrument list and the fee configuration, and from the
 * account's own party.
 */
import { decodePreparedTransaction, hashPreparedTransaction } from '@canton-network/core-tx-visualizer';
import type { DamlTransaction_Node, PreparedTransaction, Value } from '@canton-network/core-ledger-proto';
import { instrumentKey } from './dvp-admins';

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
  /** The Daml packages (name and id) a node of the transaction may come from. */
  packages: TrustedPackages;
  /** The clock, and how far ahead a proposal or allocation deadline may lie: a later one keeps funds locked longer. */
  now: number;
  maxWindowMs: number;
}

/**
 * The proposal steps' Daml package, by name and the package ids allowed: `cancore-swap` is ours,
 * and a package name alone is not an identity (anyone can upload a package under any name), so a
 * node passes only when both its name and its id are listed.
 *
 * Allocations are not pinned by package: the registries (the DSO for CC, the Digital Asset utility
 * for registry tokens) upgrade their packages on their own schedule. Their trust anchor is the
 * instrument admin instead — see `dvp-admins.ts`.
 */
export interface TrustedPackages {
  swap: Record<string, string[]>;
}

export const DEFAULT_TRUSTED_PACKAGES: TrustedPackages = {
  swap: {
    'cancore-swap': [
      '06a6e3f1f5d9dfcdc885d72248b26decdde09c7f99bc4a8af385624a30be2544', // 1.0.0
      '2b8060d64191b963d7416e0e2d15d11b239f88ad31aca2f457c4eefa2e15e395', // 1.1.0
      '0164b8f54b26b673b24ba7ca6d141b65bd4dbc8c135cd61922477c871c927a2a', // 1.2.0
    ],
  },
};

/**
 * The token-standard allocation factory interface, by package id: the standard's API packages are
 * published once and are the same on every network, so this is pinned outright.
 */
export const ALLOCATION_FACTORY_INTERFACE = {
  packageId: '275064aacfe99cea72ee0c80563936129563776f67415ef9f13e4297eecbc520',
  moduleName: 'Splice.Api.Token.AllocationInstructionV1',
  entityName: 'AllocationFactory',
};

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
  if ([terms.source.amount, terms.target.amount, terms.feeRate].some((d) => units(d) < 0n)) {
    refuse('the order’s amounts or the fee rate are not decimals of at most ten places');
  }
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
  const shape = checkTree(operation, decoded, nodes, terms);
  if (shape) return shape;
  const root = nodeType(nodes.get(transaction.roots[0]!));
  switch (operation) {
    case 'dvpCreateProposal': {
      if (root?.oneofKind !== 'create' || !isProposal(root.create.templateId)) return 'it is not the creation of a swap proposal';
      return checkProposal(root.create.argument, terms, [terms.party]);
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
      return checkProposal(recreated[0].create.argument, terms, approvers as string[]);
    }
    case 'dvpAllocateLeg': {
      if (root?.oneofKind !== 'exercise' || root.exercise.choiceId !== 'AllocationFactory_Allocate' || !sameId(root.exercise.interfaceId, ALLOCATION_FACTORY_INTERFACE)) {
        return 'it is not a token-standard allocation';
      }
      const arg = plain(root.exercise.chosenValue) as {
        expectedAdmin?: unknown;
        allocation?: { settlement?: { executor?: unknown; settlementRef?: { id?: unknown } }; transferLeg?: unknown };
      };
      const settlement = arg.allocation?.settlement;
      const late = lateDeadline(fieldsOf(fieldsOf(fieldsOf(root.exercise.chosenValue)?.get('allocation'))?.get('settlement')), ['requestedAt', 'allocateBefore', 'settleBefore'], terms);
      if (late) return late;
      if (settlement?.executor !== terms.venue) return `the allocation hands settlement to ${String(settlement?.executor)}, not to the venue`;
      if (settlement?.settlementRef?.id !== terms.swapId) return 'the allocation is for another trade';
      const leg = arg.allocation?.transferLeg as TransferLeg | undefined;
      const wrong = checkLeg(leg, terms);
      if (wrong) return wrong;
      if (leg!.sender !== terms.party) return 'the allocation spends another party’s holdings';
      if (arg.expectedAdmin !== leg!.instrumentId.admin) return 'the allocation names another instrument admin';
      if (funded.some((l) => l.receiver === leg!.receiver)) return 'the same leg is funded twice';
      // The factory the choice runs on is the registry's own: disclosed with the transaction, of the very
      // template the command exercises, and SIGNED by the instrument admin. Nobody else can create such a
      // contract, so the code the whole tree runs is the code the admin deployed.
      const factory = inputContracts(decoded).get(root.exercise.contractId);
      if (!factory) return 'the allocation factory is not among the contracts the transaction discloses';
      // Under Daml upgrades the command may run a newer version of the factory's package than the one the
      // factory was created with: the package NAME, module and entity must match, the id may differ.
      if (!sameTemplate(factory, root.exercise)) return 'the command runs on another template than the factory it names';
      // The leg's admin is the pinned one (checkLeg holds it to the instruments, which the caller pinned).
      if (!factory.signatories.includes(leg!.instrumentId.admin)) return 'the allocation factory is not signed by the instrument admin';
      const holdings = checkHoldings(decoded, nodes, terms, leg!, factory, root.exercise.contractId);
      if (holdings) return holdings;
      funded.push(leg!);
      return null;
    }
  }
}

/**
 * The tree as a whole: every node reachable from the one root and nothing else, no rollback,
 * and every node from a package the step may run. The proposal steps are fixed shapes — the
 * create is one node; the approval exercises the proposal and recreates it, two nodes.
 */
function checkTree(operation: DvpOperation, decoded: PreparedTransaction, nodes: Nodes, terms: DvpTerms): string | null {
  const reachable = new Set<string>();
  const visit = (id: string): string | null => {
    if (reachable.has(id)) return `node ${id} is reached twice`;
    const type = nodeType(nodes.get(id));
    if (!type) return `node ${id} cannot be read`;
    reachable.add(id);
    if (type.oneofKind === 'rollback') return 'it carries a rolled-back subtree';
    if (type.oneofKind === 'exercise') for (const child of type.exercise.children) {
      const wrong = visit(child);
      if (wrong) return wrong;
    }
    return null;
  };
  const wrong = visit(decoded.transaction!.roots[0]!);
  if (wrong) return wrong;
  if (reachable.size !== nodes.size) return 'it carries nodes outside its command';
  for (const node of nodes.values()) {
    const type = nodeType(node)!;
    if (type.oneofKind !== 'create' && type.oneofKind !== 'exercise' && type.oneofKind !== 'fetch') return `node ${node.nodeId} is of an unexpected kind`;
    // An allocation's nodes all hang from the one exercise on the admin-signed factory (checked above:
    // every node is reachable from the root), so they run the admin's code; the proposal steps run ours.
    if (operation === 'dvpAllocateLeg') continue;
    const { packageName, templateId } = type.oneofKind === 'create' ? type.create : type.oneofKind === 'exercise' ? type.exercise : type.fetch;
    if (!trusted(terms.packages.swap, packageName, templateId?.packageId)) {
      return `node ${node.nodeId} runs code from an untrusted package (${packageName || 'unnamed'} ${templateId?.packageId ?? ''})`;
    }
  }
  if (operation === 'dvpCreateProposal' && nodes.size !== 1) return 'the proposal is not created on its own';
  if (operation === 'dvpAcceptProposal') {
    const kinds = [...nodes.values()].map((n) => nodeType(n)!);
    const [root, child] = [nodeType(nodes.get(decoded.transaction!.roots[0]!)), kinds.find((k) => k.oneofKind === 'create')];
    if (nodes.size !== 2 || root?.oneofKind !== 'exercise' || !root.exercise.consuming || child?.oneofKind !== 'create' || !root.exercise.children.length) {
      return 'the approval does more than consume the proposal and recreate it';
    }
  }
  return null;
}

/**
 * What an allocation does to holdings and to whom. A holding here is any contract with an `owner`
 * Party and an amount (`amount`, or Amulet's `amount.initialAmount`), at the top of its argument
 * or one record down (a locked Amulet keeps its Amulet inside); it is locked when that record or
 * the one holding it carries a `lock`. In the whole tree:
 *  - every holding created is the signer's: nothing leaves the account;
 *  - what is created locked is at most the leg's amount: no second lock rides along;
 *  - every holding consumed is the signer's, and one the transaction discloses or creates;
 *  - per instrument, what is consumed and not recreated is at most what the leg locks;
 *  - no party appears in any created contract or any choice argument but the signer, the venue,
 *    the leg's receiver and the registry's own parties (the factory's signatories and
 *    stakeholders): a transfer, lock or instruction for anyone else is refused;
 *  - the signer's authority goes no further than this allocation: a contract the signer signs is
 *    either its own holding or the allocation record of exactly this leg, and a choice the signer
 *    acts in is the factory's own, one on its own holding, or one on a contract the instrument
 *    admin signed. Anything else — a proxy the signer signs and someone else controls, a choice on
 *    a stranger's contract — would be authority lasting beyond this transaction, and is refused.
 */
function checkHoldings(decoded: PreparedTransaction, nodes: Nodes, terms: DvpTerms, leg: TransferLeg, factory: Create, factoryCid: string): string | null {
  const party = terms.party;
  const inputs = inputContracts(decoded);
  const allowedParties = new Set([party, terms.venue, leg.receiver, leg.instrumentId.admin, ...factory.signatories, ...factory.stakeholders]);
  const created = new Map<string, Create>();
  const net = new Map<string, bigint>();
  const add = (key: string, amount: bigint) => net.set(key, (net.get(key) ?? 0n) + amount);
  const locked = new Map<string, bigint>();
  for (const node of nodes.values()) {
    const type = nodeType(node)!;
    if (type.oneofKind === 'create') created.set(type.create.contractId, type.create);
  }
  for (const node of nodes.values()) {
    const type = nodeType(node)!;
    const values = type.oneofKind === 'create' ? [type.create.argument] : type.oneofKind === 'exercise' ? [type.exercise.chosenValue] : [];
    const parties = [...(type.oneofKind === 'exercise' ? type.exercise.actingParties : []), ...values.flatMap((v) => [...partiesIn(v)])];
    const stranger = parties.find((p) => !allowedParties.has(p));
    if (stranger) return `node ${node.nodeId} involves ${stranger}, who is not part of this allocation`;
    if (type.oneofKind === 'exercise' && type.exercise.actingParties.includes(party)) {
      const wrong = signerActs(type.exercise.contractId, inputs, created, party, leg.instrumentId.admin, factoryCid);
      if (wrong) return `node ${node.nodeId}: ${wrong}`;
    }
    if (type.oneofKind !== 'create') continue;
    const holding = holdingOf(type.create);
    if (type.create.signatories.includes(party) && !(holding?.owner === party) && !isThisAllocation(type.create, terms, leg)) {
      return `node ${node.nodeId} creates a ${type.create.templateId?.entityName ?? 'contract'} signed by this account that is neither its holding nor this allocation`;
    }
    if (!holding) continue;
    if (holding.owner !== party) return `it creates a holding owned by ${holding.owner}`;
    add(holding.instrument, -holding.amount);
    if (holding.locked) locked.set(holding.instrument, (locked.get(holding.instrument) ?? 0n) + holding.amount);
  }
  const legKey = instrumentKey(leg.instrumentId.id);
  for (const [instrument, amount] of locked) {
    if (amount > (instrument === legKey ? units(leg.amount) : 0n)) return `it locks more ${instrument} than the leg's ${leg.amount}`;
  }
  for (const node of nodes.values()) {
    const type = nodeType(node)!;
    if (type.oneofKind !== 'exercise' || !type.exercise.consuming) continue;
    const target = inputs.get(type.exercise.contractId) ?? created.get(type.exercise.contractId);
    if (!target) return `it consumes contract ${type.exercise.contractId.slice(0, 16)}… without disclosing what it is`;
    const holding = holdingOf(target);
    if (!holding) continue;
    if (holding.owner !== party) return `it spends a holding owned by ${holding.owner}`;
    add(holding.instrument, holding.amount);
  }
  for (const [instrument, spent] of net) {
    const allowance = instrument === legKey ? units(leg.amount) : 0n;
    if (spent > allowance) return `it spends more ${instrument} than the leg locks`;
  }
  return null;
}

type Create = Extract<NonNullable<ReturnType<typeof nodeType>>, { oneofKind: 'create' }>['create'];

/** Why the signer may not act in a choice on this contract, or null when it may. */
function signerActs(cid: string, inputs: Map<string, Create>, created: Map<string, Create>, party: string, admin: string, factoryCid: string): string | null {
  if (cid === factoryCid) return null;
  const target = inputs.get(cid) ?? created.get(cid);
  if (!target) return 'this account acts on a contract the transaction does not disclose';
  if (holdingOf(target)?.owner === party) return null;
  if (target.signatories.includes(admin)) return null;
  return `this account acts on a ${target.templateId?.entityName ?? 'contract'} that is neither its holding nor the instrument admin's`;
}

/** The allocation record of exactly the verified leg: executor, trade and leg as checked at the root. */
function isThisAllocation(contract: Create, terms: DvpTerms, leg: TransferLeg): boolean {
  let arg: unknown;
  try {
    arg = plain(contract.argument);
  } catch {
    return false;
  }
  const spec = (arg as { allocation?: { settlement?: { executor?: unknown; settlementRef?: { id?: unknown } }; transferLeg?: TransferLeg } })?.allocation;
  const l = spec?.transferLeg;
  return spec?.settlement?.executor === terms.venue && spec.settlement.settlementRef?.id === terms.swapId &&
    !!l && l.sender === leg.sender && l.receiver === leg.receiver && units(l.amount) === units(leg.amount) &&
    l.instrumentId?.id === leg.instrumentId.id && l.instrumentId.admin === leg.instrumentId.admin;
}

function inputContracts(decoded: PreparedTransaction): Map<string, Create> {
  const out = new Map<string, Create>();
  for (const input of decoded.metadata?.inputContracts ?? []) {
    if (input.contract.oneofKind === 'v1') out.set(input.contract.v1.contractId, input.contract.v1);
  }
  return out;
}

/** A record's fields by label, or null when the value is not a record. */
function fieldsOf(value: Value | undefined): Map<string, Value> | null {
  if (value?.sum.oneofKind !== 'record') return null;
  return new Map(value.sum.record.fields.flatMap((f) => (f.value ? [[f.label, f.value] as const] : [])));
}

const textOf = (value: Value | undefined) => (value?.sum.oneofKind === 'text' ? value.sum.text : undefined);
const numericOf = (value: Value | undefined) => (value?.sum.oneofKind === 'numeric' ? value.sum.numeric : undefined);

/** The holding a contract is, if it is one: owner, instrument and amount in 1e-10 units. Read from typed values: `owner` must be a Party. */
function holdingOf(contract: Create): { owner: string; instrument: string; amount: bigint; locked: boolean } | null {
  const top = fieldsOf(contract.argument);
  if (!top) return null;
  const isSome = (value: Value | undefined) => value !== undefined && !(value.sum.oneofKind === 'optional' && !value.sum.optional.value);
  const candidates = [top, ...[...top.values()].map(fieldsOf).filter((f): f is Map<string, Value> => f !== null)];
  for (const record of candidates) {
    const owner = record.get('owner');
    if (owner?.sum.oneofKind !== 'party') continue;
    const raw = record.get('amount');
    const amount = units(numericOf(raw) ?? numericOf(fieldsOf(raw)?.get('initialAmount')));
    if (amount < 0n) continue;
    const named = textOf(fieldsOf(record.get('instrument') ?? record.get('instrumentId'))?.get('id'));
    const instrument = named ?? (/Amulet/.test(contract.templateId?.entityName ?? '') ? 'Amulet' : `${contract.packageName}:${contract.templateId?.entityName}`);
    return { owner: owner.sum.party, instrument: instrumentKey(instrument), amount, locked: isSome(record.get('lock')) || isSome(top.get('lock')) };
  }
  return null;
}


/** Same template across Daml upgrades: package name, module and entity; the package id may be a newer version. */
const sameTemplate = (contract: Create, exercise: { packageName: string; templateId?: { moduleName: string; entityName: string } }) =>
  contract.packageName === exercise.packageName && !!contract.templateId && !!exercise.templateId &&
  contract.templateId.moduleName === exercise.templateId.moduleName && contract.templateId.entityName === exercise.templateId.entityName;

const sameId = (a: { packageId: string; moduleName: string; entityName: string } | undefined, b: { packageId: string; moduleName: string; entityName: string } | undefined) =>
  !!a && !!b && a.packageId === b.packageId && a.moduleName === b.moduleName && a.entityName === b.entityName;

/** A node's package is trusted only by name AND id. */
const trusted = (allowed: Record<string, string[]>, packageName: string, packageId: string | undefined) =>
  !!packageId && (allowed[packageName] ?? []).includes(packageId);

/** Every Party value inside a Daml value. */
function partiesIn(value: Value | undefined, found = new Set<string>()): Set<string> {
  const sum = value?.sum;
  if (!sum) return found;
  if (sum.oneofKind === 'party') found.add(sum.party);
  else if (sum.oneofKind === 'record') sum.record.fields.forEach((f) => partiesIn(f.value, found));
  else if (sum.oneofKind === 'list') sum.list.elements.forEach((e) => partiesIn(e, found));
  else if (sum.oneofKind === 'optional') partiesIn(sum.optional.value, found);
  else if (sum.oneofKind === 'textMap') sum.textMap.entries.forEach((e) => partiesIn(e.value, found));
  else if (sum.oneofKind === 'genMap') sum.genMap.entries.forEach((e) => (partiesIn(e.key, found), partiesIn(e.value, found)));
  else if (sum.oneofKind === 'variant') partiesIn(sum.variant.value, found);
  return found;
}

/** Clock skew tolerated between this process and the ledger. */
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * An instant outside its bounds, or one that is not there. A deadline lies between now (less the
 * clock skew; one already past is a trade that cannot settle) and `maxWindowMs` ahead; `requestedAt`
 * is when the trade was requested, so it lies between `maxWindowMs` ago and now (plus the skew).
 */
function lateDeadline(record: Map<string, Value> | null, labels: string[], terms: DvpTerms): string | null {
  for (const label of labels) {
    const value = record?.get(label);
    if (value?.sum.oneofKind !== 'timestamp') return `${label} is missing`;
    const at = Number(BigInt(value.sum.timestamp) / 1000n);
    const when = new Date(at).toISOString();
    const [lo, hi] = label === 'requestedAt'
      ? [terms.now - terms.maxWindowMs, terms.now + CLOCK_SKEW_MS]
      : [terms.now - CLOCK_SKEW_MS, terms.now + terms.maxWindowMs];
    if (at > hi) return `${label} is ${when}, further ahead than this account allows`;
    if (at < lo) return `${label} is ${when}, already in the past`;
  }
  return null;
}

function checkProposal(value: Value | undefined, terms: DvpTerms, approvers: string[]): string | null {
  const late = lateDeadline(fieldsOf(value), ['expiresAt'], terms);
  if (late) return late;
  const arg = plain(value);
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
// The package a proposal node comes from is pinned by checkTree for every node of the swap steps.

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
  // More than ten decimals is not a Numeric 10 the ledger could hold: refused, never truncated.
  if (!/^\d+(\.\d{1,10})?$/.test(text)) return -1n;
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * ONE + BigInt((fraction + '0000000000').slice(0, 10));
}

const ceilDiv = (a: bigint, b: bigint) => a / b + (a % b === 0n ? 0n : 1n);
