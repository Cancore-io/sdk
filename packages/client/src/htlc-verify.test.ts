/**
 * The self-custody HTLC verifiers against a hostile API: every field the account would sign is
 * swapped in turn, and each swap must be refused before anything is signed (CAN-2929, threat model
 * F1–F21 and A1–A15 in the ticket).
 */
import type { Value } from '@canton-network/core-ledger-proto';
import { DEFAULT_ESCROWS, DEFAULT_FEE_RECIPIENTS } from './dvp-admins';
import { DEFAULT_TRUSTED_PACKAGES, UnverifiedTransactionError } from './dvp-verify';
import { createNode, createOf, DEV, factoryTransferLeg, holding, node, PKG, spend, v } from './dvp-prepared.fixture';
import {
  acceptCounterLeg, amuletInstruction, ESCROW, EXECUTOR, FEE_PARTY, HASH_LOCK, HTLC_PACKAGE, initRequestLeg, iso, some,
  type InitRequest, type Proposal,
} from './htlc-prepared.fixture';
import { verifyHtlcAcceptCounterPrepared, verifyHtlcFlowBPrepared, type AcceptCounterTerms, type FlowBTerms } from './htlc-verify';

const ME = 'party-me::1220aa';
const TAKER = 'party-taker::1220bb';
const MALLORY = 'mallory::1220ff';
const CC = { id: 'Amulet', admin: DEV.dso };
const CBTC = { id: 'CBTC', admin: DEV.cbtcRegistrar };
const NOW = Date.now();
const HOUR = 3_600_000;
const OTHER_HASH = 'cd'.repeat(32);
const UNTRUSTED_ID = 'ff'.repeat(32);

const pins = {
  escrows: DEFAULT_ESCROWS.devnet,
  executors: [EXECUTOR],
  feeParties: DEFAULT_FEE_RECIPIENTS.devnet,
  providers: [EXECUTOR],
  packages: DEFAULT_TRUSTED_PACKAGES.htlc,
};

type Prepared = { kind: string; preparedTransaction: string; preparedTransactionHash: string };

const refusedWith = async (run: Promise<void>, reason: RegExp) => {
  const err = await run.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UnverifiedTransactionError);
  expect((err as Error).message).toMatch(reason);
};

describe('Flow B: the escrow request and its deposit are signed only as the account asked (CAN-2929)', () => {
  const terms: FlowBTerms = {
    ...pins, party: ME, receiver: TAKER, amount: '10', instrument: 'Amulet', admins: [DEV.dso], hashLock: HASH_LOCK,
    timeoutHours: 2, maxFeeRate: '0.015', now: NOW, maxFee: '0.5', feeRecipients: [DEV.venue], dso: [DEV.dso],
  };
  const request = (over: Partial<InitRequest> = {}): InitRequest => ({
    party: ME, receiver: TAKER, amount: '10', instrument: CC, hashLock: HASH_LOCK, timeout: iso(NOW + 2 * HOUR),
    escrow: ESCROW, executor: EXECUTOR, fee: FEE_PARTY, maxFeeRate: '0.01', provider: null, description: 'maker quote', ...over,
  });
  const escrow = (over: Partial<InitRequest> = {}, extra: Parameters<typeof initRequestLeg>[1] = {}) => initRequestLeg(request(over), extra);
  type DepositOver = Partial<Parameters<typeof factoryTransferLeg>[0]>;
  const deposit = (over: DepositOver = {}) => factoryTransferLeg({
    party: ME, receiver: ESCROW, instrument: CC, amount: '10', input: '25', offerContract: amuletInstruction,
    outputs: [{ owner: ME, amount: '10', lockedTo: DEV.dso }, { owner: ME, amount: '15' }], ...over,
  });
  const honest = async () => [await escrow(), await deposit()];
  const refused = async (legs: Prepared[], reason: RegExp, t: FlowBTerms = terms) => refusedWith(verifyHtlcFlowBPrepared(legs, t), reason);
  const field = (name: string, value: Value) => ({ fields: (f: Record<string, Value>) => { f[name] = value; } });

  test('the honest request and deposit pass; a registry token with no deposit leg passes too', async () => {
    await expect(verifyHtlcFlowBPrepared(await honest(), terms)).resolves.toBeUndefined();
    const cbtc = { ...terms, instrument: 'CBTC', admins: [CBTC.admin] };
    await expect(verifyHtlcFlowBPrepared([await escrow({ instrument: CBTC })], cbtc)).resolves.toBeUndefined();
    // The venue as CIP-0104 provider is the pinned observer.
    await expect(verifyHtlcFlowBPrepared([await escrow({ provider: EXECUTOR }), await deposit()], terms)).resolves.toBeUndefined();
  });

  test('F1: a template of an untrusted package, or another template, is not the escrow request', async () => {
    await refused([await escrow({}, { packageId: UNTRUSTED_ID }), await deposit()], /the escrow request is not an HTLCInitRequest of a trusted htlc package/);
    await refused([await escrow({}, { packageName: 'htlc-contract-v9x' }), await deposit()], /not an HTLCInitRequest of a trusted htlc package/);
    await refused([await escrow({}, { entityName: 'HTLCProposal' }), await deposit()], /not an HTLCInitRequest of a trusted htlc package/);
    await refused([await escrow({}, { moduleName: 'HTLC.HTLC' }), await deposit()], /not an HTLCInitRequest of a trusted htlc package/);
  });

  test('F2: a command beside the create is refused', async () => {
    const stray = createNode('x', createOf('d1'.repeat(34), HTLC_PACKAGE.name, HTLC_PACKAGE.id, 'HTLC.InitRequest', 'HTLCInitRequest', v.record({}), [ME]));
    await refused([await escrow({}, { extraRoots: [stray] }), await deposit()], /expected a transaction with exactly one command/);
  });

  test('F2: a transaction whose command is not a create is not the escrow request', async () => {
    // The deposit leg handed over under the escrow kind: an exercise, where a create is asked for.
    const exercising = { ...(await deposit()), kind: 'escrow' };
    await refused([exercising, await deposit()], /the escrow request is not a create/);
  });

  test('F3: another signatory beside the account is refused', async () => {
    await refused([await escrow({}, { signatories: [ME, MALLORY] }), await deposit()], /the escrow request is signed by party-me::1220aa, mallory::1220ff, not by this account alone/);
    await refused([await escrow({}, { signatories: [MALLORY] }), await deposit()], /the escrow request is signed by mallory::1220ff, not by this account alone/);
  });

  test('F4: a request from another sender is refused', async () => {
    await refused([await escrow({}, field('sender', v.party(MALLORY))), await deposit()], /the escrow request sends from mallory::1220ff, not from this account/);
  });

  test('F5: another receiver is refused', async () => {
    await refused([await escrow({ receiver: MALLORY }), await deposit()], /the escrow request pays mallory::1220ff, not party-taker::1220bb/);
  });

  test('F6: another amount is refused, more or less', async () => {
    await refused([await escrow({ amount: '11' }), await deposit()], /the escrow request locks 11, not 10/);
    await refused([await escrow({ amount: '9.9999999999' }), await deposit()], /the escrow request locks 9.9999999999, not 10/);
  });

  test('F7: a hash lock that is not the account\'s is refused', async () => {
    await refused([await escrow({ hashLock: OTHER_HASH }), await deposit()], /the escrow request is locked to another hash than the account's/);
  });

  test('F8: a timeout outside the hours asked for, give or take the clock skew, is refused', async () => {
    await refused([await escrow({ timeout: iso(NOW + 3 * HOUR) }), await deposit()], /the escrow request times out at .*, not 2 hours from now/);
    await refused([await escrow({ timeout: iso(NOW + 1 * HOUR) }), await deposit()], /the escrow request times out at .*, not 2 hours from now/);
    await refused([await escrow({ timeout: iso(NOW - HOUR) }), await deposit()], /the escrow request times out at .*, not 2 hours from now/);
    // Inside the five minutes of skew it is the same request.
    await expect(verifyHtlcFlowBPrepared([await escrow({ timeout: iso(NOW + 2 * HOUR + 4 * 60_000) }), await deposit()], terms)).resolves.toBeUndefined();
  });

  test('F9: another instrument, or the right one under an admin this SDK does not pin, is refused', async () => {
    await refused([await escrow({ instrument: CBTC }), await deposit()], /the escrow request locks CBTC of cbtc-network::.*, not Amulet of a pinned admin/);
    await refused([await escrow({ instrument: { id: 'Amulet', admin: MALLORY } }), await deposit()], /the escrow request locks Amulet of mallory::1220ff, not Amulet of a pinned admin/);
  });

  test('F10: an escrow party that is not a pinned Cancore escrow is refused', async () => {
    await refused([await escrow({ escrow: MALLORY }), await deposit({ receiver: MALLORY })], /the escrow request names mallory::1220ff as escrow, which is not a pinned Cancore escrow party/);
  });

  test('F11: an executor that is not the pinned venue is refused', async () => {
    await refused([await escrow({ executor: MALLORY }), await deposit()], /the escrow request names mallory::1220ff as executor, which is not the pinned venue/);
  });

  test('F12: a fee party that is not a pinned Cancore fee party is refused', async () => {
    await refused([await escrow({ fee: MALLORY }), await deposit()], /the escrow request names mallory::1220ff as fee party, which is not a pinned Cancore fee party/);
  });

  test('F13: a fee rate cap above the account\'s is refused; at the cap it passes', async () => {
    await refused([await escrow({ maxFeeRate: '0.05' }), await deposit()], /the escrow request allows a fee rate of 0.05, above this account's 0.015/);
    await refused([await escrow({}, field('maxFeeRate', v.text('0.01'))), await deposit()], /the escrow request allows a fee rate of an unreadable value/);
    await expect(verifyHtlcFlowBPrepared([await escrow({ maxFeeRate: '0.015' }), await deposit()], terms)).resolves.toBeUndefined();
  });

  test('F14: a provider that is not pinned is refused', async () => {
    await refused([await escrow({ provider: MALLORY }), await deposit()], /the escrow request names mallory::1220ff as provider, which is not a pinned one/);
    await refused([await escrow({}, field('provider', v.party(EXECUTOR))), await deposit()], /the escrow request names .* as provider, which is not a pinned one/);
  });

  test('F15: a field this SDK does not read, or one missing, is refused', async () => {
    await refused([await escrow({}, field('backdoor', v.party(MALLORY))), await deposit()], /the escrow request has fields this SDK does not read: backdoor/);
    await refused([await escrow({}, { fields: (f) => { delete f.description; } }), await deposit()], /the escrow request is missing description/);
    // A field of the wrong type is not read as the right one.
    await refused([await escrow({}, field('amount', v.text('10'))), await deposit()], /the escrow request locks an unreadable amount, not 10/);
  });

  test('F16: a deposit to another party than the request\'s escrow is refused, even another pinned escrow', async () => {
    await refused([await escrow(), await deposit({ receiver: MALLORY })], /sends to mallory::1220ff, not to cancore-escrow-retail::.*, the receiver this send was asked for/);
    const second = DEFAULT_ESCROWS.devnet[1]!;
    await refused([await escrow(), await deposit({ receiver: second })], /sends to cancore-escrow-partner::.*, not to cancore-escrow-retail::.*, the receiver this send was asked for/);
  });

  test('F17: a deposit of another amount than the request\'s is refused', async () => {
    await refused([await escrow(), await deposit({ command: { amount: '11' }, offer: { amount: '11' }, outputs: [{ owner: ME, amount: '11', lockedTo: DEV.dso }, { owner: ME, amount: '14' }] })],
      /is given 11 Amulet, not the 10 this send was asked for/);
  });

  test('F18: a deposit of another instrument, or under an admin this SDK does not pin, is refused', async () => {
    await refused([await escrow(), await deposit({ expectedAdmin: MALLORY })], /names mallory::1220ff as the instrument admin, which is not one this SDK pins for it/);
    await refused([await escrow(), await deposit({ command: { instrumentId: { id: 'CBTC', admin: DEV.dso } } })], /transfers another instrument/);
  });

  test('F19: a deposit through a factory the admin did not sign is refused', async () => {
    await refused([await escrow(), await deposit({ factory: (h) => ({ ...h, signatories: [MALLORY] }) })], /runs on a transfer factory the instrument admin did not sign/);
  });

  test('F20: a deposit that costs the account more than the amount and its fee ceiling is refused', async () => {
    await refused([await escrow(), await deposit({ outputs: [{ owner: ME, amount: '10', lockedTo: DEV.dso }] })], /the send costs this account 25 Amulet, more than the 10 it sends/);
    await refused([await escrow(), await deposit({ outputs: [{ owner: ME, amount: '10', lockedTo: DEV.dso }, { owner: MALLORY, amount: '15' }] })], /node 3 involves mallory::1220ff, who is not part of this send/);
  });

  test('F21: a leg of another kind, a second request or deposit, or no request at all is refused', async () => {
    const [request1, deposit1] = await honest();
    await refused([request1!, { ...deposit1!, kind: 'fee' }], /leg 1 is a fee, not the escrow request or its deposit/);
    await refused([request1!, request1!, deposit1!], /expected one escrow request, got 2/);
    await refused([request1!, deposit1!, deposit1!], /expected at most one deposit, got 2/);
    await refused([deposit1!], /expected one escrow request, got 0/);
    await refused([], /expected one escrow request, got 0/);
  });

  test('a request the account must not sign is refused whatever its bytes say about the hash', async () => {
    const [request1] = await honest();
    await refused([{ ...request1!, preparedTransactionHash: (await escrow({ amount: '11' })).preparedTransactionHash }], /does not hash to the hash it came with/);
  });
});

describe('accept-counter: the counter HTLC is accepted only as the account expects it (CAN-2929)', () => {
  const terms: AcceptCounterTerms = {
    ...pins, party: ME, amount: '5000', instrument: 'Amulet', admins: [DEV.dso], hashLock: HASH_LOCK, minTimeout: NOW + HOUR, now: NOW,
  };
  const proposal = (over: Partial<Proposal> = {}): Proposal => ({
    party: ME, sender: TAKER, amount: '5000', instrument: CC, hashLock: HASH_LOCK, timeout: iso(NOW + 2 * HOUR),
    escrow: ESCROW, executor: EXECUTOR, fee: FEE_PARTY, feeAmount: '24.8756218905', provider: null, description: 'counter', ...over,
  });
  const accept = (over: Partial<Proposal> = {}, extra: Parameters<typeof acceptCounterLeg>[1] = {}) => acceptCounterLeg(proposal(over), extra);
  const refused = async (legs: Prepared[], reason: RegExp, t: AcceptCounterTerms = terms) => refusedWith(verifyHtlcAcceptCounterPrepared(legs, t), reason);
  const param = (name: string, value: Value) => ({ params: (p: Record<string, Value>) => { p[name] = value; } });

  test('the honest accept passes, with the venue as provider too', async () => {
    await expect(verifyHtlcAcceptCounterPrepared([await accept()], terms)).resolves.toBeUndefined();
    await expect(verifyHtlcAcceptCounterPrepared([await accept({ provider: EXECUTOR })], terms)).resolves.toBeUndefined();
    await expect(verifyHtlcAcceptCounterPrepared([await accept({}, { argument: (a) => { a.acceptExpectedAdmin = some(v.party(DEV.dso)); } })], terms)).resolves.toBeUndefined();
  });

  test('one transaction, no more', async () => {
    const leg = await accept();
    await refused([leg, leg], /expected one transaction, got 2/);
    await refused([], /expected one transaction, got 0/);
  });

  test('A1: another choice, template or package, or an accept that leaves the proposal alive, is refused', async () => {
    await refused([await accept({}, { command: (c) => { c.choiceId = 'Proposal_Reject'; } })], /the accept is not Proposal_Accept on an HTLCProposal of a trusted htlc package/);
    await refused([await accept({}, { proposalPackageId: UNTRUSTED_ID })], /not Proposal_Accept on an HTLCProposal of a trusted htlc package/);
    await refused([await accept({}, { command: (c) => { c.templateId = { ...c.templateId!, entityName: 'HTLC' }; } })], /not Proposal_Accept on an HTLCProposal of a trusted htlc package/);
    const elsewhere = <T extends { moduleName: string }>(t: T): T => ({ ...t, moduleName: 'Mallory.HTLC' });
    await refused([await accept({}, { command: (c) => { c.templateId = elsewhere(c.templateId!); }, disclose: (h) => ({ ...h, templateId: elsewhere(h.templateId!) }) })],
      /not Proposal_Accept on an HTLCProposal of a trusted htlc package/);
    await refused([await accept({}, { command: (c) => { c.consuming = false; } })], /the accept does not consume the proposal/);
    const create = await initRequestLeg({
      party: ME, receiver: TAKER, amount: '5000', instrument: CC, hashLock: HASH_LOCK, timeout: iso(NOW + 2 * HOUR),
      escrow: ESCROW, executor: EXECUTOR, fee: FEE_PARTY, maxFeeRate: '0.01', provider: null, description: 'counter',
    });
    await refused([create], /the accept is not Proposal_Accept on an HTLCProposal of a trusted htlc package/);
  });

  test('A2: acting with another party beside the account is refused', async () => {
    await refused([await accept({}, { command: (c) => { c.actingParties = [ME, MALLORY]; } })], /the accept acts as party-me::1220aa, mallory::1220ff, not as this account alone/);
    await refused([await accept({}, { command: (c) => { c.actingParties = [MALLORY]; } })], /the accept acts as mallory::1220ff, not as this account alone/);
  });

  test('A3: a proposal the transaction does not disclose, or another contract under its id, is refused', async () => {
    await refused([await accept({}, { disclose: false })], /the accept does not disclose the proposal it accepts/);
    await refused([await accept({}, { disclose: (h) => ({ ...h, templateId: { ...h.templateId!, entityName: 'HTLCInitRequest' } }) })], /the accept runs on another template than the proposal it names/);
  });

  test('A4: a proposal to another receiver is refused', async () => {
    await refused([await accept({}, param('receiver', v.party(MALLORY)))], /the proposal is to mallory::1220ff, not to this account/);
  });

  test('A5: a proposal locked to another hash than the account\'s is refused', async () => {
    await refused([await accept({ hashLock: OTHER_HASH })], /the proposal is locked to another hash than the account's/);
  });

  test('A6: another amount is refused', async () => {
    await refused([await accept({ amount: '4999' })], /the proposal locks 4999, not 5000/);
  });

  test('A7: another instrument, or an admin this SDK does not pin, is refused', async () => {
    await refused([await accept({ instrument: CBTC })], /the proposal locks CBTC of cbtc-network::.*, not Amulet of a pinned admin/);
    await refused([await accept({ instrument: { id: 'Amulet', admin: MALLORY } })], /the proposal locks Amulet of mallory::1220ff, not Amulet of a pinned admin/);
  });

  test('A8: a counter that times out before the claim margin is refused; at the margin it passes', async () => {
    await refused([await accept({ timeout: iso(NOW + 30 * 60_000) })], /the proposal times out at .*, before .*, the claim margin this account needs/);
    await expect(verifyHtlcAcceptCounterPrepared([await accept({ timeout: iso(NOW + HOUR) })], terms)).resolves.toBeUndefined();
  });

  test('A9: an escrow, executor or fee party that is not pinned is refused', async () => {
    await refused([await accept({ escrow: MALLORY })], /the proposal names mallory::1220ff as escrow, which is not a pinned Cancore escrow party/);
    await refused([await accept({ executor: MALLORY })], /the proposal names mallory::1220ff as executor, which is not the pinned venue/);
    await refused([await accept({ fee: MALLORY })], /the proposal names mallory::1220ff as fee party, which is not a pinned Cancore fee party/);
  });

  test('A10: a provider that is not pinned is refused', async () => {
    await refused([await accept({ provider: MALLORY })], /the proposal names mallory::1220ff as provider, which is not a pinned one/);
  });

  test('A11: a field this SDK does not read — in the params, the contract or the choice argument — is refused', async () => {
    await refused([await accept({}, param('backdoor', v.party(MALLORY)))], /the proposal has fields this SDK does not read: backdoor/);
    await refused([await accept({}, { params: (p) => { delete p.feeAmount; } })], /the proposal is missing feeAmount/);
    await refused([await accept({}, { record: (r) => { r.extra = v.text('x'); } })], /the proposal contract has fields this SDK does not read: extra/);
    await refused([await accept({}, { argument: (a) => { a.redirect = v.party(MALLORY); } })], /the accept has arguments this SDK does not read: redirect/);
  });

  test('A12: an expected admin this SDK does not pin is refused', async () => {
    await refused([await accept({}, { argument: (a) => { a.acceptExpectedAdmin = some(v.party(MALLORY)); } })], /the accept expects mallory::1220ff as the instrument admin, which is not a pinned one/);
    await refused([await accept({}, { argument: (a) => { a.acceptExpectedAdmin = v.party(DEV.dso); } })], /the accept expects .* as the instrument admin, which is not a pinned one/);
  });

  test('A13: an HTLC that is not the proposal\'s, none, or two, is refused', async () => {
    await refused([await accept({}, { htlcParams: (p) => { p.receiver = v.party(MALLORY); } })], /the HTLC it creates differs from the proposal in receiver/);
    await refused([await accept({}, { htlcParams: (p) => { p.amount = v.numeric('4000.0000000000'); } })], /the HTLC it creates differs from the proposal in amount/);
    await refused([await accept({}, { htlcParams: (p) => { p.backdoor = v.party(MALLORY); } })], /the HTLC it creates has fields this SDK does not read: backdoor/);
    await refused([await accept({}, { htlcs: 0 })], /the accept creates 0 HTLCs, not one/);
    await refused([await accept({}, { htlcs: 2 })], /the accept creates 2 HTLCs, not one/);
    await refused([await accept({}, { htlcPackageId: UNTRUSTED_ID })], /node 1 runs on a HTLC that is neither the HTLC package's nor the instrument admin's/);
  });

  test('A14: an accept that spends the account\'s holding, makes it sign another contract, or has it act below the root is refused', async () => {
    const mine = holding('e1'.repeat(34), ME, CC, '100');
    await refused([await accept({}, { extraChildren: [spend('x', mine, ESCROW)], extraInputs: [mine] })], /the accept spends 100 of this account's Amulet/);
    const theirs = holding('e2'.repeat(34), DEV.dso, CC, '1');
    await refused([await accept({}, { extraChildren: [spend('x', theirs, ME)], extraInputs: [theirs] })], /this account acts below the accept, in node 2/);
    const signedByMe = createNode('x', createOf('e3'.repeat(34), 'splice-amulet', PKG.amulet, 'Splice.Amulet', 'Amulet', v.record({ dso: v.party(DEV.dso) }), [DEV.dso, ME]));
    await refused([await accept({}, { extraChildren: [signedByMe] })], /node 2 creates a Amulet signed by this account that is neither its holding nor this accept/);
  });

  test('A15: a node outside the HTLC package and the admin\'s contracts is refused', async () => {
    const foreign = createOf('e4'.repeat(34), 'mallory-pkg', '00'.repeat(32), 'Mallory', 'Drain', v.record({ owner: v.party(MALLORY) }), [MALLORY]);
    const poke = node('x', {
      oneofKind: 'exercise',
      exercise: {
        lfVersion: '2.1', contractId: foreign.contractId, packageName: foreign.packageName, templateId: foreign.templateId,
        signatories: [MALLORY], stakeholders: [MALLORY], actingParties: [ESCROW], choiceId: 'Drain', chosenValue: v.record({}),
        consuming: false, children: [], choiceObservers: [],
      },
    });
    await refused([await accept({}, { extraChildren: [poke], extraInputs: [foreign] })], /node 2 runs on a Drain that is neither the HTLC package's nor the instrument admin's/);
  });
});
