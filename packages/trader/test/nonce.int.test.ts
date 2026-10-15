/**
 * CAN-2636 against a real node: anvil, no contracts. A faulty RPC answers an
 * inflated `eth_getTransactionCount(…, 'pending')`; everything else it passes
 * to anvil. The driver must not take that answer into the store's counter: it
 * allocates at most `latest` + the open nonces of the key, reports the
 * suspect answer, and every transaction it sends is mined — no nonce gap.
 * Honest `pending` with the key's own transactions in flight is taken as is.
 *
 *   anvil &
 *   ANVIL_RPC_URL=http://127.0.0.1:8545 npm run test:int -- nonce
 *
 * Skipped without ANVIL_RPC_URL. In this repository's CI the `anvil` job runs
 * it. It toggles automine, so it needs an anvil no other suite uses at the
 * same time (the job runs its suites in band).
 */
import type { Hex } from '@cancore/contracts';
import { ChainClient } from '../src/filler/chain/client';
import type { EvmChainId } from '../src/filler/chains';
import { TransactionDriver, type SuspectNonce } from '../src/filler/delivery/transactions';
import type { EvmRpc } from '../src/filler/rpc';
import type { NonceLease } from '../src/filler/store';
import { createRecordingLogger, createTestFillSigner, InMemoryFillerStore } from '../src/filler/testing';

const RPC_URL = process.env.ANVIL_RPC_URL;
const live = RPC_URL ? describe : describe.skip;

// anvil's third default account (the replacement suite uses the first): a public test key.
const KEY: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const PAYEE: Hex = '0x000000000000000000000000000000000000beef';
const INFLATION = 1_000n;

const httpRpc = (url: string): EvmRpc => {
  let id = 0;
  return {
    label: 'anvil',
    async request<T>({ method, params = [] }: { method: string; params?: readonly unknown[] }): Promise<T> {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      const body = (await response.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
      if (body.error) throw body.error;
      return body.result as T;
    },
  };
};

/** anvil, except that `pending` transaction counts come back `INFLATION` too high while `lying()` holds. */
const faulty = (inner: EvmRpc, lying: () => boolean): EvmRpc => ({
  label: 'faulty',
  async request<T>(req: { method: string; params?: readonly unknown[] }): Promise<T> {
    const answer = await inner.request<T>(req);
    if (lying() && req.method === 'eth_getTransactionCount' && req.params?.[1] === 'pending') return `0x${(BigInt(answer as string) + INFLATION).toString(16)}` as T;
    return answer;
  },
});

live('CAN-2636: the nonce counter against an inflated pending answer, on anvil', () => {
  const anvil = httpRpc(RPC_URL ?? 'http://127.0.0.1:0');
  const logger = createRecordingLogger();
  const call = <T>(method: string, params: readonly unknown[] = []) => anvil.request<T>({ method, params });
  let chain: EvmChainId;

  beforeAll(async () => {
    chain = `eip155:${BigInt(await call<string>('eth_chainId'))}` as EvmChainId;
  });
  beforeEach(async () => {
    await call('evm_setAutomine', [false]);
  });
  afterEach(async () => {
    await call('anvil_dropAllTransactions');
    await call('evm_setAutomine', [true]);
  });

  /** A driver over the faulty endpoint, a fresh store, and what it reported as suspect. */
  function world() {
    let lie = true;
    const suspects: SuspectNonce[] = [];
    const store = new InMemoryFillerStore();
    const client = new ChainClient({ chain, endpoints: [faulty(anvil, () => lie)], maxHeadLagBlocks: 5, logger });
    const signer = createTestFillSigner(KEY);
    const driver = new TransactionDriver({
      chain, client, signer, store, owner: 'it-2636', leaseTtlMs: 60_000, fees: { feeBumpPercent: 15, gasLimitMarginPercent: 20 }, logger,
      onSuspectNonce: (s) => void suspects.push(s),
    });
    const onChain = async (tag: 'latest' | 'pending') => BigInt(await call<string>('eth_getTransactionCount', [signer.address, tag]));
    const send = async (lease: NonceLease) => driver.send(lease, { to: PAYEE, data: '0x', value: 1n }, 21_000n, await driver.marketFees(), { kind: 'fill' }, Date.now());
    const mined = async (hash: Hex) => (await driver.receipt(hash))?.status;
    return { driver, store, suspects, onChain, send, mined, honest: () => void (lie = false), lying: () => void (lie = true) };
  }

  test('TC-SDK-2636-01: an inflated pending is not taken: the nonce is the chain\'s, the transaction is mined, the answer is reported', async () => {
    const w = world();
    const latest = await w.onChain('latest');
    const lease = await w.driver.acquire();
    expect(lease.nonce).toBe(latest);
    expect(w.suspects).toEqual([expect.objectContaining({ latest, open: 0, used: latest, pending: latest + INFLATION })]);
    const tx = await w.send(lease);
    await call('evm_mine');
    expect(await w.mined(tx.hash)).toBe(1);
  });

  test('TC-SDK-2636-02: after the inflated answer the counter is where the chain is: the next nonce follows with no gap and is mined', async () => {
    const w = world();
    const first = await w.driver.acquire();
    const tx1 = await w.send(first);
    await call('evm_mine');
    expect(await w.mined(tx1.hash)).toBe(1);
    await w.store.nonces.complete(first, tx1.hash);
    w.honest();
    const second = await w.driver.acquire();
    expect(second.nonce).toBe(first.nonce + 1n);
    expect(second.nonce).toBe(await w.onChain('latest'));
    const tx2 = await w.send(second);
    await call('evm_mine');
    expect(await w.mined(tx2.hash)).toBe(1);
  });

  test("TC-SDK-2636-03: an honest pending above latest by the key's own transactions in flight is taken, nothing is reported", async () => {
    const w = world();
    w.honest();
    const a = await w.driver.acquire();
    const txA = await w.send(a);
    const b = await w.driver.acquire();
    const txB = await w.send(b);
    expect(await w.onChain('pending')).toBe((await w.onChain('latest')) + 2n);
    const c = await w.driver.acquire();
    expect(c.nonce).toBe(b.nonce + 1n);
    const txC = await w.send(c);
    expect(w.suspects).toEqual([]);
    await call('evm_mine');
    for (const tx of [txA, txB, txC]) expect(await w.mined(tx.hash)).toBe(1);
  });

  test('TC-SDK-2636-04: with transactions in flight, an inflated pending is bounded by latest + the open nonces, not taken', async () => {
    const w = world();
    w.honest();
    const a = await w.driver.acquire();
    const txA = await w.send(a);
    w.lying();
    const b = await w.driver.acquire();
    expect(b.nonce).toBe(a.nonce + 1n);
    expect(w.suspects).toEqual([expect.objectContaining({ open: 1, used: a.nonce + 1n })]);
    const txB = await w.send(b);
    await call('evm_mine');
    for (const tx of [txA, txB]) expect(await w.mined(tx.hash)).toBe(1);
  });
});
