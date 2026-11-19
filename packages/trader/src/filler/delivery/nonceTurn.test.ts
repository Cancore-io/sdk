import type { Hex } from '@cancore/contracts';
import { FillerChains, type ChainConfig } from '../chain';
import type { NonceLease } from '../store';
import { createRecordingLogger, createTestFillSigner, FakeChain, FakeClock, InMemoryFillerStore } from '../testing';
import { FeeCeilingError, TransactionDriver, type TransactionPurpose } from './transactions';

const DST = 'eip155:1' as const;
const ROUTER: Hex = '0x1111111111111111111111111111111111111111';
const POLICY: ChainConfig = { router: ROUTER, openConfirmations: 3, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30, minGasWei: 0n };
const ORDER_A: Hex = `0x${'a1'.repeat(32)}`;
const ORDER_B: Hex = `0x${'b2'.repeat(32)}`;
const signer = createTestFillSigner('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const ME = signer.address.toLowerCase() as Hex;

/** One replica's driver of the delivery key on a fake chain, with nonce 0 held and empty: a send abandoned after it took the nonce. */
async function replicaWithAbandonedNonce() {
  const clock = new FakeClock();
  const dst = new FakeChain(1n, 'eth');
  const logger = createRecordingLogger();
  const chains = new FillerChains({ [DST]: [dst] }, { [DST]: POLICY }, logger);
  const store = new InMemoryFillerStore(clock);
  const driver = new TransactionDriver({ chain: DST, client: chains.get(DST)!.client, signer, store, owner: 'r1', leaseTtlMs: 5_000, fees: { feeBumpPercent: 15, gasLimitMarginPercent: 20 }, logger });
  const abandoned = await driver.acquire();
  expect(abandoned.nonce).toBe(0n);
  const send = async (lease: NonceLease, purpose: TransactionPurpose) => driver.send(lease, { to: ME, data: '0x', value: 0n }, 21_000n, await driver.marketFees(), purpose, clock.now());
  const open = async () => (await store.nonces.listOpen(DST, ME)).map((r) => ({ nonce: r.nonce, orders: r.transactions.map((t) => t.orderHash ?? t.kind) }));
  return { driver, send, open };
}

describe('BUG-1586: sends of one replica never share a nonce taken empty (F-05)', () => {
  test('BUG-1586-01: two concurrent fills of different orders on a held empty nonce get different nonces', async () => {
    const r = await replicaWithAbandonedNonce();
    const fill = (orderHash: Hex) => r.driver.withNonce((lease) => r.send(lease, { kind: 'fill', orderHash, attempt: 0 }));
    const [a, b] = await Promise.all([fill(ORDER_A), fill(ORDER_B)]);
    expect(a.hash).not.toBe(b.hash);
    expect(await r.open()).toEqual([
      { nonce: 0n, orders: [ORDER_A] },
      { nonce: 1n, orders: [ORDER_B] },
    ]);
  });

  test('BUG-1586-02: the next send waits only until the transaction is recorded, not until the first send returns', async () => {
    const r = await replicaWithAbandonedNonce();
    let finishFirst!: () => void;
    const firstStillRunning = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const first = r.driver.withNonce(async (lease) => {
      await r.send(lease, { kind: 'fill', orderHash: ORDER_A, attempt: 0 });
      await firstStillRunning;
      return lease;
    });
    const second = await r.driver.withNonce(async (lease) => lease);
    expect(second.nonce).toBe(1n);
    finishFirst();
    expect((await first).nonce).toBe(0n);
  });

  test('BUG-1586-03: a send that fails before recording ends its turn, and the next send reuses the empty nonce', async () => {
    const r = await replicaWithAbandonedNonce();
    await expect(r.driver.withNonce(async () => Promise.reject(new FeeCeilingError('fee spike')))).rejects.toBeInstanceOf(FeeCeilingError);
    await r.driver.withNonce((lease) => r.send(lease, { kind: 'fill', orderHash: ORDER_B, attempt: 0 }));
    expect(await r.open()).toEqual([{ nonce: 0n, orders: [ORDER_B] }]);
  });

  test('BUG-1586-04: the gap filler does not cancel on a nonce a concurrent fill has just recorded on', async () => {
    const r = await replicaWithAbandonedNonce();
    const [gap] = await r.open();
    const fill = r.driver.withNonce((lease) => r.send(lease, { kind: 'fill', orderHash: ORDER_A, attempt: 0 }));
    const cancel = r.driver.withEmptyNonce({ chain: DST, address: ME, nonce: gap!.nonce, owner: 'r1', expiresAtMs: 0 }, (lease) => r.send(lease, { kind: 'cancel' }));
    await fill;
    expect(await cancel).toBeUndefined();
    expect(await r.open()).toEqual([{ nonce: 0n, orders: [ORDER_A] }]);
  });
});
