import { PROOF_KIND_ATTESTATION, repayToFromParty, type CantonIntent, type FillProofJson, type Hex } from '@cancore/contracts';
import type { CantonTransferFactory } from './factories';
import { NODE_KEY, party } from './fixtures';
import { CantonRefusal } from './legs';
import type { PreparedOf } from './operations';
import { checkIntentSettle } from './settle-check';
import type { CantonTransaction, DamlValue, ExerciseNode, TransactionNode } from './transaction';

const KEY = `0x${NODE_KEY}` as Hex;
const ME = party();
const OWNER = 'alice::1220ff';
const OPERATOR = 'cancore-intent-operator::1220ee';
const ADMIN = 'cancore::1220aa';
const INTENT_PKG = 'cd'.repeat(32);
const REG_PKG = 'ab'.repeat(32);
const ORDER_HASH = `0x${'77'.repeat(32)}` as Hex;
const FACTORIES: Record<string, readonly CantonTransferFactory[]> = {
  [ADMIN]: [{ packageId: REG_PKG, factory: 'Cnrx.Rules:CnrxRules', holding: 'Cnrx.Holding:CnrxHolding', holdingView: 'holding', offer: 'Cnrx.Transfer:CnrxTransferOffer', serviceChoices: [], allocation: 'Cnrx.Allocation:CnrxAllocationV2' }],
};

// 100 CNRX at 30 bps: 100 / 1.003 = 99.7008973081 (Numeric 10, half to even), the rest to the operator.
const PAYOUT = '99.7008973081';
const FEE = '0.2991026919';

const intent: CantonIntent = {
  intentCid: '00si', templateId: `${INTENT_PKG}:Intent.SwapIntent:SwapIntent`, orderHash: ORDER_HASH, owner: OWNER, operator: OPERATOR, filler: ME, fillerId: 'cancore-dev-1',
  requestId: 'req-1', asset: { admin: ADMIN, id: 'CNRX' }, amount: '100.0000000000', destination: { chainId: '11155111', token: `0x${'11'.repeat(20)}`, recipient: `0x${'22'.repeat(20)}` },
  minReceived: { units: '99', decimals: 6 }, feeRate: '0.0030000000', fillDeadline: '1790000600', refundAfter: '1790004200', orderCreatedAt: '1789999940', allocationCid: '00al', allocation: null,
};
const proof: FillProofJson = {
  kind: PROOF_KIND_ATTESTATION, orderHash: ORDER_HASH, destination: `0x${'00'.repeat(29)}aa36a7`, fillRef: `0x${'f1'.repeat(32)}`, recipient: `0x${'00'.repeat(12)}${'22'.repeat(20)}`,
  outputAsset: `0x${'00'.repeat(12)}${'11'.repeat(20)}`, amountDelivered: '99', filledAt: '1790000100', fillerId: `0x${'fd'.repeat(32)}`, repayTo: repayToFromParty(ME), attempt: 0, setId: 1,
};

const v = {
  party: (p: string): DamlValue => ({ t: 'party', v: p }),
  text: (t: string): DamlValue => ({ t: 'text', v: t }),
  numeric: (n: string): DamlValue => ({ t: 'numeric', v: n }),
  int: (n: string | number): DamlValue => ({ t: 'int64', v: String(n) }),
  cid: (c: string): DamlValue => ({ t: 'contractId', v: c }),
  list: (l: DamlValue[]): DamlValue => ({ t: 'list', v: l }),
  record: (fields: Record<string, DamlValue>): DamlValue => ({ t: 'record', v: fields }),
  some: (x: DamlValue): DamlValue => ({ t: 'optional', v: x }),
  none: (): DamlValue => ({ t: 'optional' }),
  hex: (h: string): DamlValue => ({ t: 'record', v: { hex: { t: 'text', v: h.replace(/^0x/, '') } } }),
};
const account = (p: string) => v.record({ owner: v.some(v.party(p)), provider: v.none(), id: v.text('') });

function damlProof(p: FillProofJson): DamlValue {
  return v.record({
    kind: v.int(p.kind), orderHash: v.hex(p.orderHash), destination: v.hex(p.destination), fillRef: v.hex(p.fillRef), recipient: v.hex(p.recipient), outputAsset: v.hex(p.outputAsset),
    amountDelivered: v.hex(BigInt(p.amountDelivered).toString(16).padStart(64, '0')), filledAt: v.int(p.filledAt), fillerId: v.hex(p.fillerId), repayTo: v.hex(p.repayTo), attempt: v.int(p.attempt), setId: v.int(p.setId),
  });
}
const leg = (id: string, receiver: string, amount: string) =>
  v.record({ transferLegId: v.text(id), sender: account(OWNER), receiver: account(receiver), amount: v.numeric(amount), instrumentId: v.text('CNRX'), meta: v.record({}) });
const holding = (nodeId: string, owner: string, amount: string, locked = false): TransactionNode => ({
  nodeId, kind: 'create', contractId: `h-${nodeId}`, packageName: 'cnrx-registry', templateId: `${REG_PKG}:Cnrx.Holding:CnrxHolding`,
  argument: v.record({ holding: v.record({ account: account(owner), instrumentId: v.record({ admin: v.party(ADMIN), id: v.text('CNRX') }), amount: v.numeric(amount), lock: locked ? v.some(v.record({})) : v.none() }) }),
  signatories: [ADMIN, owner], stakeholders: [ADMIN, owner],
});

interface Over {
  root?: Partial<ExerciseNode>;
  proof?: Partial<FillProofJson>;
  entry?: string;
  legs?: DamlValue[];
  credit?: TransactionNode[];
  extra?: TransactionNode[];
  batchTemplate?: string;
  settlementFactory?: string;
  actAs?: string[];
}

function honest(o: Over = {}): CantonTransaction {
  const credit = o.credit ?? [holding('10', ME, PAYOUT), holding('11', OPERATOR, FEE)];
  const batch: TransactionNode = {
    nodeId: '3', kind: 'exercise', contractId: '00sf', packageName: 'cnrx-registry', templateId: o.batchTemplate ?? `${REG_PKG}:Cnrx.Allocation:CnrxAllocationRules`,
    interfaceId: `${'99'.repeat(32)}:Splice.Api.Token.AllocationV2:SettlementFactory`, choice: 'SettlementFactory_SettleBatch',
    chosenValue: v.record({ transferLegs: v.list(o.legs ?? [leg('payout', ME, PAYOUT), leg('fee', OPERATOR, FEE)]) }),
    actingParties: [OPERATOR, OWNER], signatories: [ADMIN], stakeholders: [ADMIN], consuming: false, children: ['4', ...credit.map((n) => n.nodeId)],
  };
  // The owner's locked give is archived: the owner signs it, the party does not.
  const give: TransactionNode = {
    nodeId: '4', kind: 'exercise', contractId: '00give', packageName: 'cnrx-registry', templateId: `${REG_PKG}:Cnrx.Holding:CnrxHolding`, choice: 'Archive',
    chosenValue: v.record({}), actingParties: [ADMIN, OWNER], signatories: [ADMIN, OWNER], stakeholders: [ADMIN, OWNER], consuming: true, children: [],
  };
  const fetchEntry: TransactionNode = { nodeId: '1', kind: 'fetch', contractId: '00en', packageName: 'cancore-intent', templateId: `${INTENT_PKG}:Intent.FillerRegistry:FillerRegistryEntry`, actingParties: [ME], signatories: [OPERATOR, ME], stakeholders: [OPERATOR, ME] };
  const receipt: TransactionNode = { nodeId: '2', kind: 'create', contractId: '00ra', packageName: 'cnrx-registry', templateId: `${REG_PKG}:Cnrx.Allocation:CnrxAllocationV2`, argument: v.record({}), signatories: [ADMIN, ME], stakeholders: [ADMIN, ME] };
  const extra = o.extra ?? [];
  const root: ExerciseNode = {
    nodeId: '0', kind: 'exercise', contractId: intent.intentCid, packageName: 'cancore-intent', templateId: intent.templateId, choice: 'SwapIntent_SettleWithProof',
    chosenValue: v.record({ proof: damlProof({ ...proof, ...o.proof }), bundle: v.list([]), fillerEntryCid: v.cid(o.entry ?? '00en'), settlementFactory: { t: 'optional', v: v.cid(o.settlementFactory ?? '00sf') } }),
    actingParties: [ME], signatories: [OWNER, OPERATOR], stakeholders: [OWNER, OPERATOR, ME], consuming: true, children: ['1', '2', '3', ...extra.map((n) => n.nodeId)],
    ...o.root,
  };
  const nodes = [root, fetchEntry, receipt, batch, give, ...credit, ...extra];
  return { commandId: 'c', actAs: o.actAs ?? [ME], roots: ['0'], nodes: Object.fromEntries(nodes.map((n) => [n.nodeId, n])), inputContracts: [], synchronizerId: 's', preparationTime: '0' };
}

const summary = { orderHash: ORDER_HASH, intentCid: '00si', asset: { admin: ADMIN, id: 'CNRX' }, amount: PAYOUT, executeBefore: '1790004200', payee: ME, giveAmount: '100.0', fee: { receiver: OPERATOR, amount: FEE } };
const prepared = (s: Partial<typeof summary> = {}) => ({ summary: { ...summary, ...s } }) as unknown as PreparedOf<'intent.settle'>;
const check = checkIntentSettle({ publicKey: KEY, party: ME, intent, feeBps: 30n, proof, entryCid: '00en', factories: FACTORIES });
const refused = (run: () => unknown, detail: RegExp) => {
  expect(run).toThrow(CantonRefusal);
  expect(run).toThrow(detail);
};

describe('intent.settle: SwapIntent_SettleWithProof of the node’s own delivery (CAN-2321)', () => {
  test('the honest settle passes', () => {
    expect(() => check(prepared(), [honest()])).not.toThrow();
  });

  test.each<[string, () => unknown, RegExp]>([
    ['a summary for another intent', () => check(prepared({ intentCid: '00xx' }), [honest()]), /another intent/],
    ['a stated payee other than the party', () => check(prepared({ payee: 'other::1220' }), [honest()]), /payee/],
    ['a stated payout one unit short', () => check(prepared({ amount: '99.700897308' }), [honest()]), /stated payout/],
    ['a stated fee to someone else', () => check(prepared({ fee: { receiver: ME, amount: FEE } }), [honest()]), /fee leg/],
    ['executeBefore past refundAfter', () => check(prepared({ executeBefore: '1790004201' }), [honest()]), /executeBefore/],
    ['acting as the operator too', () => check(prepared(), [honest({ actAs: [ME, OPERATOR] })]), /acts as another party/],
    ['another choice on the intent', () => check(prepared(), [honest({ root: { choice: 'SwapIntent_Cancel' } })]), /not SwapIntent_SettleWithProof/],
    ['TC-SDK-3172-04: the batch runs another settlement factory than the settle names', () => check(prepared(), [honest({ settlementFactory: '00other' })]), /another settlement factory/],
    ['the intent of another package', () => check(prepared(), [honest({ root: { templateId: `${'ee'.repeat(32)}:Intent.SwapIntent:SwapIntent` } })]), /not SwapIntent_SettleWithProof/],
    ['another intent contract', () => check(prepared(), [honest({ root: { contractId: '00other' } })]), /another contract/],
    ['a proof of someone else’s fill', () => check(prepared(), [honest({ proof: { fillRef: `0x${'f2'.repeat(32)}` } })]), /proof.fillRef/],
    ['a proof paying another repayTo', () => check(prepared(), [honest({ proof: { repayTo: repayToFromParty('other::1220') } })]), /proof.repayTo/],
    ['a proof of another amount', () => check(prepared(), [honest({ proof: { amountDelivered: '98' } })]), /amountDelivered/],
    ['a proof of another attempt', () => check(prepared(), [honest({ proof: { attempt: 1 } })]), /proof.attempt/],
    ['a proof under another set', () => check(prepared(), [honest({ proof: { setId: 2 } })]), /proof.setId/],
    ['another registry entry', () => check(prepared(), [honest({ entry: '00evil' })]), /registry entry/],
    ['the net leg paid to another party', () => check(prepared(), [honest({ legs: [leg('payout', 'other::1220', PAYOUT), leg('fee', OPERATOR, FEE)] })]), /payout leg pays another party/],
    ['the fee leg paid to the party', () => check(prepared(), [honest({ legs: [leg('payout', ME, PAYOUT), leg('fee', ME, FEE)] })]), /fee leg pays another party/],
    ['a third leg', () => check(prepared(), [honest({ legs: [leg('payout', ME, PAYOUT), leg('fee', OPERATOR, FEE), leg('extra', 'mallory::1220', '1.0')] })]), /3 legs/],
    ['a settlement factory of an unpinned registry', () => check(prepared(), [honest({ batchTemplate: `${'98'.repeat(32)}:Evil:Rules` })]), /not of a pinned registry/],
    ['the party credited less than the payout', () => check(prepared(), [honest({ credit: [holding('10', ME, '99.0'), holding('11', OPERATOR, FEE)] })]), /credited 99/],
    ['the party credited a locked holding', () => check(prepared(), [honest({ credit: [holding('10', ME, PAYOUT, true), holding('11', OPERATOR, FEE)] })]), /locked/],
    [
      'a holding of the party consumed',
      () =>
        check(prepared(), [
          honest({
            extra: [{ nodeId: '20', kind: 'exercise', contractId: '00mine', packageName: 'cnrx-registry', templateId: `${REG_PKG}:Cnrx.Holding:CnrxHolding`, choice: 'Archive', chosenValue: v.record({}), actingParties: [ME], signatories: [ADMIN, ME], stakeholders: [ADMIN, ME], consuming: true, children: [] }],
          }),
        ]),
      /consumes Cnrx.Holding:CnrxHolding 00mine of the party/,
    ],
    ['two transactions', () => check(prepared(), [honest(), honest()]), /one transaction/],
  ])('%s is refused', (_name, run, detail) => refused(run, detail));
});
