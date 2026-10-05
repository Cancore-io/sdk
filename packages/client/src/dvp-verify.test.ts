import { hashPreparedTransaction } from '@canton-network/core-tx-visualizer';
import { allocationTree, createNode, DEV, exercise, factoryContract, holding, prepared, proposalAccept, proposalCreate, spend, spendTransfer, type FixtureLeg } from './dvp-prepared.fixture';
import { DEFAULT_INSTRUMENT_ADMINS, mergeLists } from './dvp-admins';
import { DEFAULT_TRUSTED_PACKAGES, UnverifiedTransactionError, verifyDvpPrepared, type DvpTerms } from './dvp-verify';

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
    const upgraded = holding('66'.repeat(34), MAKER, CBTC, '0', { packageId: 'ab'.repeat(32), lockedTo: undefined });
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
  test('a create signed as an allocation', async () => {
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await create()], terms(MAKER)), /not a token-standard allocation/);
  });
});

test('overrides add to the pinned lists: one entry added keeps every default', () => {
  const merged = mergeLists(DEFAULT_INSTRUMENT_ADMINS.devnet, { CBTC: ['extra::1220ab'] });
  expect(merged.CBTC).toEqual([...DEFAULT_INSTRUMENT_ADMINS.devnet.CBTC!, 'extra::1220ab']);
  expect(merged.Amulet).toEqual(DEFAULT_INSTRUMENT_ADMINS.devnet.Amulet);
  expect(mergeLists(DEFAULT_TRUSTED_PACKAGES.swap, { 'cancore-swap': ['ff'.repeat(32)] })['cancore-swap']).toHaveLength(DEFAULT_TRUSTED_PACKAGES.swap['cancore-swap']!.length + 1);
});
