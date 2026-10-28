/**
 * preapproval.create (CAN-2904): the decoded create held to a pinned
 * registry's preapproval for the node's own party before the party key signs.
 * Shapes as cnrx-registry 0.2.3 builds them (`Cnrx.Transfer:CnrxTransferPreapproval`).
 */
import type { Hex } from '@cancore/contracts';
import { checkPreapprovalCreate } from './preapproval-check';
import { CANTON_TRANSFER_FACTORIES } from './factories';
import { NODE_KEY, OTHER_KEY, party } from './fixtures';
import { CantonRefusal } from './legs';
import type { PreparedOf } from './operations';
import type { CantonTransaction, DamlValue, TransactionNode } from './transaction';

const KEY = `0x${NODE_KEY}` as Hex;
const ME = party();
const ADMIN = 'cancore::12204f383aca6af056f6d83c9b5758fbc53c27a743e2f9d591e61bc657202172524b';
const CNRX = 'd495b7d2e9376e42bb58845c47e165492bba917216352636b6c357c76d3bb736';
const NOW = 1_790_000_000_000;
const REQUESTED = String(NOW / 1000 - 60);
const BEFORE = String(NOW / 1000 + 365 * 86_400);

const v = {
  party: (p: string): DamlValue => ({ t: 'party', v: p }),
  text: (t: string): DamlValue => ({ t: 'text', v: t }),
  time: (s: string): DamlValue => ({ t: 'timestamp', v: (BigInt(s) * 1_000_000n).toString() }),
  record: (f: Record<string, DamlValue>): DamlValue => ({ t: 'record', v: f }),
};
const summary = { party: ME, admin: ADMIN, instrumentAllowances: ['CNRX'], requestedAt: REQUESTED, executeBefore: BEFORE };
const prepared = (over: Partial<typeof summary> = {}) => ({ summary: { ...summary, ...over } }) as unknown as PreparedOf<'preapproval.create'>;

function create(over: { template?: string; arg?: Record<string, DamlValue>; signatories?: string[]; extra?: TransactionNode[]; actAs?: string[]; kind?: 'exercise' } = {}): CantonTransaction {
  const root: TransactionNode =
    over.kind === 'exercise'
      ? { nodeId: '0', kind: 'exercise', contractId: '00x', packageName: 'cnrx-registry', templateId: `${CNRX}:Cnrx.Transfer:CnrxTransferPreapproval`, choice: 'Archive', chosenValue: v.record({}), actingParties: [ME], signatories: [ME], stakeholders: [ME], consuming: true, children: [] }
      : {
          nodeId: '0', kind: 'create', contractId: '00pa', packageName: 'cnrx-registry', templateId: over.template ?? `${CNRX}:Cnrx.Transfer:CnrxTransferPreapproval`,
          argument: v.record({ admin: v.party(ADMIN), receiver: v.party(ME), instrumentAllowances: { t: 'list', v: [v.text('CNRX')] }, requestedAt: v.time(REQUESTED), executeBefore: v.time(BEFORE), ...over.arg }),
          signatories: over.signatories ?? [ME], stakeholders: [ME, ADMIN],
        };
  const nodes = [root, ...(over.extra ?? [])];
  return { commandId: 'c', actAs: over.actAs ?? [ME], roots: nodes.map((n) => n.nodeId), nodes: Object.fromEntries(nodes.map((n) => [n.nodeId, n])), inputContracts: [], synchronizerId: 's', preparationTime: '0' };
}

const check = (admin = ADMIN, nowMs = NOW) => checkPreapprovalCreate({ params: { admin }, publicKey: KEY, nowMs });
const refused = (run: () => unknown, detail: RegExp) => {
  expect(run).toThrow(CantonRefusal);
  expect(run).toThrow(detail);
};

describe('preapproval.create: the party’s own preapproval with a pinned registry (CAN-2904)', () => {
  test('TC-SDK-2904-01: the honest create passes; the dev CNRX registry pins its preapproval', () => {
    expect(CANTON_TRANSFER_FACTORIES[ADMIN]?.[0]?.preapproval).toBe('Cnrx.Transfer:CnrxTransferPreapproval');
    expect(() => check()(prepared(), [create()])).not.toThrow();
  });

  test.each([
    ['TC-SDK-2904-02: another admin stated', () => check()(prepared({ admin: 'evil::1220ee' }), [create()]), /admin is not the one asked/],
    ['TC-SDK-2904-03: another party stated', () => check()(prepared({ party: party(OTHER_KEY) }), [create()]), /another party than the node key/],
    ['TC-SDK-2904-04: an admin with no pinned preapproval', () => check('nobody::1220aa')(prepared({ admin: 'nobody::1220aa' }), [create()]), /no pinned registry/],
    ['TC-SDK-2904-05: a look-alike template of another package', () => check()(prepared(), [create({ template: `${'ee'.repeat(32)}:Cnrx.Transfer:CnrxTransferPreapproval` })]), /not the preapproval of a pinned registry/],
    ['TC-SDK-2904-06: the receiver is someone else', () => check()(prepared(), [create({ arg: { receiver: v.party('mallory::1220ee') } })]), /another receiver/],
    ['TC-SDK-2904-07: with another admin in the contract', () => check()(prepared(), [create({ arg: { admin: v.party('evil::1220ee') } })]), /another admin/],
    ['TC-SDK-2904-08: other allowances than stated', () => check()(prepared(), [create({ arg: { instrumentAllowances: { t: 'list', v: [v.text('CC')] } } })]), /allowances/],
    ['TC-SDK-2904-09: another window than stated', () => check()(prepared(), [create({ arg: { executeBefore: v.time(String(Number(BEFORE) + 1)) } })]), /executeBefore is not/],
    ['TC-SDK-2904-10: co-signed by someone else', () => check()(prepared(), [create({ signatories: [ME, ADMIN] })]), /signed by the party alone/],
    ['TC-SDK-2904-11: acting as another party too', () => check()(prepared(), [create({ actAs: [ME, ADMIN] })]), /acts as another party/],
    ['TC-SDK-2904-12: an exercise instead of a create', () => check()(prepared(), [create({ kind: 'exercise' })]), /not a create/],
    ['TC-SDK-2904-13: a second node in the transaction', () => check()(prepared(), [create({ extra: [{ nodeId: '1', kind: 'create', contractId: '00y', packageName: 'x', templateId: `${CNRX}:Cnrx.Holding:CnrxHolding`, argument: v.record({}), signatories: [ME], stakeholders: [ME] }] })]), /more than one create/],
    ['TC-SDK-2904-14: an executeBefore already passed', () => check(ADMIN, (Number(BEFORE) + 1) * 1000)(prepared(), [create()]), /has passed/],
    ['TC-SDK-2904-20: one root, and a node besides it', () => {
      const tx = create({ extra: [{ nodeId: '1', kind: 'create', contractId: '00y', packageName: 'x', templateId: `${CNRX}:Cnrx.Holding:CnrxHolding`, argument: v.record({}), signatories: [ME], stakeholders: [ME] }] });
      return check()(prepared(), [{ ...tx, roots: ['0'] }]);
    }, /more than one create/],
    ['TC-SDK-2904-21: two roots over one node', () => {
      const tx = create();
      return check()(prepared(), [{ ...tx, roots: ['0', '0'] }]);
    }, /more than one create/],
    ['TC-SDK-2904-22: allowances stated as one text', () => check()(prepared({ instrumentAllowances: 'CNRX' as never }), [create()]), /not a list of instrument ids/],
    ['TC-SDK-2904-23: allowances stated with a non-text', () => check()(prepared({ instrumentAllowances: [1] as never }), [create()]), /not a list of instrument ids/],
    ['TC-SDK-2904-15: a second transaction beside the create', () => check()(prepared(), [create(), create()]), /expected one transaction, got 2/],
    ['TC-SDK-2904-16: no transaction', () => check()(prepared(), []), /expected one transaction, got 0/],
    ['TC-SDK-2904-17: another requestedAt in the contract than stated', () => check()(prepared(), [create({ arg: { requestedAt: v.time(String(Number(REQUESTED) - 1)) } })]), /requestedAt is not the stated one/],
    ['TC-SDK-2904-18: the transaction reads contracts a create does not need', () => check()(prepared(), [{ ...create(), inputContracts: [{ contractId: '00in' } as never] }]), /reads contracts/],
  ])('%s: refused', (_name, run, detail) => refused(run, detail));

  describe('TC-SDK-2904-19: the window at its edges', () => {
    const at = (requestedAt: string, executeBefore: string, nowMs = NOW) =>
      () => check(ADMIN, nowMs)(prepared({ requestedAt, executeBefore }), [create({ arg: { requestedAt: v.time(requestedAt), executeBefore: v.time(executeBefore) } })]);
    const now = NOW / 1000;

    test('executeBefore one second ahead passes; at the clock or behind it is refused', () => {
      expect(at(REQUESTED, String(now + 1))).not.toThrow();
      refused(at(REQUESTED, String(now)), /has passed/);
      refused(at(REQUESTED, String(now - 1)), /has passed/);
    });

    test('requestedAt up to a minute ahead of the clock passes (the participant\'s clock is not the node\'s); beyond it is refused', () => {
      expect(at(String(now + 59), BEFORE)).not.toThrow();
      expect(at(String(now + 60), BEFORE)).not.toThrow();
      refused(at(String(now + 61), BEFORE), /ahead of the clock/);
    });
  });
});

describe('preapproval.create with a DA Utilities registry: the utility TransferPreapproval, no window (CAN-2931)', () => {
  const CBTC_ADMIN = 'cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff';
  const OPERATOR = 'auth0_007c65f857f1c3d599cb6df73775::1220d2d732d042c281cee80f483ab80f3cbaa4782860ed5f4dc228ab03dedd2ee8f9';
  const APP = '2293eb12e82ceaeb3ff7f8fe3346dece8578e1e9fd7d46624aeb7bb07fa31eda';
  const TEMPLATE = `${APP}:Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval`;
  const stated = { party: ME, admin: CBTC_ADMIN, operator: OPERATOR, instrumentAllowances: ['CBTC'], requestedAt: null, executeBefore: null };
  const preparedOf = (over: Record<string, unknown> = {}) => ({ summary: { ...stated, ...over } }) as unknown as PreparedOf<'preapproval.create'>;
  const utility = (over: { template?: string; arg?: Record<string, DamlValue>; signatories?: string[] } = {}): CantonTransaction => {
    const root: TransactionNode = {
      nodeId: '0', kind: 'create', contractId: '00util', packageName: 'utility-registry-app-v0', templateId: over.template ?? TEMPLATE,
      argument: v.record({ operator: v.party(OPERATOR), receiver: v.party(ME), instrumentAdmin: v.party(CBTC_ADMIN), instrumentAllowances: { t: 'list', v: [v.record({ id: v.text('CBTC') })] }, ...over.arg }),
      signatories: over.signatories ?? [ME], stakeholders: [ME, OPERATOR],
    };
    return { commandId: 'c', actAs: [ME], roots: ['0'], nodes: { '0': root }, inputContracts: [], synchronizerId: 's', preparationTime: '0' };
  };
  const checkCbtc = () => checkPreapprovalCreate({ params: { admin: CBTC_ADMIN }, publicKey: KEY, nowMs: NOW });

  test('TC-SDK-2931-01: the honest create passes; dev pins CBTC’s DA Utilities preapproval', () => {
    expect(CANTON_TRANSFER_FACTORIES[CBTC_ADMIN]?.[0]).toMatchObject({ packageId: APP, preapprovalForm: 'utility' });
    expect(() => checkCbtc()(preparedOf(), [utility()])).not.toThrow();
  });

  test.each([
    ['TC-SDK-2931-02: a window stated for a registry that has none', () => checkCbtc()(preparedOf({ requestedAt: REQUESTED, executeBefore: BEFORE }), [utility()]), /no validity window/],
    ['TC-SDK-2931-03: no operator stated', () => checkCbtc()(preparedOf({ operator: undefined }), [utility()]), /operator is not stated/],
    ['TC-SDK-2931-04: another operator in the contract than stated', () => checkCbtc()(preparedOf(), [utility({ arg: { operator: v.party('mallory::1220ee') } })]), /another operator/],
    ['TC-SDK-2931-05: another instrument admin in the contract', () => checkCbtc()(preparedOf(), [utility({ arg: { instrumentAdmin: v.party('evil::1220ee') } })]), /another admin/],
    ['TC-SDK-2931-06: other allowances than stated', () => checkCbtc()(preparedOf(), [utility({ arg: { instrumentAllowances: { t: 'list', v: [v.record({ id: v.text('CETH') })] } } })]), /allowances/],
    ['TC-SDK-2931-07: co-signed by the operator', () => checkCbtc()(preparedOf(), [utility({ signatories: [ME, OPERATOR] })]), /signed by the party alone/],
    ['TC-SDK-2931-08: the utility template of another package', () => checkCbtc()(preparedOf(), [utility({ template: `${'ee'.repeat(32)}:Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval` })]), /not the preapproval of a pinned registry/],
    ['TC-SDK-2931-09: a CNRX-form window check is not skipped for CNRX', () => check()(prepared({ requestedAt: null as never }), [create()]), /requestedAt is not unix seconds/],
  ])('%s: refused', (_name, run, detail) => refused(run, detail));
});
