import { hashPreparedTransaction } from '@canton-network/core-tx-visualizer';
import type { Create, PreparedTransaction } from '@canton-network/core-ledger-proto';
import { acceptTransferLeg, allocationTree, createNode, DEV, exercise, factoryContract, factoryTransferLeg, holding, OFFER_CID, preapprovalContract, preapprovalProposalLeg, prepared, proposalAccept, remade, proposalCreate, selfSendLeg, spend, spendTransfer, v, withdrawTree, type FixtureLeg } from './dvp-prepared.fixture';
import { DEFAULT_INSTRUMENT_ADMINS, DEFAULT_VENUES, instrumentKey, mergeLists, networkOf } from './dvp-admins';
import { DEFAULT_TRUSTED_PACKAGES, UnverifiedTransactionError, verifyAcceptPrepared, verifyConsolidatePrepared, verifyDvpPrepared, verifyFeePrepared, verifyPreapprovalSetupPrepared, verifySelfSendPrepared, verifySendPrepared, type AcceptTerms, type ConsolidateTerms, type DvpTerms, type PreapprovalSetupTerms, type SelfSendTerms, type SendTerms } from './dvp-verify';

const MAKER = 'maker::1220aa';
const TAKER = 'taker::1220bb';
// The dev stand's own parties: the honest trees below are built from what dev actually runs.
const VENUE = DEV.venue;
const FEE = 'fee::1220dd';
const CBTC = { id: 'CBTC', admin: DEV.cbtcRegistrar };
const CC = { id: 'Amulet', admin: DEV.dso };

const terms = (party: string, over: Partial<DvpTerms> = {}): DvpTerms => ({
  swapId: 'swap-1', party, maker: MAKER, taker: TAKER,
  source: { ...CBTC, amount: '0.01' }, target: { ...CC, amount: '5000' },
  venue: VENUE, feeParty: FEE, feeRate: '0.005', packages: DEFAULT_TRUSTED_PACKAGES, now: Date.now(), maxWindowMs: 3 * 3_600_000, ...over,
});

const LEGS: Record<string, FixtureLeg> = {
  'leg-main': { sender: MAKER, receiver: TAKER, amount: '0.01', instrumentId: CBTC },
  'leg-counter': { sender: TAKER, receiver: MAKER, amount: '4975.1243781095', instrumentId: CC },
  'leg-fee': { sender: TAKER, receiver: FEE, amount: '24.8756218905', instrumentId: CC },
};

const create = (legs = LEGS, approvers = [MAKER]) =>
  prepared(MAKER, [proposalCreate('0', { venue: VENUE, swapId: 'swap-1', legs, approvers })]);
const accept = (legs = LEGS) =>
  prepared(TAKER, [proposalAccept('0', TAKER, ['1']), proposalCreate('1', { venue: VENUE, swapId: 'swap-1', legs, approvers: [MAKER, TAKER] })]);
type Tree = Parameters<typeof allocationTree>[0];
const fund = (legId: keyof typeof LEGS, leg = LEGS[legId]!, executor = VENUE, over: Partial<Tree> = {}) => {
  const { nodes, inputs } = allocationTree({ executor, swapId: 'swap-1', legId, leg, balance: '10000', ...over });
  return prepared(leg.sender, nodes, inputs);
};

const refused = (promise: Promise<void>, reason: RegExp) =>
  expect(promise).rejects.toThrow(expect.objectContaining({ name: UnverifiedTransactionError.name, message: expect.stringMatching(reason) }));

test('the hash is recomputed the way the participant computes it (a pinned pair, never regenerated)', async () => {
  // One create node serialized with core-ledger-proto, and the hash Canton's scheme v2 makes of it.
  const blob =
    'Co4CCgMyLjESATAa3wEKATDCPtgBCtUBCgMyLjESRDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwGg1zcGxpY2UtYW11bGV0Ih0KBGNhZmUSDVNwbGljZS5BbXVsZXQaBkFtdWxldCo4cjYSGgoFb3duZXISEToPYWxpY2U6OjEyMjBhYWFhEhgKBmFtb3VudBIOMgwxLjAwMDAwMDAwMDAyD2FsaWNlOjoxMjIwYWFhYToPYWxpY2U6OjEyMjBhYWFhIiISIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHEm8SJQoPYWxpY2U6OjEyMjBhYWFhEhJmaXh0dXJlLWNvbW1hbmQtaWQaF2dsb2JhbC1kb21haW46OjEyMjBiYmJiKiQwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDAwgMC+l4/ojgM=';
  expect(await hashPreparedTransaction(blob, 'base64')).toBe('YN30egHX2bjSgfdT5YzzqbOpW6nd/IwGjLTNILoc6P4=');
});

describe('an honest transaction is signed', () => {
  test('the maker’s proposal', async () => {
    await expect(verifyDvpPrepared('dvpCreateProposal', [await create()], terms(MAKER))).resolves.toBeUndefined();
  });
  test('the taker’s approval, read off the proposal it recreates', async () => {
    await expect(verifyDvpPrepared('dvpAcceptProposal', [await accept()], terms(TAKER))).resolves.toBeUndefined();
  });
  test('the taker’s leg and fee, which add up to the order’s amount', async () => {
    await expect(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-counter'), await fund('leg-fee')], terms(TAKER))).resolves.toBeUndefined();
  });
  test('the maker’s leg', async () => {
    await expect(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-main')], terms(MAKER))).resolves.toBeUndefined();
  });
  test('a proposal from every pinned cancore-swap release, 1.3.0 (on dev) included', async () => {
    const pinned = DEFAULT_TRUSTED_PACKAGES.swap['cancore-swap']!;
    expect(pinned).toContain('01208653516ab062e71274729caec86254a9ac55022561cb68c189bfd6fc6742');
    for (const packageId of pinned) {
      const tx = await prepared(MAKER, [proposalCreate('0', { venue: VENUE, swapId: 'swap-1', legs: LEGS, approvers: [MAKER], packageId })]);
      await expect(verifyDvpPrepared('dvpCreateProposal', [tx], terms(MAKER))).resolves.toBeUndefined();
    }
  });
  test('a trade without a fee, on a stand with no fee configured', async () => {
    const legs = { 'leg-main': LEGS['leg-main']!, 'leg-counter': { ...LEGS['leg-counter']!, amount: '5000' } };
    await expect(verifyDvpPrepared('dvpCreateProposal', [await create(legs)], terms(MAKER, { feeParty: null, feeRate: '0' }))).resolves.toBeUndefined();
  });
});

describe('the whole tree of an allocation, not just its root', () => {
  const THIEF = 'thief::1220';
  type Extra = Tree['extra'];
  const funded = (over: Partial<Tree>) => fund('leg-main', undefined, VENUE, over);
  const withExtra = (extra: Extra) => funded({ extra });

  test('an honest dev allocation of CC: ExternalPartyAmuletRules, LockedAmulet and AmuletAllocation from dev’s splice-amulet', async () => {
    await expect(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-counter')], terms(TAKER))).resolves.toBeUndefined();
  });
  test('an honest dev allocation of CBTC: the utility factory, Holding and DvpLegAllocation from dev’s registry packages', async () => {
    await expect(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-main')], terms(MAKER))).resolves.toBeUndefined();
  });
  test('a registry upgrade (a package id nobody listed) under the admin-signed factory is still the admin’s code, and signs', async () => {
    const upgraded = holding('6b'.repeat(34), MAKER, CBTC, '0', { packageId: 'ab'.repeat(32), lockedTo: undefined });
    await expect(verifyDvpPrepared('dvpAllocateLeg', [await withExtra((id) => ({ nodes: [createNode(id(0), upgraded)] }))], terms(MAKER))).resolves.toBeUndefined();
  });
  test('an extra child that moves another of the signer’s holdings to someone else', async () => {
    const other = holding('77'.repeat(34), MAKER, CBTC, '5');
    const moved = holding('88'.repeat(34), THIEF, CBTC, '5');
    const reason = /involves thief|owned by thief/;
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await withExtra((id) => ({ nodes: [spend(id(0), other, MAKER), createNode(id(1), moved)], inputs: [other] }))], terms(MAKER)), reason);
  });
  test('an extra child that burns more of the signer’s holdings than the leg locks', async () => {
    const other = holding('77'.repeat(34), MAKER, CBTC, '5');
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await withExtra((id) => ({ nodes: [spend(id(0), other, MAKER)], inputs: [other] }))], terms(MAKER)), /spends more CBTC than the leg locks/);
  });
  test('an extra child that spends a holding of another party', async () => {
    const theirs = holding('77'.repeat(34), THIEF, CBTC, '5');
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await withExtra((id) => ({ nodes: [spend(id(0), theirs, THIEF)], inputs: [theirs] }))], terms(MAKER)), /involves thief|owned by thief/);
  });
  test('a child that consumes a contract the transaction does not disclose', async () => {
    const hidden = holding('99'.repeat(34), MAKER, CBTC, '5');
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await withExtra((id) => ({ nodes: [spend(id(0), hidden, MAKER)] }))], terms(MAKER)), /does not disclose|without disclosing what it is/);
  });
  test('a second lock on the signer’s holdings beyond the leg, even one held by the venue', async () => {
    const other = holding('77'.repeat(34), MAKER, CBTC, '5');
    const lock = holding('88'.repeat(34), MAKER, CBTC, '5', { lockedTo: VENUE });
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await withExtra((id) => ({ nodes: [spend(id(0), other, MAKER), createNode(id(1), lock)], inputs: [other] }))], terms(MAKER)), /locks more CBTC than the leg/);
  });

  test('the audit’s bypass: a real-looking transfer to a third party inside the allocation, its funds locked to them', async () => {
    // A trusted-package child that hands the signer's balance to someone else: the funds are spent into a
    // lock owned by the signer but held for the third party, and a transfer instruction names that party.
    const other = holding('77'.repeat(34), MAKER, CBTC, '5');
    const lockedForThief = holding('88'.repeat(34), MAKER, CBTC, '5', { lockedTo: THIEF });
    const transfer = exercise(spendTransfer(other, THIEF));
    await refused(
      verifyDvpPrepared('dvpAllocateLeg', [await withExtra((id) => ({ nodes: [spend(id(0), other, MAKER), createNode(id(1), lockedForThief), { ...transfer, nodeId: id(2) }], inputs: [other] }))], terms(MAKER)),
      /involves thief/,
    );
  });
  test('a look-alike factory from any package, signed by someone else than the admin', async () => {
    const factory = factoryContract(CBTC.admin, { instrument: 'CBTC', packageName: 'utility-registry-app-v0', packageId: 'cd'.repeat(32), signatory: THIEF });
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await funded({ factory })], terms(MAKER)), /not signed by the instrument admin/);
  });
  test('a factory that names the admin in its argument but is signed by someone else', async () => {
    const factory = factoryContract(CBTC.admin, { instrument: 'CBTC', signatory: THIEF });
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await funded({ factory })], terms(MAKER)), /not signed by the instrument admin/);
  });
  test('an allocation through a look-alike AllocationFactory interface', async () => {
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await funded({ interfacePackageId: 'ef'.repeat(32) })], terms(MAKER)), /not a token-standard allocation/);
  });
  test('the audit’s proxy: a contract the signer signs and the venue controls, riding along with an honest allocation', async () => {
    // Not a holding, not this allocation: authority the signer would hand out beyond the transaction.
    const proxy = { ...holding('99'.repeat(34), MAKER, CBTC, '0'), templateId: { packageId: 'ab'.repeat(32), moduleName: 'Evil', entityName: 'Proxy' },
      argument: { sum: { oneofKind: 'record' as const, record: { fields: [{ label: 'user', value: { sum: { oneofKind: 'party' as const, party: MAKER } } }, { label: 'venue', value: { sum: { oneofKind: 'party' as const, party: VENUE } } }] } } },
      signatories: [MAKER] };
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await withExtra((id) => ({ nodes: [createNode(id(0), proxy)] }))], terms(MAKER)), /creates a Proxy signed by this account that is neither its holding nor this allocation/);
  });
  test('a choice the signer acts in on a contract that is neither its holding nor the admin’s', async () => {
    const strangers = factoryContract(VENUE, { instrument: 'CBTC', signatory: VENUE });
    const foreign = { ...strangers, contractId: 'ab'.repeat(34) };
    const act = { ...exercise({ ...spendTransfer(foreign, VENUE, MAKER), contractId: foreign.contractId, actingParties: [MAKER] }), nodeId: '' };
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await withExtra((id) => ({ nodes: [{ ...act, nodeId: id(0) }], inputs: [foreign] }))], terms(MAKER)), /acts on a .* that is neither its holding nor the instrument admin's/);
  });
  test('a lock on another instrument than the leg’s, even a small one', async () => {
    // Another token of the same registrar: same parties, so only the per-instrument lock count can tell.
    const other = { id: 'OTHER', admin: CBTC.admin };
    const owned = holding('77'.repeat(34), MAKER, other, '0.001');
    const lock = holding('88'.repeat(34), MAKER, other, '0.001', { lockedTo: VENUE });
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await withExtra((id) => ({ nodes: [spend(id(0), owned, MAKER), createNode(id(1), lock)], inputs: [owned] }))], terms(MAKER)), /locks more OTHER than the leg/);
  });
  test('a factory created under an older package and exercised under its upgrade (same package name) signs', async () => {
    const factory = factoryContract(CBTC.admin, { instrument: 'CBTC', packageId: '01'.repeat(32) });
    await expect(verifyDvpPrepared('dvpAllocateLeg', [await funded({ factory, exercisedPackageId: '02'.repeat(32) })], terms(MAKER))).resolves.toBeUndefined();
  });
  test('a factory exercised under a package of another name is refused', async () => {
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await funded({ exercisedPackageName: 'utility-registry-app-v0-evil' })], terms(MAKER)), /another template than the factory/);
  });
  test.each(['allocateBefore', 'settleBefore'] as const)('an allocation whose %s has already passed', async (field) => {
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await funded({ windows: { [field]: past } })], terms(MAKER)), new RegExp(`${field} is .* already in the past`));
  });
  test('an allocation requested ten minutes from now: beyond the clock skew, though well inside the window', async () => {
    const requestedAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await funded({ windows: { requestedAt } })], terms(MAKER)), /requestedAt is .* further ahead/);
  });
  test('a party left empty in the tree is a stranger, not a pass', async () => {
    const blank = { ...exercise({ ...spendTransfer(holding('77'.repeat(34), MAKER, CBTC, '1'), VENUE, '') }), nodeId: '' };
    const other = holding('77'.repeat(34), MAKER, CBTC, '1');
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await withExtra((id) => ({ nodes: [{ ...blank, nodeId: id(0) }], inputs: [other] }))], terms(MAKER)), /involves an empty party/);
  });
  test('the pinned admin lists cannot be edited at runtime', () => {
    expect(Object.isFrozen(DEFAULT_INSTRUMENT_ADMINS.mainnet)).toBe(true);
    expect(() => (DEFAULT_INSTRUMENT_ADMINS.mainnet.Amulet as string[]).push('DSO::evil')).toThrow();
  });
  test('an allocation requested a while ago (the trade was opened before this account funded) signs', async () => {
    const requestedAt = new Date(Date.now() - 40 * 60_000).toISOString();
    await expect(verifyDvpPrepared('dvpAllocateLeg', [await funded({ windows: { requestedAt } })], terms(MAKER))).resolves.toBeUndefined();
  });
  test('an allocation whose settle deadline lies further ahead than the account allows', async () => {
    const settleBefore = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString();
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await funded({ settleBefore })], terms(MAKER)), /settleBefore is .* further ahead than this account allows/);
  });
  test('an allocation whose funding deadline lies further ahead than the account allows', async () => {
    const allocateBefore = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString();
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await funded({ windows: { allocateBefore } })], terms(MAKER)), /allocateBefore is .* further ahead/);
  });
  test('an allocation requested at a time further ahead than the account allows', async () => {
    const requestedAt = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString();
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await funded({ windows: { requestedAt } })], terms(MAKER)), /requestedAt is .* further ahead/);
  });
  test.each(['requestedAt', 'allocateBefore', 'settleBefore'] as const)('an allocation without its %s', async (field) => {
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await funded({ windows: { [field]: null } })], terms(MAKER)), new RegExp(`${field} is missing`));
  });
});

describe('anything else is refused before the key is touched', () => {
  test('a hash that is not the hash of the bytes it came with', async () => {
    const honest = await fund('leg-main');
    const other = await fund('leg-main', { ...LEGS['leg-main']!, receiver: 'thief::1220' });
    await refused(verifyDvpPrepared('dvpAllocateLeg', [{ ...honest, preparedTransactionHash: other.preparedTransactionHash }], terms(MAKER)), /does not hash to the hash/);
  });
  test('a hash with no bytes to check it against', async () => {
    const { preparedTransactionHash } = await fund('leg-main');
    await refused(verifyDvpPrepared('dvpAllocateLeg', [{ preparedTransactionHash }], terms(MAKER)), /without its bytes/);
  });
  test('an allocation of more than the order says', async () => {
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-main', { ...LEGS['leg-main']!, amount: '0.02' })], terms(MAKER)), /not the order's 0.01 CBTC/);
  });
  test('an allocation to another receiver', async () => {
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-main', { ...LEGS['leg-main']!, receiver: 'thief::1220' })], terms(MAKER)), /not part of this trade/);
  });
  test('an allocation that hands settlement to another executor', async () => {
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-main', LEGS['leg-main'], 'thief::1220')], terms(MAKER)), /not to the venue/);
  });
  test('an allocation of another instrument', async () => {
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-main', { ...LEGS['leg-main']!, instrumentId: CC })], terms(MAKER)), /not the order's/);
  });
  test('a fee above the published rate, even when leg and fee still add up', async () => {
    const counter = { ...LEGS['leg-counter']!, amount: '4900' };
    const fee = { ...LEGS['leg-fee']!, amount: '100' };
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-counter', counter), await fund('leg-fee', fee)], terms(TAKER)), /fee leg is above the published rate|less the fee/);
  });
  test('a proposal whose legs differ from the order', async () => {
    await refused(verifyDvpPrepared('dvpCreateProposal', [await create({ ...LEGS, 'leg-main': { ...LEGS['leg-main']!, amount: '0.001' } })], terms(MAKER)), /maker's leg/);
  });
  test('a proposal whose expiry lies further ahead than the account allows', async () => {
    const far = await prepared(MAKER, [proposalCreate('0', { venue: VENUE, swapId: 'swap-1', legs: LEGS, approvers: [MAKER], expiresAt: new Date(Date.now() + 365 * 24 * 3_600_000).toISOString() })]);
    await refused(verifyDvpPrepared('dvpCreateProposal', [far], terms(MAKER)), /expiresAt is .* further ahead/);
  });
  test('a proposal with an extra leg', async () => {
    const legs = { ...LEGS, 'leg-extra': { sender: MAKER, receiver: 'thief::1220', amount: '1', instrumentId: CBTC } };
    await refused(verifyDvpPrepared('dvpCreateProposal', [await create(legs)], terms(MAKER)), /not part of this trade/);
  });
  test('an approval of a proposal with other terms', async () => {
    await refused(verifyDvpPrepared('dvpAcceptProposal', [await accept({ ...LEGS, 'leg-counter': { ...LEGS['leg-counter']!, amount: '5000' } })], terms(TAKER)), /add up/);
  });
  test('a transaction acting as another party', async () => {
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-main')], terms(TAKER)), /acts as maker/);
  });
  test('an order amount with more than ten decimals, never truncated', async () => {
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-main')], terms(MAKER, { source: { ...CBTC, amount: '0.01000000000001' } })), /at most ten places/);
  });
  test('a proposal step running code from another package', async () => {
    await refused(verifyDvpPrepared('dvpCreateProposal', [await create()], terms(MAKER, { packages: { ...DEFAULT_TRUSTED_PACKAGES, swap: { 'cancore-swap': ['00'.repeat(32)] } } })), /untrusted package \(cancore-swap/);
  });
  test('a proposal from a cancore-swap release nobody pinned, under the default pins', async () => {
    const tx = await prepared(MAKER, [proposalCreate('0', { venue: VENUE, swapId: 'swap-1', legs: LEGS, approvers: [MAKER], packageId: 'ee'.repeat(32) })]);
    await refused(verifyDvpPrepared('dvpCreateProposal', [tx], terms(MAKER)), /untrusted package \(cancore-swap e{64}\)/);
  });
  test('a create signed as an allocation', async () => {
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await create()], terms(MAKER)), /not a token-standard allocation/);
  });
});

describe('withdrawing an allocation of a trade that ended unsettled (BUG-1291)', () => {
  const THIEF = 'thief::1220';
  type Withdraw = Parameters<typeof withdrawTree>[0];
  const withdraw = async (legId: keyof typeof LEGS, over: Partial<Withdraw> = {}, actAs?: string) => {
    const leg = LEGS[legId]!;
    const { nodes, inputs } = withdrawTree({ executor: VENUE, swapId: 'swap-1', legId, leg, ...over });
    return prepared(actAs ?? leg.sender, nodes, inputs);
  };
  // A withdraw takes its instrument admin from the allocation, held to the pinned list.
  const wterms = (party: string, over: Partial<DvpTerms> = {}) => terms(party, { pinnedAdmins: { [instrumentKey(CC.id)]: [CC.admin], [instrumentKey(CBTC.id)]: [CBTC.admin] }, ...over });
  const ok = (promise: Promise<void>) => expect(promise).resolves.toBeUndefined();

  test('the taker’s leg and fee, each its own signature, and the maker’s leg of a registry token', async () => {
    await ok(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter')], wterms(TAKER)));
    await ok(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-fee')], wterms(TAKER)));
    await ok(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-main')], wterms(MAKER)));
  });
  test('an allocation of another trade', async () => {
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter', { swapId: 'swap-2' })], wterms(TAKER)), /another trade/);
  });
  test('an allocation that hands settlement to someone else than the venue', async () => {
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter', { executor: THIEF })], wterms(TAKER)), /not to the venue/);
  });
  test('the other side’s allocation, signed by this account', async () => {
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-main', {}, TAKER)], wterms(TAKER)), /not this account’s/);
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-main', { actor: TAKER }, TAKER)], wterms(TAKER)), /not this account’s/);
  });
  test('a leg that is not part of the trade', async () => {
    const leg = { sender: TAKER, receiver: TAKER, amount: '1', instrumentId: CC };
    const { nodes, inputs } = withdrawTree({ executor: VENUE, swapId: 'swap-1', legId: 'leg-x', leg });
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await prepared(TAKER, nodes, inputs)], wterms(TAKER)), /not part of this trade/);
  });
  test('a holding returned to someone else', async () => {
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter', { tamper: { returnTo: THIEF } })], wterms(TAKER)), /involves thief|owned by thief/);
  });
  test('a withdraw that locks the holding again', async () => {
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter', { tamper: { relock: true } })], wterms(TAKER)), /locked holding|locks more/);
  });
  test('a withdraw that returns nothing', async () => {
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter', { tamper: { noReturn: true } })], wterms(TAKER)), /returns no holding/);
  });
  test('a withdraw that returns more than the leg locked', async () => {
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter', { tamper: { returnAmount: '9000' } })], wterms(TAKER)), /more than the leg's/);
  });
  test('another choice on the allocation, or one that leaves it standing', async () => {
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter', { tamper: { choice: 'Allocation_Cancel' } })], wterms(TAKER)), /not the withdrawal/);
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter', { tamper: { consuming: false } })], wterms(TAKER)), /does not consume/);
  });
  test('an argument beyond the registry context', async () => {
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter', { tamper: { extraArg: true } })], wterms(TAKER)), /more than its registry context/);
  });
  test('a child that archives another allocation (by its structure, whatever it is called), or a holding of someone else', async () => {
    const { inputs } = withdrawTree({ executor: VENUE, swapId: 'swap-1', legId: 'leg-counter', leg: LEGS['leg-counter']! });
    const otherAllocation = { ...inputs[0]!, contractId: '77'.repeat(34), templateId: { ...inputs[0]!.templateId!, entityName: 'Renamed' } };
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter', {
      extra: (id) => ({ nodes: [spend(id(0), otherAllocation, TAKER)], inputs: [otherAllocation] }),
    })], wterms(TAKER)), /neither this allocation nor this account's holding/);
    const theirs = holding('88'.repeat(34), THIEF, CC, '5');
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter', {
      extra: (id) => ({ nodes: [spend(id(0), theirs, THIEF)], inputs: [theirs] }),
    })], wterms(TAKER)), /involves thief|owned by thief/);
  });
  test('an unrelated holding of this account spent alongside the withdraw', async () => {
    const own = holding('88'.repeat(34), TAKER, CC, '5');
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter', {
      extra: (id) => ({ nodes: [spend(id(0), own, TAKER)], inputs: [own] }),
    })], wterms(TAKER)), /does not lock/);
  });
  test('a sliver returned of a larger lock: what comes back is exactly what was locked', async () => {
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter', { tamper: { returnAmount: '0.0000000001' } })], wterms(TAKER)), /not what the allocation locked/);
  });
  test('a withdraw run on another template than the allocation it names', async () => {
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter', { tamper: { otherTemplate: true } })], wterms(TAKER)), /another template/);
  });
  test('a withdraw does not depend on the stand’s current fee policy: any rate, any fee receiver, none', async () => {
    for (const over of [{ feeRate: '0.5' }, { feeParty: 'new-fee::1220' }, { feeParty: null, feeRate: '0' }]) {
      await ok(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-fee')], wterms(TAKER, over)));
      await ok(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter')], wterms(TAKER, over)));
    }
  });
  test('the allocation names its own admin, held to the pinned list: no stand instrument list is consulted', async () => {
    await ok(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter')], wterms(TAKER)));
    // The same transaction with the instrument admin the SDK does not pin for it.
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter')], wterms(TAKER, { pinnedAdmins: { [instrumentKey(CC.id)]: ['other-registry::1220'], [instrumentKey(CBTC.id)]: [CBTC.admin] } })), /not within the order's/);
  });
  test('a taker leg above the order’s amount is still refused', async () => {
    const leg = { sender: TAKER, receiver: FEE, amount: '9000', instrumentId: CC };
    const { nodes, inputs } = withdrawTree({ executor: VENUE, swapId: 'swap-1', legId: 'leg-x', leg });
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await prepared(TAKER, nodes, inputs)], wterms(TAKER)), /not within the order's/);
  });
  test('a child that creates a holding for a third party', async () => {
    const moved = holding('88'.repeat(34), THIEF, CC, '1');
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter', { extra: (id) => ({ nodes: [createNode(id(0), moved)] }) })], wterms(TAKER)), /involves thief|owned by thief/);
  });
  test('an allocation not signed by the instrument admin', async () => {
    // The withdraw runs the code of whoever signed the allocation: a stranger's is not the admin's.
    const leg = LEGS['leg-counter']!;
    const { nodes, inputs } = withdrawTree({ executor: VENUE, swapId: 'swap-1', legId: 'leg-counter', leg });
    const forged = inputs.map((c) => (c.contractId === '66'.repeat(34) ? { ...c, signatories: [TAKER] } : c));
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await prepared(TAKER, nodes, forged)], wterms(TAKER)), /not signed by this account and the instrument admin/);
  });
  test('an allocation the transaction does not disclose', async () => {
    const { nodes, inputs } = withdrawTree({ executor: VENUE, swapId: 'swap-1', legId: 'leg-counter', leg: LEGS['leg-counter']! });
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await prepared(TAKER, nodes, inputs.filter((c) => c.contractId !== '66'.repeat(34)))], wterms(TAKER)), /not among the contracts/);
  });
  test('a withdraw is not an allocation, and an allocation is not a withdraw', async () => {
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await withdraw('leg-counter')], wterms(TAKER)), /not a token-standard allocation/);
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await fund('leg-counter')], wterms(TAKER)), /not the withdrawal/);
  });
  test('a hash that is not the transaction’s', async () => {
    const tx = await withdraw('leg-counter');
    const other = await withdraw('leg-fee');
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [{ ...tx, preparedTransactionHash: other.preparedTransactionHash }], wterms(TAKER)), /does not hash/);
  });
  test('two transactions in one ceremony', async () => {
    await refused(verifyDvpPrepared('dvpWithdrawAllocation', [await withdraw('leg-counter'), await withdraw('leg-fee')], wterms(TAKER)), /expected one transaction/);
  });
});

test('overrides add to the pinned lists: one entry added keeps every default', () => {
  const merged = mergeLists(DEFAULT_INSTRUMENT_ADMINS.devnet, { CBTC: ['extra::1220ab'] });
  expect(merged.CBTC).toEqual([...DEFAULT_INSTRUMENT_ADMINS.devnet.CBTC!, 'extra::1220ab']);
  expect(merged.Amulet).toEqual(DEFAULT_INSTRUMENT_ADMINS.devnet.Amulet);
  expect(mergeLists(DEFAULT_TRUSTED_PACKAGES.swap, { 'cancore-swap': ['ff'.repeat(32)] })['cancore-swap']).toHaveLength(DEFAULT_TRUSTED_PACKAGES.swap['cancore-swap']!.length + 1);
});

test('networkOf places only the Cancore API hosts, never a name the lookup object inherits (CAN-2979)', () => {
  expect(networkOf('https://api-dev.cancore.app')).toBe('devnet');
  expect(networkOf('https://api-testnet.cancore.app/')).toBe('testnet');
  expect(networkOf('https://API.cancore.io')).toBe('mainnet');
  for (const host of ['constructor', '__proto__', 'tostring', 'hasownproperty', 'valueof', 'api.cancore.io.example', 'cancore.io'])
    expect(networkOf(`https://${host}`)).toBeUndefined();
  expect(networkOf('not a url')).toBeUndefined();
});

test('the pinned venue of each network is exactly the stand’s own (BUG-1291)', () => {
  expect(DEFAULT_VENUES).toEqual({
    devnet: 'cancore::12204f383aca6af056f6d83c9b5758fbc53c27a743e2f9d591e61bc657202172524b',
    testnet: 'cancore::12207fca8abfbcb8b8d936539ef9272f0f86c7e4e39dd4a3ece8c0f9aa59ebcf5fc2',
    mainnet: 'cancore::1220076a94e0a7f0256a32ffab227db7788d8075677d8afcdaa8386df8f2fa659906',
  });
  // Not the mainnet participant party, which shares the key and has another hint.
  expect(Object.values(DEFAULT_VENUES).some((v) => v.startsWith('Cancore-mainnet-1'))).toBe(false);
});

describe('a fee split (a CC send to oneself) is signed only as the account asked for it', () => {
  const ME = 'party-taker::1220aa';
  const FEE = '24.8756218905';
  const terms: SelfSendTerms = { party: ME, admins: [DEV.dso], instrument: 'Amulet', amount: FEE, maxCost: '0.5', feeRecipients: [DEV.venue] };
  type Over = Partial<Parameters<typeof selfSendLeg>[0]>;
  const transfer = (over: Over = {}) => selfSendLeg({
    party: ME, kind: 'transfer', receiver: ME, input: '10000', ids: 'a',
    outputs: [{ owner: ME, amount: FEE }, { owner: ME, amount: '9975.1243781095' }], ...over,
  });
  const feeLeg = (over: Over = {}) => selfSendLeg({
    party: ME, kind: 'fee', receiver: DEV.venue, input: '10', ids: 'b',
    outputs: [{ owner: DEV.venue, amount: '0.125' }, { owner: ME, amount: '9.875' }], ...over,
  });
  const refused = async (legs: Array<Awaited<ReturnType<typeof transfer>>>, reason: RegExp, t: SelfSendTerms = terms) => {
    const err = await verifySelfSendPrepared(legs, t).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnverifiedTransactionError);
    expect((err as Error).message).toMatch(reason);
  };

  test('the honest split and its network-fee leg pass', async () => {
    await expect(verifySelfSendPrepared([await transfer(), await feeLeg()], terms)).resolves.toBeUndefined();
  });

  describe('the preapproval is the DSO\'s own record, or nothing under it is (CAN-2249)', () => {
    // A choice body runs with the authority of everyone who acts in it. A preapproval the DSO signed runs
    // the DSO's code; one anybody else made runs theirs — with this account's authority.
    const MALLORY = 'mallory::1220ff';
    const EVIL = { packageName: 'splice-amulet', packageId: 'ee'.repeat(32) };
    type Create = ReturnType<typeof preapprovalContract>;
    const forged = (c: Create): Create => ({
      ...c, packageName: EVIL.packageName, templateId: { ...c.templateId!, packageId: EVIL.packageId }, signatories: [MALLORY], stakeholders: [MALLORY, ME],
    });

    test('a forged preapproval whose "send" makes this account sign a contract that only looks like its holding', async () => {
      // Nothing leaves the account: what it spends comes back in full, as contracts named Amulet and
      // owned by it — and signed by it and by their author, in the author's package. Whoever controls
      // such a contract's choices acts with this account's authority from then on.
      const proxy = (c: Create): Create => ({ ...c, packageName: EVIL.packageName, templateId: { ...c.templateId!, packageId: EVIL.packageId }, signatories: [MALLORY, ME], stakeholders: [MALLORY, ME] });
      const leg = await transfer({ preapproval: forged, output: proxy });
      await refused([leg], /leg 0 sends through a preapproval the instrument admin did not sign/);
    });

    test('the honest tree, through a preapproval the DSO did not sign', async () => {
      await refused([await transfer({ preapproval: (c) => ({ ...c, signatories: [ME, DEV.venue] }) }), await feeLeg()], /leg 0 sends through a preapproval the instrument admin did not sign/);
      await refused([await transfer(), await feeLeg({ preapproval: (c) => ({ ...c, signatories: [DEV.venue] }) })], /leg 1 sends through a preapproval the instrument admin did not sign/);
    });

    test('a command that names another template than the preapproval it runs on', async () => {
      const honest = preapprovalContract('00'.repeat(34), ME);
      const other = (over: Partial<NonNullable<Create['templateId']>>, packageName = honest.packageName) => ({ packageName, templateId: { ...honest.templateId!, ...over } });
      const wrong = /runs on another template than the preapproval it names/;
      await refused([await transfer({ commandOn: other({}, 'evil-amulet') })], wrong);
      await refused([await transfer({ commandOn: other({ moduleName: 'Evil.Rules' }) })], wrong);
      await refused([await transfer({ commandOn: other({ entityName: 'TransferPreapprovalProxy' }) })], wrong);
      // The fee leg is held to it like the transfer.
      await refused([await transfer(), await feeLeg({ commandOn: other({ moduleName: 'Evil.Rules' }) })], /leg 1 runs on another template/);
    });

    test('a command that names other signatories than the contract it discloses', async () => {
      // The contract says the DSO signed it; the command exercising it — the ledger's own word — does not.
      await refused([await transfer({ commandSignatories: [ME, DEV.venue] })], /leg 0 sends through a preapproval the instrument admin did not sign/);
      // And the other way round: the command claims the DSO for a contract that does not carry its signature.
      await refused([await transfer({ preapproval: (c) => ({ ...c, signatories: [ME, DEV.venue] }), commandSignatories: [DEV.dso, ME, DEV.venue] })],
        /leg 0 sends through a preapproval the instrument admin did not sign/);
    });

    test('no pinned admin at all is a refusal, not a pass', async () => {
      await refused([await transfer(), await feeLeg()], /the instrument admin did not sign/, { ...terms, admins: [] });
    });

    test('two contracts disclosed under one contract id', async () => {
      // The honest preapproval and a decoy with the same id: a reader that keeps the last one sees the
      // DSO's signature on a contract the ledger is not running.
      const honest = await transfer();
      const leg = await transfer({ extraInput: preapprovalContract('af'.repeat(34), ME) });
      expect(leg.preparedTransactionHash).not.toBe(honest.preparedTransactionHash);
      await refused([leg], /leg 0 discloses two contracts under one contract id/);
    });

    test('a newer version of the DSO\'s package is the same template: the DSO upgrades on its own schedule', async () => {
      const honest = preapprovalContract('00'.repeat(34), ME);
      const upgraded = { packageName: honest.packageName, templateId: { ...honest.templateId!, packageId: 'ab'.repeat(32) } };
      await expect(verifySelfSendPrepared([await transfer({ commandOn: upgraded })], terms)).resolves.toBeUndefined();
    });
  });

  test('a hash that is not the hash of the bytes', async () => {
    const [a, b] = [await transfer(), await feeLeg()];
    await refused([{ ...a, preparedTransactionHash: b.preparedTransactionHash }, b], /leg 0 does not hash to the hash it came with/);
  });

  test('a transaction acting as another party', async () => {
    await refused([await transfer({ actAs: 'mallory::1220ff' }), await feeLeg()], /leg 0 acts as mallory::1220ff, not as this account/);
  });

  test('a leg without its bytes', async () => {
    const a = await transfer();
    await refused([{ ...a, preparedTransaction: undefined as unknown as string }, await feeLeg()], /leg 0 came without its bytes/);
  });

  test('spending a holding of someone else', async () => {
    await refused([await transfer({ inputOwner: 'mallory::1220ff' }), await feeLeg()], /mallory::1220ff/);
  });

  test('acting on a contract neither the account nor the admin signs', async () => {
    const stranger = { ...preapprovalContract('c0'.repeat(34), 'other::1220ee', 'other::1220ee'), signatories: ['other::1220ee'], stakeholders: ['other::1220ee'] };
    await refused([await transfer({ extra: (c) => spend('x', c, ME), extraInput: stranger }), await feeLeg()],
      /acts on a TransferPreapproval that is neither its holding nor the instrument admin's/);
  });

  test('no holding of exactly the fee', async () => {
    await refused([await transfer({ outputs: [{ owner: ME, amount: '24.8756218904' }, { owner: ME, amount: '9975.1243781096' }] }), await feeLeg()],
      /no holding of exactly 24.8756218905 Amulet is created for this account/);
  });

  test('a locked holding for the account', async () => {
    await refused([await transfer({ outputs: [{ owner: ME, amount: FEE, lockedTo: DEV.venue }, { owner: ME, amount: '9975.1243781095' }] }), await feeLeg()], /leg 0 creates a locked holding/);
  });

  test('the transfer paying the fee recipient', async () => {
    await refused([await transfer({ outputs: [{ owner: ME, amount: FEE }, { owner: DEV.venue, amount: '9975.1243781095' }] }), await feeLeg()],
      /leg 0 creates a holding owned by cancore::/);
  });

  test('a transfer sent through someone else\'s preapproval', async () => {
    await refused([await transfer({ receiver: DEV.venue }), await feeLeg()], /leg 0 sends to cancore::.*not to this account/);
  });

  test('a fee leg paying a party that is not pinned', async () => {
    await refused([await transfer(), await feeLeg({ receiver: 'thief::1220dd', outputs: [{ owner: 'thief::1220dd', amount: '0.125' }, { owner: ME, amount: '9.875' }] })],
      /leg 1 sends to thief::1220dd, not to a pinned network fee recipient/);
  });

  test('a fee leg costing more than the bound', async () => {
    await refused([await transfer(), await feeLeg({ outputs: [{ owner: DEV.venue, amount: '5' }, { owner: ME, amount: '5' }] })], /costs this account more than 0.5 Amulet/);
  });
});

describe('a CC send to another party is signed only as the account asked for it (CAN-2249)', () => {
  // The stage-4 threat: the API is hostile, and the key is about to pay out a bot's budget.
  const ME = 'party-bot::1220aa';
  const OWNER = 'party-owner::1220bb';
  const MALLORY = 'mallory::1220ff';
  const terms: SendTerms = { party: ME, admins: [DEV.dso], instrument: 'Amulet', receiver: OWNER, amount: '100', maxFee: '0.5', feeRecipients: [DEV.venue] };
  type Over = Partial<Parameters<typeof selfSendLeg>[0]>;
  const transfer = (over: Over = {}) => selfSendLeg({
    party: ME, kind: 'transfer', receiver: OWNER, input: '10000', ids: 'a',
    outputs: [{ owner: OWNER, amount: '100' }, { owner: ME, amount: '9900' }], ...over,
  });
  const feeLeg = (over: Over = {}) => selfSendLeg({
    party: ME, kind: 'fee', receiver: DEV.venue, input: '10', ids: 'b',
    outputs: [{ owner: DEV.venue, amount: '0.125' }, { owner: ME, amount: '9.875' }], ...over,
  });
  const refused = async (legs: Array<Awaited<ReturnType<typeof transfer>>>, reason: RegExp, t: SendTerms = terms) => {
    const err = await verifySendPrepared(legs, t).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnverifiedTransactionError);
    expect((err as Error).message).toMatch(reason);
  };

  test('the honest send passes, with its network-fee leg and without one', async () => {
    await expect(verifySendPrepared([await transfer(), await feeLeg()], terms)).resolves.toBeUndefined();
    // One holding: the API defers the fee, and the send is the transfer alone.
    await expect(verifySendPrepared([await transfer()], terms)).resolves.toBeUndefined();
  });

  test('the receiver may be given the amount in more than one holding', async () => {
    const legs = [await transfer({ outputs: [{ owner: OWNER, amount: '60' }, { owner: OWNER, amount: '40' }, { owner: ME, amount: '9900' }] })];
    await expect(verifySendPrepared(legs, terms)).resolves.toBeUndefined();
  });

  test('a send through another party\'s preapproval', async () => {
    await refused([await transfer({ receiver: MALLORY, outputs: [{ owner: MALLORY, amount: '100' }, { owner: ME, amount: '9900' }] })],
      /leg 0 sends to mallory::1220ff, not to party-owner::1220bb, the receiver this send was asked for/);
  });

  test('the right preapproval, and the holding made for somebody else', async () => {
    await refused([await transfer({ outputs: [{ owner: MALLORY, amount: '100' }, { owner: ME, amount: '9900' }] })], /leg 0: node \d+ involves mallory::1220ff, who is not part of this send/);
  });

  test('the holding made for a party the send does involve, and still not the receiver', async () => {
    // The DSO is in every CC send; that does not make it somebody to pay.
    await refused([await transfer({ outputs: [{ owner: DEV.dso, amount: '100' }, { owner: ME, amount: '9900' }] })], new RegExp(`leg 0 creates a holding owned by ${DEV.dso}`));
  });

  test('a second payee beside the receiver', async () => {
    await refused([await transfer({ outputs: [{ owner: OWNER, amount: '100' }, { owner: MALLORY, amount: '9000' }, { owner: ME, amount: '900' }] })],
      /leg 0: node \d+ involves mallory::1220ff, who is not part of this send/);
  });

  test.each([
    ['less', '99.9999999999', '9900.0000000001'],
    ['more', '1000', '9000'],
    ['everything', '10000', '0.0000000001'],
  ])('the receiver given %s than was asked for', async (_what, toReceiver, change) => {
    await refused([await transfer({ outputs: [{ owner: OWNER, amount: toReceiver }, { owner: ME, amount: change }] })],
      /party-owner::1220bb is given [0-9.]+ Amulet, not the 100 this send was asked for/);
  });

  test('the receiver given nothing at all', async () => {
    await refused([await transfer({ outputs: [{ owner: ME, amount: '10000' }] })], /is given 0 Amulet, not the 100/);
  });

  test('the right amount to the receiver, and the change gone', async () => {
    // Nobody else is paid — the rest of the input simply does not come back.
    await refused([await transfer({ outputs: [{ owner: OWNER, amount: '100' }, { owner: ME, amount: '5000' }] })],
      /the send costs this account 5000 Amulet, more than the 100 it sends and the fee it allows/);
  });

  test('a locked holding for the receiver', async () => {
    await refused([await transfer({ outputs: [{ owner: OWNER, amount: '100', lockedTo: DEV.venue }, { owner: ME, amount: '9900' }] })], /leg 0 creates a locked holding/);
  });

  test('a fee leg paying a party that is not pinned', async () => {
    await refused([await transfer(), await feeLeg({ receiver: 'thief::1220dd', outputs: [{ owner: 'thief::1220dd', amount: '0.125' }, { owner: ME, amount: '9.875' }] })],
      /leg 1 sends to thief::1220dd, not to a pinned network fee recipient/);
  });

  test('a fee leg that pays the receiver instead — the fee leg is not a second transfer', async () => {
    await refused([await transfer(), await feeLeg({ receiver: OWNER, outputs: [{ owner: OWNER, amount: '0.125' }, { owner: ME, amount: '9.875' }] })],
      /leg 1 sends to party-owner::1220bb, not to a pinned network fee recipient/);
  });

  test('a fee above the bound', async () => {
    await refused([await transfer(), await feeLeg({ outputs: [{ owner: DEV.venue, amount: '5' }, { owner: ME, amount: '5' }] })],
      /the send costs this account 105 Amulet, more than the 100 it sends and the fee it allows/);
  });

  test('a hash that is not the hash of the bytes', async () => {
    const [a, b] = [await transfer(), await feeLeg()];
    await refused([{ ...a, preparedTransactionHash: b.preparedTransactionHash }, b], /leg 0 does not hash to the hash it came with/);
  });

  test('a transaction acting as another party', async () => {
    await refused([await transfer({ actAs: MALLORY })], /leg 0 acts as mallory::1220ff, not as this account/);
  });

  test('a leg without its bytes', async () => {
    const a = await transfer();
    await refused([{ ...a, preparedTransaction: undefined as unknown as string }], /leg 0 came without its bytes/);
  });

  test('spending a holding of someone else', async () => {
    await refused([await transfer({ inputOwner: MALLORY })], /mallory::1220ff/);
  });

  test('a leg of another kind, and no legs at all', async () => {
    await refused([{ ...(await transfer()), kind: 'setup' as never }], /leg 0 is a setup, not a transfer or its fee/);
    await refused([], /the API prepared nothing to sign/);
  });

  test('a send to oneself is the split\'s to read, not this one\'s', async () => {
    await refused([await transfer({ receiver: ME, outputs: [{ owner: ME, amount: '100' }, { owner: ME, amount: '9900' }] })],
      /a send to the account itself is a split/, { ...terms, receiver: ME });
  });

  test.each([['0'], ['-1'], ['1.00000000001'], ['lots']])('an amount of %s is not one the ledger could hold', async (amount) => {
    await refused([await transfer()], /not a decimal of at most ten places/, { ...terms, amount });
  });

  test('a send to a fee recipient: what the fee leg pays it is the fee, not part of the amount', async () => {
    const toVenue = { ...terms, receiver: DEV.venue };
    const pay = (amount: string, change: string) => transfer({ receiver: DEV.venue, outputs: [{ owner: DEV.venue, amount }, { owner: ME, amount: change }] });
    await expect(verifySendPrepared([await pay('100', '9900'), await feeLeg()], toVenue)).resolves.toBeUndefined();
    await refused([await pay('99.875', '9900.125'), await feeLeg()], /is given 99.875 Amulet, not the 100 this send was asked for/, toVenue);
  });

  test('the bound is the amount plus the fee allowed, to the unit', async () => {
    // 100 to the receiver, 0.5 lost to an old input's accrued fee: exactly at the bound.
    const atBound = [await transfer({ outputs: [{ owner: OWNER, amount: '100' }, { owner: ME, amount: '9899.5' }] })];
    await expect(verifySendPrepared(atBound, terms)).resolves.toBeUndefined();
    await refused([await transfer({ outputs: [{ owner: OWNER, amount: '100' }, { owner: ME, amount: '9899.4999999999' }] })], /more than the 100 it sends and the fee it allows/);
  });
});

// The shapes below are the ones the dev stand prepares (captured 2026-10-12): a registry send is a
// TransferFactory_Transfer that locks the amount under an offer; an accept consumes that offer; a
// merge is a send to oneself; the preapproval step is one bare create.
const BOT = 'party-bot::1220aa';
const OWNER = 'party-owner::1220bb';
const MALLORY = 'mallory::1220ff';
type Prepared = { kind: string; preparedTransaction: string; preparedTransactionHash: string };
const refusedWith = async (run: Promise<void>, reason: RegExp) => {
  const err = await run.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UnverifiedTransactionError);
  expect((err as Error).message).toMatch(reason);
};
const ccFee = (over: Partial<Parameters<typeof selfSendLeg>[0]> = {}) => selfSendLeg({
  party: BOT, kind: 'fee', receiver: DEV.venue, input: '10', ids: 'b', outputs: [{ owner: DEV.venue, amount: '0.125' }, { owner: BOT, amount: '9.875' }], ...over,
});

describe('a registry-token send is signed only as the account asked for it (CAN-2249)', () => {
  const terms: SendTerms = { party: BOT, admins: [CBTC.admin], dso: [DEV.dso], instrument: 'CBTC', receiver: OWNER, amount: '0.5', maxFee: '0.5', feeRecipients: [DEV.venue] };
  type Over = Partial<Parameters<typeof factoryTransferLeg>[0]>;
  const offered: Over['outputs'] = [{ owner: BOT, amount: '0.5', lockedTo: CBTC.admin }, { owner: BOT, amount: '1.5' }];
  const transfer = (over: Over = {}) => factoryTransferLeg({ party: BOT, receiver: OWNER, instrument: CBTC, amount: '0.5', input: '2', outputs: offered, ...over });
  const refused = (legs: Prepared[], reason: RegExp, t: SendTerms = terms) => refusedWith(verifySendPrepared(legs, t), reason);

  test('the honest send passes: the amount locked under an offer to the receiver, with and without its CC fee leg', async () => {
    await expect(verifySendPrepared([await transfer()], terms)).resolves.toBeUndefined();
    await expect(verifySendPrepared([await transfer(), await ccFee()], terms)).resolves.toBeUndefined();
  });

  test('a registry that hands the holding over at once passes too', async () => {
    await expect(verifySendPrepared([await transfer({ offer: null, outputs: [{ owner: OWNER, amount: '0.5' }, { owner: BOT, amount: '1.5' }] })], terms)).resolves.toBeUndefined();
  });

  test('the command sends to another party, or another amount', async () => {
    await refused([await transfer({ command: { receiver: MALLORY } })], /leg 0 sends to mallory::1220ff, not to party-owner::1220bb, the receiver this send was asked for/);
    // The lock is of the right size; the command it runs under asks for more.
    await refused([await transfer({ command: { amount: '1.5' }, offer: { amount: '1.5' } })], /leg 0 transfers 1.5 and neither hands exactly that to party-owner::1220bb, the receiver this send was asked for nor locks exactly that under one offer of this transfer/);
    // The lock, the offer and the command agree with each other — on three times what the caller asked to send.
    await refused([await transfer({ command: { amount: '1.5' }, offer: { amount: '1.5' }, outputs: [{ owner: BOT, amount: '1.5', lockedTo: CBTC.admin }, { owner: BOT, amount: '0.5' }] })], /is given 1.5 CBTC, not the 0.5 this send was asked for/);
    await refused([await transfer({ command: { amount: '0' } })], /transfers an amount that is not a positive decimal/);
  });

  test('more locked than was asked for, or the change gone', async () => {
    await refused([await transfer({ outputs: [{ owner: BOT, amount: '2', lockedTo: CBTC.admin }] })], /leg 0 transfers 0.5 and neither hands exactly that to .* nor locks exactly that under one offer of this transfer/);
    await refused([await transfer({ outputs: [{ owner: BOT, amount: '0.5', lockedTo: CBTC.admin }] })], /the send costs this account 2 CBTC and 0 CC of fee, more than the 0.5 it sends/);
  });

  test('a holding for a third party, and an offer to one', async () => {
    await refused([await transfer({ outputs: [...offered!, { owner: MALLORY, amount: '0.1' }] })], /involves mallory::1220ff, who is not part of this send/);
    await refused([await transfer({ offer: { receiver: MALLORY } })], /involves mallory::1220ff/);
    // An offer that names only parties of this send, and is still not this transfer: a second, larger one.
    await refused([await transfer({ offer: { amount: '2' } })], /creates a TransferOffer signed by this account that is neither its holding nor this send/);
    await refused([await transfer({ outputs: [{ owner: DEV.venue, amount: '0.5' }, { owner: BOT, amount: '1.5' }], factory: (c) => ({ ...c, stakeholders: [...c.stakeholders, DEV.venue] }) })],
      /leg 0 creates a holding owned by cancore::/);
  });

  test('a locked holding made for the receiver is not a payment', async () => {
    await refused([await transfer({ offer: null, outputs: [{ owner: OWNER, amount: '0.5', lockedTo: CBTC.admin }, { owner: BOT, amount: '1.5' }] })], /leg 0 creates a locked holding/);
  });

  test('the factory is the admin\'s own, or nothing under it is', async () => {
    await refused([await transfer({ expectedAdmin: MALLORY })], /names mallory::1220ff as the instrument admin, which is not one this SDK pins for it/);
    await refused([await transfer({ factory: (c) => ({ ...c, signatories: [DEV.utilityOperator] }) })], /runs on a transfer factory the instrument admin did not sign/);
    await refused([await transfer({ commandSignatories: [DEV.utilityOperator] })], /runs on a transfer factory the instrument admin did not sign/);
    const honest = factoryContract(CBTC.admin, { instrument: 'CBTC' });
    await refused([await transfer({ commandOn: { packageName: 'evil', templateId: honest.templateId } })], /runs on another template than the factory it names/);
    await refused([await transfer({ interfaceEntity: 'TransferFactoryProxy' })], /is not a token-standard transfer/);
    // An admin pinned for another instrument is not this one's.
    await refused([await transfer()], /names cbtc-network::\S+ as the instrument admin/, { ...terms, admins: [DEV.dso] });
  });

  test('the change comes back in another token', async () => {
    // The right amount is locked; what is left of the input returns as a holding of something else.
    await refused([await transfer({ outputs: [{ owner: BOT, amount: '0.5', lockedTo: CBTC.admin }, { owner: BOT, amount: '1.5', instrument: { id: 'HTEST', admin: CBTC.admin } }] })],
      /leg 0 creates HTEST, not CBTC/);
  });

  test('another sender, another instrument, someone else\'s holding', async () => {
    await refused([await transfer({ command: { sender: OWNER } })], /sends another party's holdings/);
    await refused([await transfer({ command: { instrumentId: { id: 'USDCx', admin: CBTC.admin } } })], /transfers another instrument/);
    await refused([await transfer({ command: { instrumentId: { id: 'CBTC', admin: MALLORY } } })], /transfers another instrument/);
    await refused([await transfer({ inputOwner: OWNER })], /spends a holding owned by party-owner::1220bb/);
    await refused([await transfer({ actAs: MALLORY })], /acts as mallory::1220ff, not as this account/);
  });

  test('the fee leg is a CC send, held to the DSO and to the fee bound — not to the token\'s admin', async () => {
    await refused([await transfer(), await ccFee({ outputs: [{ owner: DEV.venue, amount: '5' }, { owner: BOT, amount: '5' }] })], /costs this account 0.5 CBTC and 5 CC of fee, more than/);
    await refused([await transfer(), await ccFee({ receiver: MALLORY, outputs: [{ owner: MALLORY, amount: '0.125' }, { owner: BOT, amount: '9.875' }] })], /leg 1 sends to mallory::1220ff, not to a pinned network fee recipient/);
    await refused([await transfer(), await ccFee()], /leg 1 sends through a preapproval the instrument admin did not sign/, { ...terms, dso: [CBTC.admin] });
    // A fee "preapproval" the token's registry signed is not the DSO's: the registry is trusted for its token, not for CC.
    await refused([await transfer(), await ccFee({ preapproval: (c) => ({ ...c, signatories: [CBTC.admin, DEV.venue] }) })], /leg 1 sends through a preapproval the instrument admin did not sign/);
  });
});

describe('a merge of the account\'s own holdings is signed only as a merge (CAN-2249)', () => {
  const ccTerms: ConsolidateTerms = { party: BOT, admins: [DEV.dso], instrument: 'Amulet', maxFee: '0.5', feeRecipients: [DEV.venue] };
  const regTerms: ConsolidateTerms = { party: BOT, admins: [CBTC.admin], dso: [DEV.dso], instrument: 'CBTC', maxFee: '0.5', feeRecipients: [DEV.venue] };
  const ccMerge = (outputs: Array<{ owner: string; amount: string; lockedTo?: string }>, over: Partial<Parameters<typeof selfSendLeg>[0]> = {}) =>
    selfSendLeg({ party: BOT, kind: 'transfer', receiver: BOT, input: '19.54084', ids: 'a', outputs, ...over });
  const regMerge = (over: Partial<Parameters<typeof factoryTransferLeg>[0]> = {}) =>
    factoryTransferLeg({ party: BOT, receiver: BOT, instrument: CBTC, amount: '0.0003', input: '0.0003', outputs: [{ owner: BOT, amount: '0.0003' }], offer: null, ...over });

  test('the honest merges pass: CC through the account\'s own preapproval, a registry token through the factory', async () => {
    await expect(verifyConsolidatePrepared([await ccMerge([{ owner: BOT, amount: '19.5212991599' }, { owner: BOT, amount: '0.0195408401' }])], ccTerms)).resolves.toBeUndefined();
    await expect(verifyConsolidatePrepared([await ccMerge([{ owner: BOT, amount: '19.4' }]), await ccFee()], ccTerms)).resolves.toBeUndefined();
    await expect(verifyConsolidatePrepared([await regMerge()], regTerms)).resolves.toBeUndefined();
  });

  test('a "merge" that pays somebody', async () => {
    await refusedWith(verifyConsolidatePrepared([await ccMerge([{ owner: OWNER, amount: '19.54084' }], { receiver: OWNER })], ccTerms), /leg 0 sends to party-owner::1220bb, not to this account/);
    await refusedWith(verifyConsolidatePrepared([await regMerge({ command: { receiver: OWNER } })], regTerms), /leg 0 sends to party-owner::1220bb, not to this account/);
    await refusedWith(verifyConsolidatePrepared([await regMerge({ outputs: [{ owner: BOT, amount: '0.0002' }, { owner: DEV.cbtcRegistrar, amount: '0.0001' }] })], regTerms), /creates a holding owned by cbtc-network::/);
  });

  test('a merge that loses more than the fee it allows', async () => {
    await refusedWith(verifyConsolidatePrepared([await ccMerge([{ owner: BOT, amount: '19' }])], ccTerms), /the merge costs this account 0.54084 Amulet, more than the fee it allows/);
    await refusedWith(verifyConsolidatePrepared([await ccMerge([{ owner: BOT, amount: '19.4' }]), await ccFee({ outputs: [{ owner: DEV.venue, amount: '0.4' }, { owner: BOT, amount: '9.6' }] })], ccTerms), /the merge costs this account 0.54084 Amulet/);
    // A registry token has no holding fee: the merge gives back every unit.
    await refusedWith(verifyConsolidatePrepared([await regMerge({ outputs: [{ owner: BOT, amount: '0.0002' }] })], regTerms), /the merge costs this account 0.0001 CBTC and 0 CC of fee/);
  });

  test('a merge that leaves the balance locked, and one with no transfer in it', async () => {
    await refusedWith(verifyConsolidatePrepared([await regMerge({ outputs: [{ owner: BOT, amount: '0.0003', lockedTo: CBTC.admin }] })], regTerms), /leg 0 is a transfer to the account itself that leaves a holding locked/);
    await refusedWith(verifyConsolidatePrepared([await ccMerge([{ owner: BOT, amount: '19.54084', lockedTo: DEV.venue }])], ccTerms), /leg 0 creates a locked holding/);
    await refusedWith(verifyConsolidatePrepared([await ccFee()], ccTerms), /the merge has no transfer in it/);
    await refusedWith(verifyConsolidatePrepared([], ccTerms), /the API prepared nothing to sign/);
    await refusedWith(verifyConsolidatePrepared([await regMerge()], { ...regTerms, maxFee: '-1' }), /the fee bound is not a decimal/);
  });
});

describe('an incoming transfer is accepted only as the one the account chose (CAN-2249)', () => {
  const terms: AcceptTerms = { party: BOT, instructionCid: OFFER_CID, pinnedAdmins: { CBTC: [CBTC.admin], Amulet: [DEV.dso] }, dso: [DEV.dso], maxFee: '0.5', feeRecipients: [DEV.venue] };
  type Over = Partial<Parameters<typeof acceptTransferLeg>[0]>;
  const accept = (over: Over = {}) => acceptTransferLeg({ party: BOT, sender: OWNER, instrument: CBTC, amount: '0.5', ...over });
  const refused = (legs: Prepared[], reason: RegExp, t: AcceptTerms = terms) => refusedWith(verifyAcceptPrepared(legs, t), reason);

  test('the honest accept passes, with and without a CC fee leg', async () => {
    await expect(verifyAcceptPrepared([await accept()], terms)).resolves.toBeUndefined();
    await expect(verifyAcceptPrepared([await accept(), await ccFee()], terms)).resolves.toBeUndefined();
    // What the lock held beyond the amount goes back to the sender.
    await expect(verifyAcceptPrepared([await accept({ outputs: [{ owner: BOT, amount: '0.5' }, { owner: OWNER, amount: '0.1' }] })], terms)).resolves.toBeUndefined();
  });

  test('another transfer than the one asked for, or one to somebody else', async () => {
    await refused([await accept()], /accepts another transfer than the one it was asked for/, { ...terms, instructionCid: 'ee'.repeat(34) });
    await refused([await accept({ receiver: MALLORY })], /accepts a transfer that is not to this account/);
  });

  test('the instruction is the admin\'s own, or nothing under it is', async () => {
    await refused([await accept({ offer: (c) => ({ ...c, signatories: [OWNER] }) })], /accepts a transfer the instrument admin did not sign/);
    await refused([await accept({ commandSignatories: [OWNER] })], /accepts a transfer the instrument admin did not sign/);
    await refused([await accept()], /accepts CBTC from cbtc-network::\S+, which is not an admin this SDK pins for it/, { ...terms, pinnedAdmins: { CBTC: [DEV.dso] } });
    await refused([await accept()], /which is not an admin this SDK pins for it/, { ...terms, pinnedAdmins: {} });
    await refused([await accept({ commandOn: { packageName: 'evil', templateId: { packageId: 'ee'.repeat(32), moduleName: 'Utility.Registry.App.V0.Model.Transfer', entityName: 'TransferOffer' } } })], /runs on another template than the transfer it names/);
    await refused([await accept({ interfaceEntity: 'TransferInstructionProxy' })], /is not the accept of a token-standard transfer/);
    await refused([await accept({ choice: 'TransferInstruction_Withdraw' })], /is not the accept of a token-standard transfer/);
  });

  test('an accept that takes something of the account along', async () => {
    const mine = holding('d0'.repeat(34), BOT, CBTC, '3');
    await refused([await accept({ alsoSpend: mine })], /leg 0 spends this account's own holding/);
    await refused([await accept({ alsoSpend: holding('d1'.repeat(34), DEV.venue, CBTC, '3'), offer: (c) => ({ ...c, stakeholders: [...c.stakeholders, DEV.venue] }) })], /leg 0 spends a holding owned by cancore::/);
  });

  test('holdings for a third party, of another instrument, or locked', async () => {
    await refused([await accept({ outputs: [{ owner: MALLORY, amount: '0.5' }] })], /involves mallory::1220ff, who is not part of this accept/);
    await refused([await accept({ outputs: [{ owner: DEV.venue, amount: '0.5' }], offer: (c) => ({ ...c, stakeholders: [...c.stakeholders, DEV.venue] }) })], /leg 0 creates a holding owned by cancore::/);
    await refused([await accept({ outputs: [{ owner: BOT, amount: '0.5', lockedTo: CBTC.admin }] })], /leg 0 creates a locked holding/);
  });

  test('the fee leg within its bound and to a pinned recipient; one accept, no more and no fewer', async () => {
    await refused([await accept(), await ccFee({ outputs: [{ owner: DEV.venue, amount: '5' }, { owner: BOT, amount: '5' }] })], /the accept costs this account 5 CC of fee, more than the fee it allows/);
    await refused([await accept(), await ccFee({ receiver: MALLORY, outputs: [{ owner: MALLORY, amount: '0.1' }, { owner: BOT, amount: '9.9' }] })], /leg 1 sends to mallory::1220ff, not to a pinned network fee recipient/);
    await refused([await accept(), await accept()], /expected one accept, the API prepared 2/);
    await refused([await ccFee()], /expected one accept, the API prepared 0/);
    await refused([], /the API prepared nothing to sign/);
    await refused([{ ...(await accept()), kind: 'setup' }], /leg 0 is a setup, not an accept or its fee/);
    await refused([await accept({ actAs: MALLORY })], /acts as mallory::1220ff/);
  });
});

describe('the preapproval step of onboard() is signed only as a proposal of the account\'s own (CAN-2249)', () => {
  const terms: PreapprovalSetupTerms = { party: BOT, dso: [DEV.dso], providers: [DEV.venue, BOT], packages: DEFAULT_TRUSTED_PACKAGES.wallet };
  type Over = Partial<Parameters<typeof preapprovalProposalLeg>[0]>;
  const proposal = (over: Over = {}) => preapprovalProposalLeg({ party: BOT, ...over });
  const refused = (legs: Prepared[], reason: RegExp, t: PreapprovalSetupTerms = terms) => refusedWith(verifyPreapprovalSetupPrepared(legs, t), reason);

  test('the honest proposal passes: provided by the venue, or by the account itself', async () => {
    await expect(verifyPreapprovalSetupPrepared([await proposal()], terms)).resolves.toBeUndefined();
    await expect(verifyPreapprovalSetupPrepared([await proposal({ provider: BOT })], terms)).resolves.toBeUndefined();
  });

  test('a create has no admin-signed contract under it: its package is pinned by id', async () => {
    await refused([await proposal({ packageId: 'ee'.repeat(32) })], /runs code from an untrusted package \(splice-wallet e{64}\): .* take its id from Splice's own daml\/dars\.lock or from Cancore — never from this message.* trustedPackages: \{ wallet: \{ 'splice-wallet': \[id\] \} \}/);
    await refused([await proposal({ packageName: 'evil-wallet' })], /untrusted package \(evil-wallet/);
    await refused([await proposal()], /untrusted package/, { ...terms, packages: {} });
    await refused([await proposal({ entityName: 'TransferPreapprovalProxy' })], /is not a transfer preapproval proposal/);
  });

  test('every released splice-wallet is pinned, not one stand\'s: a network runs whichever its validators voted in', async () => {
    const released = DEFAULT_TRUSTED_PACKAGES.wallet['splice-wallet']!;
    expect(released).toHaveLength(26);
    expect(new Set(released).size).toBe(26);
    expect(released.every((id) => /^[0-9a-f]{64}$/.test(id))).toBe(true);
    // 0.1.24 is what the dev stand prepared on 2026-10-12; the oldest and the newest hold as well.
    for (const packageId of [released[0]!, 'd42261314d98cc04bf50bcc58930af98b9f33aeed11339465925de697d3ba66e', released.at(-1)!]) {
      await expect(verifyPreapprovalSetupPrepared([await proposal({ packageId })], terms)).resolves.toBeUndefined();
    }
    // An id the caller adds is trusted next to them, never instead.
    const added = mergeLists(DEFAULT_TRUSTED_PACKAGES.wallet, { 'splice-wallet': ['ab'.repeat(32)] });
    await expect(verifyPreapprovalSetupPrepared([await proposal({ packageId: 'ab'.repeat(32) })], { ...terms, packages: added })).resolves.toBeUndefined();
    await expect(verifyPreapprovalSetupPrepared([await proposal()], { ...terms, packages: added })).resolves.toBeUndefined();
  });

  test('a proposal for somebody else, to an unpinned provider, or to another DSO', async () => {
    await refused([await proposal({ receiver: OWNER })], /involves|the proposal is for another receiver/);
    await refused([await proposal({ provider: MALLORY })], /names mallory::1220ff as provider, which is neither this account nor a pinned venue/);
    await refused([await proposal({ expectedDso: MALLORY })], /expects mallory::1220ff as the DSO, which is not a pinned CC admin/);
    await refused([await proposal({ expectedDso: null })], /expects null as the DSO/);
  });

  test('anything more than the one create', async () => {
    await refused([await proposal({ signatories: [BOT, MALLORY] })], /the proposal is not signed by this account alone/);
    await refused([await proposal({ extraField: { controller: { sum: { oneofKind: 'party', party: MALLORY } } } })], /the proposal is not of the shape this SDK knows/);
    await refused([await proposal({ extraNode: createNode('1', holding('e0'.repeat(34), BOT, CC, '1')) })], /carries nodes outside its command/);
    await refused([await proposal(), await proposal()], /expected the one transaction that proposes the preapproval/);
    await refused([await proposal({ kind: 'transfer' })], /expected the one transaction that proposes the preapproval/);
    await refused([await proposal({ actAs: MALLORY })], /acts as mallory::1220ff/);
  });
});


describe('what a second, hostile reading of these verifiers found (CAN-2249)', () => {
  // The security review of the verifiers themselves: each case below was signed before and is refused now.
  const sendTerms: SendTerms = { party: BOT, admins: [DEV.dso], instrument: 'Amulet', receiver: OWNER, amount: '100', maxFee: '0.5', feeRecipients: [DEV.venue] };
  const regTerms: SendTerms = { party: BOT, admins: [CBTC.admin], dso: [DEV.dso], instrument: 'CBTC', receiver: OWNER, amount: '0.5', maxFee: '0.5', feeRecipients: [DEV.venue] };
  const acceptTerms: AcceptTerms = { party: BOT, instructionCid: OFFER_CID, pinnedAdmins: { CBTC: [CBTC.admin], Amulet: [DEV.dso] }, dso: [DEV.dso], maxFee: '0.5', feeRecipients: [DEV.venue] };
  const mergeTerms: ConsolidateTerms = { party: BOT, admins: [DEV.dso], instrument: 'Amulet', maxFee: '0.5', feeRecipients: [DEV.venue] };
  type SendOver = Partial<Parameters<typeof selfSendLeg>[0]>;
  type FactoryOver = Partial<Parameters<typeof factoryTransferLeg>[0]>;
  const ccTransfer = (over: SendOver = {}) => selfSendLeg({ party: BOT, kind: 'transfer', receiver: OWNER, input: '10000', ids: 'a', outputs: [{ owner: OWNER, amount: '100' }, { owner: BOT, amount: '9900' }], ...over });
  const ccMerge = () => selfSendLeg({ party: BOT, kind: 'transfer', receiver: BOT, input: '19.54084', ids: 'a', outputs: [{ owner: BOT, amount: '19.54084' }] });
  const acceptLeg = () => acceptTransferLeg({ party: BOT, sender: OWNER, instrument: CBTC, amount: '0.5' });
  const offered: FactoryOver['outputs'] = [{ owner: BOT, amount: '0.5', lockedTo: CBTC.admin }, { owner: BOT, amount: '1.5' }];
  const regTransfer = (over: FactoryOver = {}) => factoryTransferLeg({ party: BOT, receiver: OWNER, instrument: CBTC, amount: '0.5', input: '2', outputs: offered, ...over });
  const other = (contractId: string, entityName: string, fields: Record<string, ReturnType<typeof v.party>>, signatories: string[]): Create => ({
    lfVersion: '2.1', contractId, packageName: 'splice-amulet', templateId: { packageId: 'ab'.repeat(32), moduleName: 'Splice.Amulet', entityName },
    argument: v.record(fields), signatories, stakeholders: [...new Set([...signatories, BOT])],
  });
  // A reward coupon of the account's: value that is the account's and is not a holding.
  const coupon = (amount: string) => other('e0'.repeat(34), 'AppRewardCoupon', { dso: v.party(DEV.dso), provider: v.party(BOT), amount: v.numeric(amount) }, [DEV.dso]);
  /** A fee leg that hands the venue `venueGets`, the difference paid out of a coupon of the account's. */
  const feeOf = (venueGets: string, couponWorth?: string) => ccFee({
    outputs: [{ owner: DEV.venue, amount: venueGets }, { owner: BOT, amount: '9.875' }],
    ...(couponWorth ? { extra: (c: Create) => spend('x', c, DEV.dso), extraInput: coupon(couponWorth) } : {}),
  });
  const createIn = (decoded: PreparedTransaction, nodeId: string) => {
    const versioned = decoded.transaction!.nodes.find((n) => n.nodeId === nodeId)!.versionedNode;
    if (versioned.oneofKind !== 'v1' || versioned.v1.nodeType.oneofKind !== 'create') throw new Error(`node ${nodeId} is not a create`);
    return versioned.v1.nodeType.create;
  };
  const exerciseIn = (decoded: PreparedTransaction, nodeId: string) => {
    const versioned = decoded.transaction!.nodes.find((n) => n.nodeId === nodeId)!.versionedNode;
    if (versioned.oneofKind !== 'v1' || versioned.v1.nodeType.oneofKind !== 'exercise') throw new Error(`node ${nodeId} is not an exercise`);
    return versioned.v1.nodeType.exercise;
  };

  test('a fee leg costs the account what it hands over, whatever paid for it', async () => {
    // The venue is handed 500 CC of "fee"; the account's holdings lose 0.125, the rest is a reward coupon of its own.
    await refusedWith(verifySendPrepared([await ccTransfer(), await feeOf('500', '490.125')], sendTerms), /the send costs this account 600 Amulet, more than the 100 it sends and the fee it allows/);
    await refusedWith(verifyAcceptPrepared([await acceptLeg(), await feeOf('500', '490.125')], acceptTerms), /the accept costs this account 500 CC of fee, more than the fee it allows/);
    await refusedWith(verifyConsolidatePrepared([await ccMerge(), await feeOf('500', '490.125')], mergeTerms), /the merge costs this account 500 Amulet, more than the fee it allows/);
    await refusedWith(verifyFeePrepared([await feeOf('500', '490.125')], { party: BOT, dso: [DEV.dso], maxFee: '0.5', feeRecipients: [DEV.venue] }), /the fee costs this account 500 CC, more than the fee it allows/);
    // And with no source at all for it in the tree: what is handed over is what is counted.
    await refusedWith(verifySendPrepared([await ccTransfer(), await feeOf('500')], sendTerms), /the send costs this account 600 Amulet/);
    // The honest fee is unchanged.
    await expect(verifySendPrepared([await ccTransfer(), await feeOf('0.125')], sendTerms)).resolves.toBeUndefined();
  });

  test('a gain on one leg does not pay for an overcharge on another', async () => {
    // The transfer leg turns a 400 CC coupon into change: the account's holdings GAIN 300 on it. The fee leg then takes 300.5.
    const gaining = await ccTransfer({ outputs: [{ owner: OWNER, amount: '100' }, { owner: BOT, amount: '10300' }], extra: (c) => spend('x', c, DEV.dso), extraInput: coupon('400') });
    const taking = await ccFee({ input: '310', outputs: [{ owner: DEV.venue, amount: '300.5' }, { owner: BOT, amount: '9.5' }] });

    await refusedWith(verifySendPrepared([gaining, taking], sendTerms), /the send costs this account 400.5 Amulet, more than the 100 it sends and the fee it allows/);
    // The coupon folded into the change, with the honest fee, is the account's own business.
    await expect(verifySendPrepared([gaining, await feeOf('0.125')], sendTerms)).resolves.toBeUndefined();
  });

  test('a registry send gives exactly what it transfers: handed over, or locked under one offer of this transfer', async () => {
    // Locked, and nobody is offered it: the receiver has nothing to accept and the sender's balance is stuck.
    await refusedWith(verifySendPrepared([await regTransfer({ offer: null })], regTerms), /leg 0 transfers 0.5 and neither hands exactly that to .* nor locks exactly that under one offer of this transfer/);
    // Two legs, each asking for the whole amount and locking half of it.
    const half = () => regTransfer({ outputs: [{ owner: BOT, amount: '0.25', lockedTo: CBTC.admin }, { owner: BOT, amount: '1.75' }] });
    await refusedWith(verifySendPrepared([await half(), await half()], regTerms), /leg 0 transfers 0.5 and neither hands exactly that/);
    // An "offer" of this transfer that the admin did not sign, and one of another instrument, are not the offer.
    const unsigned = await remade(await regTransfer(), (decoded) => {
      for (const n of decoded.transaction!.nodes) {
        const type = n.versionedNode.oneofKind === 'v1' ? n.versionedNode.v1.nodeType : undefined;
        if (type?.oneofKind === 'create' && type.create.templateId?.entityName === 'TransferOffer') type.create.signatories = [BOT];
      }
    });
    await refusedWith(verifySendPrepared([unsigned], regTerms), /creates a TransferOffer signed by this account that is neither its holding nor this send/);
    await refusedWith(verifySendPrepared([await regTransfer({ offer: { instrumentId: { id: 'HTEST', admin: CBTC.admin } } })], regTerms), /creates a TransferOffer signed by this account that is neither its holding nor this send/);
    // The holding handed over AND an offer of the same transfer beside it; and the lock under two offers of it.
    const handedOver = [{ owner: OWNER, amount: '0.5' }, { owner: BOT, amount: '1.5' }];
    await refusedWith(verifySendPrepared([await regTransfer({ outputs: handedOver })], regTerms), /leg 0 transfers 0.5 and neither hands exactly that/);
    const twoOffers = await remade(await regTransfer(), (decoded) => {
      const offer = decoded.transaction!.nodes.find((n) => n.versionedNode.oneofKind === 'v1' && n.versionedNode.v1.nodeType.oneofKind === 'create'
        && n.versionedNode.v1.nodeType.create.templateId?.entityName === 'TransferOffer')!;
      const second = createNode('9', { ...createIn(decoded, offer.nodeId), contractId: '1f'.repeat(34) });
      decoded.transaction!.nodes.push(second);
      decoded.transaction!.nodeSeeds.push({ nodeId: 9, seed: new Uint8Array(32).fill(7) });
      const parent = decoded.transaction!.nodes.find((n) => n.versionedNode.oneofKind === 'v1' && n.versionedNode.v1.nodeType.oneofKind === 'exercise'
        && n.versionedNode.v1.nodeType.exercise.children.includes(offer.nodeId))!;
      exerciseIn(decoded, parent.nodeId).children.push('9');
    });
    await refusedWith(verifySendPrepared([twoOffers], regTerms), /leg 0 transfers 0.5 and neither hands exactly that .* nor locks exactly that under one offer of this transfer/);
  });

  test('a registry transfer to the account itself locks nothing: a split or a merge has nobody to accept it', async () => {
    const toSelf = (outputs: NonNullable<FactoryOver['outputs']>) => factoryTransferLeg({ party: BOT, receiver: BOT, instrument: CBTC, amount: '0.5', input: '2', outputs, offer: null });
    const splitTerms: SelfSendTerms = { party: BOT, admins: [CBTC.admin], instrument: 'CBTC', amount: '0.5', maxCost: '2', feeRecipients: [] };
    await expect(verifySelfSendPrepared([await toSelf([{ owner: BOT, amount: '0.5' }, { owner: BOT, amount: '1.5' }])], splitTerms)).resolves.toBeUndefined();
    // Within the cost the caller allows, and still not a split: the half is locked, and nobody is there to take it.
    await refusedWith(verifySelfSendPrepared([await toSelf([{ owner: BOT, amount: '0.5', lockedTo: CBTC.admin }, { owner: BOT, amount: '1.5' }])], splitTerms), /leg 0 is a transfer to the account itself that leaves a holding locked/);
  });

  test('one contract id is one contract among those a transaction creates, too', async () => {
    // A third holding — the venue's — under the contract id of the receiver's: the holdings rule would read one of the two.
    const hidden = await ccTransfer({
      outputs: [{ owner: DEV.venue, amount: '0.5' }, { owner: OWNER, amount: '100' }, { owner: BOT, amount: '9899.5' }],
      output: (c) => (c.contractId.startsWith('a1') ? { ...c, contractId: 'a2'.repeat(34) } : c),
    });
    await refusedWith(verifySendPrepared([hidden], sendTerms), /leg 0 creates two contracts under one contract id/);
    // And a create under the id of a contract the transaction discloses.
    const shadow = other('ee'.repeat(34), 'Note', { holder: v.party(BOT) }, [DEV.dso]);
    await refusedWith(verifySendPrepared([await ccTransfer({ extra: (c) => createNode('x', c), extraInput: shadow })], sendTerms), /leg 0 creates two contracts under one contract id/);
  });

  test('a record that names a field twice is not read at all', async () => {
    const twice = await remade(await preapprovalProposalLeg({ party: BOT }), (decoded) => {
      const argument = createIn(decoded, '0').argument!.sum;
      if (argument.oneofKind !== 'record') throw new Error('the proposal is a record');
      // Read by label, the last `provider` wins; read by position, the first does.
      argument.record.fields.unshift({ label: 'provider', value: v.party(MALLORY) });
    });
    await refusedWith(verifyPreapprovalSetupPrepared([twice], { party: BOT, dso: [DEV.dso], providers: [DEV.venue, BOT], packages: DEFAULT_TRUSTED_PACKAGES.wallet }), /leg 0 carries a record that names a field twice/);
  });

  test('a field named twice is found wherever a record sits: in a choice argument, in a disclosed contract, and at any depth', async () => {
    // Not a party among them: the bounds on who appears in a tree would catch a second `receiver`, not a second `amount`.
    const doubled = { sum: { oneofKind: 'record' as const, record: { fields: [{ label: 'amount', value: v.numeric('1000.0000000000') }, { label: 'amount', value: v.numeric('0.5000000000') }] } } };
    const wrapped: Array<[string, ReturnType<typeof v.text>]> = [
      ['a list', v.list([doubled])],
      ['a text map', v.textMap({ k: doubled })],
      ['an optional', { sum: { oneofKind: 'optional', optional: { value: doubled } } }],
      ['a variant', { sum: { oneofKind: 'variant', variant: { constructor: 'C', value: doubled } } }],
      ['a map key', { sum: { oneofKind: 'genMap', genMap: { entries: [{ key: doubled, value: v.text('x') }] } } }],
      ['a map value', { sum: { oneofKind: 'genMap', genMap: { entries: [{ key: v.text('x'), value: doubled }] } } }],
      ['a nested record', v.record({ inner: doubled })],
    ];
    for (const [where, value] of wrapped) {
      const inChoice = await remade(await ccTransfer(), (decoded) => {
        const argument = exerciseIn(decoded, '0').chosenValue!.sum;
        if (argument.oneofKind !== 'record') throw new Error('the choice argument is a record');
        argument.record.fields.push({ label: 'extra', value });
      });
      await refusedWith(verifySendPrepared([inChoice], sendTerms), /leg 0 carries a record that names a field twice/).catch((e: unknown) => { throw new Error(`${where}: ${String(e)}`); });
    }
    const inDisclosed = await remade(await ccTransfer(), (decoded) => {
      const contract = decoded.metadata!.inputContracts[0]!.contract;
      if (contract.oneofKind !== 'v1' || contract.v1.argument?.sum.oneofKind !== 'record') throw new Error('the disclosed contract is a record');
      contract.v1.argument.sum.record.fields.push({ label: 'extra', value: doubled });
    });
    await refusedWith(verifySendPrepared([inDisclosed], sendTerms), /leg 0 carries a record that names a field twice/);
  });

  test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('a name the transaction supplies — %s — finds no pin and is refused as any unpinned name is', async (name) => {
    // An instrument id and a package name are the API's words: looked up as an own entry of the pins, they are just unknown.
    await refusedWith(verifyAcceptPrepared([await acceptTransferLeg({ party: BOT, sender: OWNER, instrument: { id: name, admin: CBTC.admin }, amount: '0.5' })], acceptTerms), /which is not an admin this SDK pins for it/);
    await refusedWith(verifyPreapprovalSetupPrepared([await preapprovalProposalLeg({ party: BOT, packageName: name })], { party: BOT, dso: [DEV.dso], providers: [DEV.venue, BOT], packages: DEFAULT_TRUSTED_PACKAGES.wallet }), /runs code from an untrusted package/);
  });

  test('the package pins cannot be changed by whoever imports them', () => {
    const wallet = DEFAULT_TRUSTED_PACKAGES.wallet['splice-wallet'] as string[];
    expect(Object.isFrozen(DEFAULT_TRUSTED_PACKAGES)).toBe(true);
    expect(() => wallet.push('ee'.repeat(32))).toThrow(TypeError);
    expect(() => { (DEFAULT_TRUSTED_PACKAGES.swap as Record<string, string[]>).evil = ['ee'.repeat(32)]; }).toThrow(TypeError);
  });

  test('rules that held and had no test of their own', async () => {
    // A contract the account signs that is neither its holding nor the offer of this transfer — in a send, and in an accept.
    const paper = (contractId: string) => other(contractId, 'Paper', { holder: v.party(BOT) }, [BOT]);
    await refusedWith(verifySendPrepared([await ccTransfer({ extra: () => createNode('x', paper('ef'.repeat(34))), extraInput: other('ee'.repeat(34), 'Note', { holder: v.party(BOT) }, [DEV.dso]) })], sendTerms),
      /creates a Paper signed by this account that is neither its holding nor this send/);
    const signing = await remade(await acceptLeg(), (decoded) => {
      decoded.transaction!.nodes.push(createNode('9', paper('ef'.repeat(34))));
      decoded.transaction!.nodeSeeds.push({ nodeId: 9, seed: new Uint8Array(32).fill(7) });
      exerciseIn(decoded, '0').children.push('9');
    });
    await refusedWith(verifyAcceptPrepared([signing], acceptTerms), /creates a Paper signed by this account that is neither its holding nor this accept/);
    // A CC send that spends a holding of another instrument along the way.
    const cbtc = holding('d5'.repeat(34), BOT, CBTC, '0.5');
    await refusedWith(verifySendPrepared([await ccTransfer({ extra: (c) => spend('x', c, DEV.dso), extraInput: cbtc })], sendTerms), /leg 0 spends \S+, not \S+/);
    // A "merge" whose one command is another choice of the account's own preapproval.
    const cancel = await remade(await ccMerge(), (decoded) => { exerciseIn(decoded, '0').choiceId = 'TransferPreapproval_Cancel'; });
    await refusedWith(verifyConsolidatePrepared([cancel], mergeTerms), /leg 0 is not a send through a transfer preapproval/);
    // A registry merge pays its CC fee under the DSO's pin, not the registrar's: named, it passes; left out, the fee leg is refused.
    const regMerge = () => factoryTransferLeg({ party: BOT, receiver: BOT, instrument: CBTC, amount: '0.0003', input: '0.0003', outputs: [{ owner: BOT, amount: '0.0003' }], offer: null });
    const regMergeTerms: ConsolidateTerms = { party: BOT, admins: [CBTC.admin], dso: [DEV.dso], instrument: 'CBTC', maxFee: '0.5', feeRecipients: [DEV.venue] };
    await expect(verifyConsolidatePrepared([await regMerge(), await ccFee()], regMergeTerms)).resolves.toBeUndefined();
    await refusedWith(verifyConsolidatePrepared([await regMerge(), await ccFee()], { ...regMergeTerms, dso: undefined }), /leg 1 sends through a preapproval the instrument admin did not sign/);
  });
});
