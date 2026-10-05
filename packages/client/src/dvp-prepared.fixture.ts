/**
 * Prepared DvP transactions built the way the participant returns them, for the
 * tests: the protobuf `PreparedTransaction` base64-encoded, and its hash under
 * Canton's hashing scheme v2. Test-only; no entry point imports it.
 */
import { PreparedTransaction, type Create, type DamlTransaction_Node, type Value } from '@canton-network/core-ledger-proto';
import { hashPreparedTransaction } from '@canton-network/core-tx-visualizer';

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
const template = (moduleName: string, entityName: string) => ({ packageId: 'cafe', moduleName, entityName });

export function proposalCreate(nodeId: string, input: { venue: string; swapId: string; legs: Record<string, FixtureLeg>; approvers: string[] }): DamlTransaction_Node {
  return node(nodeId, {
    oneofKind: 'create',
    create: {
      lfVersion: '2.1',
      contractId: '00'.repeat(34),
      packageName: 'cancore-swap',
      templateId: template('Swap.Trade', 'SwapProposal'),
      argument: v.record({
        venue: v.party(input.venue),
        swapId: v.text(input.swapId),
        tradeRef: v.none(),
        transferLegs: v.textMap(Object.fromEntries(Object.entries(input.legs).map(([id, leg]) => [id, legValue(leg)]))),
        approvers: v.list(input.approvers.map(v.party)),
        expiresAt: v.time('2026-10-05T12:00:00Z'),
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
      templateId: template('Swap.Trade', 'SwapProposal'),
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

export function allocate(nodeId: string, input: { executor: string; swapId: string; legId: string; leg: FixtureLeg; expectedAdmin?: string; factoryCid?: string; children?: string[] }): DamlTransaction_Node {
  return node(nodeId, {
    oneofKind: 'exercise',
    exercise: {
      lfVersion: '2.1',
      contractId: input.factoryCid ?? FACTORY_CID,
      packageName: 'splice-amulet',
      templateId: template('Splice.ExternalPartyAmuletRules', 'ExternalPartyAmuletRules'),
      interfaceId: { packageId: 'beef', moduleName: 'Splice.Api.Token.AllocationInstructionV1', entityName: 'AllocationFactory' },
      signatories: [input.leg.instrumentId.admin],
      stakeholders: [input.leg.instrumentId.admin],
      actingParties: [input.leg.sender],
      choiceId: 'AllocationFactory_Allocate',
      chosenValue: v.record({
        expectedAdmin: v.party(input.expectedAdmin ?? input.leg.instrumentId.admin),
        allocation: v.record({
          settlement: v.record({
            executor: v.party(input.executor),
            settlementRef: v.record({ id: v.text(input.swapId), cid: v.none() }),
            requestedAt: v.time('2026-10-05T11:00:00Z'),
            allocateBefore: v.time('2026-10-05T11:30:00Z'),
            settleBefore: v.time('2026-10-05T12:00:00Z'),
            meta: meta(),
          }),
          transferLegId: v.text(input.legId),
          transferLeg: legValue(input.leg),
        }),
        requestedAt: v.time('2026-10-05T11:00:00Z'),
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

const createOf = (contractId: string, packageName: string, moduleName: string, entityName: string, argument: Value, signatories: string[]): Create => ({
  lfVersion: '2.1', contractId, packageName, templateId: template(moduleName, entityName), argument, signatories, stakeholders: signatories,
});

/** The registry's allocation factory, as the transaction discloses it. */
export const factoryContract = (admin: string, packageName = 'splice-amulet', contractId = FACTORY_CID) =>
  createOf(contractId, packageName, 'Splice.ExternalPartyAmuletRules', 'ExternalPartyAmuletRules', v.record({ dso: v.party(admin) }), [admin]);

/** A holding: an Amulet for CC (its amount an ExpiringAmount), a registry holding otherwise. */
export function holding(contractId: string, owner: string, instrument: { id: string; admin: string }, amount: string, packageName?: string): Create {
  if (instrument.id === 'Amulet' || instrument.id === 'CC') {
    return createOf(contractId, packageName ?? 'splice-amulet', 'Splice.Amulet', 'Amulet', v.record({
      dso: v.party(instrument.admin),
      owner: v.party(owner),
      amount: v.record({ initialAmount: v.numeric(numeric10(amount)), createdAt: v.record({ number: v.numeric('1') }), ratePerRound: v.record({ rate: v.numeric('0.0000000001') }) }),
    }), [instrument.admin, owner]);
  }
  return createOf(contractId, packageName ?? 'utility-registry-holding-v0', 'Utility.Registry.Holding.V0.Holding', 'Holding', v.record({
    registrar: v.party(instrument.admin),
    owner: v.party(owner),
    instrument: v.record({ source: v.party(instrument.admin), id: v.text(instrument.id) }),
    amount: v.numeric(numeric10(amount)),
    lock: v.none(),
  }), [instrument.admin, owner]);
}

export const createNode = (nodeId: string, create: Create): DamlTransaction_Node => node(nodeId, { oneofKind: 'create', create });

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
  factory?: Create;
}) {
  const { leg } = input;
  const owned = holding('33'.repeat(34), leg.sender, leg.instrumentId, input.balance);
  const locked = holding('44'.repeat(34), leg.sender, leg.instrumentId, leg.amount);
  const change = holding('55'.repeat(34), leg.sender, leg.instrumentId, (Number(input.balance) - Number(leg.amount)).toFixed(10));
  const extra = input.extra?.((n) => String(10 + n)) ?? { nodes: [] };
  const children = ['1', '2', '3', ...extra.nodes.map((n) => n.nodeId)];
  const factory = input.factory ?? factoryContract(leg.instrumentId.admin);
  return {
    nodes: [
      allocate('0', { ...input, factoryCid: factory.contractId, children }),
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
