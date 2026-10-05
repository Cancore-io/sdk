import { hashPreparedTransaction } from '@canton-network/core-tx-visualizer';
import { allocationTree, createNode, factoryContract, holding, prepared, proposalAccept, proposalCreate, spend, type FixtureLeg } from './dvp-prepared.fixture';
import { DEFAULT_TRUSTED_PACKAGES, UnverifiedTransactionError, verifyDvpPrepared, type DvpTerms } from './dvp-verify';

const MAKER = 'maker::1220aa';
const TAKER = 'taker::1220bb';
const VENUE = 'venue::1220cc';
const FEE = 'fee::1220dd';
const CBTC = { id: 'CBTC', admin: 'cbtc-admin::1220ee' };
const CC = { id: 'Amulet', admin: 'dso::1220ff' };

const terms = (party: string, over: Partial<DvpTerms> = {}): DvpTerms => ({
  swapId: 'swap-1', party, maker: MAKER, taker: TAKER,
  source: { ...CBTC, amount: '0.01' }, target: { ...CC, amount: '5000' },
  venue: VENUE, feeParty: FEE, feeRate: '0.005', packages: DEFAULT_TRUSTED_PACKAGES, ...over,
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
  test('a child node from a package nobody trusts', async () => {
    const lookalike = holding('66'.repeat(34), MAKER, CBTC, '0', 'utility-registry-holding-v0-evil');
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-main', undefined, VENUE, { extra: (id) => ({ nodes: [createNode(id(0), lookalike)] }) })], terms(MAKER)), /untrusted package \(utility-registry-holding-v0-evil\)/);
  });
  test('an extra child that moves another of the signer’s holdings to someone else', async () => {
    const other = holding('77'.repeat(34), MAKER, CBTC, '5');
    const moved = holding('88'.repeat(34), THIEF, CBTC, '5');
    const tree = { extra: (id: (n: number) => string) => ({ nodes: [spend(id(0), other, MAKER), createNode(id(1), moved)], inputs: [other] }) };
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-main', undefined, VENUE, tree)], terms(MAKER)), /creates a holding owned by thief/);
  });
  test('an extra child that burns more of the signer’s holdings than the leg locks', async () => {
    const other = holding('77'.repeat(34), MAKER, CBTC, '5');
    const tree = { extra: (id: (n: number) => string) => ({ nodes: [spend(id(0), other, MAKER)], inputs: [other] }) };
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-main', undefined, VENUE, tree)], terms(MAKER)), /spends more CBTC than the leg locks/);
  });
  test('an extra child that spends a holding of another party', async () => {
    const theirs = holding('77'.repeat(34), THIEF, CBTC, '5');
    const tree = { extra: (id: (n: number) => string) => ({ nodes: [spend(id(0), theirs, THIEF)], inputs: [theirs] }) };
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-main', undefined, VENUE, tree)], terms(MAKER)), /spends a holding owned by thief/);
  });
  test('a child that consumes a contract the transaction does not disclose', async () => {
    const hidden = holding('99'.repeat(34), MAKER, CBTC, '5');
    const tree = { extra: (id: (n: number) => string) => ({ nodes: [spend(id(0), hidden, MAKER)] }) };
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-main', undefined, VENUE, tree)], terms(MAKER)), /without disclosing what it is/);
  });
  test('a factory from a look-alike package', async () => {
    const factory = factoryContract(CBTC.admin, 'splice-amulet-lookalike');
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-main', undefined, VENUE, { factory })], terms(MAKER)), /factory comes from an untrusted package/);
  });
  test('a factory that is not the instrument admin’s', async () => {
    const factory = factoryContract(THIEF);
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await fund('leg-main', undefined, VENUE, { factory })], terms(MAKER)), /does not belong to the instrument admin/);
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
    await refused(verifyDvpPrepared('dvpCreateProposal', [await create()], terms(MAKER, { packages: { ...DEFAULT_TRUSTED_PACKAGES, swap: 'other-swap' } })), /untrusted package \(cancore-swap\)/);
  });
  test('a create signed as an allocation', async () => {
    await refused(verifyDvpPrepared('dvpAllocateLeg', [await create()], terms(MAKER)), /untrusted package \(cancore-swap\)/);
  });
});
