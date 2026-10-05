/**
 * Prepared DvP transactions built the way the participant returns them, for the
 * tests: the protobuf `PreparedTransaction` base64-encoded, and its hash under
 * Canton's hashing scheme v2. Test-only; no entry point imports it.
 */
import { PreparedTransaction, type Create, type DamlTransaction_Node, type Value } from '@canton-network/core-ledger-proto';
import { hashPreparedTransaction } from '@canton-network/core-tx-visualizer';
import { ALLOCATION_FACTORY_INTERFACE, DEFAULT_TRUSTED_PACKAGES } from './dvp-verify';

/** Package ids the fixture's nodes carry: the trusted ones, unless a test says otherwise. */
export const PKG = {
  swap: DEFAULT_TRUSTED_PACKAGES.swap['cancore-swap']!.at(-1)!,
  amulet: DEFAULT_TRUSTED_PACKAGES.registries['splice-amulet']!.at(-1)!,
  holding: DEFAULT_TRUSTED_PACKAGES.registries['utility-registry-holding-v0']!.at(-1)!,
};

/** An instant relative to now, as the ledger writes it. */
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

export interface FixtureLeg {
  sender: string;
  receiver: string;
  amount: string;
  instrumentId: { admin: string; id: string };
}

const v = {
  party: (party: string): Value => ({ sum: { oneofKind: 'party', party } }),
  text: (text: string): Value => ({ sum: { oneofKind: 'text', text } }),
  numeric: (numeric: string): Value => ({ sum: { oneofKind: 'numeric', numeric } }),
  time: (iso: string): Value => ({ sum: { oneofKind: 'timestamp', timestamp: String(BigInt(Date.parse(iso)) * 1000n) } }),
  none: (): Value => ({ sum: { oneofKind: 'optional', optional: {} } }),
  list: (elements: Value[]): Value => ({ sum: { oneofKind: 'list', list: { elements } } }),
  textMap: (entries: Record<string, Value>): Value => ({
    sum: { oneofKind: 'textMap', textMap: { entries: Object.entries(entries).map(([key, value]) => ({ key, value })) } },
  }),
  record: (fields: Record<string, Value>): Value => ({
    sum: { oneofKind: 'record', record: { fields: Object.entries(fields).map(([label, value]) => ({ label, value })) } },
  }),
};

const meta = () => v.record({ values: v.textMap({}) });

/** Daml Numeric 10, as the ledger writes it. */
const numeric10 = (amount: string) => {
  const [whole = '0', fraction = ''] = amount.split('.');
  return `${whole}.${(fraction + '0000000000').slice(0, 10)}`;
};

const legValue = (leg: FixtureLeg) =>
  v.record({
    sender: v.party(leg.sender),
    receiver: v.party(leg.receiver),
    amount: v.numeric(numeric10(leg.amount)),
    instrumentId: v.record({ admin: v.party(leg.instrumentId.admin), id: v.text(leg.instrumentId.id) }),
    meta: meta(),
  });

type NodeType = Extract<DamlTransaction_Node['versionedNode'], { oneofKind: 'v1' }>['v1']['nodeType'];
const node = (nodeId: string, nodeType: NodeType): DamlTransaction_Node => ({ nodeId, versionedNode: { oneofKind: 'v1', v1: { nodeType } } });
const template = (moduleName: string, entityName: string, packageId: string) => ({ packageId, moduleName, entityName });

export function proposalCreate(nodeId: string, input: { venue: string; swapId: string; legs: Record<string, FixtureLeg>; approvers: string[]; expiresAt?: string; packageId?: string }): DamlTransaction_Node {
  return node(nodeId, {
    oneofKind: 'create',
    create: {
      lfVersion: '2.1',
      contractId: '00'.repeat(34),
      packageName: 'cancore-swap',
      templateId: template('Swap.Trade', 'SwapProposal', input.packageId ?? PKG.swap),
      argument: v.record({
        venue: v.party(input.venue),
        swapId: v.text(input.swapId),
        tradeRef: v.none(),
        transferLegs: v.textMap(Object.fromEntries(Object.entries(input.legs).map(([id, leg]) => [id, legValue(leg)]))),
        approvers: v.list(input.approvers.map(v.party)),
        expiresAt: v.time(input.expiresAt ?? at(60)),
      }),
      signatories: input.approvers,
      stakeholders: input.approvers,
    },
  });
}

export function proposalAccept(nodeId: string, approver: string, children: string[]): DamlTransaction_Node {
  return node(nodeId, {
    oneofKind: 'exercise',
    exercise: {
      lfVersion: '2.1',
      contractId: '11'.repeat(34),
      packageName: 'cancore-swap',
      templateId: template('Swap.Trade', 'SwapProposal', PKG.swap),
      signatories: [approver],
      stakeholders: [approver],
      actingParties: [approver],
      choiceId: 'SwapProposal_Accept',
      chosenValue: v.record({ approver: v.party(approver) }),
      consuming: true,
      children,
      choiceObservers: [],
    },
  });
}

export function allocate(nodeId: string, input: { executor: string; swapId: string; legId: string; leg: FixtureLeg; expectedAdmin?: string; factory?: Create; children?: string[]; settleBefore?: string; interfacePackageId?: string }): DamlTransaction_Node {
  const factory = input.factory ?? factoryContract(input.leg.instrumentId.admin);
  return node(nodeId, {
    oneofKind: 'exercise',
    exercise: {
      lfVersion: '2.1',
      contractId: factory.contractId,
      packageName: factory.packageName,
      templateId: factory.templateId,
      interfaceId: { ...ALLOCATION_FACTORY_INTERFACE, packageId: input.interfacePackageId ?? ALLOCATION_FACTORY_INTERFACE.packageId },
      signatories: factory.signatories,
      stakeholders: factory.stakeholders,
      actingParties: [input.leg.sender],
      choiceId: 'AllocationFactory_Allocate',
      chosenValue: v.record({
        expectedAdmin: v.party(input.expectedAdmin ?? input.leg.instrumentId.admin),
        allocation: v.record({
          settlement: v.record({
            executor: v.party(input.executor),
            settlementRef: v.record({ id: v.text(input.swapId), cid: v.none() }),
            requestedAt: v.time(at(0)),
            allocateBefore: v.time(at(30)),
            settleBefore: v.time(input.settleBefore ?? at(60)),
            meta: meta(),
          }),
          transferLegId: v.text(input.legId),
          transferLeg: legValue(input.leg),
        }),
        requestedAt: v.time(at(0)),
        inputHoldingCids: v.list([]),
        extraArgs: v.record({ context: v.record({ values: v.textMap({}) }), meta: meta() }),
      }),
      consuming: false,
      children: input.children ?? [],
      choiceObservers: [],
    },
  });
}

export const FACTORY_CID = '22'.repeat(34);

const createOf = (contractId: string, packageName: string, packageId: string, moduleName: string, entityName: string, argument: Value, signatories: string[]): Create => ({
  lfVersion: '2.1', contractId, packageName, templateId: template(moduleName, entityName, packageId), argument, signatories, stakeholders: signatories,
});

/** The registry's allocation factory, as the transaction discloses it: signed by `signatory`, naming `admin`. */
export const factoryContract = (admin: string, over: { packageName?: string; packageId?: string; signatory?: string } = {}) =>
  createOf(FACTORY_CID, over.packageName ?? 'splice-amulet', over.packageId ?? PKG.amulet, 'Splice.ExternalPartyAmuletRules', 'ExternalPartyAmuletRules',
    v.record({ dso: v.party(admin) }), [over.signatory ?? admin]);

/** A holding: an Amulet for CC (its amount an ExpiringAmount), a registry holding otherwise. */
export function holding(
  contractId: string, owner: string, instrument: { id: string; admin: string }, amount: string,
  over: { packageName?: string; packageId?: string; lockedTo?: string } = {},
): Create {
  const lock = over.lockedTo ? v.record({ holders: v.list([v.party(over.lockedTo)]), expiresAt: v.time(at(60)) }) : undefined;
  if (instrument.id === 'Amulet' || instrument.id === 'CC') {
    const amulet = v.record({
      dso: v.party(instrument.admin),
      owner: v.party(owner),
      amount: v.record({ initialAmount: v.numeric(numeric10(amount)), createdAt: v.record({ number: v.numeric('1') }), ratePerRound: v.record({ rate: v.numeric('0.0000000001') }) }),
    });
    return lock
      ? createOf(contractId, over.packageName ?? 'splice-amulet', over.packageId ?? PKG.amulet, 'Splice.Amulet', 'LockedAmulet', v.record({ amulet, lock }), [instrument.admin, owner])
      : createOf(contractId, over.packageName ?? 'splice-amulet', over.packageId ?? PKG.amulet, 'Splice.Amulet', 'Amulet', amulet, [instrument.admin, owner]);
  }
  return createOf(contractId, over.packageName ?? 'utility-registry-holding-v0', over.packageId ?? PKG.holding, 'Utility.Registry.Holding.V0.Holding', 'Holding', v.record({
    registrar: v.party(instrument.admin),
    owner: v.party(owner),
    instrument: v.record({ source: v.party(instrument.admin), id: v.text(instrument.id) }),
    amount: v.numeric(numeric10(amount)),
    lock: lock ? { sum: { oneofKind: 'optional', optional: { value: lock } } } : v.none(),
  }), [instrument.admin, owner]);
}

export const createNode = (nodeId: string, create: Create): DamlTransaction_Node => node(nodeId, { oneofKind: 'create', create });

/** A node from an exercise description; `nodeId` is set by the caller. */
export const exercise = (e: Extract<NodeType, { oneofKind: 'exercise' }>['exercise']): DamlTransaction_Node => node('x', { oneofKind: 'exercise', exercise: e });

/** A trusted-package TransferFactory_Transfer of `from` to `receiver`: what a hostile allocation would hide. */
export const spendTransfer = (from: Create, receiver: string): Extract<NodeType, { oneofKind: 'exercise' }>['exercise'] => {
  const owner = (from.argument?.sum.oneofKind === 'record' ? from.argument.sum.record.fields.find((f) => f.label === 'owner')?.value : undefined) ?? v.party('');
  return {
    lfVersion: '2.1', contractId: FACTORY_CID, packageName: 'splice-amulet', templateId: template('Splice.ExternalPartyAmuletRules', 'ExternalPartyAmuletRules', PKG.amulet),
    interfaceId: { packageId: '55ba4deb0ad4662c4168b39859738a0e91388d252286480c7331b3f71a517281', moduleName: 'Splice.Api.Token.TransferInstructionV1', entityName: 'TransferFactory' },
    signatories: from.signatories, stakeholders: from.stakeholders, actingParties: [owner.sum.oneofKind === 'party' ? owner.sum.party : ''],
    choiceId: 'TransferFactory_Transfer',
    chosenValue: v.record({ transfer: v.record({ sender: owner, receiver: v.party(receiver), amount: v.numeric('5.0000000000') }) }),
    consuming: false, children: [], choiceObservers: [],
  };
};

/** A consuming exercise on a holding: how a registry spends it. */
export const spend = (nodeId: string, target: Create, actor: string): DamlTransaction_Node =>
  node(nodeId, {
    oneofKind: 'exercise',
    exercise: {
      lfVersion: '2.1', contractId: target.contractId, packageName: target.packageName, templateId: target.templateId,
      signatories: target.signatories, stakeholders: target.stakeholders, actingParties: [actor],
      choiceId: 'Archive', chosenValue: v.record({}), consuming: true, children: [], choiceObservers: [],
    },
  });

/**
 * A whole allocation as a registry runs it: the factory exercise, the input holding spent,
 * the locked holding and the change created for the sender. `extra` nodes are appended as
 * further children of the factory exercise — the shapes a hostile tree would add.
 */
export function allocationTree(input: {
  executor: string; swapId: string; legId: string; leg: FixtureLeg; balance: string;
  extra?: (id: (n: number) => string) => { nodes: DamlTransaction_Node[]; inputs?: Create[] };
  factory?: Create; settleBefore?: string; interfacePackageId?: string;
}) {
  const { leg } = input;
  const owned = holding('33'.repeat(34), leg.sender, leg.instrumentId, input.balance);
  const locked = holding('44'.repeat(34), leg.sender, leg.instrumentId, leg.amount, { lockedTo: input.executor });
  const change = holding('55'.repeat(34), leg.sender, leg.instrumentId, (Number(input.balance) - Number(leg.amount)).toFixed(10));
  const extra = input.extra?.((n) => String(10 + n)) ?? { nodes: [] };
  const children = ['1', '2', '3', ...extra.nodes.map((n) => n.nodeId)];
  const factory = input.factory ?? factoryContract(leg.instrumentId.admin);
  return {
    nodes: [
      allocate('0', { ...input, factory, children }),
      spend('1', owned, leg.sender),
      createNode('2', locked),
      createNode('3', change),
      ...extra.nodes,
    ],
    inputs: [factory, owned, ...(extra.inputs ?? [])],
  };
}

/** The transaction and its hash, as `prepare-command` returns them. */
export async function prepared(actAs: string, nodes: DamlTransaction_Node[], inputs: Create[] = [], roots = [nodes[0]!.nodeId]) {
  const message = PreparedTransaction.create({
    transaction: {
      version: '2.1',
      roots,
      nodes,
      nodeSeeds: nodes.map((n) => ({ nodeId: Number(n.nodeId), seed: new Uint8Array(32).fill(7) })),
    },
    metadata: {
      submitterInfo: { actAs: [actAs], commandId: 'fixture-command-id' },
      synchronizerId: 'global-domain::1220dso',
      mediatorGroup: 0,
      transactionUuid: '00000000-0000-4000-8000-000000000000',
      preparationTime: 1000000000000000n,
      inputContracts: inputs.map((contract) => ({ contract: { oneofKind: 'v1' as const, v1: contract }, createdAt: 1000000000000000n, eventBlob: new Uint8Array() })),
      globalKeyMapping: [],
    },
  });
  const preparedTransaction = Buffer.from(PreparedTransaction.toBinary(message)).toString('base64');
  return { preparedTransaction, preparedTransactionHash: await hashPreparedTransaction(preparedTransaction, 'base64') };
}
