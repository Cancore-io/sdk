/**
 * cnrx-registry 0.2.6 on dev (CAN-3304): a guardian co-signs every holding, and a direct transfer spends its first
 * input through `CnrxHolding_Move`, archiving the rest (cancore-token-canton `Cnrx.Holding` `moveCheckedInputs`).
 * cnrx-registry 0.2.7 (CAN-2573, CertiK CNA-03) upgrades 0.2.6 in place: its transfers spend holdings of both.
 * cnrx-registry 0.2.8 (CAN-2574, CertiK CNA-04) upgrades 0.2.7 the same way.
 */
import type { Hex } from '@cancore/contracts';
import { checkHoldingsTransfer } from './checks';
import { CANTON_ALLOCATION_TEMPLATES, CANTON_TRANSFER_FACTORIES, registriesProblem, type CantonTransferFactory } from './factories';
import { NODE_KEY, party } from './fixtures';
import { CantonRefusal } from './legs';
import type { PreparedOf } from './operations';
import { checkPreapprovalCreate } from './preapproval-check';
import type { CantonTransaction, DamlValue, TransactionNode } from './transaction';

const KEY = `0x${NODE_KEY}` as Hex;
const ME = party();
const RECEIVER = 'treasury::1220cd';
const GUARDIAN = 'cnrx-guardian::1220ef';
const ADMIN = 'cancore::12204f383aca6af056f6d83c9b5758fbc53c27a743e2f9d591e61bc657202172524b';
const CNRX_0_2_8 = '0673c0e747c716342d189a7fcdf36448864b49788a91c1c664da08df2944d28f';
const CNRX_0_2_7 = '0cc44c28f323b455c1875e85fd7a1ad7732ad2a34ed8dd1550cb79dead750bba';
const CNRX_0_2_6 = '643a728658256e42fe69f8bb5202a4466da5d8564e628af5d5534d8b416c9dc8';
const CNRX_0_2_3 = 'd495b7d2e9376e42bb58845c47e165492bba917216352636b6c357c76d3bb736';
const TI_V1 = '55ba4deb0ad4662c4168b39859738a0e91388d252286480c7331b3f71a517281';
const NOW = 1_790_000_000_000;
const executeBefore = String(NOW / 1000 + 600);
const asset = { admin: ADMIN, id: 'CNRX' };

const v = {
  party: (p: string): DamlValue => ({ t: 'party', v: p }),
  text: (t: string): DamlValue => ({ t: 'text', v: t }),
  numeric: (n: string): DamlValue => ({ t: 'numeric', v: n }),
  cid: (c: string): DamlValue => ({ t: 'contractId', v: c }),
  list: (l: DamlValue[]): DamlValue => ({ t: 'list', v: l }),
  time: (micros: bigint): DamlValue => ({ t: 'timestamp', v: micros.toString() }),
  record: (fields: Record<string, DamlValue>): DamlValue => ({ t: 'record', v: fields }),
};
const opt = (p?: string): DamlValue => (p ? { t: 'optional', v: v.party(p) } : { t: 'optional' });
const account = (owner: string) => v.record({ owner: opt(owner), provider: opt(), id: v.text('') });
const instrument = () => v.record({ admin: v.party(ADMIN), id: v.text('CNRX') });
const view = (owner: string, amount: string) =>
  v.record({ account: account(owner), instrumentId: instrument(), amount: v.numeric(amount), lock: opt(), meta: v.record({ values: v.record({}) }) });
const holdingTemplate = (pkg: string) => `${pkg}:Cnrx.Holding:CnrxHolding`;
const signed = (owner: string) => [ADMIN, owner, GUARDIAN];

const input = (cid: string, amount: string, pkg = CNRX_0_2_6) => ({
  contractId: cid, packageName: 'cnrx-registry', templateId: holdingTemplate(pkg), argument: v.record({ holding: view(ME, amount) }), signatories: signed(ME), stakeholders: signed(ME),
});
const spend = (nodeId: string, cid: string, choice: string, pkg = CNRX_0_2_6): TransactionNode => ({
  nodeId, kind: 'exercise', contractId: cid, packageName: 'cnrx-registry', templateId: holdingTemplate(pkg), choice, chosenValue: v.record({}),
  actingParties: [ADMIN, ME], signatories: signed(ME), stakeholders: signed(ME), consuming: true, children: [],
});
const mint = (nodeId: string, owner: string, amount: string, pkg = CNRX_0_2_6): TransactionNode => ({
  nodeId, kind: 'create', contractId: `${nodeId}${'e'.repeat(67)}`, packageName: 'cnrx-registry', templateId: holdingTemplate(pkg),
  argument: v.record({ holding: view(owner, amount) }), signatories: signed(owner), stakeholders: signed(owner),
});
const viaPreapproval = (nodeId: string, pkg: string, children: TransactionNode[]): TransactionNode => ({
  nodeId, kind: 'exercise', contractId: 'pa'.repeat(34), packageName: 'cnrx-registry', templateId: `${pkg}:Cnrx.Transfer:CnrxTransferPreapproval`,
  choice: 'CnrxTransferPreapproval_Transfer', chosenValue: v.record({}), actingParties: [ADMIN, ME], signatories: [RECEIVER], stakeholders: [RECEIVER, ADMIN],
  consuming: false, children: children.map((n) => n.nodeId),
});

/** The direct transfer of 25 from h1 (20) and h2 (10) as 0.2.6 runs it: h1 moved, h2 archived, 25 to the receiver, 5 back. */
function transfer(o: { pkg?: string; spent?: TransactionNode[]; inputs?: ReturnType<typeof input>[] } = {}): CantonTransaction {
  const pkg = o.pkg ?? CNRX_0_2_6;
  const spent = o.spent ?? [spend('2', 'h1', 'CnrxHolding_Move', pkg), spend('3', 'h2', 'Archive', pkg)];
  const children = [...spent, mint('4', RECEIVER, '25', pkg), mint('5', ME, '5', pkg)];
  const direct = viaPreapproval('1', pkg, children);
  const root: TransactionNode = {
    nodeId: '0', kind: 'exercise', contractId: 'fa'.repeat(34), packageName: 'cnrx-registry', templateId: `${pkg}:Cnrx.Rules:CnrxRules`,
    interfaceId: `${TI_V1}:Splice.Api.Token.TransferInstructionV1:TransferFactory`, choice: 'TransferFactory_Transfer',
    chosenValue: v.record({
      expectedAdmin: v.party(ADMIN),
      transfer: v.record({
        sender: v.party(ME), receiver: v.party(RECEIVER), amount: v.numeric('25.0000000000'), instrumentId: instrument(),
        requestedAt: v.time(BigInt(NOW) * 1000n), executeBefore: v.time(BigInt(executeBefore) * 1_000_000n), inputHoldingCids: v.list([v.cid('h1'), v.cid('h2')]), meta: v.record({}),
      }),
      extraArgs: v.record({}),
    }),
    actingParties: [ME], signatories: [ADMIN, GUARDIAN], stakeholders: [ADMIN, GUARDIAN], consuming: false, children: ['1'],
  };
  const nodes = [root, direct, ...children];
  return {
    commandId: 'c', actAs: [ME], roots: ['0'], nodes: Object.fromEntries(nodes.map((n) => [n.nodeId, n])),
    inputContracts: o.inputs ?? [input('h1', '20', pkg), input('h2', '10', pkg)], synchronizerId: 's', preparationTime: '0',
  };
}

const prepared = { summary: { asset, amount: '25', receiver: RECEIVER, inputHoldingCids: ['h1', 'h2'], executeBefore } } as unknown as PreparedOf<'holdings.transfer'>;
const pinned = CANTON_TRANSFER_FACTORIES[ADMIN] ?? [];
const only = (pkg: string) => ({ [ADMIN]: pinned.filter((f) => f.packageId === pkg) });
const check = (factories?: Record<string, readonly CantonTransferFactory[]>) =>
  checkHoldingsTransfer({ params: { asset, amount: '25', toParty: RECEIVER }, publicKey: KEY, nowMs: NOW, ...(factories ? { factories } : {}) });
const refused = (run: () => unknown, detail: RegExp) => {
  expect(run).toThrow(CantonRefusal);
  expect(run).toThrow(detail);
};

describe('holdings.transfer of CNRX under cnrx-registry 0.2.6: the first input spent by CnrxHolding_Move (CAN-3304)', () => {
  test('TC-SDK-3304-01: dev pins 0.2.6 next to 0.2.3, behind 0.2.8 and 0.2.7; the honest direct transfer passes', () => {
    expect(pinned.map((f) => f.packageId)).toEqual([CNRX_0_2_8, CNRX_0_2_7, CNRX_0_2_6, CNRX_0_2_3]);
    expect(() => check()(prepared, [transfer()])).not.toThrow();
  });

  test.each([
    ['TC-SDK-3304-02: the 0.2.6 transfer with 0.2.3 pinned alone', () => check(only(CNRX_0_2_3))(prepared, [transfer()]), /not a pinned factory/],
    ['TC-SDK-3304-03: a 0.2.6 transfer spending holdings of 0.2.3', () => check()(prepared, [transfer({ inputs: [input('h1', '20', CNRX_0_2_3), input('h2', '10', CNRX_0_2_3)] })]), /not a holding of the pinned registry/],
    ['TC-SDK-3304-04: CnrxHolding_Move under the 0.2.3 pin, which never spends through it', () => check()(prepared, [transfer({ pkg: CNRX_0_2_3 })]), /exercises Cnrx.Holding:CnrxHolding.CnrxHolding_Move/],
    ['TC-SDK-3304-05: CnrxHolding_Move on a holding of the sender that is not stated', () => check()(prepared, [transfer({ spent: [spend('2', 'h1', 'CnrxHolding_Move'), spend('3', 'h2', 'Archive'), spend('6', 'h9', 'CnrxHolding_Move')] })]), /not a stated input/],
    ['TC-SDK-3304-06: a stated input both moved and archived', () => check()(prepared, [transfer({ spent: [spend('2', 'h1', 'CnrxHolding_Move'), spend('3', 'h1', 'Archive')] })]), /archived twice/],
    ['TC-SDK-3304-07: the second input left unspent', () => check()(prepared, [transfer({ spent: [spend('2', 'h1', 'CnrxHolding_Move')] })]), /are not spent/],
  ])('%s: refused', (_name, run, detail) => refused(run, detail));
});

describe('V-C4 and preapproval.create of CNRX under cnrx-registry 0.2.6 (CAN-3304)', () => {
  test('TC-SDK-3304-08: a committed 0.2.6 allocation is a pinned allocation of the CNRX admin, as is 0.2.3’s', () => {
    expect(CANTON_ALLOCATION_TEMPLATES[ADMIN]).toEqual([CNRX_0_2_8, CNRX_0_2_7, CNRX_0_2_6, CNRX_0_2_3].map((pkg) => `${pkg}:Cnrx.Allocation:CnrxAllocationV2`));
  });

  test.each([
    ['TC-SDK-3304-09', CNRX_0_2_6],
    ['TC-SDK-2573-04', CNRX_0_2_7],
    ['TC-SDK-2574-02', CNRX_0_2_8],
  ])('%s: the party’s CnrxTransferPreapproval of %s passes the CNRX form', (_id, pkg) => {
    const requested = String(NOW / 1000 - 60);
    const before = String(NOW / 1000 + 86_400);
    const created: TransactionNode = {
      nodeId: '0', kind: 'create', contractId: '00pa', packageName: 'cnrx-registry', templateId: `${pkg}:Cnrx.Transfer:CnrxTransferPreapproval`,
      argument: v.record({ admin: v.party(ADMIN), receiver: v.party(ME), instrumentAllowances: v.list([v.text('CNRX')]), requestedAt: v.time(BigInt(requested) * 1_000_000n), executeBefore: v.time(BigInt(before) * 1_000_000n) }),
      signatories: [ME], stakeholders: [ME, ADMIN],
    };
    const tx: CantonTransaction = { commandId: 'c', actAs: [ME], roots: ['0'], nodes: { '0': created }, inputContracts: [], synchronizerId: 's', preparationTime: '0' };
    const summary = { party: ME, admin: ADMIN, instrumentAllowances: ['CNRX'], requestedAt: requested, executeBefore: before };
    expect(() => checkPreapprovalCreate({ params: { admin: ADMIN }, publicKey: KEY, nowMs: NOW })({ summary } as unknown as PreparedOf<'preapproval.create'>, [tx])).not.toThrow();
  });

  test('TC-SDK-3304-10: a registry entry whose spendChoices is not a list of choices is no usable pin', () => {
    const entry = pinned[0] as CantonTransferFactory;
    expect(registriesProblem({ [ADMIN]: [entry] })).toBeUndefined();
    expect(registriesProblem({ [ADMIN]: [{ ...entry, spendChoices: 'Cnrx.Holding:CnrxHolding.CnrxHolding_Move' as never }] })).toMatch(/spendChoices/);
  });
});

describe('holdings.transfer of CNRX under cnrx-registry 0.2.7: an in-place upgrade of 0.2.6 (CAN-2573)', () => {
  const holdingsOf = (pkg: string) => [input('h1', '20', pkg), input('h2', '10', pkg)];

  test.each([
    ['TC-SDK-2573-01: holdings created under 0.2.6', CNRX_0_2_6],
    ['TC-SDK-2573-02: holdings created under 0.2.7', CNRX_0_2_7],
  ])('%s, spent by a 0.2.7 transfer: passes', (_name, pkg) => {
    expect(() => check()(prepared, [transfer({ pkg: CNRX_0_2_7, inputs: holdingsOf(pkg) })])).not.toThrow();
  });

  test('TC-SDK-2573-03: holdings of 0.2.3, which 0.2.7 does not upgrade, spent by a 0.2.7 transfer: refused', () => {
    refused(() => check()(prepared, [transfer({ pkg: CNRX_0_2_7, inputs: holdingsOf(CNRX_0_2_3) })]), /not a holding of the pinned registry/);
  });

  test.each([
    ['not a list', CNRX_0_2_6 as never],
    ['not a package id', ['0.2.6']],
  ])('TC-SDK-2573-05: upgradedHoldingPackageIds %s is no usable pin', (_name, upgradedHoldingPackageIds) => {
    const entry = pinned[0] as CantonTransferFactory;
    expect(registriesProblem({ [ADMIN]: [entry] })).toBeUndefined();
    expect(registriesProblem({ [ADMIN]: [{ ...entry, upgradedHoldingPackageIds }] })).toMatch(/upgradedHoldingPackageIds/);
  });
});

describe('holdings.transfer of CNRX under cnrx-registry 0.2.8: an in-place upgrade of 0.2.7 (CAN-2574)', () => {
  const holdingsOf = (pkg: string) => [input('h1', '20', pkg), input('h2', '10', pkg)];

  test.each([
    ['TC-SDK-2574-01: holdings created under 0.2.6', CNRX_0_2_6],
    ['TC-SDK-2574-01: holdings created under 0.2.7', CNRX_0_2_7],
    ['TC-SDK-2574-01: holdings created under 0.2.8', CNRX_0_2_8],
  ])('%s, spent by a 0.2.8 transfer: passes', (_name, pkg) => {
    expect(() => check()(prepared, [transfer({ pkg: CNRX_0_2_8, inputs: holdingsOf(pkg) })])).not.toThrow();
  });

  test('TC-SDK-2574-03: holdings of 0.2.3 spent by a 0.2.8 transfer: refused', () => {
    refused(() => check()(prepared, [transfer({ pkg: CNRX_0_2_8, inputs: holdingsOf(CNRX_0_2_3) })]), /not a holding of the pinned registry/);
  });
});
