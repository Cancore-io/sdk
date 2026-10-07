/**
 * The executor against the real `CancoreRouter` of the local stand (meta
 * `make evm-genesis && make intent-genesis`, a router built from CAN-2140 on):
 * a fill from the delivery key the ticket names, nothing sent past
 * `validUntil`, `validUntil` inclusive at the router, replace-by-fee, a fill
 * reorged out and resent, and a restart between the nonce journal and the
 * broadcast that sends no second fill. anvil plays the chain: automine off for
 * a stuck transaction, `evm_snapshot` / `evm_revert` for a reorg,
 * `evm_setNextBlockTimestamp` for the boundary.
 *
 *   CANCORE_INTENT_JSON=<meta>/docker/modules/genesis/out/intent.json \
 *   CANCORE_ACTORS_ENV=<meta>/docker/modules/genesis/out/local-actors.env \
 *   npm run test:int
 *
 * `evm.json` (the stand's test tokens) is read next to `intent.json` unless
 * CANCORE_EVM_JSON names it. Keys come from the stand's actor file (test keys:
 * FILLER1 delivers, TICKETSIGNER signs tickets). Skipped without the stand:
 * CI of this repository has none (CAN-1876).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CANCORE_ROUTER_ABI, FILL_TICKET_DOMAIN, IBURN_MINT_ERC20_ABI, FILL_TICKET_TYPES, fillerIdHash, repayToFromEvm, type Hex, type OrderJson, type TicketJson } from '@cancore/contracts';
import { FillerChains, hashOrder, type ChainConfig } from '../src/filler/chain';
import { encodeFunctionCall, entryOf, type AbiEntry } from '../src/filler/chain/abi';
import { Executor, type DeliveryOptions } from '../src/filler/delivery/executor';
import { TransactionDriver } from '../src/filler/delivery/transactions';
import type { StageEvent } from '../src/filler/events';
import type { EvmRpc } from '../src/filler/rpc';
import type { Clock } from '../src/filler/runtime';
import type { FillRecord, TicketRecord } from '../src/filler/store';
import { createRecordingEventSink, createRecordingLogger, createTestFillSigner, createTestTypedDataSigner, decodeSignedTransaction, InMemoryFillerStore } from '../src/filler/testing';

const INTENT = process.env.CANCORE_INTENT_JSON;
const ACTORS = process.env.CANCORE_ACTORS_ENV;
const live = INTENT && ACTORS ? describe : describe.skip;

interface IntentArtifact {
  chainId: number;
  rpcUrlHost: string;
  contracts: { CancoreRouter: Hex };
  ticketSigner: Hex;
  destinations: Record<string, { destination: Hex; isEvm: boolean }>;
}

const FILLER = 'stand-filler-1';

/** JSON-RPC over HTTP. */
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

const env = (path: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );

/** Process time `offsetMs` ahead of the wall clock: aligned with the chain's own time. */
const offsetClock = (offsetMs: () => number): Clock => ({
  now: () => Date.now() + offsetMs(),
  schedule(delayMs, callback) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
});

async function waitFor<T>(read: () => Promise<T | undefined>, what: string, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

live('Executor against the stand router (make intent-genesis)', () => {
  const stand = (INTENT ? JSON.parse(readFileSync(INTENT, 'utf8')) : {}) as IntentArtifact;
  const evm = (INTENT ? JSON.parse(readFileSync(process.env.CANCORE_EVM_JSON ?? join(dirname(INTENT), 'evm.json'), 'utf8')) : {}) as { tokens: Record<string, { address: Hex }> };
  const actors = ACTORS ? env(ACTORS) : {};
  const chain = `eip155:${stand.chainId}` as const;
  const router = stand.contracts?.CancoreRouter?.toLowerCase() as Hex;
  const rpc = httpRpc(stand.rpcUrlHost);
  // The suite body is evaluated even when skipped: no key is touched without the stand.
  const delivery = ACTORS ? createTestFillSigner(actors.FILLER1_EVM_PRIVATE_KEY as Hex) : (undefined as never);
  const ticketSigner = ACTORS ? createTestTypedDataSigner(actors.TICKETSIGNER_EVM_PRIVATE_KEY as Hex) : (undefined as never);
  const token = Object.values(evm.tokens ?? {})[0]?.address?.toLowerCase() as Hex;
  const destination = Object.values(stand.destinations ?? {}).find((d) => d.isEvm)?.destination as Hex;
  const logger = createRecordingLogger();
  const policy = (extra: Partial<ChainConfig> = {}): ChainConfig => ({ router, openConfirmations: 1, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 900, sendGuardSec: 10, minGasWei: 0n, fillConfirmations: 2, ...extra });

  const chainTime = async (): Promise<bigint> => BigInt((await rpc.request<{ timestamp: string }>({ method: 'eth_getBlockByNumber', params: ['latest', false] })).timestamp);
  const mine = (blocks = 1) => rpc.request({ method: 'anvil_mine', params: [`0x${blocks.toString(16)}`] });

  /** A raw transaction from the delivery key, mined (automine). */
  async function sendFrom(to: Hex, data: Hex): Promise<void> {
    const nonce = BigInt(await rpc.request<string>({ method: 'eth_getTransactionCount', params: [delivery.address, 'pending'] }));
    const raw = await delivery.signTransaction({ chainId: BigInt(stand.chainId), nonce, to, data, value: 0n, gasLimit: 200_000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    await rpc.request({ method: 'eth_sendRawTransaction', params: [raw] });
  }

  /** An EVM → EVM order on the stand's one network, its ticket issued to FILLER1 and receipted in a fresh store. */
  async function scenario(options: { ttlS?: number; validUntil?: bigint; clockAt?: () => number; delivery?: DeliveryOptions; chain?: Partial<ChainConfig>; instanceId?: string } = {}) {
    const now = await chainTime();
    const offset = Number(now) * 1000 - Date.now();
    const clock = options.clockAt ? { ...offsetClock(() => 0), now: options.clockAt } : offsetClock(() => offset);
    const store = new InMemoryFillerStore(clock);
    const recipient = `0x${Date.now().toString(16).padStart(40, '0').slice(-40)}` as Hex;
    const order: OrderJson = {
      user: '0x1111111111111111111111111111111111111111',
      originChainId: String(stand.chainId),
      inputToken: token,
      inputAmount: '1000000000000000000',
      destination,
      outputAsset: `0x${'00'.repeat(12)}${token.slice(2)}`,
      minReceived: '990000000000000000',
      recipient: `0x${'00'.repeat(12)}${recipient.slice(2)}`,
      createdAt: String(now - 60n),
      fillDeadline: String(now + 3_600n),
      feeBps: '30',
    };
    const orderHash = hashOrder(order, { chainId: stand.chainId, router });
    const validUntil = options.validUntil ?? now + BigInt(options.ttlS ?? 300);
    const ticket: TicketJson = {
      orderHash,
      fillerId: fillerIdHash(FILLER),
      deliveryKey: delivery.address.toLowerCase() as Hex,
      repayTo: repayToFromEvm(delivery.address),
      attempt: 0,
      validFrom: String(now - 10n),
      validUntil: String(validUntil),
    };
    const ticketSig = await ticketSigner.signTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: { ...ticket } });
    const record: TicketRecord = {
      orderHash,
      attempt: 0,
      state: 'receipted',
      offer: { type: 'ticket.offer', orderHash, attempt: 0, order, amountOut: order.minReceived, validFrom: ticket.validFrom, validUntil: ticket.validUntil } as never,
      issued: { type: 'ticket.issued', form: 'evm', orderHash, attempt: 0, ticket, ticketSig } as never,
      receipt: { type: 'ticket.receipt' } as never,
      sentAtMs: clock.now(),
      updatedAtMs: clock.now(),
    };
    await store.withOrder(orderHash, (tx) => tx.putTicket(record));
    const events = createRecordingEventSink();
    const chains = new FillerChains({ [chain]: [rpc] }, { [chain]: policy(options.chain) }, logger);
    const receipted = async (hash: Hex, attempt: number) => store.withOrder(hash, (tx) => tx.getTicket(attempt));
    const executor = new Executor({
      store,
      chains,
      fillSigners: { [chain]: delivery },
      fillerId: FILLER,
      receipted,
      instanceId: options.instanceId ?? 'int-1',
      clock,
      logger,
      events,
      delivery: { pollIntervalMs: 200, replaceAfterMs: 1_500, nonceLeaseTtlMs: 1_000, ...options.delivery },
    });
    const fill = () => store.withOrder(orderHash, (tx) => tx.getFill(0));
    const state = (want: FillRecord['state']) => waitFor(async () => ((await fill())?.state === want ? (await fill())! : undefined), `fill ${want}`);
    const stages = (name: string) => events.events.filter((e): e is StageEvent => e.type === 'stage' && e.stage === name);
    const filled = async () => (await chains.get(chain)!.router.filled(orderHash)) as boolean;
    return { clock, store, order, orderHash, ticket, ticketSig, executor, events, fill, state, stages, filled, chains };
  }

  beforeAll(async () => {
    expect(ticketSigner.address.toLowerCase()).toBe(stand.ticketSigner.toLowerCase());
    // Stock the delivery key — TestToken.mint(uint256) mints to the caller — and approve the router once (T-25).
    await sendFrom(token, `0xa0712d68${(10n ** 24n).toString(16).padStart(64, '0')}`);
    await sendFrom(token, encodeFunctionCall(entryOf(IBURN_MINT_ERC20_ABI as unknown as readonly AbiEntry[], 'function', 'approve'), [router, 10n ** 24n]));
  });

  afterEach(async () => {
    await rpc.request({ method: 'evm_setAutomine', params: [true] });
  });

  test('fill from the delivery key the ticket names; confirmed 2 deep, with the header and receipt kept', async () => {
    const s = await scenario();
    await s.executor.start();
    expect(await s.executor.deliver(s.orderHash, 0)).toMatchObject({ status: 'sent' });
    await s.state('included');
    await mine(2);
    const fill = await s.state('confirmed');
    expect(fill.inclusion?.receipt).toMatchObject({ transactionHash: fill.txRef });
    expect(await s.filled()).toBe(true);
    expect(s.events.events.filter((e) => e.type === 'filled')).toHaveLength(1);
    s.executor.stop();
  });

  test('nothing is sent with less than sendGuard left, nor past validUntil', async () => {
    for (const ttlS of [5, -1]) {
      const s = await scenario({ ttlS });
      const before = await rpc.request<string>({ method: 'eth_getTransactionCount', params: [delivery.address, 'pending'] });
      expect(await s.executor.deliver(s.orderHash, 0)).toMatchObject({ status: 'refused', reason: 'send-guard' });
      expect(await rpc.request<string>({ method: 'eth_getTransactionCount', params: [delivery.address, 'pending'] })).toBe(before);
    }
  });

  test('validUntil is inclusive at the router (T-28): a fill in a block stamped validUntil is accepted, one stamped validUntil + 1 is not', async () => {
    for (const [late, accepted] of [[0n, true], [1n, false]] as const) {
      const at = (await chainTime()) + 30n;
      const s = await scenario({ validUntil: at, clockAt: () => Number(at - 1n) * 1000, chain: { sendGuardSec: 0 } });
      await rpc.request({ method: 'evm_setNextBlockTimestamp', params: [`0x${(at + late).toString(16)}`] });
      const result = await s.executor.deliver(s.orderHash, 0);
      if (accepted) {
        expect(result).toMatchObject({ status: 'sent' });
        await s.state('included');
        await mine(2);
        await s.state('confirmed');
      } else {
        // TicketExpired: refused by eth_estimateGas, or mined and reverted — gas only, never a fill.
        if (result.status === 'sent') await mine(2);
        await s.state('failed');
      }
      expect(await s.filled()).toBe(accepted);
      s.executor.stop();
    }
  });

  test('replace-by-fee: a fill stuck in the mempool is replaced on its nonce and the replacement fills', async () => {
    await rpc.request({ method: 'evm_setAutomine', params: [false] });
    const s2 = await scenario({ instanceId: 'int-rbf' });
    await s2.executor.start();
    const first = await s2.executor.deliver(s2.orderHash, 0);
    expect(first).toMatchObject({ status: 'sent' });
    const replaced = await waitFor(async () => s2.stages('fill.replaced')[0], 'a replacement');
    expect(replaced.detail).toMatchObject({ from: first.txHash });
    await rpc.request({ method: 'evm_setAutomine', params: [true] });
    await mine(3);
    const fill = await s2.state('confirmed');
    expect(fill.txRef).toBe(replaced.detail!.txHash);
    s2.executor.stop();
  });

  test('a fill reorged out before validUntil is resent on its nonce and confirms', async () => {
    const s = await scenario({ chain: { fillConfirmations: 3 } });
    await s.executor.start();
    const snapshot = await rpc.request<string>({ method: 'evm_snapshot', params: [] });
    const sent = await s.executor.deliver(s.orderHash, 0);
    await s.state('included');
    await rpc.request({ method: 'evm_revert', params: [snapshot] }); // the block with the fill is gone, and the fill with it
    await waitFor(async () => s.stages('fill.reorged')[0], 'the reorg');
    await waitFor(async () => ((await s.fill())?.state === 'included' ? true : undefined), 'the resent fill included');
    await mine(3);
    const fill = await s.state('confirmed');
    expect(fill.txRef).toBe(sent.txHash);
    expect(await s.filled()).toBe(true);
    s.executor.stop();
  });

  test('restart between the nonce journal and the broadcast: another replica takes the lease after its TTL and sends those bytes; no second fill', async () => {
    const s = await scenario({ instanceId: 'int-r2' });
    const dead = new TransactionDriver({ chain, client: s.chains.get(chain)!.client, signer: delivery, store: s.store, owner: 'int-dead', leaseTtlMs: 1_000, fees: { feeBumpPercent: 15, gasLimitMarginPercent: 20 }, logger });
    const lease = await dead.acquire();
    const data = encodeFunctionCall(entryOf(CANCORE_ROUTER_ABI as unknown as readonly AbiEntry[], 'function', 'fill'), [s.order, BigInt(s.order.minReceived), s.ticket, s.ticketSig]);
    const call = { to: router, data, value: 0n, gasLimit: 400_000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    const raw = await delivery.signTransaction({ chainId: BigInt(stand.chainId), nonce: lease.nonce, ...call });
    const { hash } = decodeSignedTransaction(raw);
    expect(await s.store.nonces.recordTransaction(lease, { hash, raw, kind: 'fill', orderHash: s.orderHash, attempt: 0, ...call, sentAtMs: s.clock.now() })).toBe(true);

    await s.executor.start();
    expect(await s.executor.deliver(s.orderHash, 0)).toMatchObject({ status: 'tracking', txHash: hash });
    await s.state('included');
    await mine(2);
    const fill = await s.state('confirmed');
    expect(fill.txRef).toBe(hash);
    expect(await s.filled()).toBe(true);
    s.executor.stop();
  });
});
