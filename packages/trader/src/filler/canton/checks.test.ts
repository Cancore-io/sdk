import type { Hex } from '@cancore/contracts';
import { canonicalDecimal, checkHoldingsTransfer, checkRegistryAccept, isOwnParty } from './checks';
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

  test('the honest transfer passes, change and receiver holdings included', () => {
    expect(() => check(prepared(), [honest({ children: [holding('1', ME), holding('2', RECEIVER)] })])).not.toThrow();
  });

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
    ['a contract for a third party', () => check(prepared(), [honest({ children: [holding('1', 'evil::1220ee')] })]), /third party/],
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
