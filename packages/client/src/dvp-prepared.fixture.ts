/**
 * Prepared DvP transactions built the way the participant returns them, for the
 * tests: the protobuf `PreparedTransaction` base64-encoded, and its hash under
 * Canton's hashing scheme v2. Test-only; no entry point imports it.
 */
import { PreparedTransaction, type Create, type DamlTransaction_Node, type Value } from '@canton-network/core-ledger-proto';
import { hashPreparedTransaction } from '@canton-network/core-tx-visualizer';
import { ALLOCATION_FACTORY_INTERFACE, DEFAULT_TRUSTED_PACKAGES } from './dvp-verify';

/**
 * The ids the dev stand actually runs, read from its own records (dev DB `swap_legs.details`
 * allocation disclosures and `tokens.admin_party`, 2026-10-05): the honest trees are built from
 * them, so a verifier pinned to anything else fails these tests.
 */
export const PKG = {
  swap: DEFAULT_TRUSTED_PACKAGES.swap['cancore-swap']!.at(-1)!,
  /** splice-amulet: LockedAmulet, AmuletAllocation, ExternalPartyAmuletRules. */
  amulet: '8fe7573f5535dc5b910a1f24d7d980da0e10ab38f8d29cb397146119bbfb7b3a',
  /** utility-registry-holding-v0: Holding. */
  holding: '415a1ec96a9e2839453e9aa1c5c71b6511c008c79511cb6f873e0b7393fe3b92',
  /** utility-registry-v0: DvpLegAllocation. */
  registry: '8c654487d9f5fb195fbcdd7b44cd8e365b1ea39c15ae62ce6c7a48343f1210dd',
  /** utility-registry-app-v0 0.9.2: the allocation factory. */
  registryApp: '1eddd268bdd50d6e262722bea799c9455da032b3f94489e589975151b274b8c0',
};

/** Parties of the dev stand, as its ledger names them. */
export const DEV = {
  dso: 'DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a',
  cbtcRegistrar: 'cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff',
  utilityOperator: 'auth0_007c65f857f1c3d599cb6df73775::1220d2d732d042c281cee80f483ab80f3cbaa4782860ed5f4dc228ab03dedd2ee8f9',
  venue: 'cancore::12204f383aca6af056f6d83c9b5758fbc53c27a743e2f9d591e61bc657202172524b',
};

const isCc = (id: string) => id === 'Amulet' || id === 'CC';

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

export function allocate(nodeId: string, input: { executor: string; swapId: string; legId: string; leg: FixtureLeg; expectedAdmin?: string; factory?: Create; children?: string[]; settleBefore?: string; interfacePackageId?: string; windows?: Window; inputHoldingCids?: string[]; exercisedPackageId?: string; exercisedPackageName?: string }): DamlTransaction_Node {
  const times: Record<string, string | null> = { requestedAt: at(0), allocateBefore: at(30), settleBefore: input.settleBefore ?? at(60), ...input.windows };
  const settlementTimes = Object.fromEntries(Object.entries(times).flatMap(([k, t]) => (t === null ? [] : [[k, v.time(t)] as const])));
  const factory = input.factory ?? factoryContract(input.leg.instrumentId.admin);
  return node(nodeId, {
    oneofKind: 'exercise',
    exercise: {
      lfVersion: '2.1',
      contractId: factory.contractId,
      // Under a Daml upgrade the factory is exercised under a newer package than it was created with.
      packageName: input.exercisedPackageName ?? factory.packageName,
      templateId: { ...factory.templateId!, packageId: input.exercisedPackageId ?? factory.templateId!.packageId },
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
            ...settlementTimes,
            meta: meta(),
          }),
          transferLegId: v.text(input.legId),
          transferLeg: legValue(input.leg),
        }),
        requestedAt: v.time(at(0)),
        inputHoldingCids: v.list((input.inputHoldingCids ?? []).map((cid) => ({ sum: { oneofKind: 'contractId', contractId: cid } }))),
        extraArgs: v.record({ context: v.record({ values: v.textMap({}) }), meta: meta() }),
      }),
      consuming: false,
      children: input.children ?? [],
      choiceObservers: [],
    },
  });
}

export const FACTORY_CID = '22'.repeat(34);

/** Settlement instants to replace; null leaves the field out. */
export type Window = Partial<Record<'requestedAt' | 'allocateBefore' | 'settleBefore', string | null>>;

const createOf = (contractId: string, packageName: string, packageId: string, moduleName: string, entityName: string, argument: Value, signatories: string[]): Create => ({
  lfVersion: '2.1', contractId, packageName, templateId: template(moduleName, entityName, packageId), argument, signatories, stakeholders: signatories,
});

/**
 * The registry's allocation factory, as the transaction discloses it: for CC the DSO's
 * ExternalPartyAmuletRules, for a registry token the utility's AllocationFactory, signed by the
 * operator and the registrar. `signatory` replaces the admin among the signers.
 */
export const factoryContract = (admin: string, over: { instrument?: string; packageName?: string; packageId?: string; signatory?: string } = {}) =>
  isCc(over.instrument ?? 'Amulet')
    ? createOf(FACTORY_CID, over.packageName ?? 'splice-amulet', over.packageId ?? PKG.amulet, 'Splice.ExternalPartyAmuletRules', 'ExternalPartyAmuletRules',
      v.record({ dso: v.party(admin) }), [over.signatory ?? admin])
    : createOf(FACTORY_CID, over.packageName ?? 'utility-registry-app-v0', over.packageId ?? PKG.registryApp, 'Utility.Registry.App.V0.Service.AllocationFactory', 'AllocationFactory',
      v.record({ operator: v.party(DEV.utilityOperator), provider: v.party(admin), registrar: v.party(admin) }), [DEV.utilityOperator, over.signatory ?? admin]);

/** A holding: an Amulet for CC (its amount an ExpiringAmount), a registry holding otherwise. */
export function holding(
  contractId: string, owner: string, instrument: { id: string; admin: string }, amount: string,
  over: { packageName?: string; packageId?: string; lockedTo?: string } = {},
): Create {
  const lock = over.lockedTo ? v.record({ holders: v.list([v.party(over.lockedTo)]), expiresAt: v.time(at(60)), context: v.text('allocation for settlement') }) : undefined;
  if (isCc(instrument.id)) {
    const amulet = v.record({
      dso: v.party(instrument.admin),
      owner: v.party(owner),
      amount: v.record({ initialAmount: v.numeric(numeric10(amount)), createdAt: v.record({ number: v.numeric('1') }), ratePerRound: v.record({ rate: v.numeric('0.0000000001') }) }),
    });
    return lock
      ? createOf(contractId, over.packageName ?? 'splice-amulet', over.packageId ?? PKG.amulet, 'Splice.Amulet', 'LockedAmulet', v.record({ amulet, lock }), [instrument.admin, owner])
      : createOf(contractId, over.packageName ?? 'splice-amulet', over.packageId ?? PKG.amulet, 'Splice.Amulet', 'Amulet', amulet, [instrument.admin, owner]);
  }
  // The dev Holding's own shape: operator, provider, registrar, owner, instrument, label, amount, lock.
  return createOf(contractId, over.packageName ?? 'utility-registry-holding-v0', over.packageId ?? PKG.holding, 'Utility.Registry.Holding.V0.Holding', 'Holding', v.record({
    operator: v.party(DEV.utilityOperator),
    provider: v.party(instrument.admin),
    registrar: v.party(instrument.admin),
    owner: v.party(owner),
    instrument: v.record({ source: v.party(instrument.admin), id: v.text(instrument.id), scheme: v.text('RegistrarInternalScheme') }),
    label: v.text(''),
    amount: v.numeric(numeric10(amount)),
    lock: lock ? { sum: { oneofKind: 'optional', optional: { value: lock } } } : v.none(),
  }), [DEV.utilityOperator, instrument.admin, owner]);
}

export const createNode = (nodeId: string, create: Create): DamlTransaction_Node => node(nodeId, { oneofKind: 'create', create });

/** A node from an exercise description; `nodeId` is set by the caller. */
export const exercise = (e: Extract<NodeType, { oneofKind: 'exercise' }>['exercise']): DamlTransaction_Node => node('x', { oneofKind: 'exercise', exercise: e });

/** A trusted-package TransferFactory_Transfer of `from` to `receiver`: what a hostile allocation would hide. */
export const spendTransfer = (from: Create, receiver: string, sender?: string): Extract<NodeType, { oneofKind: 'exercise' }>['exercise'] => {
  const named = from.argument?.sum.oneofKind === 'record' ? from.argument.sum.record.fields.find((f) => f.label === 'owner')?.value : undefined;
  const owner = sender !== undefined ? v.party(sender) : named;
  if (!owner) throw new Error('spendTransfer: the contract has no owner; name the sender');
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
  factory?: Create; settleBefore?: string; interfacePackageId?: string; windows?: Window;
  exercisedPackageId?: string; exercisedPackageName?: string;
}) {
  const { leg } = input;
  const owned = holding('33'.repeat(34), leg.sender, leg.instrumentId, input.balance);
  // splice-amulet locks to the DSO; the utility registry to the executor.
  const locked = holding('44'.repeat(34), leg.sender, leg.instrumentId, leg.amount, { lockedTo: isCc(leg.instrumentId.id) ? leg.instrumentId.admin : input.executor });
  const change = holding('55'.repeat(34), leg.sender, leg.instrumentId, (Number(input.balance) - Number(leg.amount)).toFixed(10));
  const extra = input.extra?.((n) => String(10 + n)) ?? { nodes: [] };
  const children = ['1', '2', '3', '4', ...extra.nodes.map((n) => n.nodeId)];
  const factory = input.factory ?? factoryContract(leg.instrumentId.admin, { instrument: leg.instrumentId.id });
  // The allocation the registry records: AmuletAllocation for CC, DvpLegAllocation for a registry token.
  const spec = v.record({
    settlement: v.record({ executor: v.party(input.executor), settlementRef: v.record({ id: v.text(input.swapId), cid: v.none() }) }),
    transferLegId: v.text(input.legId),
    transferLeg: legValue(leg),
  });
  const allocation = isCc(leg.instrumentId.id)
    ? createOf('66'.repeat(34), 'splice-amulet', PKG.amulet, 'Splice.AmuletAllocation', 'AmuletAllocation',
      v.record({ allocation: spec, lockedAmulet: { sum: { oneofKind: 'contractId', contractId: locked.contractId } } }), [leg.instrumentId.admin, leg.sender])
    : createOf('66'.repeat(34), 'utility-registry-v0', PKG.registry, 'Utility.Registry.V0.Holding.Allocation', 'DvpLegAllocation',
      v.record({ operator: v.party(DEV.utilityOperator), registrar: v.party(leg.instrumentId.admin), allocation: spec, lockedHolding: { sum: { oneofKind: 'contractId', contractId: locked.contractId } } }),
      [DEV.utilityOperator, leg.instrumentId.admin, leg.sender]);
  // What splice-amulet 0.1.22 adds around the lock (ExternalPartyAmuletRules allocate → two-step transfer):
  // an interface fetch of each input holding and a fetch of the DSO's AmuletRules — the transfer itself is a
  // function inside the factory exercise, not a choice node — and an AppRewardCoupon (provider = sender)
  // signed by the DSO. The lock is held by the DSO.
  const cc = isCc(leg.instrumentId.id);
  const rules = createOf('77'.repeat(34) + 'aa', 'splice-amulet', PKG.amulet, 'Splice.AmuletRules', 'AmuletRules', v.record({ dso: v.party(leg.instrumentId.admin) }), [leg.instrumentId.admin]);
  const coupon = createOf('88'.repeat(34) + 'aa', 'splice-amulet', PKG.amulet, 'Splice.Amulet', 'AppRewardCoupon',
    v.record({ dso: v.party(leg.instrumentId.admin), provider: v.party(leg.sender), featured: { sum: { oneofKind: 'bool', bool: false } }, amount: v.numeric('0.0000000001'), round: v.record({ number: v.numeric('1') }), beneficiary: v.none() }),
    [leg.instrumentId.admin]);
  const fetchOf = (nodeId: string, target: Create, interfaceId?: { packageId: string; moduleName: string; entityName: string }) =>
    node(nodeId, { oneofKind: 'fetch', fetch: { lfVersion: '2.1', contractId: target.contractId, packageName: target.packageName, templateId: target.templateId, signatories: target.signatories, stakeholders: target.stakeholders, actingParties: [leg.sender], interfaceId } });
  const ccNodes = cc
    ? [
      fetchOf('5', owned, { packageId: '718a0f77e505a8de22f188bd4c87fe74101274e9d4cb1bfac7d09aec7158d35b', moduleName: 'Splice.Api.Token.HoldingV1', entityName: 'Holding' }),
      fetchOf('6', rules),
      createNode('7', coupon),
    ]
    : [];
  return {
    nodes: [
      allocate('0', { ...input, factory, children: [...children, ...ccNodes.map((n) => n.nodeId)], inputHoldingCids: [owned.contractId] }),
      spend('1', owned, leg.sender),
      createNode('2', locked),
      createNode('3', change),
      createNode('4', allocation),
      ...extra.nodes,
      ...ccNodes,
    ],
    inputs: [factory, owned, ...(cc ? [rules] : []), ...(extra.inputs ?? [])],
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

/** A party's CC TransferPreapproval, as a send through it discloses it: signed by the receiver and its provider. */
export const preapprovalContract = (contractId: string, receiver: string, provider = DEV.venue) =>
  createOf(contractId, 'splice-amulet', PKG.amulet, 'Splice.AmuletRules', 'TransferPreapproval',
    v.record({ dso: v.party(DEV.dso), receiver: v.party(receiver), provider: v.party(provider) }), [receiver, provider]);

/**
 * One leg of a CC `tokens.send` as the participant prepares it: `TransferPreapproval_Send` on the
 * receiver's preapproval, acting as `party`, spending one amulet of `input` and creating `outputs`.
 * The overrides are the shapes a hostile API would hand over instead.
 */
export async function selfSendLeg(input: {
  party: string; kind: 'transfer' | 'fee'; receiver: string; input: string; ids: string;
  outputs: Array<{ owner: string; amount: string; lockedTo?: string }>;
  actAs?: string; inputOwner?: string; extra?: (contract: Create) => DamlTransaction_Node; extraInput?: Create;
}) {
  const cc = { id: 'Amulet', admin: DEV.dso };
  const preapproval = preapprovalContract(`${input.ids}f`.repeat(34), input.receiver);
  const owned = holding(`${input.ids}0`.repeat(34), input.inputOwner ?? input.party, cc, input.input);
  const outputs = input.outputs.map((o, i) => createNode(String(i + 2), holding(`${input.ids}${i + 1}`.repeat(34), o.owner, cc, o.amount, { lockedTo: o.lockedTo })));
  const extra = input.extra && input.extraInput ? [{ ...input.extra(input.extraInput), nodeId: String(outputs.length + 2) }] : [];
  const root = node('0', {
    oneofKind: 'exercise',
    exercise: {
      lfVersion: '2.1', contractId: preapproval.contractId, packageName: preapproval.packageName, templateId: preapproval.templateId,
      signatories: preapproval.signatories, stakeholders: preapproval.stakeholders, actingParties: [input.party],
      choiceId: 'TransferPreapproval_Send', chosenValue: v.record({ sender: v.party(input.party), amount: v.numeric(numeric10(input.outputs[0]!.amount)) }),
      consuming: false, children: ['1', ...outputs.map((n) => n.nodeId), ...extra.map((n) => n.nodeId)], choiceObservers: [],
    },
  });
  const built = await prepared(input.actAs ?? input.party, [root, spend('1', owned, input.party), ...outputs, ...extra], [preapproval, owned, ...(input.extraInput ? [input.extraInput] : [])]);
  return { kind: input.kind, ...built };
}
