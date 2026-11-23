import { isRegistryFactory, REGISTRY_GUARDIANS, REGISTRY_PACKAGES, type RegistryGuardians, type RegistryPackages } from './registry';
import type { CantonTransaction, CreateNode, DamlValue, ExerciseNode, TransactionNode } from './transactionTypes';

/**
 * What an owner's key signs for the intent rail (CAN-3340): a prepared transaction whose root is
 * one of the owner's own choices of an allowed `cancore-intent` package, in which the owner's
 * authority reaches nothing but that package's code and the registry's own factories — or, under
 * the owner's withdraw (BUG-1685), nothing but the release of the intent's own allocation.
 */

export const INTENT_PACKAGE_NAME = 'cancore-intent';

/**
 * Package ids of the `cancore-intent` versions whose Open, Renew and Withdraw this wallet signs: 0.6.2 and 0.6.3 (CAN-3340, CAN-2716,
 * CAN-3588). 0.6.2 is an SCU of 0.4.2–0.6.1, so a root of an older package still runs: up to 0.5.2 their Open stores a settlement
 * factory without the owner's PublicFetch and their settle runs the operator's pin under the owner's authority; 0.6.0
 * and 0.6.1 read an attestor registry whose sets may start on a fractional second (CAN-2716).
 * The 0.6.2 id is the main package of `deploy-contracts/dars/cancore-intent-0.6.2.dar` at canton-contracts dev 55438e36
 * (#319 merged), the DAR the dev participant vets. The 0.6.3 id is the main package of the staged
 * `deploy-contracts/dars/cancore-intent-0.6.3.dar` (canton-contracts#371): pinned before its upload, since the participant
 * then prefers it and the backend prepares owner-signed steps against it. Drop 0.6.2 once dev un-vets it.
 */
export const INTENT_PACKAGE_IDS: readonly string[] = [
  '16883f74059616eda07b70764b1160196a5123c5691adccf11062f90176d9d5d',
  '535cb88a2faec69ec361089d1d5ecbbe150cd50a00b736b2941b52c6b820b6fa',
];

/** The roots an owner signs, by `<module>:<entity>` of the template and the choice. */
export const INTENT_ROOTS = {
  open: { template: 'Intent.SwapIntent:IntentFactory', choice: 'IntentFactory_Open' },
  // Checked against the cancore-intent 0.6.0 DAR of canton-contracts#327 (973d063); unchanged through 0.6.2 (#319).
  renewSettlementFactory: { template: 'Intent.SwapIntent:SwapIntent', choice: 'SwapIntent_RenewSettlementFactory' },
  // BUG-1685: the owner's take-back past refundAfter; its only owner action is Allocation_Withdraw of the intent's own allocation.
  // Checked against canton-contracts dev Intent/SwapIntent.daml (cancore-intent 0.6.3): `controller owner`, body `exercise allocationCid AV2.Allocation_Withdraw`.
  withdraw: { template: 'Intent.SwapIntent:SwapIntent', choice: 'SwapIntent_Withdraw' },
} as const;

export type IntentRoot = keyof typeof INTENT_ROOTS;

/**
 * The wallet operations whose legs are intent roots: signed from the prepared transaction
 * (`signPreparedTransaction`), never from a bare hash.
 */
export const INTENT_OPERATIONS: Readonly<Record<string, IntentRoot>> = {
  'intent.open': 'open',
  // shortcut: the operation name the backend serves Renew under is set in CAN-3340 E4; align it there.
  'intent.renew-settlement-factory': 'renewSettlementFactory',
  'intent.refund': 'withdraw',
};

export const isIntentOperation = (operation: string): boolean => Object.hasOwn(INTENT_OPERATIONS, operation);

/** Choices of the registry's factories the owner's authority may reach, with the token-standard interface each is exercised through. */
const REGISTRY_FACTORY_CHOICES: Readonly<Record<string, string>> = {
  AllocationFactory_Allocate: 'Splice.Api.Token.AllocationInstructionV2:AllocationFactory',
  SettlementFactory_PublicFetch: 'Splice.Api.Token.AllocationV2:SettlementFactory',
};

/** `cancore-intent` choices below the root that run with the owner as an actor, as `<module>:<entity>.<choice>`. */
const INTENT_OWNER_CHOICES: ReadonlySet<string> = new Set(['Intent.FillerRegistry:FillerRegistryEntry.FillerRegistryEntry_PublicFetch']);

/** `SwapIntent_Withdraw` runs `exercise allocationCid AV2.Allocation_Withdraw with actors = [owner]` (canton-contracts `Intent/SwapIntent.daml`). */
const ALLOCATION_WITHDRAW = { interface: 'Splice.Api.Token.AllocationV2:Allocation', choice: 'Allocation_Withdraw' } as const;

/** Positions in the `SwapIntent` declaration (canton-contracts `Intent/SwapIntent.daml`, unchanged through cancore-intent 0.6.3). */
const SWAP_INTENT_FIELDS = { owner: 0, allocationCid: 8 } as const;

/** What the owner's authority may reach below the root: the intent rail's Open and Renew, or one withdraw of the intent's own allocation. */
type OwnerReach = { kind: 'intent' } | { kind: 'withdraw'; allocationCid: string };

export interface IntentSigningPolicy {
  /** The party the key signs for. */
  owner: string;
  /** The instrument admin of the intent's give: the registry whose factories (Open, Renew) or allocation (Withdraw) the owner's authority may reach. */
  admin: string;
  /** Package ids of the `cancore-intent` versions this signature may be for: a subset of {@link INTENT_PACKAGE_IDS}, which is the default. */
  intentPackageIds?: readonly string[];
  /** The roots this signature may be for. Default: every intent root. */
  roots?: readonly IntentRoot[];
  /** Registry packages by admin. Default {@link REGISTRY_PACKAGES}. */
  registries?: RegistryPackages;
  /**
   * CNRX guardians by admin (CAN-3132): G must co-sign the admin's cnrx-registry factories. Default
   * {@link REGISTRY_GUARDIANS}. A cnrx-registry factory of an admin with no G here is refused.
   */
  guardians?: RegistryGuardians;
}

/** Thrown before anything is signed; `reason` is the sentence a wallet shows its user. */
export class IntentTransactionRefusedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`${reason} — nothing was signed.`);
    this.name = 'IntentTransactionRefusedError';
    this.reason = reason;
  }
}

function refuse(reason: string): never {
  throw new IntentTransactionRefusedError(reason);
}

const packageOf = (templateId: string): string => templateId.split(':')[0] ?? '';
const qualified = (templateId: string): string => templateId.split(':').slice(1).join(':');

const intentPackagesOf = (policy: IntentSigningPolicy): readonly string[] => policy.intentPackageIds ?? INTENT_PACKAGE_IDS;

function isIntentCode(node: Pick<CreateNode, 'packageName' | 'templateId'>, policy: IntentSigningPolicy): boolean {
  return node.packageName === INTENT_PACKAGE_NAME && intentPackagesOf(policy).includes(packageOf(node.templateId));
}

function rootOf(tx: CantonTransaction, policy: IntentSigningPolicy): { node: ExerciseNode; root: IntentRoot } {
  if (tx.roots.length !== 1) refuse(`expected one root action, got ${tx.roots.length}`);
  const node = tx.nodes[tx.roots[0] ?? ''];
  if (node?.kind !== 'exercise' || !isIntentCode(node, policy)) refuse('the root is not a choice of an allowed cancore-intent package');
  const exercise = node;
  const allowed = policy.roots ?? (Object.keys(INTENT_ROOTS) as IntentRoot[]);
  const root = allowed.find((r) => INTENT_ROOTS[r].template === qualified(exercise.templateId) && INTENT_ROOTS[r].choice === exercise.choice);
  if (!root || exercise.interfaceId) refuse(`the root ${qualified(exercise.templateId)}.${exercise.choice} is not an intent operation this wallet signs`);
  if (!exercise.actingParties.includes(policy.owner)) refuse('the owner is not the actor of the root');
  return { node: exercise, root };
}

/** A field read by its position in the declaration, its label empty or the expected one: a label alone could be spoofed into place. */
function swapIntentField(argument: DamlValue, label: keyof typeof SWAP_INTENT_FIELDS): DamlValue {
  const position = SWAP_INTENT_FIELDS[label];
  const entry = argument.t === 'record' ? Object.entries(argument.v)[position] : undefined;
  if (!entry || (entry[0] !== label && entry[0] !== `#${position}`)) refuse(`field ${position} of the intent withdrawn is not its ${label}`);
  return entry[1];
}

/** The allocation a withdraw may release: the `allocationCid` of the owner's SwapIntent the root runs on, as the transaction discloses it. */
function withdrawnAllocationOf(tx: CantonTransaction, root: ExerciseNode, policy: IntentSigningPolicy): string {
  const intent = tx.inputContracts.find((c) => c.contractId === root.contractId);
  // The creation package, not the pin: an intent opened under a version the wallet later drops stays the owner's to withdraw, and SCU keeps field positions.
  if (!intent || intent.packageName !== INTENT_PACKAGE_NAME || qualified(intent.templateId) !== INTENT_ROOTS.withdraw.template) refuse('the transaction does not disclose the SwapIntent it withdraws');
  const owner = swapIntentField(intent.argument, 'owner');
  if (owner.t !== 'party' || owner.v !== policy.owner) refuse("the intent withdrawn is not the owner's");
  const allocation = swapIntentField(intent.argument, 'allocationCid');
  if (allocation.t !== 'contractId') refuse("the intent's allocationCid is not a contract id");
  return allocation.v;
}

function ownerReachOf(root: IntentRoot, tx: CantonTransaction, node: ExerciseNode, policy: IntentSigningPolicy): OwnerReach {
  switch (root) {
    case 'open':
    case 'renewSettlementFactory':
      return { kind: 'intent' };
    case 'withdraw':
      return { kind: 'withdraw', allocationCid: withdrawnAllocationOf(tx, node, policy) };
    default:
      return assertNever(root);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

/**
 * Under a withdraw the owner's authority reaches the intent's own allocation alone, consumed by the registry's
 * Allocation_Withdraw. The walk stops there, so the allocation must be the registry's as a factory must
 * ({@link isRegistryFactory}): the admin signs it and its package is the admin's.
 */
function checkWithdrawExercise(node: ExerciseNode, name: string, allocationCid: string, policy: IntentSigningPolicy): boolean {
  if (node.choice !== ALLOCATION_WITHDRAW.choice || qualified(node.interfaceId ?? '') !== ALLOCATION_WITHDRAW.interface) refuse(`the owner's authority reaches ${name}`);
  if (node.contractId !== allocationCid) refuse(`the withdraw releases ${node.contractId}, not the intent's allocation ${allocationCid}`);
  if (!node.consuming) refuse("the withdraw does not consume the intent's allocation");
  const registries = policy.registries ?? REGISTRY_PACKAGES;
  const packages = Object.hasOwn(registries, policy.admin) ? registries[policy.admin] : undefined;
  if (!packages?.includes(packageOf(node.templateId)) || !node.signatories.includes(policy.admin)) {
    refuse(`the allocation ${node.contractId} (${qualified(node.templateId)}) is not the registry's of ${policy.admin}`);
  }
  return false;
}

/** Whether the walk descends below `node`: a registry factory's own subtree is the registry's code, not checked further. */
function checkExercise(node: ExerciseNode, policy: IntentSigningPolicy, reach: OwnerReach): boolean {
  const lendsOwnerAuthority = node.actingParties.includes(policy.owner) || node.signatories.includes(policy.owner);
  if (!lendsOwnerAuthority) return true;
  const name = `${qualified(node.templateId)}.${node.choice}`;
  if (reach.kind === 'withdraw') return checkWithdrawExercise(node, name, reach.allocationCid, policy);
  if (isIntentCode(node, policy) && INTENT_OWNER_CHOICES.has(name)) return true;
  const factoryInterface = Object.hasOwn(REGISTRY_FACTORY_CHOICES, node.choice) ? REGISTRY_FACTORY_CHOICES[node.choice] : undefined;
  if (!factoryInterface || qualified(node.interfaceId ?? '') !== factoryInterface) refuse(`the owner's authority reaches ${name}`);
  if (!isRegistryFactory(node, policy.admin, policy.registries ?? REGISTRY_PACKAGES, policy.guardians ?? REGISTRY_GUARDIANS)) {
    refuse(`${node.choice} runs on ${qualified(node.templateId)} (${node.contractId}), which is not a factory of the registry ${policy.admin}`);
  }
  return false;
}

function childrenToCheck(node: TransactionNode, policy: IntentSigningPolicy, reach: OwnerReach): readonly string[] {
  switch (node.kind) {
    case 'rollback':
      return node.children;
    case 'fetch':
      return [];
    case 'create':
      if (node.signatories.includes(policy.owner) && reach.kind === 'withdraw') refuse(`the owner signs a ${qualified(node.templateId)} created under a withdraw`);
      if (node.signatories.includes(policy.owner) && !isIntentCode(node, policy)) refuse(`the owner signs a ${qualified(node.templateId)} created outside the registry`);
      return [];
    case 'exercise':
      return checkExercise(node, policy, reach) ? node.children : [];
  }
}

/**
 * The intent root a prepared transaction is for, or {@link IntentTransactionRefusedError}:
 * the owner acts alone, the one root is an allowed intent choice, and every action below it that
 * carries the owner's authority is either code of an allowed `cancore-intent` package or
 * `AllocationFactory_Allocate` / `SettlementFactory_PublicFetch` on a factory of the policy's
 * registry ({@link isRegistryFactory}). Under `SwapIntent_Withdraw` (BUG-1685) the one action carrying the owner's
 * authority is `Allocation_Withdraw` of the `allocationCid` of the owner's SwapIntent the transaction discloses.
 */
export function checkIntentTransaction(tx: CantonTransaction, policy: IntentSigningPolicy): IntentRoot {
  const packages = intentPackagesOf(policy);
  if (packages.length === 0) refuse('no cancore-intent package is allowed');
  const unpinned = packages.find((id) => !INTENT_PACKAGE_IDS.includes(id));
  if (unpinned) refuse(`cancore-intent package ${unpinned} is not a version this wallet signs for`);
  if (tx.actAs.length !== 1 || tx.actAs[0] !== policy.owner) refuse(`the transaction acts as ${tx.actAs.join(', ') || 'nobody'}, not as the owner alone`);
  const { node, root } = rootOf(tx, policy);
  const reach = ownerReachOf(root, tx, node, policy);
  const seen = new Set<string>([node.nodeId]);
  const pending = [...node.children];
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (seen.has(id)) refuse(`node ${id} is reached twice`);
    seen.add(id);
    const child = tx.nodes[id];
    if (!child) refuse(`node ${id} is not in the transaction`);
    pending.push(...childrenToCheck(child, policy, reach));
  }
  return root;
}
