/**
 * RouterReader against the real `CancoreRouter` of the local stand (meta
 * `make evm-genesis && make intent-genesis && make intent-smoke`). Read-only:
 * it sends no transaction; the Opened → Filled → Settled chain it checks is
 * the one `intent-smoke` left on anvil.
 *
 *   CANCORE_INTENT_JSON=<meta>/docker/modules/genesis/out/intent.json npm run test:int
 *
 * Without CANCORE_INTENT_JSON the suite is skipped: CI of this repository has
 * no stand (the stand in CI is CAN-1876).
 */
import { readFileSync } from 'node:fs';
import type { FillProof, FillTicket, Hex, Order } from '@cancore/contracts';
import { ChainClient, ChainReadError, hashFillProof, hashOrder, hashTicket, INTENT_STATUS, RouterEventWatcher, RouterReader, type RouterEventUpdate } from '../src/filler/chain';
import type { EvmRpc } from '../src/filler/rpc';
import { createRecordingLogger } from '../src/filler/testing';

const ARTIFACT = process.env.CANCORE_INTENT_JSON;
const live = ARTIFACT ? describe : describe.skip;

interface IntentArtifact {
  chainId: number;
  rpcUrlHost: string;
  contracts: { CancoreRouter: Hex };
  deployBlock: number;
  attestors: Hex[];
  threshold: number;
  ticketSigner: Hex;
  destinations: Record<string, { destination: Hex; proofWindow: number; isEvm: boolean }>;
}

/** JSON-RPC over HTTP: the `EvmRpc` a node would build in one line. */
const httpRpc = (url: string, label: string): EvmRpc => {
  let id = 0;
  return {
    label,
    async request<T>({ method, params = [] }: { method: string; params?: readonly unknown[] }): Promise<T> {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      const body = (await response.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
      if (body.error) throw body.error;
      return body.result as T;
    },
  };
};

live('RouterReader against the stand router (make intent-genesis)', () => {
  const stand = (ARTIFACT ? JSON.parse(readFileSync(ARTIFACT, 'utf8')) : {}) as IntentArtifact;
  const chain = `eip155:${stand.chainId}` as const;
  const logger = createRecordingLogger();
  const client = () => new ChainClient({ chain, endpoints: [httpRpc(stand.rpcUrlHost, 'anvil')], maxHeadLagBlocks: 5, logger });
  const reader = () => new RouterReader(chain, stand.contracts.CancoreRouter.toLowerCase() as Hex, client());
  const evmDestination = () => Object.values(stand.destinations).find((d) => d.isEvm)!;

  test('the configured CAIP-2 id is checked: anvil under another chain id is refused before any read', async () => {
    const wrong = new ChainClient({ chain: 'eip155:1', endpoints: [httpRpc(stand.rpcUrlHost, 'anvil')], maxHeadLagBlocks: 5, logger });
    await expect(new RouterReader('eip155:1', stand.contracts.CancoreRouter, wrong).currentSetId()).rejects.toMatchObject({ reason: 'wrong-chain' });
  });

  test('a dead endpoint first: the read fails over to anvil', async () => {
    const failover = new ChainClient({ chain, endpoints: [httpRpc('http://127.0.0.1:9', 'dead'), httpRpc(stand.rpcUrlHost, 'anvil')], maxHeadLagBlocks: 5, logger });
    await expect(new RouterReader(chain, stand.contracts.CancoreRouter, failover).currentSetId()).resolves.toBeGreaterThanOrEqual(1);
  });

  test('ticket signers, attestor set, proof window, minInput', async () => {
    const r = reader();
    await expect(r.ticketSigners(stand.ticketSigner)).resolves.toBe(true);
    await expect(r.ticketSigners('0x000000000000000000000000000000000000dead')).resolves.toBe(false);
    const setId = await r.currentSetId();
    const set = await r.getAttestorSet(setId);
    expect(set.members).toEqual(stand.attestors.map((a) => a.toLowerCase()).sort());
    expect(set.threshold).toBe(stand.threshold);
    await expect(r.isMember(setId, stand.attestors[0]!)).resolves.toBe(true);
    await expect(r.revokedAttestors(stand.attestors[0]!)).resolves.toBe(false);
    await expect(r.proofWindow(evmDestination().destination)).resolves.toBe(BigInt(evmDestination().proofWindow));
    expect(typeof (await r.minInput('0x000000000000000000000000000000000000dead'))).toBe('bigint');
  });

  test('local digests equal the router: hashOrder, sourceOrderHash, hashTicket, hashFillProof', async () => {
    const r = reader();
    const order: Order = {
      user: '0x1111111111111111111111111111111111111111',
      originChainId: String(stand.chainId),
      inputToken: '0x0000000000000000000000000000000000000056',
      inputAmount: '105',
      destination: evmDestination().destination,
      outputAsset: `0x${'00'.repeat(12)}${'0a'.repeat(20)}`,
      minReceived: '99',
      recipient: `0x${'00'.repeat(12)}${'0b'.repeat(20)}`,
      createdAt: '1790000000',
      fillDeadline: '1790000600',
      feeBps: 500,
    };
    const source = { chainId: stand.chainId, router: stand.contracts.CancoreRouter };
    const orderHash = hashOrder(order, source);
    await expect(r.hashOrder(order)).resolves.toBe(orderHash);
    await expect(r.sourceOrderHash(order)).resolves.toBe(orderHash);
    const ticket = { orderHash, filler: '0x2222222222222222222222222222222222222222', attempt: 3, validFrom: '1790000100', validUntil: '1790000400' } as unknown as FillTicket;
    await expect(r.hashTicket(ticket)).resolves.toBe(hashTicket(ticket));
    const proof: FillProof = {
      kind: 1,
      orderHash,
      destination: evmDestination().destination,
      fillRef: `0x${'cc'.repeat(32)}`,
      recipient: order.recipient,
      outputAsset: order.outputAsset,
      amountDelivered: 99n,
      filledAt: 1_790_000_200n,
      filler: '0x2222222222222222222222222222222222222222',
      attempt: 3,
      setId: 1,
    };
    await expect(r.hashFillProof(proof)).resolves.toBe(hashFillProof(proof, source));
  });

  test('reads at a depth: confirmations, safe and finalized resolve to blocks at or below the head', async () => {
    const c = client();
    const head = await c.head();
    await expect(c.resolve({ confirmations: 3 })).resolves.toBe(head >= 3n ? head - 3n : 0n);
    expect(await c.resolve('safe')).toBeLessThanOrEqual(head);
    expect(await c.resolve('finalized')).toBeLessThanOrEqual(head);
  });

  test('the router logs of intent-smoke: every settled order opened, then filled, then settled — each reported once', async () => {
    const updates: RouterEventUpdate[] = [];
    const watcher = new RouterEventWatcher({ client: client(), router: stand.contracts.CancoreRouter, confirmations: 0, fromBlock: BigInt(stand.deployBlock), onUpdate: (u) => void updates.push(u), logger });
    await watcher.poll();
    await watcher.poll();
    expect(updates.every((u) => u.kind === 'added')).toBe(true);
    const keys = updates.map((u) => `${u.log.name}:${u.log.orderHash}`);
    expect(new Set(keys).size).toBe(keys.length);

    const settled = updates.filter((u) => u.log.name === 'Settled').map((u) => u.log.orderHash);
    if (settled.length === 0) throw new Error('no Settled log on the stand router: run `make intent-smoke` first');
    const r = reader();
    for (const orderHash of settled) {
      const order = (name: string) => updates.findIndex((u) => u.log.name === name && u.log.orderHash === orderHash);
      expect(order('IntentOpened')).toBeGreaterThanOrEqual(0);
      expect(order('IntentOpened')).toBeLessThan(order('Filled'));
      expect(order('Filled')).toBeLessThan(order('Settled'));
      await expect(r.intents(orderHash)).resolves.toMatchObject({ status: INTENT_STATUS.Settled });
      await expect(r.filled(orderHash)).resolves.toBe(true);
    }
  });

  test('an escrow is not visible below the block it opened at', async () => {
    const updates: RouterEventUpdate[] = [];
    const watcher = new RouterEventWatcher({ client: client(), router: stand.contracts.CancoreRouter, confirmations: 0, fromBlock: BigInt(stand.deployBlock), onUpdate: (u) => void updates.push(u), logger });
    await watcher.poll();
    const opened = updates.find((u) => u.log.name === 'IntentOpened');
    if (!opened) throw new Error('no IntentOpened log on the stand router: run `make intent-smoke` first');
    const r = reader();
    await expect(r.intents(opened.log.orderHash, { blockNumber: opened.log.blockNumber - 1n })).resolves.toMatchObject({ status: INTENT_STATUS.None });
    expect((await r.intents(opened.log.orderHash, { blockNumber: opened.log.blockNumber })).status).not.toBe(INTENT_STATUS.None);
  });

  test('a router that is not there answers no data: malformed, never a value', async () => {
    const nowhere = new RouterReader(chain, '0x000000000000000000000000000000000000dead', client());
    await expect(nowhere.filled(`0x${'ab'.repeat(32)}`)).rejects.toBeInstanceOf(ChainReadError);
  });
});
