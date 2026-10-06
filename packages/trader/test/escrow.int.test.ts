/**
 * The checks before a receipt against the real router of the local stand
 * (meta `make evm-genesis && make intent-genesis && make intent-smoke`).
 * Read-only: the order is the one `intent-smoke` opened and settled, read
 * back from its `IntentOpened` log; V-E1 is held to the real router's
 * domain, V-E2 to its real escrow record.
 *
 *   CANCORE_INTENT_JSON=<meta>/docker/modules/genesis/out/intent.json npm run test:int
 *
 * Skipped without CANCORE_INTENT_JSON (no stand in this repository's CI: CAN-1876).
 */
import { readFileSync } from 'node:fs';
import { FILL_TICKET_DOMAIN, FILL_TICKET_TYPES, type Hex, type OrderJson, type TicketIssuedEvm, type TicketOffer } from '@cancore/contracts';
import { FillerChains, RouterEventWatcher, type RouterEventUpdate } from '../src/filler/chain';
import type { EvmRpc } from '../src/filler/rpc';
import type { FillSigner } from '../src/filler/signer';
import { createRecordingEventSink, createRecordingLogger, createTestTypedDataSigner, FakeClock } from '../src/filler/testing';
import { TicketVerifier } from '../src/filler/tickets/checks';

const ARTIFACT = process.env.CANCORE_INTENT_JSON;
const live = ARTIFACT ? describe : describe.skip;

// Test keys only (the hardhat/anvil defaults); neither is a ticket signer of the stand.
const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TICKET_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';

const httpRpc = (url: string): EvmRpc => {
  let id = 0;
  return {
    label: 'anvil',
    async request<T>({ method, params = [] }: { method: string; params?: readonly unknown[] }): Promise<T> {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      const body = (await response.json()) as { result?: T; error?: unknown };
      if (body.error) throw body.error;
      return body.result as T;
    },
  };
};

const decimal = (value: unknown): string => String(value);

live('the checks before a receipt against the stand router', () => {
  const stand = (ARTIFACT ? JSON.parse(readFileSync(ARTIFACT, 'utf8')) : {}) as { chainId: number; rpcUrlHost: string; contracts: { CancoreRouter: Hex }; deployBlock: number };
  const chain = `eip155:${stand.chainId}` as const;
  const logger = createRecordingLogger();
  const fill: FillSigner = { ...createTestTypedDataSigner(FILL_KEY), signTransaction: async () => '0x02' };
  const ticketSigner = createTestTypedDataSigner(TICKET_KEY);

  async function smokeOrder(): Promise<{ order: OrderJson; orderHash: Hex }> {
    const chains = new FillerChains({ [chain]: [httpRpc(stand.rpcUrlHost)] }, { [chain]: policy() }, logger);
    const updates: RouterEventUpdate[] = [];
    await new RouterEventWatcher({ client: chains.get(chain)!.client, router: stand.contracts.CancoreRouter, confirmations: 0, fromBlock: BigInt(stand.deployBlock), onUpdate: (u) => void updates.push(u), logger }).poll();
    const opened = updates.find((u) => u.log.name === 'IntentOpened' && updates.some((s) => s.log.name === 'Settled' && s.log.orderHash === u.log.orderHash));
    if (!opened) throw new Error('no settled intent on the stand router: run `make intent-smoke` first');
    const raw = opened.log.args.order as Record<string, unknown>;
    const order = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === 'bigint' ? decimal(v) : v])) as unknown as OrderJson;
    return { order, orderHash: opened.log.orderHash };
  }

  function policy() {
    return { router: stand.contracts.CancoreRouter, openConfirmations: 0, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 60, sendGuardSec: 30, minGasWei: 0n };
  }

  async function verify(order: OrderJson, orderHash: Hex) {
    const fillDeadline = BigInt(order.fillDeadline);
    const clock = new FakeClock(Number(fillDeadline - 400n) * 1000);
    const offer: TicketOffer = {
      type: 'ticket.offer', fillerId: 'acme-1', sentAt: clock.now(), sig: '0x', orderHash, attempt: 0, order, amountOut: order.minReceived,
      validFrom: String(fillDeadline - 400n), validUntil: String(fillDeadline - 100n), acceptBy: clock.now() + 5_000,
    };
    const ticket = { orderHash, filler: fill.address, attempt: 0, validFrom: offer.validFrom, validUntil: offer.validUntil };
    const ticketSig = await ticketSigner.signTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: ticket });
    const issued = { type: 'ticket.issued', form: 'evm', fillerId: 'acme-1', sentAt: clock.now(), sig: '0x', orderHash, attempt: 0, ticket, ticketSig } as unknown as TicketIssuedEvm;
    const chains = new FillerChains({ [chain]: [httpRpc(stand.rpcUrlHost)] }, { [chain]: policy() }, logger);
    const verifier = new TicketVerifier({ chains, fillSigners: { [chain]: fill }, ticketSigners: [ticketSigner.address], deltaIssueMs: 3_000, clock, events: createRecordingEventSink(), logger });
    return verifier.verify({ offer, issued, issuedAtMs: clock.now() });
  }

  test('V-E1 holds against the real router domain; the settled escrow is ESCROW_NOT_OPEN', async () => {
    const { order, orderHash } = await smokeOrder();
    const result = await verify(order, orderHash);
    expect(result.checks.find((c) => c.check === 'V-E1')).toMatchObject({ status: 'passed' });
    expect(result).toMatchObject({ ok: false, reason: 'ESCROW_NOT_OPEN' });
  });

  test('one order field changed: ESCROW_MISMATCH', async () => {
    const { order, orderHash } = await smokeOrder();
    const result = await verify({ ...order, minReceived: String(BigInt(order.minReceived) + 1n) }, orderHash);
    expect(result).toMatchObject({ ok: false, reason: 'ESCROW_MISMATCH' });
  });

  test('an order that was never opened: ESCROW_NOT_OPEN', async () => {
    const { order } = await smokeOrder();
    const fresh: OrderJson = { ...order, createdAt: String(BigInt(order.createdAt) + 1n) };
    const { hashOrder } = await import('../src/filler/chain');
    const orderHash = hashOrder(fresh, { chainId: stand.chainId, router: stand.contracts.CancoreRouter });
    await expect(verify(fresh, orderHash)).resolves.toMatchObject({ ok: false, reason: 'ESCROW_NOT_OPEN' });
  });
});
