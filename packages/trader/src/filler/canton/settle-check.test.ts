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
// CAN-3132: the registry's guardian G, which a CNRX pin must name and which marks and co-signs every accounted holding.
const G = 'cnrx-guardian::1220c7';
const G_PRIME = 'cnrx-guardian-prime::1220c7';
const FACTORIES: Record<string, readonly CantonTransferFactory[]> = {
  [ADMIN]: [{ packageId: REG_PKG, factory: 'Cnrx.Rules:CnrxRules', holding: 'Cnrx.Holding:CnrxHolding', holdingView: 'holding', offer: 'Cnrx.Transfer:CnrxTransferOffer', serviceChoices: [], allocation: 'Cnrx.Allocation:CnrxAllocationV2', guardian: G }],
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
/** The view meta cnrx-registry 0.2.6 gives an accounted holding: `cnrx/guardian` = its guardian. */
const marked = (mark: DamlValue): DamlValue => v.record({ values: { t: 'textMap', v: { 'cnrx/guardian': mark } } });
/** A holding the settle creates; `meta` null leaves the view without one. */
const holding = (nodeId: string, owner: string, amount: string, locked = false, pkg = REG_PKG, meta: DamlValue | null = marked(v.text(G)), entity = 'Cnrx.Holding:CnrxHolding'): TransactionNode => ({
  nodeId, kind: 'create', contractId: `h-${nodeId}`, packageName: 'cnrx-registry', templateId: `${pkg}:${entity}`,
  argument: v.record({
    holding: v.record({ account: account(owner), instrumentId: v.record({ admin: v.party(ADMIN), id: v.text('CNRX') }), amount: v.numeric(amount), lock: locked ? v.some(v.record({})) : v.none(), ...(meta === null ? {} : { meta }) }),
  }),
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
  /** The operator's RegistryFactoryPin the settle names; fields replace the honest one's, `null` leaves it undisclosed. */
  pin?: Record<string, DamlValue> | null;
  /** The settle names no factory pin: the field is left out (a 0.4.2 command) or None. */
  unnamedPin?: 'missing' | 'none';
  /** The SwapIntent as the transaction discloses it: left out, or created under another package. */
  noIntent?: boolean;
  intentPackage?: string;
  actAs?: string[];
}

const PIN_CID = '00pin';
const intentContract = (pkg = INTENT_PKG) => ({ contractId: intent.intentCid, packageName: 'cancore-intent', templateId: `${pkg}:Intent.SwapIntent:SwapIntent`, argument: v.record({}), signatories: [OWNER, OPERATOR], stakeholders: [OWNER, OPERATOR, ME] });
function namedPin(o: Over): Record<string, DamlValue> {
  if (o.unnamedPin === 'missing') return {};
  return { factoryPin: o.unnamedPin === 'none' ? v.none() : v.some(v.cid(PIN_CID)) };
}
/** The operator's `RegistryFactoryPin` of the give instrument holding the registry's current factories (CAN-3172). */
const pinContract = (over: Record<string, DamlValue> = {}) => ({
  contractId: PIN_CID, packageName: 'cancore-intent', templateId: `${INTENT_PKG}:Intent.RegistryFactoryPin:RegistryFactoryPin`,
  argument: v.record({ operator: v.party(OPERATOR), instrumentId: v.record({ admin: v.party(ADMIN), id: v.text('CNRX') }), allocationFactory: v.some(v.cid('00af')), settlementFactory: v.some(v.cid('00sf')), transfer: v.none(), ...over }),
  signatories: [OPERATOR], stakeholders: [OPERATOR],
});

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
    chosenValue: v.record({ proof: damlProof({ ...proof, ...o.proof }), bundle: v.list([]), fillerEntryCid: v.cid(o.entry ?? '00en'), ...namedPin(o) }),
    actingParties: [ME], signatories: [OWNER, OPERATOR], stakeholders: [OWNER, OPERATOR, ME], consuming: true, children: ['1', '2', '3', ...extra.map((n) => n.nodeId)],
    ...o.root,
  };
  const nodes = [root, fetchEntry, receipt, batch, give, ...credit, ...extra];
  return { commandId: 'c', actAs: o.actAs ?? [ME], roots: ['0'], nodes: Object.fromEntries(nodes.map((n) => [n.nodeId, n])), inputContracts: [...(o.noIntent ? [] : [intentContract(o.intentPackage)]), ...(o.pin === null ? [] : [pinContract(o.pin)])], synchronizerId: 's', preparationTime: '0' };
}

const OTHER_REG_PKG = 'bc'.repeat(32);
const OTHER_ADMIN = 'other-admin::1220bb';
/** A receipt allocation the settle runs on `templateId` with the party's authority (CAN-3352). */
const allocate = (templateId: string, signatories: string[]): TransactionNode => ({
  nodeId: '30', kind: 'exercise', contractId: '00af', packageName: 'registry', templateId, interfaceId: `${'99'.repeat(32)}:Splice.Api.Token.AllocationInstructionV2:AllocationFactory`,
  choice: 'AllocationFactory_Allocate', chosenValue: v.record({}), actingParties: [ME, OPERATOR], signatories, stakeholders: signatories, consuming: false, children: [],
});

const summary = { orderHash: ORDER_HASH, intentCid: '00si', asset: { admin: ADMIN, id: 'CNRX' }, amount: PAYOUT, executeBefore: '1790004200', payee: ME, giveAmount: '100.0', fee: { receiver: OPERATOR, amount: FEE } };
const prepared = (s: Partial<typeof summary> = {}) => ({ summary: { ...summary, ...s } }) as unknown as PreparedOf<'intent.settle'>;
const check = checkIntentSettle({ publicKey: KEY, party: ME, intent, feeBps: 30n, proof, entryCid: '00en', factories: FACTORIES });
const checkTwoRegistries = checkIntentSettle({
  publicKey: KEY, party: ME, intent, feeBps: 30n, proof, entryCid: '00en',
  factories: { ...FACTORIES, [OTHER_ADMIN]: [{ ...(FACTORIES[ADMIN]?.[0] as CantonTransferFactory), packageId: OTHER_REG_PKG }] },
});
const refused = (run: () => unknown, detail: RegExp) => {
  expect(run).toThrow(CantonRefusal);
  expect(run).toThrow(detail);
};

describe('intent.settle: SwapIntent_SettleWithProof of the node’s own delivery (CAN-2321)', () => {
  test('the honest settle passes', () => {
    expect(() => check(prepared(), [honest()])).not.toThrow();
  });

  test('TC-SDK-3352-03: a receipt allocation through the pinned registry’s factory passes', () => {
    expect(() => check(prepared(), [honest({ extra: [allocate(`${REG_PKG}:Cnrx.Allocation:CnrxAllocationRules`, [ADMIN, G])] })])).not.toThrow();
  });

  test('TC-SDK-3352-04: a receipt allocation through an unlisted template the instrument admin signs passes', () => {
    expect(() => check(prepared(), [honest({ extra: [allocate(`${'97'.repeat(32)}:Cnrx.Allocation:CnrxAllocationRulesV3`, [ADMIN, G])] })])).not.toThrow();
  });

  test('TC-SDK-3172-05: a 0.4.2 settle names no pin and runs the factory stored at Open: passes', () => {
    expect(() => check(prepared(), [honest({ unnamedPin: 'missing', pin: null })])).not.toThrow();
  });

  test.each<[string, () => unknown, RegExp]>([
    ['a summary for another intent', () => check(prepared({ intentCid: '00xx' }), [honest()]), /another intent/],
    ['a stated payee other than the party', () => check(prepared({ payee: 'other::1220' }), [honest()]), /payee/],
    ['a stated payout one unit short', () => check(prepared({ amount: '99.700897308' }), [honest()]), /stated payout/],
    ['a stated fee to someone else', () => check(prepared({ fee: { receiver: ME, amount: FEE } }), [honest()]), /fee leg/],
    ['executeBefore past refundAfter', () => check(prepared({ executeBefore: '1790004201' }), [honest()]), /executeBefore/],
    ['acting as the operator too', () => check(prepared(), [honest({ actAs: [ME, OPERATOR] })]), /acts as another party/],
    ['another choice on the intent', () => check(prepared(), [honest({ root: { choice: 'SwapIntent_Cancel' } })]), /not SwapIntent_SettleWithProof/],
    ['TC-SDK-3172-04: the batch runs another settlement factory than the settle’s pin holds', () => check(prepared(), [honest({ pin: { settlementFactory: v.some(v.cid('00other')) } })]), /another settlement factory/],
    ['TC-SDK-3172-15: both packages vetted — a 0.4.2-form settle on an intent another package created', () => check(prepared(), [honest({ unnamedPin: 'missing', pin: null, intentPackage: 'ee'.repeat(32) })]), /another package than the one that created the intent/],
    ['TC-SDK-3172-16: the intent is not disclosed with the transaction', () => check(prepared(), [honest({ noIntent: true })]), /another package than the one that created the intent/],
    ['TC-SDK-3172-05: a 0.4.2 settle (no pin) whose batch is not of a pinned registry', () => check(prepared(), [honest({ unnamedPin: 'missing', pin: null, batchTemplate: `${'ee'.repeat(32)}:Cnrx.Allocation:CnrxAllocationRules` })]), /not of a pinned registry/],
    ['TC-SDK-3172-06: the settle names None for the factory pin', () => check(prepared(), [honest({ unnamedPin: 'none' })]), /names no registry factory pin/],
    ['TC-SDK-3172-11: the settle’s pin holds no settlement factory', () => check(prepared(), [honest({ pin: { settlementFactory: v.none() } })]), /another settlement factory/],
    ['TC-SDK-3172-12: the settle names a pin of another party than the intent’s operator', () => check(prepared(), [honest({ pin: { operator: v.party(OWNER) } })]), /not the operator’s/],
    ['TC-SDK-3172-13: the settle’s pin is not disclosed with the transaction', () => check(prepared(), [honest({ pin: null })]), /factory pin is not disclosed/],
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
    ['TC-SDK-3352-01: a receipt allocation through a factory of another package', () => check(prepared(), [honest({ extra: [allocate(`${'98'.repeat(32)}:Evil:AllocationFactory`, [OPERATOR])] })]), /allocation factory .* is not of a pinned registry/],
    ['TC-SDK-3352-02: a receipt allocation through a factory of another admin’s registry', () => checkTwoRegistries(prepared(), [honest({ extra: [allocate(`${OTHER_REG_PKG}:Other.Rules:Rules`, [OTHER_ADMIN])] })]), /allocation factory .* is not of a pinned registry/],
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

describe('intent.settle of a CNRX registry with a guardian G: G accounts for every holding the party is credited (CAN-3132)', () => {
  const credit = (meta: DamlValue | null, entity?: string) => [holding('10', ME, PAYOUT, false, REG_PKG, meta, entity), holding('11', OPERATOR, FEE, false, REG_PKG, meta, entity)];
  const settleWith = (entry: Partial<CantonTransferFactory>) =>
    checkIntentSettle({ publicKey: KEY, party: ME, intent, feeBps: 30n, proof, entryCid: '00en', factories: { [ADMIN]: [{ ...(FACTORIES[ADMIN]?.[0] as CantonTransferFactory), ...entry }] } });

  test('TC-SDK-3132-04: the payout marked with G, through an allocation factory G co-signs, counts', () => {
    expect(() => check(prepared(), [honest({ credit: credit(marked(v.text(G))), extra: [allocate(`${REG_PKG}:Cnrx.Allocation:CnrxAllocationRules`, [ADMIN, G])] })])).not.toThrow();
  });

  test.each([
    ['marked with another guardian G\'', marked(v.text(G_PRIME))],
    ['without a mark (unaccounted)', v.record({ values: { t: 'textMap', v: {} } })],
    ['without any meta', null],
    ['with a meta without values', v.record({})],
    ['marked with a value that is not text', marked(v.party(G))],
  ])('TC-SDK-3132-05: the payout %s is refused', (_name, meta) => {
    refused(() => check(prepared(), [honest({ credit: credit(meta) })]), /credited h-10, which the registry’s guardian cnrx-guardian::1220c7 does not account for/);
  });

  test('TC-SDK-3132-06: a receipt allocation through a factory anchored on G\' is refused', () => {
    refused(
      () => check(prepared(), [honest({ extra: [allocate(`${REG_PKG}:Cnrx.Allocation:CnrxAllocationRules`, [ADMIN, G_PRIME])] })]),
      /allocation factory .* is not of a pinned registry/,
    );
  });

  test('TC-SDK-3132-07: a CNRX pin that names no guardian refuses the settle — fail-closed, even for G-marked holdings', () => {
    refused(() => settleWith({ guardian: undefined })(prepared(), [honest()]), /the pin names no guardian for the CNRX registry of cancore::1220aa/);
  });

  test('TC-SDK-3132-08: a registry that is not cnrx-registry needs no guardian and credits a holding whatever its mark', () => {
    const other = settleWith({ guardian: undefined, factory: 'Other.Rules:Rules', holding: 'Other.Holding:Holding' });
    expect(() => other(prepared(), [honest({ credit: credit(marked(v.text(G_PRIME)), 'Other.Holding:Holding') })])).not.toThrow();
  });
});

describe('intent.settle of a registry whose holdings live in a package of their own (CAN-3301)', () => {
  // DA Utilities keeps `Holding` in utility-registry-holding-v0, apart from the app package that runs the batch.
  const HOLDING_PKG = 'ef'.repeat(32);
  const split = { [ADMIN]: [{ ...(FACTORIES[ADMIN]?.[0] as CantonTransferFactory), holdingPackageId: HOLDING_PKG }] };
  const checkSplit = checkIntentSettle({ publicKey: KEY, party: ME, intent, feeBps: 30n, proof, entryCid: '00en', factories: split });
  const credited = (pkg: string) => [holding('10', ME, PAYOUT, false, pkg), holding('11', OPERATOR, FEE, false, pkg)];

  test('TC-SDK-3301-01: the payout credited as a holding of the registry’s holding package counts', () => {
    expect(() => checkSplit(prepared(), [honest({ credit: credited(HOLDING_PKG) })])).not.toThrow();
  });

  test('TC-SDK-3301-02: a holding of the app package is no payout of a registry that keeps holdings apart', () => {
    refused(() => checkSplit(prepared(), [honest({ credit: credited(REG_PKG) })]), /credited 0, not 99\.7008973081/);
  });
});
