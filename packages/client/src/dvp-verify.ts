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
import { deepFreeze, DEFAULT_HTLC_PACKAGES, instrumentKey } from './dvp-admins';

export type DvpOperation = 'dvpCreateProposal' | 'dvpAcceptProposal' | 'dvpAllocateLeg' | 'dvpWithdrawAllocation';

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
  /**
   * Set for a withdraw: the instrument admins this account trusts, by instrument. The allocation names its own
   * instrument and admin; the admin must be one of these, and the instrument id the order's. `source.admin` and
   * `target.admin` are then not consulted.
   */
  pinnedAdmins?: Record<string, string[]>;
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
  /**
   * `splice-wallet`, for the one transaction that is a bare create — the transfer preapproval
   * proposal `onboard()` signs. A create runs on no contract an admin signed, so unlike a send or an
   * allocation it has no anchor but its package id; the ids are Splice's own: one per release, the
   * same on every network, and a network may run any release.
   */
  wallet: Record<string, string[]>;
  /** `htlc-contract-v9` (`HTLCInitRequest`, `HTLCProposal`, `HTLC`): trusted by name AND id, as `swap` is. */
  htlc: Record<string, string[]>;
}

export const DEFAULT_TRUSTED_PACKAGES: TrustedPackages = deepFreeze({
  swap: {
    'cancore-swap': [
      '06a6e3f1f5d9dfcdc885d72248b26decdde09c7f99bc4a8af385624a30be2544', // 1.0.0
      '2b8060d64191b963d7416e0e2d15d11b239f88ad31aca2f457c4eefa2e15e395', // 1.1.0
      '0164b8f54b26b673b24ba7ca6d141b65bd4dbc8c135cd61922477c871c927a2a', // 1.2.0
      '01208653516ab062e71274729caec86254a9ac55022561cb68c189bfd6fc6742', // 1.3.0
    ],
  },
  wallet: {
    // Every released `splice-wallet`, from Splice's own `daml/dars.lock`
    // (hyperledger-labs/splice @ 5fb974056a29, 2026-09-29). A network runs whichever of them its
    // super validators voted in, so one stand's id alone would refuse the others — and that stand
    // too, the day it upgrades. A release after 0.1.25 is added here, or by `trustedPackages.wallet`.
    'splice-wallet': [
      '5f384fba007e8b93c8ff1ac151cdc2d035ae1e0506f5e5770de469048713024c', // 0.1.0
      'e276113de450c2bb4bf8cf2d2991dd0b397fe7fe8103fe1b5377b8ab6622edec', // 0.1.1
      'c162e08a4ec0428bfa870b6d9040989e575c74199c3a80558c62e03196dd5146', // 0.1.2
      '2c35bb4f5084ea66db59717d21750bfd64c43147ef5fd5166615092d592a6917', // 0.1.3
      '141dad2d33b6410b8e1c35a0c4f8f76cb691e4d9a4410ce89f33f373855317e1', // 0.1.4
      '614b525a50c624062d851ce7df5bdb90ddfa0d6871c486cb6e2c7b694bfbce59', // 0.1.5
      'ba51e944e430facce00c297c58f4769240402721de4a1d121705050f8e9be901', // 0.1.6
      'd9a91419b27aa27002a883334015a892c35075967b07008a446bc4b5073051ec', // 0.1.7
      '882f6438ef69a4fbbe36e32e020d98f3eb1982ac484686e3ca1e2577d677626a', // 0.1.8
      '940b9fd181c0cf358dd8c38934a8c908d2a3ee5a4728f72481b4de6720f3f8d5', // 0.1.9
      '9824ffa414d5803d17efafd75c69c1dd53591ac5197d07048b24dbac1720a462', // 0.1.10
      '991842eee48ec3caa3a649e8f47e3544dd7b688ce4b363aa934a83db7dada427', // 0.1.11
      'b30bb727552cf6b624dbc9a5ff95f6c158e0a654e2e9c5c27bcfe3f5d0f9ada2', // 0.1.12
      'eb6e01efacc3397e23c6be8b9be7db4bf37672211974d69e24b48980e2f98b7e', // 0.1.13
      '690c1d47bac06db419db344d59a7a30c53fa3f5d961943fe1782cfc6c78794d8', // 0.1.14
      'fd57252dda29e3ce90028114c91b521cb661df5a9d6e87c41a9e91518215fa5b', // 0.1.15
      '17dca10fd8eb6a833be530fe9c6f9c2b7397a38c06e9c86d0679adc200b90e14', // 0.1.16
      '176c2924cd7aa12bc81ffd1a8d6cfaf46e70378f653eb5f19f2d6b9599cfd45c', // 0.1.17
      '94d88246f69d8a4b69333d1f993e3280deaca19b70511ea7687f01e4328a34a4', // 0.1.18
      '1d8317b1e476c03ea2a85bed8435e5c182abe501db58350009187fa839ab2cca', // 0.1.19
      'e485c2eb59cca556e0e2ecfaaef45346dd0ba64f9976a3957938d814f846c78c', // 0.1.20
      'f799a58fa53dfe48bae52bd5dbcc2b578a7d4dfee3ae3f4eb7635fe9a8cc67d3', // 0.1.21
      'a78daeeb1a4a2405828b29f8c04814725dbd97ee5a60bd02e839f32518640afa', // 0.1.22
      '727c0fb9711d59b506fbb3cff2342e55eb583bb88682a946220525c304feca4a', // 0.1.23
      'd42261314d98cc04bf50bcc58930af98b9f33aeed11339465925de697d3ba66e', // 0.1.24 — the dev stand, 2026-10
      '916f16ea9413ba72d9ae660c9d0741f1078fc27b82b61e4b9db6a991dc47a848', // 0.1.25
    ],
  },
  htlc: DEFAULT_HTLC_PACKAGES as Record<string, string[]>,
});

/**
 * The token-standard allocation factory interface, by package id: the standard's API packages are
 * published once and are the same on every network, so this is pinned outright.
 */
export const ALLOCATION_FACTORY_INTERFACE = {
  packageId: '275064aacfe99cea72ee0c80563936129563776f67415ef9f13e4297eecbc520',
  moduleName: 'Splice.Api.Token.AllocationInstructionV1',
  entityName: 'AllocationFactory',
};

/**
 * The token-standard Allocation interface, by module and entity. Not pinned by package id: a withdraw
 * names the interface VERSION the allocation contract implements, which differs per registry; the
 * trust anchor is the allocation itself, signed by the instrument admin (see `dvpWithdrawAllocation`).
 */
export const ALLOCATION_INTERFACE = { moduleName: 'Splice.Api.Token.AllocationV1', entityName: 'Allocation' };

export interface PreparedToSign {
  preparedTransactionHash: string;
  preparedTransaction?: string;
}

/** The wallet operations outside a trade whose transactions are read before the key signs them. */
export type TokenOperation = 'tokens.send' | 'tokens.send-fee' | 'tokens.consolidate' | 'tokens.accept' | 'tokens.preapproval' | 'htlc.flow-b-create' | 'htlc.accept-counter';

/** A prepared transaction the account refuses to sign, with the reason. */
export class UnverifiedTransactionError extends Error {
  constructor(operation: DvpOperation | TokenOperation, reason: string) {
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
    const decoded = await readPrepared(tx, `transaction ${index}`, terms.party, refuse);
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

/**
 * The transaction behind a hash, read: its bytes decoded, the hash recomputed from them and held
 * to the one it came with, and the transaction acting as the signer alone.
 */
async function readPrepared(tx: PreparedToSign, what: string, party: string, refuse: (reason: string) => never): Promise<PreparedTransaction> {
  if (!tx.preparedTransaction) refuse(`${what} came without its bytes, so its hash cannot be checked`);
  let recomputed: string;
  let decoded: PreparedTransaction;
  try {
    decoded = decodePreparedTransaction(tx.preparedTransaction!);
    recomputed = await hashPreparedTransaction(tx.preparedTransaction!, 'base64');
  } catch (err) {
    return refuse(`${what} cannot be read (${err instanceof Error ? err.message : String(err)})`);
  }
  if (recomputed !== tx.preparedTransactionHash) refuse(`${what} does not hash to the hash it came with`);
  const actAs = decoded.metadata?.submitterInfo?.actAs ?? [];
  if (actAs.length !== 1 || actAs[0] !== party) refuse(`${what} acts as ${actAs.join(', ') || 'nobody'}, not as this account`);
  // One contract id, one contract: every check below reads a disclosed contract by its id, and with
  // two under the same id it would read one while the ledger runs the other.
  const disclosed = (decoded.metadata?.inputContracts ?? []).map((c) => (c.contract.oneofKind === 'v1' ? c.contract.v1.contractId : ''));
  if (new Set(disclosed).size !== disclosed.length) refuse(`${what} discloses two contracts under one contract id`);
  // The same of the contracts it creates: the holdings rules read them by id, and a second create
  // under an id already taken — by a create or by a disclosed contract — would be a holding no rule sees.
  const made = (decoded.transaction?.nodes ?? []).flatMap((n) => {
    const type = nodeType(n);
    return type?.oneofKind === 'create' ? [type.create.contractId] : [];
  });
  if (new Set([...disclosed, ...made]).size !== disclosed.length + made.length) refuse(`${what} creates two contracts under one contract id`);
  // Records are read by label here; a label said twice would be read one way and run another.
  const values = [
    ...(decoded.metadata?.inputContracts ?? []).map((c) => (c.contract.oneofKind === 'v1' ? c.contract.v1.argument : undefined)),
    ...(decoded.transaction?.nodes ?? []).flatMap((n) => {
      const type = nodeType(n);
      return type?.oneofKind === 'create' ? [type.create.argument] : type?.oneofKind === 'exercise' ? [type.exercise.chosenValue] : [];
    }),
  ];
  if (values.some(repeatsLabel)) refuse(`${what} carries a record that names a field twice`);
  return decoded;
}

/** A record, anywhere inside a Daml value, with one label on two fields. */
function repeatsLabel(value: Value | undefined): boolean {
  const sum = value?.sum;
  if (!sum) return false;
  if (sum.oneofKind === 'record') {
    const labels = sum.record.fields.map((f) => f.label).filter(Boolean);
    return new Set(labels).size !== labels.length || sum.record.fields.some((f) => repeatsLabel(f.value));
  }
  if (sum.oneofKind === 'list') return sum.list.elements.some(repeatsLabel);
  if (sum.oneofKind === 'optional') return repeatsLabel(sum.optional.value);
  if (sum.oneofKind === 'variant') return repeatsLabel(sum.variant.value);
  if (sum.oneofKind === 'textMap') return sum.textMap.entries.some((e) => repeatsLabel(e.value));
  if (sum.oneofKind === 'genMap') return sum.genMap.entries.some((e) => repeatsLabel(e.key) || repeatsLabel(e.value));
  return false;
}

/**
 * The tree as a whole: every node reachable from the one root and nothing else, none reached
 * twice, no rollback, and only creates, exercises and fetches.
 */
function walkTree(decoded: PreparedTransaction, nodes: Nodes): string | null {
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
    const kind = nodeType(node)!.oneofKind;
    if (kind !== 'create' && kind !== 'exercise' && kind !== 'fetch') return `node ${node.nodeId} is of an unexpected kind`;
  }
  return null;
}

/** Every contract the transaction creates, by id. */
function createdIn(nodes: Nodes): Map<string, Create> {
  const out = new Map<string, Create>();
  for (const node of nodes.values()) {
    const type = nodeType(node);
    if (type?.oneofKind === 'create') out.set(type.create.contractId, type.create);
  }
  return out;
}

/**
 * What the signer may do in the tree, the same for every kind of transaction it signs: no party
 * outside `allowed` in any created contract, choice argument or acting set (an empty party is a
 * stranger), a choice it acts in only by `signerActs`, and a contract it signs only when it is
 * its own holding or one `mayCreate` accepts.
 */
export function signerBounds(
  nodes: Nodes, inputs: Map<string, Create>, created: Map<string, Create>, party: string, admins: string[], entryCid: string,
  allowed: Set<string>, what: string, mayCreate: (contract: Create) => boolean,
): string | null {
  for (const node of nodes.values()) {
    const type = nodeType(node)!;
    const values = type.oneofKind === 'create' ? [type.create.argument] : type.oneofKind === 'exercise' ? [type.exercise.chosenValue] : [];
    const parties = [...(type.oneofKind === 'exercise' ? type.exercise.actingParties : []), ...values.flatMap((v) => [...partiesIn(v)])];
    const stranger = parties.find((p) => !p || !allowed.has(p));
    if (stranger !== undefined) return `node ${node.nodeId} involves ${stranger || 'an empty party'}, who is not part of this ${what}`;
    if (type.oneofKind === 'exercise' && type.exercise.actingParties.includes(party)) {
      const wrong = signerActs(type.exercise.contractId, inputs, created, party, admins, entryCid);
      if (wrong) return `node ${node.nodeId}: ${wrong}`;
    }
    if (type.oneofKind === 'create' && type.create.signatories.includes(party) && holdingOf(type.create)?.owner !== party && !mayCreate(type.create)) {
      return `node ${node.nodeId} creates a ${type.create.templateId?.entityName ?? 'contract'} signed by this account that is neither its holding nor this ${what}`;
    }
  }
  return null;
}

/** What the tree spends, per instrument: every holding it consumes must be the signer's, and one the transaction discloses or creates. */
function spentHoldings(nodes: Nodes, inputs: Map<string, Create>, created: Map<string, Create>, party: string): Map<string, bigint> | string {
  const spent = new Map<string, bigint>();
  for (const node of nodes.values()) {
    const type = nodeType(node)!;
    if (type.oneofKind !== 'exercise' || !type.exercise.consuming) continue;
    const target = inputs.get(type.exercise.contractId) ?? created.get(type.exercise.contractId);
    if (!target) return `it consumes contract ${type.exercise.contractId.slice(0, 16)}… without disclosing what it is`;
    const holding = holdingOf(target);
    if (!holding) continue;
    if (holding.owner !== party) return `it spends a holding owned by ${holding.owner}`;
    spent.set(holding.instrument, (spent.get(holding.instrument) ?? 0n) + holding.amount);
  }
  return spent;
}

interface TransferLeg {
  sender: string;
  receiver: string;
  amount: string;
  instrumentId: { admin: string; id: string };
}

export type Nodes = Map<string, DamlTransaction_Node>;

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
    case 'dvpWithdrawAllocation':
      return checkWithdraw(root, decoded, nodes, terms);
  }
}

/**
 * The owner releasing its own allocation of a trade that ended unsettled: one consuming
 * `Allocation_Withdraw` on an allocation of THIS trade that this account sends and the instrument
 * admin signed, carrying nothing but its registry context. In the whole tree the only contracts
 * archived are that allocation, this account's own holdings, and admin-signed registry records that
 * are not another allocation; every holding created is this account's, unlocked, and at most what
 * the leg locked; at least one is returned. No party appears but the signer, the venue, the
 * receiver and the registry's own — so the lock goes back to the owner and nothing goes anywhere else.
 */
function checkWithdraw(root: ReturnType<typeof nodeType>, decoded: PreparedTransaction, nodes: Nodes, terms: DvpTerms): string | null {
  if (root?.oneofKind !== 'exercise' || root.exercise.choiceId !== 'Allocation_Withdraw' || !sameInterface(root.exercise.interfaceId, ALLOCATION_INTERFACE)) {
    return 'it is not the withdrawal of a token-standard allocation';
  }
  if (root.exercise.actingParties.join() !== terms.party) return 'the withdrawal is not this account’s';
  if (!root.exercise.consuming) return 'the withdrawal does not consume the allocation';
  if (Object.keys(plain(root.exercise.chosenValue) as Record<string, unknown>).join() !== 'extraArgs') return 'the withdrawal carries more than its registry context';
  const allocation = inputContracts(decoded).get(root.exercise.contractId);
  if (!allocation) return 'the allocation is not among the contracts the transaction discloses';
  const spec = (plain(allocation.argument) as { allocation?: { settlement?: { executor?: unknown; settlementRef?: { id?: unknown } }; transferLeg?: TransferLeg } })?.allocation;
  if (spec?.settlement?.executor !== terms.venue) return `the allocation hands settlement to ${String(spec?.settlement?.executor)}, not to the venue`;
  if (spec.settlement.settlementRef?.id !== terms.swapId) return 'the allocation is for another trade';
  // Under Daml upgrades the command may run a newer version of the allocation's package: name, module and entity must match.
  if (!sameTemplate(allocation, root.exercise)) return 'the withdrawal runs on another template than the allocation it names';
  const leg = spec.transferLeg;
  const wrong = checkWithdrawnLeg(leg, terms);
  if (wrong) return wrong;
  if (leg!.sender !== terms.party) return 'the allocation is not this account’s';
  if (!allocation.signatories.includes(leg!.instrumentId.admin) || !allocation.signatories.includes(terms.party)) {
    return 'the allocation is not signed by this account and the instrument admin';
  }
  const holdings = checkHoldings(decoded, nodes, terms, leg!, allocation, root.exercise.contractId);
  if (holdings) return holdings;
  const inputs = inputContracts(decoded);
  const created = new Map<string, Create>();
  for (const node of nodes.values()) {
    const type = nodeType(node)!;
    if (type.oneofKind === 'create') created.set(type.create.contractId, type.create);
  }
  let returned = 0n;
  for (const contract of created.values()) {
    const holding = holdingOf(contract);
    if (!holding) continue;
    if (holding.locked) return 'it creates a locked holding: a withdraw locks nothing';
    returned += holding.amount;
  }
  if (returned === 0n) return 'it returns no holding to this account';
  if (returned > units(leg!.amount)) return `it returns more than the leg's ${leg!.amount}`;
  // What goes back is exactly what the allocation held: every holding of this account the tree consumes is a
  // locked one, and together they are the amount returned, to the unit. An unrelated holding of the signer's
  // spent, or a sliver returned of a larger lock, does not add up.
  let released = 0n;
  for (const node of nodes.values()) {
    const type = nodeType(node)!;
    if (type.oneofKind !== 'exercise' || !type.exercise.consuming || type.exercise.contractId === root.exercise.contractId) continue;
    const target = inputs.get(type.exercise.contractId) ?? created.get(type.exercise.contractId);
    if (!target) return `it consumes contract ${type.exercise.contractId.slice(0, 16)}… without disclosing what it is`;
    const holding = holdingOf(target);
    if (holding?.owner === terms.party) {
      if (!holding.locked) return 'it spends a holding of this account that the allocation does not lock';
      released += holding.amount;
      continue;
    }
    if (!target.signatories.includes(leg!.instrumentId.admin) || holding || looksLikeAllocation(target)) {
      return `it archives a ${target.templateId?.entityName ?? 'contract'} that is neither this allocation nor this account's holding`;
    }
  }
  if (released !== returned) return 'what it returns is not what the allocation locked';
  return null;
}

/** An allocation by structure, not by name: a record carrying a settlement and a transfer leg. */
function looksLikeAllocation(contract: Create): boolean {
  const spec = fieldsOf(fieldsOf(contract.argument)?.get('allocation') ?? undefined);
  return !!spec?.has('settlement') && !!spec.has('transferLeg');
}

/**
 * A leg of the trade, as a withdraw sees it: by who it is from and to and in what, never by the stand's
 * current fee policy. The maker's leg is exactly the order's source; the taker's legs (the trade leg and the
 * fee) are the order's target, at most its amount. A fee that changed since the trade must not keep funds locked.
 */
function checkWithdrawnLeg(leg: TransferLeg | undefined, terms: DvpTerms): string | null {
  if (!leg?.instrumentId) return 'a leg cannot be read';
  // The instrument is the allocation's own; its admin must be one this account pins for that instrument.
  const is = (i: Instrument) =>
    leg.instrumentId.id === i.id && (terms.pinnedAdmins?.[instrumentKey(i.id)] ?? []).includes(leg.instrumentId.admin);
  const amount = units(leg.amount);
  if (amount < 0n) return `a leg amount (${String(leg.amount)}) cannot be read`;
  if (leg.sender === terms.maker && leg.receiver === terms.taker) {
    return is(terms.source) && amount === units(terms.source.amount) ? null : `the maker's leg is not the order's ${terms.source.amount} ${terms.source.id}`;
  }
  if (leg.sender === terms.taker && leg.receiver !== terms.taker) {
    return is(terms.target) && amount <= units(terms.target.amount) ? null : `the taker's leg is not within the order's ${terms.target.amount} ${terms.target.id}`;
  }
  return `a leg from ${leg.sender} to ${leg.receiver} is not part of this trade`;
}

const sameInterface = (a: { moduleName: string; entityName: string } | undefined, b: { moduleName: string; entityName: string }) =>
  !!a && a.moduleName === b.moduleName && a.entityName === b.entityName;

/**
 * The tree as a whole: every node reachable from the one root and nothing else, no rollback,
 * and every node from a package the step may run. The proposal steps are fixed shapes — the
 * create is one node; the approval exercises the proposal and recreates it, two nodes.
 */
function checkTree(operation: DvpOperation, decoded: PreparedTransaction, nodes: Nodes, terms: DvpTerms): string | null {
  const wrong = walkTree(decoded, nodes);
  if (wrong) return wrong;
  for (const node of nodes.values()) {
    const type = nodeType(node)!;
    // An allocation's nodes all hang from the one exercise on the admin-signed factory (checked above:
    // every node is reachable from the root), so they run the admin's code; the proposal steps run ours.
    // A withdraw is the same: every node hangs from the one exercise on the admin-signed allocation.
    if (operation === 'dvpAllocateLeg' || operation === 'dvpWithdrawAllocation' || (type.oneofKind !== 'create' && type.oneofKind !== 'exercise' && type.oneofKind !== 'fetch')) continue;
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
 *  - a contract the signer signs is shaped like its own holding or is the allocation record of
 *    exactly this leg, and a choice the signer acts in is the factory's own, one on its own
 *    holding, or one on a contract the instrument admin signed; anything else (a proxy the signer
 *    signs and someone else controls, a choice on a stranger's contract) is refused. This is a
 *    check of shape: it does not bound the instrument admin's own code, which runs the allocation
 *    and later its execution with the signer's authority. The admin is trusted, see dvp-admins.ts.
 */
function checkHoldings(decoded: PreparedTransaction, nodes: Nodes, terms: DvpTerms, leg: TransferLeg, factory: Create, factoryCid: string): string | null {
  const party = terms.party;
  const inputs = inputContracts(decoded);
  const allowedParties = new Set([party, terms.venue, leg.receiver, leg.instrumentId.admin, ...factory.signatories, ...factory.stakeholders]);
  const created = createdIn(nodes);
  const net = new Map<string, bigint>();
  const add = (key: string, amount: bigint) => net.set(key, (net.get(key) ?? 0n) + amount);
  const locked = new Map<string, bigint>();
  const bounds = signerBounds(nodes, inputs, created, party, [leg.instrumentId.admin], factoryCid, allowedParties, 'allocation', (c) => isThisAllocation(c, terms, leg));
  if (bounds) return bounds;
  for (const node of nodes.values()) {
    const type = nodeType(node)!;
    if (type.oneofKind !== 'create') continue;
    const holding = holdingOf(type.create);
    if (!holding) continue;
    if (holding.owner !== party) return `it creates a holding owned by ${holding.owner}`;
    add(holding.instrument, -holding.amount);
    if (holding.locked) locked.set(holding.instrument, (locked.get(holding.instrument) ?? 0n) + holding.amount);
  }
  const legKey = instrumentKey(leg.instrumentId.id);
  for (const [instrument, amount] of locked) {
    if (amount > (instrument === legKey ? units(leg.amount) : 0n)) return `it locks more ${instrument} than the leg's ${leg.amount}`;
  }
  const spent = spentHoldings(nodes, inputs, created, party);
  if (typeof spent === 'string') return spent;
  for (const [instrument, amount] of spent) add(instrument, amount);
  for (const [instrument, spent] of net) {
    const allowance = instrument === legKey ? units(leg.amount) : 0n;
    if (spent > allowance) return `it spends more ${instrument} than the leg locks`;
  }
  return null;
}

export type Create = Extract<NonNullable<ReturnType<typeof nodeType>>, { oneofKind: 'create' }>['create'];

/** Why the signer may not act in a choice on this contract, or null when it may. */
function signerActs(cid: string, inputs: Map<string, Create>, created: Map<string, Create>, party: string, admins: string[], entryCid: string): string | null {
  if (cid === entryCid) return null;
  const target = inputs.get(cid) ?? created.get(cid);
  if (!target) return 'this account acts on a contract the transaction does not disclose';
  if (holdingOf(target)?.owner === party) return null;
  if (target.signatories.some((p) => admins.includes(p))) return null;
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
export function fieldsOf(value: Value | undefined): Map<string, Value> | null {
  if (value?.sum.oneofKind !== 'record') return null;
  return new Map(value.sum.record.fields.flatMap((f) => (f.value ? [[f.label, f.value] as const] : [])));
}

export const textOf = (value: Value | undefined) => (value?.sum.oneofKind === 'text' ? value.sum.text : undefined);
export const numericOf = (value: Value | undefined) => (value?.sum.oneofKind === 'numeric' ? value.sum.numeric : undefined);

/** The holding a contract is, if it is one: owner, instrument and amount in 1e-10 units. Read from typed values: `owner` must be a Party. */
export function holdingOf(contract: Create): { owner: string; instrument: string; amount: bigint; locked: boolean } | null {
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
export const sameTemplate = (contract: Create, exercise: { packageName: string; templateId?: { moduleName: string; entityName: string } }) =>
  contract.packageName === exercise.packageName && !!contract.templateId && !!exercise.templateId &&
  contract.templateId.moduleName === exercise.templateId.moduleName && contract.templateId.entityName === exercise.templateId.entityName;

const sameId = (a: { packageId: string; moduleName: string; entityName: string } | undefined, b: { packageId: string; moduleName: string; entityName: string } | undefined) =>
  !!a && !!b && a.packageId === b.packageId && a.moduleName === b.moduleName && a.entityName === b.entityName;

/** A node's package is trusted only by name AND id. */
export const trusted = (allowed: Record<string, string[]>, packageName: string, packageId: string | undefined) =>
  !!packageId && pinnedFor(allowed, packageName).includes(packageId);

/** What is pinned under a name the TRANSACTION supplied: an own entry of the map, never `constructor` or `__proto__`. */
const pinnedFor = (pins: Record<string, readonly string[]>, name: string): readonly string[] =>
  (Object.prototype.hasOwnProperty.call(pins, name) ? pins[name]! : []);

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
export const CLOCK_SKEW_MS = 5 * 60_000;

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

export function nodeType(node: DamlTransaction_Node | undefined) {
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

/** A self-send the account asked for, to split a holding off its own balance. Amounts are decimal strings. */
export interface SelfSendTerms {
  /** The account signing, and the only owner of every holding the send may leave behind but the fee's. */
  party: string;
  /** The instrument's pinned admins (the DSO for CC). */
  admins: string[];
  instrument: string;
  /** The holding the send must create for the account, to the unit. */
  amount: string;
  /** The most the whole ceremony may leave the account poorer by, its fee leg's payment included. */
  maxCost: string;
  /** The pinned parties the ceremony's `fee` leg may pay. */
  feeRecipients: string[];
}

/** The CC send choice a self-send exercises, on the receiver's own preapproval. */
const PREAPPROVAL_SEND = /^TransferPreapproval_Send(V2)?$/;

/**
 * Verify every transaction of a `tokens.send` to the account itself before its key signs them —
 * read (`readPrepared`) and walked (`walkTree`) exactly as a DvP step is, under the same bounds
 * on the signer (`signerBounds`), with only the holdings rule its own:
 *  - each leg is one `TransferPreapproval_Send` on a disclosed preapproval whose receiver is the
 *    account (the transfer) or a pinned fee recipient (the `fee` leg); no party but the account,
 *    the instrument admins and that preapproval's own parties appears anywhere;
 *  - every holding created is the account's and unlocked, but what the fee leg pays its receiver;
 *  - every holding spent is the account's, of this instrument;
 *  - one holding of exactly `amount` is created for the account by the transfer (the split);
 *  - what the account ends up poorer, the fee leg's payment included, is at most `maxCost`.
 */
export async function verifySelfSendPrepared(legs: Leg[], terms: SelfSendTerms): Promise<void> {
  await selfSendCost(legs, terms);
}

/** {@link verifySelfSendPrepared}, resolving to what the ceremony costs the account, in 1e-10 CC units. */
export async function selfSendCost(legs: Leg[], terms: SelfSendTerms): Promise<bigint> {
  const refuse = refuser('tokens.send');
  if (units(terms.amount) <= 0n || units(terms.maxCost) < 0n) refuse('the amount or the cost bound is not a decimal of at most ten places');
  const { net, fee, transfers } = await tokenLegs(legs, refuse, { ...terms, dso: terms.admins }, terms.party, 'this account');
  if (!transfers.some((t) => t.own.includes(units(terms.amount)))) refuse(`no holding of exactly ${terms.amount} ${terms.instrument} is created for this account`);
  if (net + fee > units(terms.maxCost)) {
    refuse(`the send costs this account more than ${decimalOf(units(terms.maxCost))} ${terms.instrument} (an old input's accrued holding fee counts: consolidate() it first)`);
  }
  return net + fee;
}

/** A send the account asked for, to another party. Amounts are decimal strings. */
export interface SendTerms {
  /** The account signing: the only party that acts, and the owner of everything the send spends or leaves as change. */
  party: string;
  /** The instrument's pinned admins (the DSO for CC, the registry for a registry token). */
  admins: string[];
  instrument: string;
  /** The party the caller named: besides the account and a fee recipient, the only owner a holding may be created for. */
  receiver: string;
  /** What the receiver must be given, to the unit — no less and no more. */
  amount: string;
  /** The most CC the send may cost the account on top of `amount`: its fee leg's payment, and an old CC input's accrued holding fee. */
  maxFee: string;
  /** The pinned parties the ceremony's `fee` leg may pay. */
  feeRecipients: string[];
  /** The pinned CC admins the fee leg — a CC send, whatever the instrument — is held to. Default: `admins`, right for a CC send. */
  dso?: string[];
}

/**
 * Verify every transaction of a `tokens.send` to ANOTHER party before the account's key signs them
 * (CAN-2249, stage 4). Read and walked as a DvP step is, with the holdings rule of a payment: the
 * receiver the caller named is given exactly `amount` — unlocked holdings through its own
 * preapproval, or, where it must accept (`TransferFactory_Transfer` on the admin's own factory), a
 * lock of exactly `amount` under an offer to that receiver; nobody else is given anything but the
 * fee leg's pinned recipient; and the account ends up poorer by at most `amount`, plus `maxFee` CC.
 * A hostile API that swaps the receiver, the amount, or adds a payee of its own is refused before
 * anything is signed.
 */
export async function verifySendPrepared(legs: Leg[], terms: SendTerms): Promise<void> {
  await sendCost(legs, terms);
}

/** {@link verifySendPrepared}, resolving to the CC the ceremony costs the account beyond `amount`, in 1e-10 units. */
export async function sendCost(legs: Leg[], terms: SendTerms, operation: TokenOperation = 'tokens.send'): Promise<bigint> {
  const refuse = refuser(operation);
  const [amount, maxFee] = [units(terms.amount), units(terms.maxFee)];
  if (amount <= 0n || maxFee < 0n) refuse('the amount or the fee bound is not a decimal of at most ten places');
  // To oneself nothing is paid: that is a split, and it has its own rule (one holding of exactly the amount).
  if (terms.receiver === terms.party) refuse('a send to the account itself is a split: verifySelfSendPrepared reads it');
  const { net, fee, transfers } = await tokenLegs(legs, refuse, { ...terms, dso: terms.dso ?? terms.admins }, terms.receiver, `${terms.receiver}, the receiver this send was asked for`);
  const given = transfers.reduce((sum, t) => sum + t.received + t.locked, 0n);
  if (given !== amount || transfers.some((t) => t.factory && t.asked !== amount)) {
    refuse(`${terms.receiver} is given ${decimalOf(given)} ${terms.instrument}, not the ${terms.amount} this send was asked for`);
  }
  if (!withinCost(terms.instrument, net, fee, amount, maxFee)) {
    refuse(`the send costs this account ${costOf(terms.instrument, net, fee)}, more than the ${terms.amount} it sends and the fee it allows ` +
      "(a fee debt the API collects on the fee leg counts, and so does an old input's accrued holding fee: consolidate() it first)");
  }
  return isAmulet(terms.instrument) ? net + fee - amount : fee;
}

/** A merge of the account's own holdings of one instrument. Amounts are decimal strings. */
export interface ConsolidateTerms {
  party: string;
  /** The instrument's pinned admins. */
  admins: string[];
  instrument: string;
  /** The most CC the merge may cost: a fee leg's payment, and for CC the inputs' accrued holding fees. */
  maxFee: string;
  feeRecipients: string[];
  /** As in {@link SendTerms}. */
  dso?: string[];
}

/**
 * Verify every transaction of a `tokens.consolidate`: a send to the account itself — through its own
 * preapproval (CC) or the admin's transfer factory (a registry token) — in which every holding spent
 * and every holding created is the account's, none is left locked, and the account ends up with what
 * it had, less at most `maxFee` CC.
 */
export async function verifyConsolidatePrepared(legs: Leg[], terms: ConsolidateTerms): Promise<void> {
  const refuse = refuser('tokens.consolidate');
  const maxFee = units(terms.maxFee);
  if (maxFee < 0n) refuse('the fee bound is not a decimal of at most ten places');
  const { net, fee, transfers } = await tokenLegs(legs, refuse, { ...terms, dso: terms.dso ?? terms.admins }, terms.party, 'this account');
  if (transfers.length === 0) refuse('the merge has no transfer in it');
  if (!withinCost(terms.instrument, net, fee, 0n, maxFee)) refuse(`the merge costs this account ${costOf(terms.instrument, net, fee)}, more than the fee it allows`);
}

/**
 * Verify a ceremony that is a network fee and nothing else (`tokens.send-fee`, the fee of a send that
 * could not carry one): CC sends to a pinned fee recipient, through a preapproval the DSO signed,
 * costing the account at most `maxFee`.
 */
export async function verifyFeePrepared(legs: Leg[], terms: { party: string; dso: string[]; maxFee: string; feeRecipients: string[] }): Promise<void> {
  await feeCost(legs, terms);
}

/** {@link verifyFeePrepared}, resolving to the fee the ceremony pays, in 1e-10 CC units. */
export async function feeCost(legs: Leg[], terms: { party: string; dso: string[]; maxFee: string; feeRecipients: string[] }): Promise<bigint> {
  const refuse = refuser('tokens.send-fee');
  const maxFee = units(terms.maxFee);
  if (maxFee < 0n) refuse('the fee bound is not a decimal of at most ten places');
  const { fee, transfers } = await tokenLegs(legs, refuse, { ...terms, admins: terms.dso, instrument: 'Amulet' }, terms.party, 'this account');
  if (transfers.length > 0) refuse('a fee ceremony carries a transfer');
  if (fee > maxFee) refuse(`the fee costs this account ${decimalOf(fee)} CC, more than the fee it allows`);
  return fee;
}

/** An incoming transfer the account was asked to accept. */
export interface AcceptTerms {
  party: string;
  /** The transfer instruction the caller chose to accept: the contract the transaction must run on. */
  instructionCid: string;
  /** The admins this account trusts, by instrument key (`instrumentKey`): the instruction names its own instrument and admin. */
  pinnedAdmins: Record<string, string[]>;
  /** The most CC the accept may cost the account: its fee leg's payment, when it has one. */
  maxFee: string;
  feeRecipients: string[];
  /** The pinned CC admins the fee leg is held to. */
  dso: string[];
}

/**
 * Verify every transaction of a `tokens.accept`: one `TransferInstruction_Accept` on the instruction
 * the caller chose, which a pinned admin of its instrument signed and which names this account as
 * receiver. In the whole tree the account spends no holding and signs nothing but the holdings it
 * receives; holdings go to the account or back to the sender, to nobody else. A `fee` leg is a CC send
 * to a pinned fee recipient, within `maxFee`.
 */
export async function verifyAcceptPrepared(legs: Leg[], terms: AcceptTerms): Promise<void> {
  await acceptCost(legs, terms);
}

/** {@link verifyAcceptPrepared}, resolving to the fee the accept pays, in 1e-10 CC units. */
export async function acceptCost(legs: Leg[], terms: AcceptTerms): Promise<bigint> {
  const refuse = refuser('tokens.accept');
  const maxFee = units(terms.maxFee);
  if (maxFee < 0n) refuse('the fee bound is not a decimal of at most ten places');
  if (legs.length === 0) refuse('the API prepared nothing to sign');
  let [fee, accepts] = [0n, 0];
  for (const [index, leg] of legs.entries()) {
    const what = `leg ${index}`;
    if (leg.kind !== 'fee' && leg.kind !== 'transfer') refuse(`${what} is a ${leg.kind}, not an accept or its fee`);
    const opened = await openLeg(leg, what, terms.party, refuse);
    if (leg.kind === 'fee') fee += costOfLeg(preapprovalMoved(opened, what, refuse, { party: terms.party, admins: terms.dso, key: AMULET, receivers: terms.feeRecipients, wanted: 'a pinned network fee recipient' }));
    else accepts += acceptLeg(opened, what, refuse, terms);
  }
  if (accepts !== 1) refuse(`expected one accept, the API prepared ${accepts}`);
  if (fee > maxFee) refuse(`the accept costs this account ${decimalOf(fee)} CC of fee, more than the fee it allows`);
  return fee;
}

/** The step of `onboard()` that lets CC reach the account directly. */
export interface PreapprovalSetupTerms {
  party: string;
  /** The pinned CC admins: the proposal must name one as the DSO it expects. */
  dso: string[];
  /** Who may provide the preapproval: the venue this SDK pins for the network, or the account itself. */
  providers: string[];
  /** The `splice-wallet` package ids the proposal may be created from ({@link TrustedPackages.wallet}). */
  packages: Record<string, string[]>;
}

/**
 * Verify the one transaction of a `tokens.preapproval`: a single create of a
 * `TransferPreapprovalProposal` from a pinned `splice-wallet` package, signed by the account alone,
 * naming the account as receiver, a pinned provider, and the pinned DSO — and nothing else in the tree.
 */
export async function verifyPreapprovalSetupPrepared(legs: Leg[], terms: PreapprovalSetupTerms): Promise<void> {
  const refuse = refuser('tokens.preapproval');
  if (legs.length !== 1 || legs[0]!.kind !== 'setup') refuse('expected the one transaction that proposes the preapproval');
  const { root } = await openLeg(legs[0]!, 'leg 0', terms.party, refuse);
  // A create has no children, and every node hangs from the one root: the tree is this create and nothing else.
  if (root?.oneofKind !== 'create') return refuse('it is not the creation of a preapproval proposal');
  const { templateId, packageName, signatories, argument } = root.create;
  if (templateId?.moduleName !== 'Splice.Wallet.TransferPreapproval' || templateId.entityName !== 'TransferPreapprovalProposal') refuse('it is not a transfer preapproval proposal');
  // A create has no admin-signed contract under it: the package id is all that says whose code this is.
  if (!trusted(terms.packages, packageName, templateId?.packageId)) {
    refuse(`it runs code from an untrusted package (${packageName || 'unnamed'} ${templateId?.packageId ?? ''}): ` +
      "if a splice-wallet release newer than this SDK lists is live, take its id from Splice's own daml/dars.lock or from Cancore — " +
      "never from this message, the API wrote the id in it — and add it with trustedPackages: { wallet: { 'splice-wallet': [id] } }");
  }
  if (signatories.length !== 1 || signatories[0] !== terms.party) refuse('the proposal is not signed by this account alone');
  const proposal = readPlain(argument) as { receiver?: unknown; provider?: unknown; expectedDso?: unknown } | null;
  if (!proposal || Object.keys(proposal).sort().join() !== 'expectedDso,provider,receiver') return refuse('the proposal is not of the shape this SDK knows');
  if (proposal.receiver !== terms.party) refuse('the proposal is for another receiver');
  if (!terms.providers.includes(proposal.provider as string)) {
    refuse(`the proposal names ${String(proposal.provider)} as provider, which is neither this account nor a pinned venue (the venue comes from network, or from venuePartyId)`);
  }
  if (!terms.dso.includes(proposal.expectedDso as string)) refuse(`the proposal expects ${String(proposal.expectedDso)} as the DSO, which is not a pinned CC admin`);
}

export type Leg = PreparedToSign & { kind: string };
export type Refuse = (reason: string) => never;
type Exercise = Extract<NonNullable<ReturnType<typeof nodeType>>, { oneofKind: 'exercise' }>['exercise'];
export type Opened = Awaited<ReturnType<typeof openLeg>>;

export const refuser = (operation: TokenOperation): Refuse => (reason) => { throw new UnverifiedTransactionError(operation, reason); };

const AMULET = instrumentKey('Amulet');
const isAmulet = (instrument: string) => instrumentKey(instrument) === AMULET;

/** The token standard's transfer interfaces, by module and entity: the anchor is the admin-signed contract the choice runs on. */
const TRANSFER_FACTORY_INTERFACE = { moduleName: 'Splice.Api.Token.TransferInstructionV1', entityName: 'TransferFactory' };
const TRANSFER_INSTRUCTION_INTERFACE = { moduleName: 'Splice.Api.Token.TransferInstructionV1', entityName: 'TransferInstruction' };

/** A Daml value as plain JSON, or null when it holds a kind this SDK does not read. */
function readPlain(value: Value | undefined): unknown {
  try {
    return plain(value);
  } catch {
    return null;
  }
}

/** A leg read as far as every leg is: its bytes against its hash, its one command, its whole tree. */
export async function openLeg(leg: Leg, what: string, party: string, refuse: Refuse) {
  const decoded = await readPrepared(leg, what, party, refuse);
  if (!decoded.transaction || decoded.transaction.roots.length !== 1) refuse(`${what}: expected a transaction with exactly one command`);
  const nodes: Nodes = new Map(decoded.transaction!.nodes.map((n) => [n.nodeId, n]));
  const shape = walkTree(decoded, nodes);
  if (shape) refuse(`${what}: ${shape}`);
  return { nodes, root: nodeType(nodes.get(decoded.transaction!.roots[0]!)), inputs: inputContracts(decoded), created: createdIn(nodes) };
}

/**
 * What a transfer leg did to the account's holdings of the instrument, in 1e-10 units: `net` is what
 * it spent less what came back unlocked (`own`, each holding's amount); `received` went to the
 * receiver; `locked` stays the account's under a lock (a transfer the receiver has yet to accept).
 * `factory` legs also carry the amount the command itself `asked` for.
 */
interface Moved { net: bigint; own: bigint[]; received: bigint; locked: bigint; factory: boolean; asked: bigint }

/** The legs of a send or a merge: `transfer` legs to `to`, `fee` legs — CC, whatever the instrument — to a pinned fee recipient. */
async function tokenLegs(
  legs: Leg[], refuse: Refuse,
  terms: { party: string; admins: string[]; instrument: string; feeRecipients: string[]; dso: string[] },
  to: string, wanted: string,
): Promise<{ net: bigint; fee: bigint; transfers: Moved[] }> {
  if (legs.length === 0) refuse('the API prepared nothing to sign');
  const out = { net: 0n, fee: 0n, transfers: [] as Moved[] };
  const key = instrumentKey(terms.instrument);
  for (const [index, leg] of legs.entries()) {
    const what = `leg ${index}`;
    if (leg.kind !== 'fee' && leg.kind !== 'transfer') refuse(`${what} is a ${leg.kind}, not a transfer or its fee`);
    const opened = await openLeg(leg, what, terms.party, refuse);
    if (leg.kind === 'fee') {
      out.fee += costOfLeg(preapprovalMoved(opened, what, refuse, { party: terms.party, admins: terms.dso, key: AMULET, receivers: terms.feeRecipients, wanted: 'a pinned network fee recipient' }));
      continue;
    }
    const viaFactory = opened.root?.oneofKind === 'exercise' && opened.root.exercise.choiceId === 'TransferFactory_Transfer';
    const moved = viaFactory
      ? factoryMoved(opened, what, refuse, { party: terms.party, admins: terms.admins, key, receiver: to, wanted })
      : preapprovalMoved(opened, what, refuse, { party: terms.party, admins: terms.admins, key, receivers: [to], wanted });
    out.net += costOfLeg(moved);
    out.transfers.push(moved);
  }
  return out;
}

/**
 * What one leg costs the account: what its holdings lost, and never less than what the leg hands to
 * somebody else. The two differ when value enters the transfer from something that is not a holding —
 * a reward coupon of the account's own — and "spent less change" alone would let that leave unseen,
 * or let a gain on one leg pay for an overcharge on another.
 */
const costOfLeg = (moved: Moved) => {
  const given = moved.received + moved.locked;
  return moved.net > given ? moved.net : given;
};

/** What a ceremony cost, in words: one CC figure, or the instrument's and the CC fee beside it. */
const costOf = (instrument: string, net: bigint, fee: bigint) =>
  isAmulet(instrument) ? `${decimalOf(net + fee)} ${instrument}` : `${decimalOf(net)} ${instrument} and ${decimalOf(fee)} CC of fee`;

/** The instrument's own cost within `amount`, the CC fee within `maxFee`; for CC the two are one balance. */
const withinCost = (instrument: string, net: bigint, fee: bigint, amount: bigint, maxFee: bigint) =>
  isAmulet(instrument) ? net + fee <= amount + maxFee : net <= amount && fee <= maxFee;

/**
 * One leg sent through a CC transfer preapproval: a single `TransferPreapproval_Send` on a disclosed
 * preapproval the admin signed, whose receiver is one of `receivers`; no party but the account, the
 * admins and that preapproval's own; every holding spent the account's, every holding created
 * unlocked and the account's or that receiver's.
 */
function preapprovalMoved(
  { nodes, root, inputs, created }: Opened, what: string, refuse: Refuse,
  terms: { party: string; admins: string[]; key: string; receivers: string[]; wanted: string },
): Moved {
  if (root?.oneofKind !== 'exercise' || !PREAPPROVAL_SEND.test(root.exercise.choiceId)) return refuse(`${what} is not a send through a transfer preapproval`);
  const command = root.exercise;
  const preapproval = inputs.get(command.contractId);
  if (!preapproval || preapproval.templateId?.entityName !== 'TransferPreapproval') return refuse(`${what} does not disclose the preapproval it sends through`);
  // The preapproval is the trust anchor of everything under it, as the factory is for an allocation:
  // a choice body acts with this account's authority, so it must be the DSO's code and nobody else's.
  // A contract the DSO signed is one only the DSO could create, of the template the command runs (the
  // package id may be a newer version; its name, module and entity may not differ).
  if (!sameTemplate(preapproval, command)) refuse(`${what} runs on another template than the preapproval it names`);
  // Who signed it is said twice — by the contract disclosed and by the command exercising it — and
  // both must say the admin: the command's word is the one the ledger holds the transaction to.
  if (!signedBy(preapproval, command, terms.admins)) refuse(`${what} sends through a preapproval the instrument admin did not sign`);
  const receiver = partyOf(fieldsOf(preapproval.argument)?.get('receiver'));
  if (!receiver || !terms.receivers.includes(receiver)) return refuse(`${what} sends to ${receiver ?? 'an unreadable receiver'}, not to ${terms.wanted}`);
  const allowed = new Set([terms.party, ...terms.admins, ...preapproval.signatories, ...preapproval.stakeholders]);
  const bounds = signerBounds(nodes, inputs, created, terms.party, terms.admins, command.contractId, allowed, 'send', () => false);
  if (bounds) refuse(`${what}: ${bounds}`);
  const moved = movedHoldings({ nodes, inputs, created }, what, refuse, { party: terms.party, key: terms.key, receiver });
  if (moved.locked > 0n) refuse(`${what} creates a locked holding`);
  return moved;
}

/**
 * One leg sent through the token standard's transfer factory: a single `TransferFactory_Transfer` on a
 * disclosed factory a pinned admin signed, from this account to `receiver`, of this instrument. The
 * account signs nothing but its own holdings and the offer of exactly this transfer; what it spends
 * comes back as change, goes to the receiver, or is locked under that offer.
 */
function factoryMoved(
  { nodes, root, inputs, created }: Opened, what: string, refuse: Refuse,
  terms: { party: string; admins: string[]; key: string; receiver: string; wanted: string },
): Moved {
  if (root?.oneofKind !== 'exercise' || !sameInterface(root.exercise.interfaceId, TRANSFER_FACTORY_INTERFACE)) return refuse(`${what} is not a token-standard transfer`);
  const command = root.exercise;
  const arg = readPlain(command.chosenValue) as { expectedAdmin?: unknown; transfer?: Partial<TransferLeg> } | null;
  const [admin, transfer] = [arg?.expectedAdmin, arg?.transfer];
  if (typeof admin !== 'string' || !terms.admins.includes(admin)) return refuse(`${what} names ${String(admin)} as the instrument admin, which is not one this SDK pins for it`);
  if (!transfer || transfer.sender !== terms.party) return refuse(`${what} sends another party's holdings`);
  if (transfer.receiver !== terms.receiver) return refuse(`${what} sends to ${String(transfer.receiver)}, not to ${terms.wanted}`);
  if (transfer.instrumentId?.admin !== admin || instrumentKey(String(transfer.instrumentId?.id)) !== terms.key) return refuse(`${what} transfers another instrument`);
  const asked = units(transfer.amount);
  if (asked <= 0n) return refuse(`${what} transfers an amount that is not a positive decimal`);
  const factory = inputs.get(command.contractId);
  if (!factory) return refuse(`${what} does not disclose the transfer factory it runs on`);
  if (!sameTemplate(factory, command)) refuse(`${what} runs on another template than the factory it names`);
  if (!signedBy(factory, command, [admin])) refuse(`${what} runs on a transfer factory the instrument admin did not sign`);
  const allowed = new Set([terms.party, terms.receiver, admin, ...factory.signatories, ...factory.stakeholders]);
  const isThisOffer = (contract: Create) => contract.signatories.includes(admin) && sameTransfer((readPlain(contract.argument) as { transfer?: Partial<TransferLeg> } | null)?.transfer, transfer);
  const bounds = signerBounds(nodes, inputs, created, terms.party, [admin], command.contractId, allowed, 'send', isThisOffer);
  if (bounds) refuse(`${what}: ${bounds}`);
  const moved = movedHoldings({ nodes, inputs, created }, what, refuse, { party: terms.party, key: terms.key, receiver: terms.receiver });
  // To somebody else the leg gives exactly what it transfers, in one of the two ways the standard has:
  // the holding handed over, or the amount locked under ONE offer of this transfer for the receiver to
  // accept. A lock with no offer is money nobody can take; half the amount is not the transfer asked.
  if (terms.receiver !== terms.party) {
    const offers = [...created.values()].filter(isThisOffer).length;
    const handedOver = offers === 0 && moved.locked === 0n && moved.received === asked;
    const offered = offers === 1 && moved.locked === asked && moved.received === 0n;
    if (!handedOver && !offered) {
      refuse(`${what} transfers ${decimalOf(asked)} and neither hands exactly that to ${terms.wanted} nor locks exactly that under one offer of this transfer`);
    }
  } else if (moved.locked > 0n) {
    // To itself a registry locks nothing: there is nobody to accept. A lock here is the account's balance tied up.
    refuse(`${what} is a transfer to the account itself that leaves a holding locked`);
  }
  return { ...moved, factory: true, asked };
}

/** Holdings of one instrument, spent and created: the account's only, but what is created for `receiver`. */
function movedHoldings(
  { nodes, inputs, created }: Pick<Opened, 'nodes' | 'inputs' | 'created'>, what: string, refuse: Refuse,
  terms: { party: string; key: string; receiver: string },
): Moved {
  const moved: Moved = { net: 0n, own: [], received: 0n, locked: 0n, factory: false, asked: 0n };
  const spent = spentHoldings(nodes, inputs, created, terms.party);
  if (typeof spent === 'string') return refuse(`${what}: ${spent}`);
  for (const [instrument, amount] of spent) {
    if (instrument !== terms.key) refuse(`${what} spends ${instrument}, not ${terms.key}`);
    moved.net += amount;
  }
  for (const contract of created.values()) {
    const holding = holdingOf(contract);
    if (!holding) continue;
    if (holding.instrument !== terms.key) refuse(`${what} creates ${holding.instrument}, not ${terms.key}`);
    if (holding.owner === terms.party) {
      if (holding.locked) moved.locked += holding.amount;
      else {
        moved.net -= holding.amount;
        moved.own.push(holding.amount);
      }
    } else if (holding.owner === terms.receiver && !holding.locked) {
      moved.received += holding.amount;
    } else {
      refuse(holding.locked ? `${what} creates a locked holding` : `${what} creates a holding owned by ${holding.owner}`);
    }
  }
  return moved;
}

/**
 * The accept of one transfer instruction: `TransferInstruction_Accept` on the contract the caller
 * chose, disclosed, signed by a pinned admin of the instrument it names, and to this account. The
 * account spends nothing; holdings are created for it or for the sender.
 */
function acceptLeg({ nodes, root, inputs, created }: Opened, what: string, refuse: Refuse, terms: AcceptTerms): number {
  if (root?.oneofKind !== 'exercise' || root.exercise.choiceId !== 'TransferInstruction_Accept' || !sameInterface(root.exercise.interfaceId, TRANSFER_INSTRUCTION_INTERFACE)) {
    return refuse(`${what} is not the accept of a token-standard transfer`);
  }
  const command = root.exercise;
  if (command.contractId !== terms.instructionCid) refuse(`${what} accepts another transfer than the one it was asked for`);
  const instruction = inputs.get(command.contractId);
  if (!instruction) return refuse(`${what} does not disclose the transfer it accepts`);
  const transfer = (readPlain(instruction.argument) as { transfer?: Partial<TransferLeg> } | null)?.transfer;
  const admin = transfer?.instrumentId?.admin;
  const key = instrumentKey(String(transfer?.instrumentId?.id));
  if (!transfer || transfer.receiver !== terms.party || typeof transfer.sender !== 'string') return refuse(`${what} accepts a transfer that is not to this account`);
  if (typeof admin !== 'string' || !pinnedFor(terms.pinnedAdmins, key).includes(admin)) return refuse(`${what} accepts ${key} from ${String(admin)}, which is not an admin this SDK pins for it`);
  if (!sameTemplate(instruction, command)) refuse(`${what} runs on another template than the transfer it names`);
  if (!signedBy(instruction, command, [admin])) refuse(`${what} accepts a transfer the instrument admin did not sign`);
  const allowed = new Set([terms.party, transfer.sender, admin, ...instruction.signatories, ...instruction.stakeholders]);
  const bounds = signerBounds(nodes, inputs, created, terms.party, [admin], command.contractId, allowed, 'accept', () => false);
  if (bounds) refuse(`${what}: ${bounds}`);
  for (const node of nodes.values()) {
    const type = nodeType(node)!;
    if (type.oneofKind !== 'exercise' || !type.exercise.consuming) continue;
    const target = inputs.get(type.exercise.contractId) ?? created.get(type.exercise.contractId);
    if (!target) return refuse(`${what} consumes contract ${type.exercise.contractId.slice(0, 16)}… without disclosing what it is`);
    const owner = holdingOf(target)?.owner;
    if (owner !== undefined && owner !== transfer.sender) refuse(owner === terms.party ? `${what} spends this account's own holding` : `${what} spends a holding owned by ${owner}`);
  }
  for (const contract of created.values()) {
    const holding = holdingOf(contract);
    if (!holding) continue;
    if (holding.instrument !== key) refuse(`${what} creates ${holding.instrument}, not ${key}`);
    if (holding.owner !== terms.party && holding.owner !== transfer.sender) refuse(`${what} creates a holding owned by ${holding.owner}`);
    if (holding.owner === terms.party && holding.locked) refuse(`${what} creates a locked holding`);
  }
  return 1;
}

/** Signed by one of `admins` — as the contract disclosed says and as the command exercising it says. */
const signedBy = (contract: Create, command: Exercise, admins: string[]) =>
  [contract.signatories, command.signatories].every((signed) => signed.some((p) => admins.includes(p)));

/** The same transfer: sender, receiver, amount, instrument and admin. */
const sameTransfer = (a: Partial<TransferLeg> | undefined, b: Partial<TransferLeg>) =>
  !!a && a.sender === b.sender && a.receiver === b.receiver && units(a.amount) === units(b.amount) && units(a.amount) > 0n &&
  a.instrumentId?.id === b.instrumentId?.id && a.instrumentId?.admin === b.instrumentId?.admin;

/** Exact 1e-10 units back to a decimal string, without trailing zeros. */
export function decimalOf(value: bigint): string {
  const [sign, abs] = [value < 0n ? '-' : '', value < 0n ? -value : value];
  const fraction = (abs % ONE).toString().padStart(10, '0').replace(/0+$/, '');
  return `${sign}${abs / ONE}${fraction ? `.${fraction}` : ''}`;
}
export const partyOf = (value: Value | undefined) => (value?.sum.oneofKind === 'party' ? value.sum.party : undefined);
