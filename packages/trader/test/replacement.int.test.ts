/**
 * The replacement cap of CAN-2299 against a real node: anvil, no contracts.
 * A `fill` (as `approve` and `cancel`) is never replaced above
 * REPLACEMENT_FEE_CAP_MULTIPLE × the first fee on its nonce, and at the cap
 * the same bytes are broadcast again; a `settle` is held to `maxFeePerGasWei`
 * only, and priced at it when urgent (R-14). anvil decides what is accepted,
 * replaced and mined: automine off, the next block's base fee set by hand.
 *
 *   anvil &
 *   ANVIL_RPC_URL=http://127.0.0.1:8545 npm run test:int -- replacement
 *
 * Skipped without ANVIL_RPC_URL. In this repository's CI the `anvil` job
 * starts its own anvil and runs this suite. It toggles automine, so it needs
 * an anvil of its own: never one another suite uses at the same time.
 */
import type { Hex } from '@cancore/contracts';
import { ChainClient } from '../src/filler/chain/client';
import type { EvmChainId } from '../src/filler/chains';
import { REPLACEMENT_FEE_CAP_MULTIPLE, ReplacementCapError, TransactionDriver, type Fees, type FeePolicy } from '../src/filler/delivery/transactions';
import type { EvmRpc } from '../src/filler/rpc';
import type { InFlightTransaction, NonceLease } from '../src/filler/store';
import { createRecordingLogger, createTestFillSigner, InMemoryFillerStore } from '../src/filler/testing';

const RPC_URL = process.env.ANVIL_RPC_URL;
const live = RPC_URL ? describe : describe.skip;

// anvil's first default account: a public test key.
const KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PAYEE: Hex = '0x000000000000000000000000000000000000beef';
const GWEI = 1_000_000_000n;

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

const hex = (n: bigint) => `0x${n.toString(16)}`;

live('CAN-2299: replacement cap against anvil', () => {
  const rpc = httpRpc(RPC_URL ?? 'http://127.0.0.1:0');
  const logger = createRecordingLogger();
  const call = <T>(method: string, params: readonly unknown[] = []) => rpc.request<T>({ method, params });
  let chain: EvmChainId;

  beforeAll(async () => {
    chain = `eip155:${BigInt(await call<string>('eth_chainId'))}` as EvmChainId;
  });

  beforeEach(async () => {
    await call('evm_setAutomine', [false]);
    await mineAt(GWEI);
  });

  afterEach(async () => {
    await call('anvil_dropAllTransactions');
    await call('evm_setAutomine', [true]);
  });

  /** Mines one block whose base fee is `baseFee`. */
  async function mineAt(baseFee: bigint): Promise<void> {
    await call('anvil_setNextBlockBaseFeePerGas', [hex(baseFee)]);
    await call('evm_mine');
  }

  function driver(fees: Partial<FeePolicy> = {}) {
    const store = new InMemoryFillerStore();
    const client = new ChainClient({ chain, endpoints: [rpc], maxHeadLagBlocks: 5, logger });
    return new TransactionDriver({ chain, client, signer: createTestFillSigner(KEY), store, owner: 'it-2299', leaseTtlMs: 60_000, fees: { feeBumpPercent: 15, gasLimitMarginPercent: 20, ...fees }, logger });
  }

  /** A plain transfer of `kind` on a fresh lease, at market fees; not mined (automine off). */
  async function first(d: TransactionDriver, kind: 'fill' | 'settle'): Promise<{ lease: NonceLease; tx: InFlightTransaction; fees: Fees }> {
    const fees = await d.marketFees();
    const lease = await d.acquire();
    const tx = await d.send(lease, { to: PAYEE, data: '0x', value: 1n }, 21_000n, fees, { kind }, Date.now());
    return { lease, tx, fees };
  }

  const mined = async (d: TransactionDriver, hash: Hex) => (await d.receipt(hash))?.status;

  test('TC-SDK-2299-01: a fill whose market fee went past 3× the first is not replaced; nothing new is sent', async () => {
    const d = driver();
    const { lease, tx, fees } = await first(d, 'fill');
    await mineAt(fees.maxFeePerGas * 10n);
    expect(await mined(d, tx.hash)).toBeUndefined();
    await expect(d.replacementFees(fees, { kind: 'fill', first: fees })).rejects.toBeInstanceOf(ReplacementCapError);
    expect((await d.record(lease))?.transactions.map((t) => t.hash)).toEqual([tx.hash]);
  });

  test('TC-SDK-2299-02: at the cap the same bytes go out again and are mined once the base fee falls', async () => {
    const d = driver();
    const { tx, fees } = await first(d, 'fill');
    await mineAt(fees.maxFeePerGas * 10n);
    await expect(d.broadcast(tx)).resolves.toBeUndefined();
    expect(await d.known(tx.hash)).toBe(true);
    await mineAt(GWEI);
    expect(await mined(d, tx.hash)).toBe(1);
  });

  test('TC-SDK-2299-03: at the cap a transaction dropped from the mempool is broadcast again and mined', async () => {
    const d = driver();
    const { tx, fees } = await first(d, 'fill');
    await mineAt(fees.maxFeePerGas * 10n);
    await call('anvil_dropTransaction', [tx.hash]);
    expect(await d.known(tx.hash)).toBe(false);
    await d.broadcast(tx);
    expect(await d.known(tx.hash)).toBe(true);
    await mineAt(GWEI);
    expect(await mined(d, tx.hash)).toBe(1);
  });

  test('TC-SDK-2299-04: a fill replaced within the cap is accepted by the node and replaces the first', async () => {
    const d = driver();
    const { lease, tx, fees } = await first(d, 'fill');
    const bumped = await d.replacementFees(fees, { kind: 'fill', first: fees });
    expect(bumped.maxFeePerGas).toBeLessThanOrEqual(fees.maxFeePerGas * REPLACEMENT_FEE_CAP_MULTIPLE);
    const replacement = await d.send(lease, { to: PAYEE, data: '0x', value: 1n }, 21_000n, bumped, { kind: 'fill' }, Date.now());
    await mineAt(GWEI);
    expect(await mined(d, replacement.hash)).toBe(1);
    expect(await mined(d, tx.hash)).toBeUndefined();
  });

  test('TC-SDK-2299-05: a settle at base fee ×10 is replaced above 3× up to maxFeePerGasWei and is mined', async () => {
    const probe = await driver().marketFees();
    const ceiling = probe.maxFeePerGas * 25n;
    const d = driver({ maxFeePerGasWei: ceiling });
    const { lease, tx, fees } = await first(d, 'settle');
    await mineAt(fees.maxFeePerGas * 10n);
    expect(await mined(d, tx.hash)).toBeUndefined();
    const bumped = await d.replacementFees(fees, { kind: 'settle', first: fees });
    expect(bumped.maxFeePerGas).toBeGreaterThan(fees.maxFeePerGas * REPLACEMENT_FEE_CAP_MULTIPLE);
    expect(bumped.maxFeePerGas).toBeLessThanOrEqual(ceiling);
    const replacement = await d.send(lease, { to: PAYEE, data: '0x', value: 1n }, 21_000n, bumped, { kind: 'settle' }, Date.now());
    await call('evm_mine');
    expect(await mined(d, replacement.hash)).toBe(1);
    expect(await mined(d, tx.hash)).toBeUndefined();
  });

  test('TC-SDK-2299-06: an urgent settle is priced at maxFeePerGasWei at once and is mined', async () => {
    const probe = await driver().marketFees();
    const ceiling = probe.maxFeePerGas * 25n;
    const d = driver({ maxFeePerGasWei: ceiling });
    const { lease, tx, fees } = await first(d, 'settle');
    const urgent = await d.replacementFees(fees, { kind: 'settle', first: fees, urgent: true });
    expect(urgent.maxFeePerGas).toBe(ceiling);
    const replacement = await d.send(lease, { to: PAYEE, data: '0x', value: 1n }, 21_000n, urgent, { kind: 'settle' }, Date.now());
    await mineAt(fees.maxFeePerGas * 10n);
    expect(await mined(d, replacement.hash)).toBe(1);
    expect(await mined(d, tx.hash)).toBeUndefined();
  });
});
