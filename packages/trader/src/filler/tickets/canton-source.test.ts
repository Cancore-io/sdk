import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCantonSourceOrder,
  FILL_TICKET_DOMAIN,
  FILL_TICKET_TYPES,
  fillerIdHash,
  repayToFromParty,
  type CantonIntent,
  type CantonParty,
  type CantonSourceIntent,
  type Hex,
  type OrderJson,
  type TicketIssuedEvm,
  type TicketJson,
  type TicketOffer,
} from '@cancore/contracts';
import { CANTON_ALLOCATION_TEMPLATES } from '../canton/factories';
import { FillerChains, type ChainConfig } from '../chain';
import { GatewayError } from '../errors';
import type { FillSigner } from '../signer';
import { createRecordingEventSink, createRecordingLogger, createTestTypedDataSigner, FakeChain, FakeClock } from '../testing';
import { checkCantonSource, type CantonSourceReader } from './canton-source';
import { TicketVerifier } from './checks';
import { Refusal } from './refusal';

const PARTY = 'filler-acme::12206c81aa';
const OPERATOR = 'cancore-intent-operator::1220ee';
const ALLOCATION_TEMPLATE = `${'ab'.repeat(32)}:Cnrx.Allocation:CnrxAllocationV2`;

const VECTORS = join(__dirname, '..', '..', '..', '..', 'contracts', 'spec', 'vectors');
const golden = JSON.parse(readFileSync(join(VECTORS, 'canton-order.json'), 'utf8')) as {
  vector: { input: CantonSourceIntent & { createdAt: number; fillDeadline: number }; order: OrderJson; orderHash: Hex };
};

const decimal10 = (v: string): string => {
  const [whole, fraction = ''] = v.split('.');
  return `${whole}.${fraction.padEnd(10, '0')}`;
};

/** The intent wire of a Canton-source request, as `GET /v1/filler/canton/intents/{orderHash}` serves it. */
function intentOf(input: CantonSourceIntent, orderHash: Hex, legs: { payout: string; fee: string }, refundAfter: string): CantonIntent {
  const units = (BigInt(Math.round(Number(input.minReceived) * 10 ** input.wantDecimals))).toString();
  return {
    intentCid: '00si',
    templateId: `${'cd'.repeat(32)}:Intent.SwapIntent:SwapIntent`,
    orderHash,
    owner: input.ownerPartyId,
    operator: OPERATOR,
    filler: PARTY,
    fillerId: input.fillerId,
    requestId: input.requestId,
    asset: { admin: input.instrumentAdmin, id: input.instrumentId },
    amount: decimal10(input.amount),
    destination: { chainId: String(input.destinationChainId), token: input.wantToken.toLowerCase() as Hex, recipient: input.recipient.toLowerCase() as Hex },
    minReceived: { units, decimals: input.wantDecimals },
    // As the JSON Ledger API writes a Decimal: ten fraction digits.
    feeRate: decimal10(input.feeRate),
    fillDeadline: String(input.fillDeadline),
    refundAfter,
    orderCreatedAt: String(input.createdAt),
    allocationCid: '00al',
    allocation: {
      contractId: '00al',
      templateId: ALLOCATION_TEMPLATE,
      admin: input.instrumentAdmin,
      authorizer: input.ownerPartyId,
      committed: true,
      settlementId: `cancore-intent/${orderHash.slice(2)}`,
      executors: [OPERATOR, input.ownerPartyId],
      settlementDeadline: refundAfter,
      legs: [
        { legId: 'payout', side: 'SENDER', otherside: PARTY, amount: legs.payout, instrumentId: input.instrumentId },
        { legId: 'fee', side: 'SENDER', otherside: OPERATOR, amount: legs.fee, instrumentId: input.instrumentId },
      ],
    },
  };
}

const ACTIVE: CantonParty = { party: PARTY, publicKey: null, registry: { state: 'ACTIVE', proposalCid: null, entryCid: '00en' } };

function reader(intent: CantonIntent | Error, party: CantonParty | Error = ACTIVE): CantonSourceReader & { asked: Hex[] } {
  const asked: Hex[] = [];
  return {
    asked,
    intent: async (orderHash) => {
      asked.push(orderHash);
      if (intent instanceof Error) throw intent;
      return structuredClone(intent);
    },
    party: async () => {
      if (party instanceof Error) throw party;
      return party;
    },
  };
}

// 1250.5 CNRX at 30 bps, divided as the ledger divides (Numeric 10, half to even): 1250.5 / 1.003.
const GOLDEN_LEGS = { payout: '1246.7597208375', fee: '3.7402791625' };

function golden3(mutate: (i: CantonIntent) => void = () => undefined, party: CantonParty | Error = ACTIVE) {
  const { input, order, orderHash } = golden.vector;
  const intent = intentOf(input, orderHash, GOLDEN_LEGS, String(input.fillDeadline + 3_600));
  mutate(intent);
  const ticket = { orderHash, fillerId: fillerIdHash('acme'), deliveryKey: `0x${'0d'.repeat(20)}`, repayTo: repayToFromParty(PARTY), attempt: 0, validFrom: '1', validUntil: '2' } as TicketJson;
  const r = reader(intent, party);
  const passed: string[] = [];
  const run = (overrides: { ticket?: Partial<TicketJson>; order?: Partial<OrderJson>; requiredProofWindowSec?: number } = {}) =>
    checkCantonSource(
      {
        order: { ...order, ...overrides.order },
        ticket: { ...ticket, ...overrides.ticket },
        party: PARTY,
        fillerId: 'acme',
        requiredProofWindowSec: overrides.requiredProofWindowSec ?? 2_700,
        reader: r,
        allocationTemplates: { [input.instrumentAdmin]: [ALLOCATION_TEMPLATE] },
      },
      (check) => void passed.push(check),
    );
  return { run, passed, reader: r, orderHash };
}

async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('V-C1…V-C6 on the golden Canton-source order (CAN-1863)', () => {
  test('a committed intent that names this filler passes every check, in order', async () => {
    const g = golden3();
    await g.run();
    expect(g.passed).toEqual(['V-C1', 'V-C2', 'V-C3', 'V-C4', 'V-C5', 'V-C6']);
    expect(g.reader.asked).toEqual([golden.vector.orderHash]);
  });

  test('V-C3: the hash recomputed from the intent fields is the canton-order.json orderHash', async () => {
    const { input, orderHash } = golden.vector;
    expect(buildCantonSourceOrder({ ...input, minReceived: '1200250000', wantDecimals: 0 }).orderHash).toBe(orderHash);
    await expect(golden3().run()).resolves.toBeUndefined();
  });

  test('a fee rate at 0 leaves one leg: the whole give to the filler', async () => {
    const { input } = golden.vector;
    const zero = { ...input, feeRate: '0' };
    const built = buildCantonSourceOrder(zero);
    const intent = intentOf(zero, built.orderHash, { payout: '1250.5', fee: '0' }, String(input.fillDeadline + 3_600));
    intent.allocation!.legs = intent.allocation!.legs.slice(0, 1);
    const passed: string[] = [];
    await checkCantonSource(
      {
        order: built.order as unknown as OrderJson,
        ticket: { orderHash: built.orderHash, repayTo: repayToFromParty(PARTY) } as TicketJson,
        party: PARTY, fillerId: 'acme', requiredProofWindowSec: 2_700, reader: reader(intent),
        allocationTemplates: { [input.instrumentAdmin]: [ALLOCATION_TEMPLATE] },
      },
      (check) => void passed.push(check),
    );
    expect(passed).toHaveLength(6);
  });

  type Case = [name: string, mutate: (i: CantonIntent) => void, check: string, reason: string, run?: Parameters<ReturnType<typeof golden3>['run']>[0], party?: CantonParty | Error];
  const cases: Case[] = [
    ['V-C1: no live intent names this filler (UNKNOWN_TICKET)', () => undefined, 'V-C1', 'ESCROW_NOT_OPEN'],
    ['V-C1: the intent names another filler party', (i) => void (i.filler = 'other::1220ff'), 'V-C1', 'ESCROW_MISMATCH'],
    ['V-C1: the intent names another fillerId', (i) => void (i.fillerId = 'other'), 'V-C1', 'ESCROW_MISMATCH'],
    ['V-C1: the contract is not a SwapIntent', (i) => void (i.templateId = `${'cd'.repeat(32)}:Intent.DeliveryReceipt:DeliveryOrder`), 'V-C1', 'ESCROW_MISMATCH'],
    ['V-C1: the read answers for another order', (i) => void (i.orderHash = `0x${'ee'.repeat(32)}`), 'V-C1', 'ESCROW_MISMATCH'],
    ['V-C2: another amount than the offer', (i) => void (i.amount = '1250.4'), 'V-C2', 'ESCROW_MISMATCH'],
    ['V-C2: another instrument', (i) => void (i.asset = { ...i.asset, id: 'CC' }), 'V-C2', 'ESCROW_MISMATCH'],
    ['V-C2: another destination chain', (i) => void (i.destination = { ...i.destination, chainId: '56' }), 'V-C2', 'ESCROW_MISMATCH'],
    ['V-C2: another recipient', (i) => void (i.destination = { ...i.destination, recipient: `0x${'99'.repeat(20)}` }), 'V-C2', 'ESCROW_MISMATCH'],
    ['V-C2: another minReceived', (i) => void (i.minReceived = { ...i.minReceived, units: '1200249999' }), 'V-C2', 'ESCROW_MISMATCH'],
    ['V-C2: another fee rate', (i) => void (i.feeRate = '0.004'), 'V-C2', 'ESCROW_MISMATCH'],
    ['V-C2: another fillDeadline', (i) => void (i.fillDeadline = String(Number(i.fillDeadline) - 1)), 'V-C2', 'ESCROW_MISMATCH'],
    ['V-C2: another orderCreatedAt', (i) => void (i.orderCreatedAt = String(Number(i.orderCreatedAt) + 1)), 'V-C2', 'ESCROW_MISMATCH'],
    ['V-C2: another owner', (i) => void (i.owner = 'mallory::1220ab'), 'V-C2', 'ESCROW_MISMATCH'],
    ['V-C2: another requestId', (i) => void (i.requestId = 'req-other'), 'V-C2', 'ESCROW_MISMATCH'],
    ['V-C2: a fee rate the order cannot carry', (i) => void (i.feeRate = '0.00305'), 'V-C2', 'ESCROW_MISMATCH'],
    ['V-C3: the offered order is the intent, but the ticket names another hash', () => undefined, 'V-C3', 'ESCROW_MISMATCH'],
    ['V-C4: the allocation is not live', (i) => void (i.allocation = null), 'V-C4', 'ESCROW_NOT_OPEN'],
    ['V-C4: the allocation read is not allocationCid', (i) => void (i.allocation!.contractId = '00xx'), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C4: an allocation template that is not pinned', (i) => void (i.allocation!.templateId = `${'99'.repeat(32)}:Cnrx.Allocation:CnrxAllocationV2`), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C4: not committed (the owner could withdraw before refundAfter)', (i) => void (i.allocation!.committed = false), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C4: authorized by another party than the owner', (i) => void (i.allocation!.authorizer = 'mallory::1220ab'), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C4: another set of executors (the owner alone)', (i) => void (i.allocation!.executors = [i.owner]), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C4: another set of executors (the filler among them)', (i) => void (i.allocation!.executors = [i.operator, i.owner, PARTY]), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C4: another set of executors (a third party for the owner)', (i) => void (i.allocation!.executors = [i.operator, 'mallory::1220ab']), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C4: settlementDeadline is not refundAfter', (i) => void (i.allocation!.settlementDeadline = String(Number(i.refundAfter) + 1)), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C4: no settlement deadline', (i) => void (i.allocation!.settlementDeadline = null), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C4: another settlement', (i) => void (i.allocation!.settlementId = 'cancore-intent/other'), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C4: the net leg pays another party', (i) => void (i.allocation!.legs[0]!.otherside = 'other-filler::1220cc'), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C4: the fee leg pays the filler instead of the operator', (i) => void (i.allocation!.legs[1]!.otherside = PARTY), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C4: the net leg is one unit short', (i) => void (i.allocation!.legs[0]!.amount = '1246.7597208374'), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C4: a third leg', (i) => void i.allocation!.legs.push({ legId: 'extra', side: 'SENDER', otherside: 'mallory::1220ab', amount: '0.1', instrumentId: 'CNRX' }), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C4: the net leg on the receiving side', (i) => void (i.allocation!.legs[0]!.side = 'RECEIVER'), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C4: a leg of another instrument', (i) => void (i.allocation!.legs[1]!.instrumentId = 'CC'), 'V-C4', 'ESCROW_MISMATCH'],
    ['V-C5: ticket.repayTo is not the hash of this party', () => undefined, 'V-C5', 'TICKET_MISMATCH', { ticket: { repayTo: repayToFromParty('other::1220') } }],
    ['V-C5: the registry entry is only proposed', () => undefined, 'V-C5', 'OTHER', undefined, { ...ACTIVE, registry: { state: 'PROPOSED', proposalCid: '00pp', entryCid: null } }],
    ['V-C5: the registry entry was removed', () => undefined, 'V-C5', 'OTHER', undefined, { ...ACTIVE, registry: { state: 'REMOVED', proposalCid: null, entryCid: null } }],
    ['V-C5: another party is registered for the fillerId', () => undefined, 'V-C5', 'OTHER', undefined, { ...ACTIVE, party: 'other::1220' }],
    ['V-C5: the registry cannot be read (N-12)', () => undefined, 'V-C5', 'OTHER', undefined, new GatewayError('CANTON_UNAVAILABLE', true, 'down')],
    ['V-C6: refundAfter − fillDeadline one second short of the proof window', () => undefined, 'V-C6', 'PROOF_WINDOW_TOO_SHORT', { requiredProofWindowSec: 3_601 }],
  ];

  // A rest parameter: jest reads a callback with more parameters than the row has columns as a `done` test.
  test.each(cases)('%s', async (...row: Case) => {
    const [name, mutate, check, reason, run, party] = row;
    const g = golden3(mutate, party ?? ACTIVE);
    if (name.startsWith('V-C1: no live intent')) g.reader.intent = async () => Promise.reject(new GatewayError('UNKNOWN_TICKET', false, 'none'));
    const overrides = name.startsWith('V-C3') ? { ticket: { orderHash: `0x${'ee'.repeat(32)}` as Hex }, order: {} } : run;
    if (name.startsWith('V-C3')) {
      // The read answers for the ticket's hash, and the order offered is the intent's own: only the label lies.
      g.reader.intent = async () => ({ ...intentOf(golden.vector.input, golden.vector.orderHash, GOLDEN_LEGS, String(golden.vector.input.fillDeadline + 3_600)), orderHash: `0x${'ee'.repeat(32)}` });
    }
    const r = await refusal(g.run(overrides));
    expect({ check: r.check, reason: r.reason }).toEqual({ check, reason });
    expect(g.passed).toEqual(['V-C1', 'V-C2', 'V-C3', 'V-C4', 'V-C5', 'V-C6'].slice(0, ['V-C1', 'V-C2', 'V-C3', 'V-C4', 'V-C5', 'V-C6'].indexOf(check)));
  });

  test('V-C1: a read that fails is unverifiable, never passed (N-12)', async () => {
    const g = golden3();
    g.reader.intent = async () => Promise.reject(new GatewayError('CANTON_UNAVAILABLE', true, 'participant down'));
    const r = await refusal(g.run());
    expect(r).toMatchObject({ check: 'V-C1', reason: 'ESCROW_NOT_OPEN', detail: expect.stringMatching(/^unverifiable/) });
  });

  test('V-C6: exactly the required window passes', async () => {
    await expect(golden3().run({ requiredProofWindowSec: 3_600 })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The verifier: a Canton source runs V-C1…V-C6 in place of V-E1…V-E4
// ---------------------------------------------------------------------------

const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TICKET_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const DST_ROUTER: Hex = '0x1111111111111111111111111111111111111111';
const TOKEN: Hex = '0x00000000000000000000000000000000000000aa';
const fill: FillSigner = { ...createTestTypedDataSigner(FILL_KEY), signTransaction: async () => '0x02' };
const ticketSigner = createTestTypedDataSigner(TICKET_KEY);

async function verifierSetup(canton: { reader?: CantonSourceReader; party?: string } = {}) {
  const clock = new FakeClock();
  const nowS = Math.floor(clock.now() / 1000);
  // The dev CNRX registrar: its allocation template is the one the verifier pins (CANTON_ALLOCATION_TEMPLATES).
  const [admin, [template]] = Object.entries(CANTON_ALLOCATION_TEMPLATES)[0] as [string, string[]];
  const input: CantonSourceIntent = {
    ...golden.vector.input,
    instrumentAdmin: admin,
    destinationChainId: '1',
    wantToken: TOKEN,
    wantDecimals: 0,
    minReceived: '99',
    createdAt: nowS - 60,
    fillDeadline: nowS + 600,
  };
  const built = buildCantonSourceOrder(input);
  const order = built.order as unknown as OrderJson;
  const orderHash = built.orderHash;
  const intent = intentOf(input, orderHash, GOLDEN_LEGS, String(nowS + 600 + 3_600));
  intent.minReceived = { units: '99', decimals: 0 };
  intent.allocation!.templateId = template!;
  const dst = new FakeChain(1n, 'eth');
  dst.router(DST_ROUTER).ticketSigners.add(ticketSigner.address);
  dst.token(TOKEN).setBalance(fill.address, 1_000n).approve(fill.address, DST_ROUTER, 1_000n);
  dst.nativeBalances.set(fill.address.toLowerCase(), 10n ** 16n);
  const validFrom = String(nowS);
  const validUntil = String(nowS + 300);
  const offer: TicketOffer = {
    type: 'ticket.offer', id: 'g-1', fillerId: 'acme', sentAt: clock.now(), sig: '0x', orderHash, attempt: 0, order, amountOut: '99', validFrom, validUntil, acceptBy: clock.now() + 5_000,
  };
  const ticket = { orderHash, fillerId: fillerIdHash('acme'), deliveryKey: fill.address.toLowerCase(), repayTo: repayToFromParty(PARTY), attempt: 0, validFrom, validUntil };
  const ticketSig = await ticketSigner.signTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: ticket });
  const issued = { type: 'ticket.issued', form: 'evm', fillerId: 'acme', sentAt: clock.now(), sig: '0x', orderHash, attempt: 0, ticket, ticketSig } as unknown as TicketIssuedEvm;
  const logger = createRecordingLogger();
  const config: ChainConfig = { router: DST_ROUTER, openConfirmations: 3, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30, minGasWei: 10n ** 15n };
  const chains = new FillerChains({ 'eip155:1': [dst] }, { 'eip155:1': config }, logger);
  const r = canton.reader ?? reader(intent);
  const verifier = new TicketVerifier({
    chains, fillSigners: { 'eip155:1': fill }, fillerId: 'acme', ticketSigners: [ticketSigner.address], deltaIssueMs: 3_000, clock, events: createRecordingEventSink(), logger,
    ...('party' in canton ? (canton.party ? { cantonParty: canton.party } : {}) : { cantonParty: PARTY }),
    ...(canton.reader === undefined && 'reader' in canton ? {} : { cantonSource: r }),
  });
  return { verifier, input: { offer, issued, issuedAtMs: clock.now() }, dst, orderHash, intent };
}

describe('TicketVerifier on a Canton source (CAN-1863)', () => {
  test('V-C1…V-C6 run in place of V-E1…V-E4; V-T1 and V-E5 are read on the destination', async () => {
    const h = await verifierSetup();
    const result = await h.verifier.verify(h.input);
    expect(result).toMatchObject({ ok: true });
    expect(result.checks.map((c) => c.check)).toEqual(['form', 'V-T4', 'V-T2', 'V-T3', 'V-C1', 'V-C2', 'V-C3', 'V-C4', 'V-C5', 'V-C6', 'V-T1', 'V-E5']);
  });

  test('a delivery already on the destination router: V-E5 on the intent orderHash', async () => {
    const h = await verifierSetup();
    h.dst.router(DST_ROUTER).filled.set(h.orderHash, 50n);
    await expect(h.verifier.verify(h.input)).resolves.toMatchObject({ ok: false, reason: 'OTHER', detail: expect.stringMatching(/^V-E5: already-filled/) });
  });

  test('a failed V-C stops the checks: no V-T1, no V-E5, and the decline carries its code', async () => {
    const h = await verifierSetup();
    h.intent.allocation!.executors = [h.intent.owner];
    const result = await h.verifier.verify(h.input);
    expect(result).toMatchObject({ ok: false, reason: 'ESCROW_MISMATCH', detail: expect.stringMatching(/^V-C4:/) });
    expect(result.checks.map((c) => c.check)).not.toContain('V-T1');
  });

  test('a node without a Canton reader declines a Canton source at form, never signs blind', async () => {
    const h = await verifierSetup({ reader: undefined });
    await expect(h.verifier.verify(h.input)).resolves.toMatchObject({ ok: false, reason: 'OTHER', detail: expect.stringMatching(/^form:/) });
  });
});
