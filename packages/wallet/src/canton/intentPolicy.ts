import { isRegistryFactory, REGISTRY_GUARDIANS, REGISTRY_PACKAGES, type RegistryGuardians, type RegistryPackages } from './registry';
import type { CantonTransaction, CreateNode, ExerciseNode, TransactionNode } from './transactionTypes';

/**
 * What an owner's key signs for the intent rail (CAN-3340): a prepared transaction whose root is
 * one of the owner's own choices of an allowed `cancore-intent` package, in which the owner's
 * authority reaches nothing but that package's code and the registry's own factories.
 */

export const INTENT_PACKAGE_NAME = 'cancore-intent';

/**
 * Package ids of the `cancore-intent` versions whose Open and Renew this wallet signs: 0.6.2 only (CAN-3340, CAN-2716).
 * 0.6.2 is an SCU of 0.4.2–0.6.1, so a root of an older package still runs: up to 0.5.2 their Open stores a settlement
 * factory without the owner's PublicFetch and their settle runs the operator's pin under the owner's authority; 0.6.0
 * and 0.6.1 read an attestor registry whose sets may start on a fractional second (CAN-2716).
 * The 0.6.2 id is the main package of `deploy-contracts/dars/cancore-intent-0.6.2.dar` at canton-contracts dev 55438e36
 * (#319 merged), the DAR the dev participant vets and the backend prepares owner-signed steps against.
 */
export const INTENT_PACKAGE_IDS: readonly string[] = ['16883f74059616eda07b70764b1160196a5123c5691adccf11062f90176d9d5d'];

/** The roots an owner signs, by `<module>:<entity>` of the template and the choice. */
export const INTENT_ROOTS = {
  open: { template: 'Intent.SwapIntent:IntentFactory', choice: 'IntentFactory_Open' },
  // Checked against the cancore-intent 0.6.0 DAR of canton-contracts#327 (973d063); unchanged through 0.6.2 (#319).
  renewSettlementFactory: { template: 'Intent.SwapIntent:SwapIntent', choice: 'SwapIntent_RenewSettlementFactory' },
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
};

export const isIntentOperation = (operation: string): boolean => Object.hasOwn(INTENT_OPERATIONS, operation);

/** Choices of the registry's factories the owner's authority may reach, with the token-standard interface each is exercised through. */
const REGISTRY_FACTORY_CHOICES: Readonly<Record<string, string>> = {
  AllocationFactory_Allocate: 'Splice.Api.Token.AllocationInstructionV2:AllocationFactory',
  SettlementFactory_PublicFetch: 'Splice.Api.Token.AllocationV2:SettlementFactory',
};

/** `cancore-intent` choices below the root that run with the owner as an actor, as `<module>:<entity>.<choice>`. */
const INTENT_OWNER_CHOICES: ReadonlySet<string> = new Set(['Intent.FillerRegistry:FillerRegistryEntry.FillerRegistryEntry_PublicFetch']);

export interface IntentSigningPolicy {
  /** The party the key signs for. */
  owner: string;
  /** The instrument admin of the intent's give: the registry whose factories the owner's authority may reach. */
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

function isIntentCode(node: ExerciseNode | CreateNode, policy: IntentSigningPolicy): boolean {
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

/** Whether the walk descends below `node`: a registry factory's own subtree is the registry's code, not checked further. */
function checkExercise(node: ExerciseNode, policy: IntentSigningPolicy): boolean {
  const lendsOwnerAuthority = node.actingParties.includes(policy.owner) || node.signatories.includes(policy.owner);
  if (!lendsOwnerAuthority) return true;
  const name = `${qualified(node.templateId)}.${node.choice}`;
  if (isIntentCode(node, policy) && INTENT_OWNER_CHOICES.has(name)) return true;
  const factoryInterface = Object.hasOwn(REGISTRY_FACTORY_CHOICES, node.choice) ? REGISTRY_FACTORY_CHOICES[node.choice] : undefined;
  if (!factoryInterface || qualified(node.interfaceId ?? '') !== factoryInterface) refuse(`the owner's authority reaches ${name}`);
  if (!isRegistryFactory(node, policy.admin, policy.registries ?? REGISTRY_PACKAGES, policy.guardians ?? REGISTRY_GUARDIANS)) {
    refuse(`${node.choice} runs on ${qualified(node.templateId)} (${node.contractId}), which is not a factory of the registry ${policy.admin}`);
  }
  return false;
}

function childrenToCheck(node: TransactionNode, policy: IntentSigningPolicy): readonly string[] {
  switch (node.kind) {
    case 'rollback':
      return node.children;
    case 'fetch':
      return [];
    case 'create':
      if (node.signatories.includes(policy.owner) && !isIntentCode(node, policy)) refuse(`the owner signs a ${qualified(node.templateId)} created outside the registry`);
      return [];
    case 'exercise':
      return checkExercise(node, policy) ? node.children : [];
  }
}

/**
 * The intent root a prepared transaction is for, or {@link IntentTransactionRefusedError}:
 * the owner acts alone, the one root is an allowed intent choice, and every action below it that
 * carries the owner's authority is either code of an allowed `cancore-intent` package or
 * `AllocationFactory_Allocate` / `SettlementFactory_PublicFetch` on a factory of the policy's
 * registry ({@link isRegistryFactory}).
 */
export function checkIntentTransaction(tx: CantonTransaction, policy: IntentSigningPolicy): IntentRoot {
  const packages = intentPackagesOf(policy);
  if (packages.length === 0) refuse('no cancore-intent package is allowed');
  const unpinned = packages.find((id) => !INTENT_PACKAGE_IDS.includes(id));
  if (unpinned) refuse(`cancore-intent package ${unpinned} is not a version this wallet signs for`);
  if (tx.actAs.length !== 1 || tx.actAs[0] !== policy.owner) refuse(`the transaction acts as ${tx.actAs.join(', ') || 'nobody'}, not as the owner alone`);
  const { node, root } = rootOf(tx, policy);
  const seen = new Set<string>([node.nodeId]);
  const pending = [...node.children];
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (seen.has(id)) refuse(`node ${id} is reached twice`);
    seen.add(id);
    const child = tx.nodes[id];
    if (!child) refuse(`node ${id} is not in the transaction`);
    pending.push(...childrenToCheck(child, policy));
  }
  return root;
}
