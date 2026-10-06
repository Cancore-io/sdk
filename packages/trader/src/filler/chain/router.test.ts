import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANCORE_ROUTER_ABI, CONTRACTS_RELEASE, type FillProof, type FillTicket, type Hex, type Order } from '@cancore/contracts';
import { createRecordingLogger, FakeChain } from '../testing';
import { ChainClient } from './client';
import { hashFillProof, hashOrder, hashTicket } from './hashes';
import { FillerChains } from './index';
import { INTENT_STATUS, RouterReader } from './router';

const SPEC = join(__dirname, '..', '..', '..', '..', 'contracts', 'spec', 'typed-data');
type Vector = { note: string; chainId?: string | number; verifyingContract?: Hex; message: Record<string, unknown>; digest: Hex };
const vectors = (name: string): Vector[] => (JSON.parse(readFileSync(join(SPEC, `${name}.json`), 'utf8')) as { vectors: Vector[] }).vectors;

describe('local digests equal the golden vectors of @cancore/contracts', () => {
  test.each(vectors('Order').map((v) => [v.note, v] as const))('Order: %s', (_note, v) => {
    expect(hashOrder(v.message as unknown as Order, { chainId: BigInt(v.chainId!), router: v.verifyingContract! })).toBe(v.digest);
  });

  test.each(vectors('FillTicket').map((v) => [v.note, v] as const))('FillTicket: %s', (_note, v) => {
    expect(hashTicket(v.message as unknown as FillTicket)).toBe(v.digest);
  });

  test.each(vectors('FillProof').map((v) => [v.note, v] as const))('FillProof: %s', (_note, v) => {
    expect(hashFillProof(v.message as unknown as FillProof, { chainId: BigInt(v.chainId!), router: v.verifyingContract! })).toBe(v.digest);
  });

  test('the Canton-source order vector (canton-order.json) hashes in the anchor domain', () => {
    const spec = JSON.parse(readFileSync(join(SPEC, '..', 'vectors', 'canton-order.json'), 'utf8')) as {
      vector: { order: Order; domain: { chainId: string; verifyingContract: Hex }; orderHash: Hex };
    };
    const { order, domain, orderHash } = spec.vector;
    expect(hashOrder(order, { chainId: BigInt(domain.chainId), router: domain.verifyingContract })).toBe(orderHash);
  });

  test('every Order field is in the digest: changing any one changes it', () => {
    const [v] = vectors('Order');
    const source = { chainId: BigInt(v!.chainId!), router: v!.verifyingContract! };
    const base = v!.message as unknown as Order;
    const changed = (field: keyof Order): Order => {
      const value = base[field];
      if (typeof value === 'string' && value.startsWith('0x')) return { ...base, [field]: `${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}` };
      return { ...base, [field]: String(BigInt(value as string) + 1n) };
    };
    for (const field of Object.keys(base) as Array<keyof Order>) expect(hashOrder(changed(field), source)).not.toBe(v!.digest);
  });
});

describe('RouterReader reads every view the filler needs off the pinned router', () => {
  const ROUTER: Hex = '0x3333333333333333333333333333333333333333';
  const HASH: Hex = `0x${'ab'.repeat(32)}`;
  const ATTESTOR: Hex = '0x00000000000000000000000000000000000000a1';
  const SIGNER: Hex = '0x2222222222222222222222222222222222222222';
  const TOKEN: Hex = '0x0000000000000000000000000000000000000056';
  const DEST: Hex = `0x${'00'.repeat(31)}38`;

  const setup = () => {
    const chain = new FakeChain(56n);
    const state = chain.router(ROUTER);
    state.openIntent(HASH, { refundAfter: 1_790_003_600n, openedAt: 1_790_000_000n });
    state.filled.set(HASH, 50n);
    state.ticketSigners.add(SIGNER);
    state.minInput.set(TOKEN, 1_000n);
    state.proofWindow.set(DEST, 2_700n);
    state.attestationSetFor.set(HASH, 3);
    state.attestorSets.set(3, { members: [ATTESTOR, '0x00000000000000000000000000000000000000b2'], threshold: 2, activeFrom: 10n, retiredAt: 0n });
    state.revokedAttestors.add(ATTESTOR);
    state.currentSetId = 4;
    return new RouterReader('eip155:56', ROUTER, new ChainClient({ chain: 'eip155:56', endpoints: [chain], maxHeadLagBlocks: 5, logger: createRecordingLogger() }));
  };

  test('escrow, delivery, ticket signers, floors and windows', async () => {
    const reader = setup();
    await expect(reader.intents(HASH)).resolves.toEqual({ status: INTENT_STATUS.Opened, refundAfter: 1_790_003_600n, openedAt: 1_790_000_000n });
    await expect(reader.filled(HASH)).resolves.toBe(true);
    await expect(reader.filled(`0x${'cd'.repeat(32)}`)).resolves.toBe(false);
    await expect(reader.ticketSigners(SIGNER)).resolves.toBe(true);
    await expect(reader.ticketSigners(ATTESTOR)).resolves.toBe(false);
    await expect(reader.minInput(TOKEN)).resolves.toBe(1_000n);
    await expect(reader.proofWindow(DEST)).resolves.toBe(2_700n);
  });

  test('attestor sets', async () => {
    const reader = setup();
    await expect(reader.attestationSetFor(HASH)).resolves.toBe(3);
    await expect(reader.getAttestorSet(3)).resolves.toEqual({ members: [ATTESTOR, '0x00000000000000000000000000000000000000b2'], threshold: 2, activeFrom: 10n, retiredAt: 0n });
    await expect(reader.currentSetId()).resolves.toBe(4);
    await expect(reader.isMember(3, ATTESTOR)).resolves.toBe(true);
    await expect(reader.isMember(4, ATTESTOR)).resolves.toBe(false);
    await expect(reader.revokedAttestors(ATTESTOR)).resolves.toBe(true);
  });

  test('the router hash views equal the local digests', async () => {
    const reader = setup();
    const [orderVector] = vectors('Order');
    const order = { ...(orderVector!.message as unknown as Order), originChainId: '56' };
    await expect(reader.sourceOrderHash(order)).resolves.toBe(hashOrder(order, { chainId: 56n, router: ROUTER }));
    await expect(reader.hashOrder(order)).resolves.toBe(hashOrder(order, { chainId: 56n, router: ROUTER }));
  });

  // The FillTicket of @cancore/contracts is the variant A struct; the router ABI is synced from
  // evm-contracts, where it is merged (evm-contracts#97). The sync into this package is a separate,
  // coordinated sdk PR (the CAN-2140 session). Not a silent skip (review F-3 of sdk#58): on the
  // snapshot synced before it — and only on that one — the gap is asserted by name; any ABI whose
  // hashTicket takes repayTo runs the golden-vector check; any other sync without it fails.
  const PRE_VARIANT_A_SYNC = '8c7d36f6a4f1cb76e6d5098c4f4b18367d46e350';
  const hashTicketInput = (CANCORE_ROUTER_ABI as readonly { type: string; name?: string; inputs?: readonly { components?: readonly { name: string }[] }[] }[])
    .find((e) => e.type === 'function' && e.name === 'hashTicket')?.inputs?.[0]?.components?.map((c) => c.name);
  if (hashTicketInput?.includes('repayTo')) {
    test('the router hashTicket view equals the FillTicket golden vector', async () => {
      const reader = setup();
      const [ticket] = vectors('FillTicket');
      await expect(reader.hashTicket(ticket!.message as unknown as FillTicket)).resolves.toBe(ticket!.digest);
    });
  } else {
    test('tripwire: only the pre-variant-A router snapshot may lack repayTo in hashTicket — the next ABI sync must bring it', () => {
      expect(CONTRACTS_RELEASE.commit).toBe(PRE_VARIANT_A_SYNC);
      expect(hashTicketInput).toContain('filler');
    });
  }
});

describe('router addresses come only from the node config', () => {
  test('every chain gets the router of its config entry; nothing else can name one', async () => {
    const eth = new FakeChain(1n);
    const bsc = new FakeChain(56n);
    eth.router('0x1111111111111111111111111111111111111111').minInput.set('0x0000000000000000000000000000000000000001', 7n);
    const chains = new FillerChains(
      { 'eip155:1': [eth], 'eip155:56': [bsc] },
      {
        'eip155:1': { router: '0x1111111111111111111111111111111111111111', openConfirmations: 3, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30, minGasWei: 10n ** 15n },
        'eip155:56': { router: '0x5656565656565656565656565656565656565656', openConfirmations: 10, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30, minGasWei: 10n ** 15n },
      },
      createRecordingLogger(),
    );
    expect(chains.chains).toEqual(['eip155:1', 'eip155:56']);
    expect(chains.get('eip155:56')!.router.address).toBe('0x5656565656565656565656565656565656565656');
    expect(chains.get('canton:devnet')).toBeUndefined();
    expect(chains.get('eip155:137')).toBeUndefined();
    await expect(chains.get('eip155:1')!.router.minInput('0x0000000000000000000000000000000000000001')).resolves.toBe(7n);
    expect(eth.calls.filter((c) => c.method === 'eth_call').map((c) => (c.params![0] as { to: string }).to)).toEqual(['0x1111111111111111111111111111111111111111']);
  });
});
