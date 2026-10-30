import type { Hex } from '@cancore/contracts';
import { canonicalDecimal, checkHoldingsTransfer, checkRegistryAccept, isOwnParty } from './checks';
import { CANTON_TRANSFER_FACTORIES } from './factories';
import { NODE_KEY, OTHER_KEY, party } from './fixtures';
import { CantonRefusal } from './legs';
import type { PreparedOf } from './operations';
import type { CantonTransaction, DamlValue, TransactionNode } from './transaction';

const KEY = `0x${NODE_KEY}` as Hex;
const ME = party();
const OPERATOR = 'cancore-operator::1220ab';
const RECEIVER = 'treasury::1220cd';
const PKG = 'ab'.repeat(32);
const NOW = 1_790_000_000_000;

const v = {
  party: (p: string): DamlValue => ({ t: 'party', v: p }),
  text: (t: string): DamlValue => ({ t: 'text', v: t }),
  numeric: (n: string): DamlValue => ({ t: 'numeric', v: n }),
  cid: (c: string): DamlValue => ({ t: 'contractId', v: c }),
  list: (l: DamlValue[]): DamlValue => ({ t: 'list', v: l }),
  time: (micros: bigint): DamlValue => ({ t: 'timestamp', v: micros.toString() }),
  record: (fields: Record<string, DamlValue>): DamlValue => ({ t: 'record', v: fields }),
};
const tx = (nodes: TransactionNode[], actAs = [ME]): CantonTransaction => ({
  commandId: 'c',
  actAs,
  roots: [nodes[0]!.nodeId],
  nodes: Object.fromEntries(nodes.map((n) => [n.nodeId, n])),
  inputContracts: [],
  synchronizerId: 's',
  preparationTime: '0',
});
const refused = (run: () => unknown, detail: RegExp) => {
  expect(run).toThrow(CantonRefusal);
  expect(run).toThrow(detail);
};

describe('the party is recognised by the namespace of the node key', () => {
  test('own party, another key’s, malformed', () => {
    expect(isOwnParty(ME, KEY)).toBe(true);
    expect(isOwnParty(party(OTHER_KEY), KEY)).toBe(false);
    expect(isOwnParty(`${ME}::extra`, KEY)).toBe(false);
    expect(isOwnParty(`::${ME.split('::')[1]}`, KEY)).toBe(false);
    expect(isOwnParty(42, KEY)).toBe(false);
  });

  test('decimals compare by value', () => {
    expect(canonicalDecimal('1.5000000000')).toBe('1.5');
    expect(canonicalDecimal('10')).toBe('10');
    expect(canonicalDecimal('10.0')).toBe('10');
    expect(() => canonicalDecimal('1e3')).toThrow(CantonRefusal);
  });
});

describe('registry.accept', () => {
  const summary = { fillerId: 'cancore-dev-1', party: ME, operator: OPERATOR, proposalCid: 'aa'.repeat(34) };
  const honest = (over: { entry?: Partial<Record<string, DamlValue>>; signatories?: string[]; choice?: string; contractId?: string; acting?: string[]; extra?: TransactionNode[] } = {}) =>
    tx([
      {
        nodeId: '0', kind: 'exercise', contractId: over.contractId ?? summary.proposalCid, packageName: 'cancore-intent',
        templateId: `${PKG}:Intent.FillerRegistry:FillerRegistryEntryProposal`, choice: over.choice ?? 'FillerRegistryEntryProposal_Accept',
        chosenValue: v.record({}), actingParties: over.acting ?? [ME], signatories: [OPERATOR], stakeholders: [OPERATOR, ME], consuming: true,
        children: ['1', ...(over.extra ?? []).map((n) => n.nodeId)],
      },
      {
        nodeId: '1', kind: 'create', contractId: 'bb'.repeat(34), packageName: 'cancore-intent', templateId: `${PKG}:Intent.FillerRegistry:FillerRegistryEntry`,
        argument: v.record({ operator: v.party(OPERATOR), fillerId: v.text('cancore-dev-1'), filler: v.party(ME), ...over.entry }),
        signatories: over.signatories ?? [OPERATOR, ME], stakeholders: [OPERATOR, ME],
      },
      ...(over.extra ?? []),
    ]);
  const prepared = (s = summary) => ({ summary: s }) as unknown as PreparedOf<'registry.accept'>;
  const check = checkRegistryAccept({ fillerId: 'cancore-dev-1', publicKey: KEY });

  test('the honest accept passes', () => {
    expect(() => check(prepared(), [honest()])).not.toThrow();
  });

  test.each([
    ['another fillerId stated', () => check(prepared({ ...summary, fillerId: 'someone' }), [honest()]), /fillerId someone/],
    ['another party stated', () => check(prepared({ ...summary, party: party(OTHER_KEY) }), [honest()]), /another party than the node key/],
    ['another choice', () => check(prepared(), [honest({ choice: 'Archive' })]), /not the proposal's accept/],
    ['another contract', () => check(prepared(), [honest({ contractId: 'cc'.repeat(34) })]), /another contract/],
    ['acting as the operator too', () => check(prepared(), [honest({ acting: [ME, OPERATOR] })]), /acts as another party/],
    ['an entry for another fillerId', () => check(prepared(), [honest({ entry: { fillerId: v.text('x') } })]), /another fillerId/],
    ['an entry for another operator', () => check(prepared(), [honest({ entry: { operator: v.party('evil::1220ee') } })]), /another operator/],
    ['an entry not co-signed', () => check(prepared(), [honest({ signatories: [OPERATOR] })]), /not signed by exactly/],
    ['anything else in it', () => check(prepared(), [honest({ extra: [{ nodeId: '2', kind: 'create', contractId: 'dd'.repeat(34), packageName: 'x', templateId: `${PKG}:X:Y`, argument: v.record({}), signatories: [ME], stakeholders: [ME] }] })]), /exactly the entry/],
    ['two transactions', () => check(prepared(), [honest(), honest()]), /one transaction/],
  ])('%s: refused', (_name, run, detail) => refused(run, detail));
});

describe('holdings.transfer', () => {
  const params = { asset: { admin: 'registrar::1220aa', id: 'CNRX' }, amount: '25', toParty: RECEIVER };
  const executeBefore = String(NOW / 1000 + 600);
  const summary = { asset: params.asset, amount: '25.0000000000', receiver: RECEIVER, inputHoldingCids: ['h1', 'h2'], executeBefore };
  const transferArg = (over: Record<string, DamlValue> = {}) =>
    v.record({
      expectedAdmin: v.party(params.asset.admin),
      transfer: v.record({
        sender: v.party(ME),
        receiver: v.party(RECEIVER),
        amount: v.numeric('25.0000000000'),
        instrumentId: v.record({ admin: v.party(params.asset.admin), id: v.text('CNRX') }),
        requestedAt: v.time(BigInt(NOW) * 1000n),
        executeBefore: v.time(BigInt(executeBefore) * 1_000_000n),
        inputHoldingCids: v.list([v.cid('h2'), v.cid('h1')]),
        meta: v.record({}),
        ...over,
      }),
      extraArgs: v.record({}),
    });
  const honest = (over: { arg?: DamlValue; acting?: string[]; choice?: string; children?: TransactionNode[] } = {}) =>
    tx([
      {
        nodeId: '0', kind: 'exercise', contractId: 'fa'.repeat(34), packageName: 'utility-registry-app-v0', templateId: `${PKG}:Utility.Registry.App.V0.Service.TransferFactory:TransferFactory`,
        interfaceId: `${'cd'.repeat(32)}:Splice.Api.Token.TransferInstructionV1:TransferFactory`, choice: over.choice ?? 'TransferFactory_Transfer',
        chosenValue: over.arg ?? transferArg(), actingParties: over.acting ?? [ME], signatories: ['registrar::1220aa'], stakeholders: ['registrar::1220aa'], consuming: false,
        children: (over.children ?? []).map((n) => n.nodeId),
      },
      ...(over.children ?? []),
    ]);
  const holding = (nodeId: string, owner: string): TransactionNode => ({
    nodeId, kind: 'create', contractId: `${nodeId}${'0'.repeat(67)}`, packageName: 'utility-registry-holding-v0', templateId: `${PKG}:Utility.Registry.Holding.V0.Holding:Holding`,
    argument: v.record({ owner: v.party(owner), instrument: v.record({}), amount: v.numeric('1') }), signatories: ['registrar::1220aa', owner], stakeholders: [owner],
  });
  const prepared = (s = summary) => ({ summary: s }) as unknown as PreparedOf<'holdings.transfer'>;
  const check = checkHoldingsTransfer({ params, publicKey: KEY, nowMs: NOW });

  // An honest transfer passes only through a pinned factory with its subtree accounted for: TC-SDK-2352-01, -02 below.

  test.each([
    ['another receiver stated', () => check(prepared({ ...summary, receiver: 'evil::1220ee' }), [honest()]), /receiver is not the one asked/],
    ['another amount stated', () => check(prepared({ ...summary, amount: '26' }), [honest()]), /amount is not the one asked/],
    ['another instrument stated', () => check(prepared({ ...summary, asset: { ...params.asset, id: 'CC' } }), [honest()]), /instrument is not the one asked/],
    ['acting as another party', () => check(prepared(), [honest({ acting: [party(OTHER_KEY)] })]), /another party than the node key/],
    ['another choice', () => check(prepared(), [honest({ choice: 'TransferFactory_PublicFetch' })]), /not TransferFactory_Transfer/],
    ['another receiver in the transfer', () => check(prepared(), [honest({ arg: transferArg({ receiver: v.party('evil::1220ee') }) })]), /another receiver/],
    ['another amount in the transfer', () => check(prepared(), [honest({ arg: transferArg({ amount: v.numeric('250') }) })]), /another amount/],
    ['other holdings spent', () => check(prepared(), [honest({ arg: transferArg({ inputHoldingCids: v.list([v.cid('h1'), v.cid('h9')]) }) })]), /other holdings/],
    ['another executeBefore', () => check(prepared(), [honest({ arg: transferArg({ executeBefore: v.time(1n) }) })]), /executeBefore is not/],
    ['a factory not pinned for the admin', () => check(prepared(), [honest({ children: [holding('1', ME)] })]), /not a pinned factory/],
  ])('%s: refused', (_name, run, detail) => refused(run, detail));

  test('an executeBefore already passed is refused', () => {
    const past = String(NOW / 1000 - 1);
    const late = checkHoldingsTransfer({ params, publicKey: KEY, nowMs: NOW });
    refused(() => late(prepared({ ...summary, executeBefore: past }), [honest({ arg: transferArg({ executeBefore: v.time(BigInt(past) * 1_000_000n) }) })]), /has passed/);
  });

  test('a transfer to the party itself is refused', () => {
    const self = checkHoldingsTransfer({ params: { ...params, toParty: ME }, publicKey: KEY, nowMs: NOW });
    refused(() => self(prepared({ ...summary, receiver: ME }), [honest({ arg: transferArg({ receiver: v.party(ME) }) })]), /to the party itself/);
  });
});

/**
 * holdings.transfer of CNRX through the dev registry, decoded down to the
 * subtree (sdk#105 review): the root's arguments are honest in every case;
 * what the factory does under it is not. Shapes as cnrx-registry 0.2.3
 * builds them: `CnrxHolding { holding: HoldingView }`, the owner inside
 * `holding.account.owner`, the offer a `CnrxTransferOffer { transfer }`.
 */
describe('holdings.transfer: the subtree under an honest root (TC-SDK-2352)', () => {
  const ADMIN = 'cancore::12204f383aca6af056f6d83c9b5758fbc53c27a743e2f9d591e61bc657202172524b';
  const CNRX = 'd495b7d2e9376e42bb58845c47e165492bba917216352636b6c357c76d3bb736';
  const TI_V1 = '55ba4deb0ad4662c4168b39859738a0e91388d252286480c7331b3f71a517281';
  const asset = { admin: ADMIN, id: 'CNRX' };
  const params = { asset, amount: '25', toParty: RECEIVER };
  const executeBefore = String(NOW / 1000 + 600);
  const opt = (p?: string): DamlValue => (p ? { t: 'optional', v: v.party(p) } : { t: 'optional' });
  const account = (owner: string) => v.record({ owner: opt(owner), provider: opt(), id: v.text('') });
  const instrument = (id = 'CNRX') => v.record({ admin: v.party(ADMIN), id: v.text(id) });
  const view = (owner: string, amount: string, locked = false) =>
    v.record({ account: account(owner), instrumentId: instrument(), amount: v.numeric(amount), lock: locked ? { t: 'optional', v: v.record({ holders: v.list([v.party(ADMIN)]) }) } : opt(), meta: v.record({}) });
  const holdingTemplate = `${CNRX}:Cnrx.Holding:CnrxHolding`;
  const input = (cid: string, owner: string, amount: string) => ({
    contractId: cid, packageName: 'cnrx-registry', templateId: holdingTemplate, argument: v.record({ holding: view(owner, amount) }), signatories: [ADMIN, owner], stakeholders: [ADMIN, owner],
  });
  const archive = (nodeId: string, cid: string, owner = ME): TransactionNode => ({
    nodeId, kind: 'exercise', contractId: cid, packageName: 'cnrx-registry', templateId: holdingTemplate, choice: 'Archive', chosenValue: v.record({}),
    actingParties: [ADMIN, owner], signatories: [ADMIN, owner], stakeholders: [ADMIN, owner], consuming: true, children: [],
  });
  const mint = (nodeId: string, owner: string, amount: string, locked = false): TransactionNode => ({
    nodeId, kind: 'create', contractId: `${nodeId}${'e'.repeat(67)}`, packageName: 'cnrx-registry', templateId: holdingTemplate,
    argument: v.record({ holding: view(owner, amount, locked) }), signatories: [ADMIN, owner], stakeholders: [ADMIN, owner],
  });
  const offer = (nodeId: string, amount = '25'): TransactionNode => ({
    nodeId, kind: 'create', contractId: `${nodeId}${'f'.repeat(67)}`, packageName: 'cnrx-registry', templateId: `${CNRX}:Cnrx.Transfer:CnrxTransferOffer`,
    argument: v.record({ transfer: v.record({ sender: account(ME), receiver: account(RECEIVER), amount: v.numeric(amount), instrumentId: instrument() }), originalInstructionCid: opt() }),
    signatories: [ME, ADMIN], stakeholders: [ME, ADMIN, RECEIVER],
  });
  const transferArg = (inputs: string[]) =>
    v.record({
      expectedAdmin: v.party(ADMIN),
      transfer: v.record({
        sender: v.party(ME), receiver: v.party(RECEIVER), amount: v.numeric('25.0000000000'), instrumentId: instrument(),
        requestedAt: v.time(BigInt(NOW) * 1000n), executeBefore: v.time(BigInt(executeBefore) * 1_000_000n), inputHoldingCids: v.list(inputs.map(v.cid)), meta: v.record({}),
      }),
      extraArgs: v.record({}),
    });
  /** The factory root over `children`, with the inputs the transaction discloses. */
  const transfer = (o: { stated?: string[]; children: TransactionNode[]; inputs?: ReturnType<typeof input>[]; factory?: string }): CantonTransaction => {
    const stated = o.stated ?? ['h1', 'h2'];
    const root: TransactionNode = {
      nodeId: '0', kind: 'exercise', contractId: 'fa'.repeat(34), packageName: 'cnrx-registry', templateId: o.factory ?? `${CNRX}:Cnrx.Rules:CnrxRules`,
      interfaceId: `${TI_V1}:Splice.Api.Token.TransferInstructionV1:TransferFactory`, choice: 'TransferFactory_Transfer', chosenValue: transferArg(stated),
      actingParties: [ME], signatories: [ADMIN], stakeholders: [ADMIN], consuming: false, children: o.children.map((n) => n.nodeId),
    };
    return { ...tx([root, ...o.children]), inputContracts: o.inputs ?? [input('h1', ME, '20'), input('h2', ME, '10')] };
  };
  const prepared = (stated = ['h1', 'h2']) =>
    ({ summary: { asset, amount: '25', receiver: RECEIVER, inputHoldingCids: stated, executeBefore } }) as unknown as PreparedOf<'holdings.transfer'>;
  const check = checkHoldingsTransfer({ params, publicKey: KEY, nowMs: NOW });

  test('TC-SDK-2352-01: the honest direct transfer passes: inputs archived, 25 to the receiver, 5 back as change', () => {
    expect(() => check(prepared(), [transfer({ children: [archive('1', 'h1'), archive('2', 'h2'), mint('3', RECEIVER, '25'), mint('4', ME, '5')] })])).not.toThrow();
  });

  test('TC-SDK-2352-02: the honest offer passes: inputs archived, 25 locked to the sender under the offer, 5 back as change', () => {
    expect(() => check(prepared(), [transfer({ children: [archive('1', 'h1'), archive('2', 'h2'), mint('3', ME, '25', true), mint('4', ME, '5'), offer('5')] })])).not.toThrow();
  });

  test('TC-SDK-2352-03: attack — the factory archives another holding of the sender and mints the whole balance to the receiver: refused', () => {
    const attack = transfer({
      stated: ['h1'],
      inputs: [input('h1', ME, '25'), input('h3', ME, '1000')],
      children: [archive('1', 'h1'), archive('2', 'h3'), mint('3', RECEIVER, '1025')],
    });
    refused(() => check(prepared(['h1']), [attack]), /not a stated input|receiver/);
  });

  test('TC-SDK-2352-04: the stated inputs, but the receiver is credited more than the amount asked: refused', () => {
    refused(() => check(prepared(), [transfer({ children: [archive('1', 'h1'), archive('2', 'h2'), mint('3', RECEIVER, '30')] })]), /receiver/);
  });

  test('TC-SDK-2352-05: change above the inputs minus the amount: refused', () => {
    refused(() => check(prepared(), [transfer({ children: [archive('1', 'h1'), archive('2', 'h2'), mint('3', RECEIVER, '25'), mint('4', ME, '50')] })]), /change/);
  });

  test('TC-SDK-2352-06: a factory outside the pinned list for the admin: refused', () => {
    const forged = transfer({ factory: `${'ee'.repeat(32)}:Evil.Factory:Rules`, children: [archive('1', 'h1'), archive('2', 'h2'), mint('3', RECEIVER, '25'), mint('4', ME, '5')] });
    refused(() => check(prepared(), [forged]), /factory/);
  });

  test("TC-SDK-2352-07: another exercise on a contract of the sender (its registry entry archived): refused", () => {
    const entry: TransactionNode = {
      nodeId: '5', kind: 'exercise', contractId: 'ab'.repeat(34), packageName: 'cancore-intent', templateId: `${PKG}:Intent.FillerRegistry:FillerRegistryEntry`, choice: 'Archive',
      chosenValue: v.record({}), actingParties: [OPERATOR, ME], signatories: [OPERATOR, ME], stakeholders: [OPERATOR, ME], consuming: true, children: [],
    };
    refused(() => check(prepared(), [transfer({ children: [archive('1', 'h1'), archive('2', 'h2'), mint('3', RECEIVER, '25'), mint('4', ME, '5'), entry] })]), /not a stated input|exercise/);
  });

  test('TC-SDK-2352-08: a holding minted to a third party: refused', () => {
    refused(() => check(prepared(), [transfer({ children: [archive('1', 'h1'), archive('2', 'h2'), mint('3', RECEIVER, '25'), mint('4', 'evil::1220ee', '5')] })]), /third party/);
  });

  test('TC-SDK-2352-09: a stated input left unspent, or one not disclosed with the transaction: refused', () => {
    refused(() => check(prepared(), [transfer({ children: [archive('1', 'h1'), mint('3', RECEIVER, '25'), mint('4', ME, '5')] })]), /not spent/);
    refused(() => check(prepared(), [transfer({ inputs: [input('h1', ME, '20')], children: [archive('1', 'h1'), archive('2', 'h2'), mint('3', RECEIVER, '25'), mint('4', ME, '5')] })]), /not disclosed/);
  });

  test('TC-SDK-2352-10: a pending transfer for another amount than it locks: refused', () => {
    refused(() => check(prepared(), [transfer({ children: [archive('1', 'h1'), archive('2', 'h2'), mint('3', ME, '25', true), mint('4', ME, '5'), offer('5', '30')] })]), /another amount/);
  });

  test('TC-SDK-2352-11: the dev CNRX registrar is pinned to cnrx-registry 0.2.3', () => {
    expect(CANTON_TRANSFER_FACTORIES[ADMIN]).toEqual([expect.objectContaining({ packageId: CNRX, factory: 'Cnrx.Rules:CnrxRules', holding: 'Cnrx.Holding:CnrxHolding' })]);
  });
});

describe('holdings.transfer of CC: a Splice amulet transfer through the receiver’s preapproval (CAN-2931)', () => {
  const DSO = 'DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a';
  const AMULET_PKG = '17b6f7c18efec9022dde39a19039783c68490a722e8a5088b22ee034678171a2';
  const TI_V1 = '55ba4deb0ad4662c4168b39859738a0e91388d252286480c7331b3f71a517281';
  const PROVIDER = 'validator::1220ef';
  const asset = { admin: DSO, id: 'Amulet' };
  const params = { asset, amount: '25', toParty: RECEIVER };
  const executeBefore = String(NOW / 1000 + 600);
  const AMULET = `${AMULET_PKG}:Splice.Amulet:Amulet`;
  const amuletArg = (owner: string, amount: string) =>
    v.record({ dso: v.party(DSO), owner: v.party(owner), amount: v.record({ initialAmount: v.numeric(amount), createdAt: v.record({ number: { t: 'int64', v: '7' } as DamlValue }), ratePerRound: v.record({ rate: v.numeric('0.0000190259') }) }) });
  const input = (cid: string, owner: string, amount: string) => ({ contractId: cid, packageName: 'splice-amulet', templateId: AMULET, argument: amuletArg(owner, amount), signatories: [DSO, owner], stakeholders: [DSO, owner] });
  const archive = (nodeId: string, cid: string): TransactionNode => ({
    nodeId, kind: 'exercise', contractId: cid, packageName: 'splice-amulet', templateId: AMULET, choice: 'Archive', chosenValue: v.record({}),
    actingParties: [DSO, ME], signatories: [DSO, ME], stakeholders: [DSO, ME], consuming: true, children: [],
  });
  const create = (nodeId: string, template: string, argument: DamlValue, stakeholders: string[]): TransactionNode => ({
    nodeId, kind: 'create', contractId: `${nodeId}${'e'.repeat(67)}`, packageName: 'splice-amulet', templateId: `${AMULET_PKG}:${template}`, argument, signatories: [DSO], stakeholders,
  });
  const amulet = (nodeId: string, owner: string, amount: string) => create(nodeId, 'Splice.Amulet:Amulet', amuletArg(owner, amount), [DSO, owner]);
  const marker = (nodeId: string) => create(nodeId, 'Splice.Amulet:FeaturedAppActivityMarker', v.record({ dso: v.party(DSO), provider: v.party(PROVIDER), beneficiary: v.party(PROVIDER), weight: v.numeric('1.0') }), [DSO, PROVIDER]);
  const eventLog = (nodeId: string): TransactionNode => ({
    nodeId, kind: 'exercise', contractId: 'fa'.repeat(34), packageName: 'splice-amulet', templateId: `${AMULET_PKG}:Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules`,
    choice: 'EventLog_HoldingsChange', chosenValue: v.record({}), actingParties: [DSO], signatories: [DSO], stakeholders: [DSO], consuming: false, children: [],
  });
  /** `TransferPreapproval_SendV2` on the receiver's preapproval: everything the transfer does happens under it. */
  const send = (children: TransactionNode[]): TransactionNode[] => [
    {
      nodeId: 's', kind: 'exercise', contractId: 'pa'.repeat(34), packageName: 'splice-amulet', templateId: `${AMULET_PKG}:Splice.AmuletRules:TransferPreapproval`, choice: 'TransferPreapproval_SendV2',
      chosenValue: v.record({}), actingParties: [ME], signatories: [RECEIVER, PROVIDER, DSO], stakeholders: [RECEIVER, PROVIDER, DSO], consuming: false, children: children.map((n) => n.nodeId),
    },
    ...children,
  ];
  const transfer = (nodes: TransactionNode[], inputs = [input('h1', ME, '20'), input('h2', ME, '10')]): CantonTransaction => {
    const root: TransactionNode = {
      nodeId: '0', kind: 'exercise', contractId: 'fa'.repeat(34), packageName: 'splice-amulet', templateId: `${AMULET_PKG}:Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules`,
      interfaceId: `${TI_V1}:Splice.Api.Token.TransferInstructionV1:TransferFactory`, choice: 'TransferFactory_Transfer',
      chosenValue: v.record({
        expectedAdmin: v.party(DSO),
        transfer: v.record({
          sender: v.party(ME), receiver: v.party(RECEIVER), amount: v.numeric('25.0000000000'), instrumentId: v.record({ admin: v.party(DSO), id: v.text('Amulet') }),
          requestedAt: v.time(BigInt(NOW) * 1000n), executeBefore: v.time(BigInt(executeBefore) * 1_000_000n), inputHoldingCids: v.list([v.cid('h1'), v.cid('h2')]), meta: v.record({}),
        }),
        extraArgs: v.record({}),
      }),
      actingParties: [ME], signatories: [DSO], stakeholders: [DSO], consuming: false,
      children: nodes.filter((n) => !nodes.some((m) => m.kind === 'exercise' && m.children.includes(n.nodeId))).map((n) => n.nodeId),
    };
    return { ...tx([root, ...nodes]), inputContracts: inputs };
  };
  const prepared = { summary: { asset, amount: '25', receiver: RECEIVER, inputHoldingCids: ['h1', 'h2'], executeBefore } } as unknown as PreparedOf<'holdings.transfer'>;
  const check = checkHoldingsTransfer({ params, publicKey: KEY, nowMs: NOW });

  test('TC-SDK-2931-40: dev pins the DSO’s splice-amulet 0.1.24 with the Amulet holding form', () => {
    expect(CANTON_TRANSFER_FACTORIES[DSO]?.[0]).toMatchObject({ packageId: AMULET_PKG, factory: 'Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules', holding: 'Splice.Amulet:Amulet', holdingForm: 'amulet' });
  });

  test('TC-SDK-2931-41: the honest direct transfer passes: inputs archived, 25 amulet to the receiver, change, the provider’s marker, the DSO’s event log', () => {
    expect(() => check(prepared, [transfer(send([archive('1', 'h1'), archive('2', 'h2'), marker('3'), amulet('4', RECEIVER, '25'), amulet('5', ME, '5'), eventLog('6')]))])).not.toThrow();
  });

  test.each([
    ['TC-SDK-2931-42: the receiver credited more than asked', () => send([archive('1', 'h1'), archive('2', 'h2'), amulet('4', RECEIVER, '30')]), /receiver is credited/],
    ['TC-SDK-2931-43: an amulet created for a third party', () => send([archive('1', 'h1'), archive('2', 'h2'), amulet('4', RECEIVER, '25'), amulet('5', 'evil::1220ee', '5')]), /third party/],
    ['TC-SDK-2931-44: the amount locked in a LockedAmulet of the sender (no preapproval: a pending transfer)', () => [archive('1', 'h1'), archive('2', 'h2'), create('4', 'Splice.Amulet:LockedAmulet', v.record({ amulet: amuletArg(ME, '25') }), [DSO, ME]), amulet('5', ME, '5')], /LockedAmulet for the sender/],
    ['TC-SDK-2931-45: change above the inputs minus the amount', () => send([archive('1', 'h1'), archive('2', 'h2'), amulet('4', RECEIVER, '25'), amulet('5', ME, '50')]), /change/],
  ])('%s: refused', (_name, nodes, detail) => refused(() => check(prepared, [transfer(nodes())]), detail));

  test('TC-SDK-2931-46: an input that is the DSO’s amulet of another owner: refused', () => {
    refused(() => check(prepared, [transfer(send([archive('1', 'h1'), archive('2', 'h2'), amulet('4', RECEIVER, '25')]), [input('h1', ME, '20'), input('h2', RECEIVER, '10')])]), /not an unlocked holding of the sender/);
  });
});

describe('holdings.transfer of CBTC: a DA Utilities transfer through the receiver’s preapproval (CAN-2931)', () => {
  const CBTC = 'cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff';
  const APP_PKG = '2293eb12e82ceaeb3ff7f8fe3346dece8578e1e9fd7d46624aeb7bb07fa31eda';
  const HOLDING_PKG = '71fbaea211f07a65666892748498bd4a0d7462a9d75bbb215ba9fbdbba78efa7';
  const TI_V1 = '55ba4deb0ad4662c4168b39859738a0e91388d252286480c7331b3f71a517281';
  const DA_OPERATOR = 'auth0_007c65f857f1c3d599cb6df73775::1220d2d732d042c281cee80f483ab80f3cbaa4782860ed5f4dc228ab03dedd2ee8f9';
  const PREAPPROVAL = `${APP_PKG}:Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval`;
  const asset = { admin: CBTC, id: 'CBTC' };
  const params = { asset, amount: '0.05', toParty: RECEIVER };
  const executeBefore = String(NOW / 1000 + 600);
  const REGISTRY_V0_PKG = '1f80e086e9ce218cf93fdeed80943793e902ac35c521733d7373a5ba58813150';
  // As the stand decoded them (sdk STAND-02): an unlocked holding has no `lock` field at all.
  const holdingArg = (owner: string, amount: string, lock?: DamlValue) =>
    v.record({ operator: v.party(DA_OPERATOR), provider: v.party(CBTC), registrar: v.party(CBTC), owner: v.party(owner), instrument: v.record({ source: v.party(CBTC), id: v.text('CBTC'), scheme: v.text('RegistrarInternalScheme') }), label: v.text(''), amount: v.numeric(amount), ...(lock ? { lock } : {}) });
  const holdingTemplate = (pkg: string) => `${pkg}:Utility.Registry.Holding.V0.Holding:Holding`;
  const input = (cid: string, owner: string, amount: string, pkg = HOLDING_PKG, lock?: DamlValue) => ({
    contractId: cid, packageName: 'utility-registry-holding-v0', templateId: holdingTemplate(pkg), argument: holdingArg(owner, amount, lock), signatories: [DA_OPERATOR, CBTC, owner], stakeholders: [DA_OPERATOR, CBTC, owner],
  });
  const archive = (nodeId: string, cid: string): TransactionNode => ({
    nodeId, kind: 'exercise', contractId: cid, packageName: 'utility-registry-holding-v0', templateId: holdingTemplate(HOLDING_PKG), choice: 'Archive', chosenValue: v.record({}),
    actingParties: [ME], signatories: [DA_OPERATOR, CBTC, ME], stakeholders: [DA_OPERATOR, CBTC, ME], consuming: true, children: [],
  });
  const holding = (nodeId: string, owner: string, amount: string): TransactionNode => ({
    nodeId, kind: 'create', contractId: `${nodeId}${'e'.repeat(67)}`, packageName: 'utility-registry-holding-v0', templateId: holdingTemplate(HOLDING_PKG), argument: holdingArg(owner, amount),
    signatories: [DA_OPERATOR, CBTC, owner], stakeholders: [DA_OPERATOR, CBTC, owner],
  });
  const transfer = (nodes: TransactionNode[], inputs = [input('h1', ME, '0.04'), input('h2', ME, '0.02')], factory = PREAPPROVAL): CantonTransaction => {
    const root: TransactionNode = {
      nodeId: '0', kind: 'exercise', contractId: 'pa'.repeat(34), packageName: 'utility-registry-app-v0', templateId: factory,
      interfaceId: `${TI_V1}:Splice.Api.Token.TransferInstructionV1:TransferFactory`, choice: 'TransferFactory_Transfer',
      chosenValue: v.record({
        expectedAdmin: v.party(CBTC),
        transfer: v.record({
          sender: v.party(ME), receiver: v.party(RECEIVER), amount: v.numeric('0.0500000000'), instrumentId: v.record({ admin: v.party(CBTC), id: v.text('CBTC') }),
          requestedAt: v.time(BigInt(NOW) * 1000n), executeBefore: v.time(BigInt(executeBefore) * 1_000_000n), inputHoldingCids: v.list([v.cid('h1'), v.cid('h2')]), meta: v.record({}),
        }),
        extraArgs: v.record({}),
      }),
      actingParties: [ME], signatories: [RECEIVER, DA_OPERATOR], stakeholders: [RECEIVER, DA_OPERATOR], consuming: false, children: nodes.map((n) => n.nodeId),
    };
    return { ...tx([root, ...nodes]), inputContracts: inputs };
  };
  const executed = (nodeId: string, signatories = [DA_OPERATOR]): TransactionNode => ({
    nodeId, kind: 'create', contractId: `${nodeId}${'e'.repeat(67)}`, packageName: 'utility-registry-v0', templateId: `${REGISTRY_V0_PKG}:Utility.Registry.V0.Holding.Transfer:ExecutedTransfer`,
    argument: v.record({ transfer: v.record({ sender: v.party(ME), receiver: v.party(RECEIVER) }) }), signatories, stakeholders: [DA_OPERATOR, ME, RECEIVER],
  });
  const honest = () => [archive('1', 'h1'), archive('2', 'h2'), holding('3', RECEIVER, '0.05'), holding('4', ME, '0.01'), executed('5')];
  const prepared = { summary: { asset, amount: '0.05', receiver: RECEIVER, inputHoldingCids: ['h1', 'h2'], executeBefore } } as unknown as PreparedOf<'holdings.transfer'>;
  const check = checkHoldingsTransfer({ params, publicKey: KEY, nowMs: NOW });

  test('TC-SDK-2931-50: the honest direct transfer through the receiver’s preapproval passes: inputs archived, 0.05 to the receiver, the change, the operator’s ExecutedTransfer', () => {
    expect(() => check(prepared, [transfer(honest())])).not.toThrow();
  });

  test.each([
    ['TC-SDK-2931-51: an input of the factory’s package, not utility-registry-holding-v0', () => transfer(honest(), [input('h1', ME, '0.04', APP_PKG), input('h2', ME, '0.02')]), /not a holding of the pinned registry/],
    ['TC-SDK-2931-52: a locked input', () => transfer(honest(), [input('h1', ME, '0.04', HOLDING_PKG, { t: 'optional', v: v.record({}) } as DamlValue), input('h2', ME, '0.02')]), /not an unlocked holding of the sender/],
    ['TC-SDK-2931-53: the transfer exercised on a template the pin does not name', () => transfer(honest(), undefined, `${APP_PKG}:Utility.Registry.App.V0.Model.Transfer:TransferOffer`), /not a pinned factory/],
    ['TC-SDK-2931-54: an ExecutedTransfer the sender signs', () => transfer([...honest().slice(0, 4), executed('5', [DA_OPERATOR, ME])]), /creates Utility.Registry.V0.Holding.Transfer:ExecutedTransfer for the sender/],
  ])('%s: refused', (_name, build, detail) => refused(() => check(prepared, [build()]), detail));
});
