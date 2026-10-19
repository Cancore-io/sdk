/**
 * delivery.fill of a Canton-form ticket (CAN-1867): the decoded
 * `DeliveryOrder_Fill` held to the node's ticket, the offered order and its
 * identity before the party key signs. Shapes as `cancore-intent` 0.4.x
 * (canton-contracts dev, `DeliveryReceipt.daml`) and cnrx-registry 0.2.3
 * build them: `Bytes32 { hex }` without `0x`, the CNRX holding view under
 * `holding`, the owner inside `holding.account.owner`.
 */
import { encodeCantonAmount, encodeCantonOutputAsset, encodeCantonRecipient, type Hex } from '@cancore/contracts';
import { checkDeliveryFill, type DeliveryFillExpectation } from './delivery-check';
import { NODE_KEY, OTHER_KEY, party } from './fixtures';
import { CantonRefusal } from './legs';
import type { PreparedOf } from './operations';
import type { CantonTransaction, DamlValue, TransactionNode } from './transaction';

const KEY = `0x${NODE_KEY}` as Hex;
const ME = party();
const OPERATOR = 'cancore-operator::1220ab';
const GUARDIAN = 'cancore-guardian::1220ac';
const ATTESTOR = 'attestor-1::1220ad';
const RECIPIENT = 'alice::1220cd';
const ADMIN = 'cancore::12204f383aca6af056f6d83c9b5758fbc53c27a743e2f9d591e61bc657202172524b';
const CNRX = 'd495b7d2e9376e42bb58845c47e165492bba917216352636b6c357c76d3bb736';
const TI_V1 = '55ba4deb0ad4662c4168b39859738a0e91388d252286480c7331b3f71a517281';
const INTENT = 'ab'.repeat(32);
const NOW = 1_790_000_000_000;
const ORDER_HASH = `0x${'5a'.repeat(32)}` as Hex;
const REPAY_TO = `0x${'00'.repeat(12)}${'7e'.repeat(20)}` as Hex;
const ORDER_CID = `00${'0d'.repeat(33)}`;
const FACTORY_CID = `00${'fa'.repeat(33)}`;
const VALID_UNTIL = String(NOW / 1000 + 120);
const FILL_DEADLINE = String(NOW / 1000 + 600);
const asset = { admin: ADMIN, id: 'CNRX' };

const v = {
  party: (p: string): DamlValue => ({ t: 'party', v: p }),
  text: (t: string): DamlValue => ({ t: 'text', v: t }),
  numeric: (n: string): DamlValue => ({ t: 'numeric', v: n }),
  int: (n: number): DamlValue => ({ t: 'int64', v: String(n) }),
  cid: (c: string): DamlValue => ({ t: 'contractId', v: c }),
  list: (l: DamlValue[]): DamlValue => ({ t: 'list', v: l }),
  time: (seconds: string): DamlValue => ({ t: 'timestamp', v: (BigInt(seconds) * 1_000_000n).toString() }),
  record: (fields: Record<string, DamlValue>): DamlValue => ({ t: 'record', v: fields }),
  bytes32: (hex: string): DamlValue => ({ t: 'record', v: { hex: { t: 'text', v: hex.replace(/^0x/, '') } } }),
};
const opt = (p?: string): DamlValue => (p ? { t: 'optional', v: v.party(p) } : { t: 'optional' });
const instrument = (id = 'CNRX') => v.record({ admin: v.party(ADMIN), id: v.text(id) });
const holdingView = (owner: string, amount: string, locked = false) =>
  v.record({
    account: v.record({ owner: opt(owner), provider: opt(), id: v.text('') }), instrumentId: instrument(), amount: v.numeric(amount),
    lock: locked ? { t: 'optional', v: v.record({ holders: v.list([v.party(ADMIN)]) }) } : opt(), meta: v.record({}),
  });
const HOLDING = `${CNRX}:Cnrx.Holding:CnrxHolding`;

const expect_: DeliveryFillExpectation = {
  publicKey: KEY,
  fillerId: 'cancore-dev-1',
  orderHash: ORDER_HASH,
  attempt: 2,
  deliveryOrderCid: ORDER_CID,
  validUntil: VALID_UNTIL,
  repayTo: REPAY_TO,
  order: { recipient: encodeCantonRecipient(RECIPIENT), outputAsset: encodeCantonOutputAsset(asset), minReceived: encodeCantonAmount('25').toString(), fillDeadline: FILL_DEADLINE },
  amountOut: encodeCantonAmount('25').toString(),
  nowMs: NOW,
};
const summary = {
  orderHash: ORDER_HASH, attempt: 2, deliveryOrderCid: ORDER_CID, recipient: RECIPIENT, asset, amount: '25.0000000000', repayTo: REPAY_TO, validUntil: VALID_UNTIL,
  inputHoldingCids: ['h1', 'h2'], executeBefore: FILL_DEADLINE, transferFactoryCid: FACTORY_CID,
};
const prepared = (over: Partial<typeof summary> = {}) => ({ summary: { ...summary, ...over } }) as unknown as PreparedOf<'delivery.fill'>;

/** The `DeliveryOrder` argument as the ledger holds it; `over` replaces fields. */
const orderArg = (over: Record<string, DamlValue> = {}) =>
  v.record({
    operator: v.party(OPERATOR), guardian: v.party(GUARDIAN), filler: v.party(ME), fillerId: v.text('cancore-dev-1'), repayTo: v.bytes32(REPAY_TO),
    fillerEntryCid: v.cid('ee'.repeat(34)), attestors: v.list([v.party(ATTESTOR)]), orderHash: v.bytes32(ORDER_HASH), recipient: v.party(RECIPIENT),
    instrumentId: instrument(), instrumentAdmin: v.party(ADMIN), transferFactoryCid: v.cid(FACTORY_CID), amount: v.numeric('25.0000000000'),
    fillDeadline: v.time(FILL_DEADLINE), attempt: v.int(2), validUntil: v.time(VALID_UNTIL),
    ...over,
  });
const receiptArg = (over: Record<string, DamlValue> = {}) =>
  v.record({
    operator: v.party(OPERATOR), filler: v.party(ME), fillerId: v.text('cancore-dev-1'), repayTo: v.bytes32(REPAY_TO), attestors: v.list([v.party(ATTESTOR)]),
    orderHash: v.bytes32(ORDER_HASH), recipient: v.party(RECIPIENT), instrumentId: instrument(), amount: v.numeric('25.0000000000'), attempt: v.int(2),
    filledAt: v.time(String(NOW / 1000)), holdingCids: v.list([v.cid(`3${'e'.repeat(67)}`)]),
    ...over,
  });

interface Over {
  root?: Partial<Extract<TransactionNode, { kind: 'exercise' }>>;
  order?: Record<string, DamlValue>;
  receipt?: Record<string, DamlValue>;
  receiptSignatories?: string[];
  transferAmount?: string;
  credited?: string;
  extra?: TransactionNode[];
  pending?: boolean;
  noOrder?: boolean;
  actAs?: string[];
  fetchSignatories?: string[];
}

/** The honest fill: DeliveryOrder_Fill → [registry fetch, TransferFactory_Transfer → (archive h1, h2, credit, change), DeliveryReceipt]. */
function fill(o: Over = {}): CantonTransaction {
  const amount = o.transferAmount ?? '25.0000000000';
  const children: TransactionNode[] = [
    { nodeId: '10', kind: 'exercise', contractId: 'h1', packageName: 'cnrx-registry', templateId: HOLDING, choice: 'Archive', chosenValue: v.record({}), actingParties: [ADMIN, ME], signatories: [ADMIN, ME], stakeholders: [ADMIN, ME], consuming: true, children: [] },
    { nodeId: '11', kind: 'exercise', contractId: 'h2', packageName: 'cnrx-registry', templateId: HOLDING, choice: 'Archive', chosenValue: v.record({}), actingParties: [ADMIN, ME], signatories: [ADMIN, ME], stakeholders: [ADMIN, ME], consuming: true, children: [] },
    o.pending
      ? { nodeId: '12', kind: 'create', contractId: `12${'e'.repeat(66)}`, packageName: 'cnrx-registry', templateId: HOLDING, argument: v.record({ holding: holdingView(ME, '25', true) }), signatories: [ADMIN, ME], stakeholders: [ADMIN, ME] }
      : { nodeId: '12', kind: 'create', contractId: `12${'e'.repeat(66)}`, packageName: 'cnrx-registry', templateId: HOLDING, argument: v.record({ holding: holdingView(RECIPIENT, o.credited ?? '25') }), signatories: [ADMIN, RECIPIENT], stakeholders: [ADMIN, RECIPIENT] },
    { nodeId: '13', kind: 'create', contractId: `13${'e'.repeat(66)}`, packageName: 'cnrx-registry', templateId: HOLDING, argument: v.record({ holding: holdingView(ME, '5') }), signatories: [ADMIN, ME], stakeholders: [ADMIN, ME] },
    ...(o.pending
      ? [{ nodeId: '14', kind: 'create', contractId: `14${'f'.repeat(66)}`, packageName: 'cnrx-registry', templateId: `${CNRX}:Cnrx.Transfer:CnrxTransferOffer`, argument: v.record({ transfer: v.record({ sender: v.record({ owner: opt(ME) }), receiver: v.record({ owner: opt(RECIPIENT) }), amount: v.numeric('25'), instrumentId: instrument() }) }), signatories: [ME, ADMIN], stakeholders: [ME, ADMIN, RECIPIENT] } as TransactionNode]
      : []),
  ];
  const transfer: TransactionNode = {
    nodeId: '2', kind: 'exercise', contractId: FACTORY_CID, packageName: 'cnrx-registry', templateId: `${CNRX}:Cnrx.Rules:CnrxRules`,
    interfaceId: `${TI_V1}:Splice.Api.Token.TransferInstructionV1:TransferFactory`, choice: 'TransferFactory_Transfer',
    chosenValue: v.record({
      expectedAdmin: v.party(ADMIN),
      transfer: v.record({
        sender: v.party(ME), receiver: v.party(RECIPIENT), amount: v.numeric(amount), instrumentId: instrument(),
        requestedAt: v.time(String(NOW / 1000)), executeBefore: v.time(FILL_DEADLINE), inputHoldingCids: v.list([v.cid('h1'), v.cid('h2')]), meta: v.record({}),
      }),
      extraArgs: v.record({}),
    }),
    actingParties: [ME], signatories: [ADMIN], stakeholders: [ADMIN], consuming: false, children: children.map((n) => n.nodeId),
  };
  const fetch: TransactionNode = { nodeId: '1', kind: 'fetch', contractId: 'ee'.repeat(34), packageName: 'cancore-intent', templateId: `${INTENT}:Intent.FillerRegistry:FillerRegistryEntry`, actingParties: [ME], signatories: o.fetchSignatories ?? [OPERATOR, ME], stakeholders: [OPERATOR, ME] };
  const receipt: TransactionNode = {
    nodeId: '3', kind: 'create', contractId: `03${'c'.repeat(66)}`, packageName: 'cancore-intent', templateId: `${INTENT}:Intent.DeliveryReceipt:DeliveryReceipt`,
    argument: receiptArg(o.receipt), signatories: o.receiptSignatories ?? [OPERATOR, ME], stakeholders: [OPERATOR, ME, ATTESTOR],
  };
  const extra = o.extra ?? [];
  const root: TransactionNode = {
    nodeId: '0', kind: 'exercise', contractId: ORDER_CID, packageName: 'cancore-intent', templateId: `${INTENT}:Intent.DeliveryReceipt:DeliveryOrder`, choice: 'DeliveryOrder_Fill',
    chosenValue: v.record({ inputHoldingCids: v.list([v.cid('h1'), v.cid('h2')]), extraArgs: v.record({}) }), actingParties: [ME],
    signatories: [OPERATOR, GUARDIAN], stakeholders: [OPERATOR, GUARDIAN, ME, ATTESTOR], consuming: true, children: ['1', '2', '3', ...extra.map((n) => n.nodeId)],
    ...o.root,
  };
  const nodes = [root, fetch, transfer, ...children, receipt, ...extra];
  const input = (cid: string, amount: string) => ({ contractId: cid, packageName: 'cnrx-registry', templateId: HOLDING, argument: v.record({ holding: holdingView(ME, amount) }), signatories: [ADMIN, ME], stakeholders: [ADMIN, ME] });
  return {
    commandId: 'c', actAs: o.actAs ?? [ME], roots: ['0'], nodes: Object.fromEntries(nodes.map((n) => [n.nodeId, n])),
    inputContracts: [
      ...(o.noOrder ? [] : [{ contractId: ORDER_CID, packageName: 'cancore-intent', templateId: `${INTENT}:Intent.DeliveryReceipt:DeliveryOrder`, argument: orderArg(o.order), signatories: [OPERATOR, GUARDIAN], stakeholders: [OPERATOR, GUARDIAN, ME, ATTESTOR] }]),
      input('h1', '20'),
      input('h2', '10'),
    ],
    synchronizerId: 's', preparationTime: '0',
  };
}

const check = (over: Partial<DeliveryFillExpectation> = {}) => checkDeliveryFill({ ...expect_, ...over });
const refused = (run: () => unknown, detail: RegExp) => {
  expect(run).toThrow(CantonRefusal);
  expect(run).toThrow(detail);
};

describe('delivery.fill: the honest delivery of the node’s own ticket (CAN-1867)', () => {
  test('TC-SDK-1867-01: DeliveryOrder_Fill of the ticket, 25 CNRX to the recipient, 5 back as change, one receipt: passes', () => {
    expect(() => check()(prepared(), [fill()])).not.toThrow();
  });
});

describe('delivery.fill: what the summary states (CAN-1867)', () => {
  test.each([
    ['TC-SDK-1867-02: another order', { orderHash: `0x${'5b'.repeat(32)}` as Hex }, /order or attempt/],
    ['TC-SDK-1867-03: another DeliveryOrder', { deliveryOrderCid: 'xx' }, /DeliveryOrder is not the ticket/],
    ['TC-SDK-1867-04: another repayTo', { repayTo: `0x${'00'.repeat(12)}${'66'.repeat(20)}` as Hex }, /repayTo/],
    ['TC-SDK-1867-05: another recipient', { recipient: 'mallory::1220ee' }, /recipient/],
    ['TC-SDK-1867-06: an amount below minReceived', { amount: '24.9' }, /below the order/],
    ['TC-SDK-1867-07: an amount above the filler’s own quote', { amount: '26' }, /above the filler/],
    ['TC-SDK-1867-08: another executeBefore', { executeBefore: '1' }, /executeBefore/],
  ])('%s: refused', (_name, over, detail) => refused(() => check()(prepared(over as Partial<typeof summary>), [fill()]), detail));

  test('TC-SDK-1867-09: a ticket already expired by the process clock: refused', () => {
    refused(() => check({ nowMs: (Number(VALID_UNTIL) + 1) * 1000 })(prepared(), [fill()]), /expired/);
  });
});

describe('delivery.fill: the decoded transaction (CAN-1867)', () => {
  test.each([
    ['TC-SDK-1867-10: acting as another party', { root: { actingParties: [party(OTHER_KEY)] } }, /another party than the node key/],
    ['TC-SDK-1867-11: submitted as the operator too', { actAs: [ME, OPERATOR] }, /acts as another party/],
    ['TC-SDK-1867-12: another choice on the order', { root: { choice: 'DeliveryOrder_Cancel' } }, /not DeliveryOrder_Fill/],
    ['TC-SDK-1867-13: a look-alike template of another package name', { root: { packageName: 'evil-intent' } }, /not DeliveryOrder_Fill/],
    ['TC-SDK-1867-14: another contract than the ticket’s order', { root: { contractId: 'zz' } }, /another contract/],
    ['TC-SDK-1867-15: the order not disclosed', { noOrder: true }, /not disclosed/],
    ['TC-SDK-1867-16: the order names another filler party', { order: { filler: v.party(party(OTHER_KEY)) } }, /another filler party/],
    ['TC-SDK-1867-17: the order names another fillerId', { order: { fillerId: v.text('someone-else') } }, /another fillerId/],
    ['TC-SDK-1867-18: T-48 — the operator wrote another repayTo into the order', { order: { repayTo: v.bytes32(`0x${'00'.repeat(12)}${'66'.repeat(20)}`) } }, /T-48/],
    ['TC-SDK-1867-19: the order is for another attempt', { order: { attempt: v.int(3) } }, /another attempt/],
    ['TC-SDK-1867-20: the order has another validUntil', { order: { validUntil: v.time(String(Number(VALID_UNTIL) + 60)) } }, /validUntil/],
    ['TC-SDK-1867-21: the order pins another factory', { order: { transferFactoryCid: v.cid('ff') } }, /another transfer factory/],
    ['TC-SDK-1867-22: the transfer moves another amount', { transferAmount: '2.5' }, /another amount/],
    ['TC-SDK-1867-23: the receipt names another repayTo', { receipt: { repayTo: v.bytes32(`0x${'00'.repeat(12)}${'66'.repeat(20)}`) } }, /DeliveryReceipt names another repayTo/],
    ['TC-SDK-1867-24: the receipt not co-signed by the party', { receiptSignatories: [OPERATOR] }, /not signed by exactly/],
    ['TC-SDK-1867-25: a pending transfer instead of a delivery', { pending: true }, /pending transfer is not a delivery/],
    ['TC-SDK-1867-26: the receiver credited less than the amount', { credited: '20' }, /receiver is credited/],
    ['TC-SDK-1867-28: a read of another party’s registry entry', { fetchSignatories: [OPERATOR, 'someone-else::1220ee'] }, /registry entry that is not the party/],
  ])('%s: refused', (_name, over, detail) => refused(() => check()(prepared(), [fill(over as Over)]), detail));

  test('TC-SDK-1867-27: anything else under the fill — a second receipt, an archive of the party’s registry entry: refused', () => {
    const second: TransactionNode = {
      nodeId: '4', kind: 'create', contractId: `04${'c'.repeat(66)}`, packageName: 'cancore-intent', templateId: `${INTENT}:Intent.DeliveryReceipt:DeliveryReceipt`,
      argument: receiptArg(), signatories: [OPERATOR, ME], stakeholders: [OPERATOR, ME],
    };
    refused(() => check()(prepared(), [fill({ extra: [second] })]), /2 DeliveryReceipts/);
    const archiveEntry: TransactionNode = {
      nodeId: '4', kind: 'exercise', contractId: 'ee'.repeat(34), packageName: 'cancore-intent', templateId: `${INTENT}:Intent.FillerRegistry:FillerRegistryEntry`, choice: 'Archive',
      chosenValue: v.record({}), actingParties: [OPERATOR, ME], signatories: [OPERATOR, ME], stakeholders: [OPERATOR, ME], consuming: true, children: [],
    };
    refused(() => check()(prepared(), [fill({ extra: [archiveEntry] })]), /besides the delivery/);
  });
});
