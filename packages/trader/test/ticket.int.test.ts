/**
 * The ticket flow against the real filler-gateway (backend apps/filler-gateway,
 * CAN-1917): login, `ticket.offer` → `ticket.intent` → `ticket.intent.ack` →
 * `ticket.issued` → checks → `ticket.receipt`, and an offer declined by the
 * hook. filler-gateway takes its ticket commands from `trading` over the Redis
 * Stream `intent:tickets`; this test plays `trading` there (XADD) and reads
 * filler-gateway's answers on `intent:ticket-events`. The chains are a
 * `FakeChain` with the escrow open — live chain state is CAN-1862's stand.
 *
 * Stand contract (all test values, never real keys):
 *   FILLER_GATEWAY_URL        ws://<host>:3107/v1
 *   FILLER_GATEWAY_REDIS_URL  redis://<host>:6379 — the Redis filler-gateway reads its streams from
 *   FILLER_GATEWAY_FILLER_ID  a filler registered with the quote key and filler address below
 *                             (quote key 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 = QUOTE_KEY,
 *                             filler address 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 = FILL_KEY, chain `*`)
 *   and FILLER_GATEWAY_TICKET_SIGNERS containing 0x90f79bf6eb2c4f870365e785982e1f101e93b906 (TICKET_KEY).
 *
 *   FILLER_GATEWAY_URL=… FILLER_GATEWAY_REDIS_URL=… FILLER_GATEWAY_FILLER_ID=… npm run test:int
 *
 * Skipped without them: neither this repository's CI nor this laptop runs the
 * stand (CAN-1876 puts filler-gateway into CI).
 */
import { connect } from 'node:net';
import { FILL_TICKET_DOMAIN, FILL_TICKET_TYPES, type Hex, type OrderJson } from '@cancore/contracts';
import { hashOrder } from '../src/filler/chain';
import { createFiller, type Filler, type TicketOfferDecision } from '../src/filler/filler';
import type { WebSocketFactory } from '../src/filler/runtime';
import type { FillSigner } from '../src/filler/signer';
import { createRecordingLogger, createTestTypedDataSigner, FakeChain, InMemoryFillerStore } from '../src/filler/testing';

const WS_URL = process.env.FILLER_GATEWAY_URL;
const REDIS_URL = process.env.FILLER_GATEWAY_REDIS_URL;
const FILLER_ID = process.env.FILLER_GATEWAY_FILLER_ID;
const live = WS_URL && REDIS_URL && FILLER_ID && typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function' ? describe : describe.skip;

// The anvil/hardhat default test keys.
const QUOTE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TICKET_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const SRC_ROUTER: Hex = '0x5656565656565656565656565656565656565656';
const DST_ROUTER: Hex = '0x1111111111111111111111111111111111111111';
const TOKEN: Hex = '0x00000000000000000000000000000000000000aa';

// -- A Redis client of four commands, in RESP over a socket -------------------

type Resp = string | number | null | Resp[];

function redis(url: string, ...args: string[]): Promise<Resp> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port || 6379), hostname);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      try {
        const [value, rest] = parse(buffer);
        if (rest !== undefined) {
          socket.end();
          resolve(value);
        }
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
    socket.on('error', reject);
    socket.write(`*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`);
  });
}

/** One RESP value from the front of `text`; `rest` undefined while incomplete. */
function parse(text: string): [Resp, string | undefined] {
  const line = text.indexOf('\r\n');
  if (line < 0) return [null, undefined];
  const head = text.slice(1, line);
  const after = text.slice(line + 2);
  switch (text[0]) {
    case '+':
      return [head, after];
    case '-':
      throw new Error(`redis: ${head}`);
    case ':':
      return [Number(head), after];
    case '$': {
      const n = Number(head);
      if (n < 0) return [null, after];
      if (Buffer.byteLength(after) < n + 2) return [null, undefined];
      return [after.slice(0, n), after.slice(n + 2)];
    }
    case '*': {
      const n = Number(head);
      const items: Resp[] = [];
      let rest: string | undefined = after;
      for (let i = 0; i < n; i++) {
        if (rest === undefined) return [null, undefined];
        const [item, next]: [Resp, string | undefined] = parse(rest);
        if (next === undefined) return [null, undefined];
        items.push(item);
        rest = next;
      }
      return [items, rest];
    }
    default:
      throw new Error(`redis: unexpected reply ${text.slice(0, 20)}`);
  }
}

/** The `ticket.*` events filler-gateway published for `orderHash` since `fromId`. */
async function ticketEvents(orderHash: Hex, fromId: string): Promise<Array<{ kind: string; data: Record<string, unknown> }>> {
  const entries = (await redis(REDIS_URL!, 'XRANGE', 'intent:ticket-events', fromId, '+')) as Array<[string, string[]]>;
  return entries
    .map(([, fields]) => {
      const record: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) record[fields[i]!] = fields[i + 1]!;
      return { kind: record.kind ?? '', data: JSON.parse(record.data ?? 'null') as Record<string, unknown> };
    })
    .filter((e) => String(e.data?.orderHash ?? '').toLowerCase() === orderHash.toLowerCase());
}

const until = async (what: string, condition: () => Promise<boolean>, timeoutMs = 15_000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out: ${what}`);
};

const globalWebSocket: WebSocketFactory = (url, h) => {
  const Ws = (globalThis as unknown as { WebSocket: new (url: string) => { onopen: () => void; onmessage: (e: { data: unknown }) => void; onclose: (e: { code: number; reason: string }) => void; onerror: (e: unknown) => void; send(t: string): void; close(c?: number, r?: string): void } }).WebSocket;
  const ws = new Ws(url);
  ws.onopen = () => h.onOpen();
  ws.onmessage = (e) => typeof e.data === 'string' && h.onMessage(e.data);
  ws.onclose = (e) => h.onClose(e.code, e.reason);
  ws.onerror = (e) => h.onError(e);
  return { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) };
};

live('the ticket flow against the real filler-gateway', () => {
  const fill: FillSigner = { ...createTestTypedDataSigner(FILL_KEY), signTransaction: async () => '0x02' };
  const ticketSigner = createTestTypedDataSigner(TICKET_KEY);

  async function start(decide: () => Promise<TicketOfferDecision>) {
    const httpBase = WS_URL!.replace(/^ws/, 'http').replace(/\/v1\/?$/, '');
    const info = (await (await fetch(`${httpBase}/v1/gateway`)).json()) as { gateway: Hex };
    const nowS = BigInt(Math.floor(Date.now() / 1000));
    const order: OrderJson = {
      user: '0x2222222222222222222222222222222222222222',
      originChainId: '56',
      inputToken: '0x0000000000000000000000000000000000000056',
      inputAmount: '105',
      destination: `0x${'00'.repeat(31)}01`,
      outputAsset: `0x${'00'.repeat(12)}${TOKEN.slice(2)}`,
      minReceived: '99',
      recipient: `0x${'00'.repeat(12)}${'0b'.repeat(20)}`,
      createdAt: String(nowS),
      fillDeadline: String(nowS + 900n),
      feeBps: '500',
    };
    const orderHash = hashOrder(order, { chainId: 56n, router: SRC_ROUTER });
    const src = new FakeChain(56n, 'bsc');
    const dst = new FakeChain(1n, 'eth');
    src.router(SRC_ROUTER).openIntent(orderHash, { refundAfter: nowS + 900n + 3_600n, openedAt: nowS, atBlock: 90n });
    dst.router(DST_ROUTER).ticketSigners.add(ticketSigner.address);
    dst.token(TOKEN).setBalance(fill.address, 1_000n).approve(fill.address, DST_ROUTER, 1_000n);
    dst.nativeBalances.set(fill.address.toLowerCase(), 10n ** 18n);
    const policy = { openConfirmations: 3, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30, minGasWei: 10n ** 15n };
    const store = new InMemoryFillerStore();
    const filler: Filler = createFiller({
      gatewayUrl: WS_URL!,
      fillerId: FILLER_ID!,
      gatewaySigner: info.gateway,
      ticketSigners: [ticketSigner.address],
      quoteSigner: createTestTypedDataSigner(QUOTE_KEY),
      fillSigners: { 'eip155:1': fill },
      rpc: { 'eip155:56': [src], 'eip155:1': [dst] },
      chains: { 'eip155:56': { router: SRC_ROUTER, ...policy }, 'eip155:1': { router: DST_ROUTER, ...policy } },
      tickets: { deltaIssueMs: 3_000 },
      store,
      webSocket: globalWebSocket,
      logger: createRecordingLogger(),
    });
    filler.onQuoteRequest(async () => null);
    filler.onReconfirm(async () => false);
    filler.onTicketOffer(decide);
    await filler.start();

    const validFrom = nowS;
    const validUntil = nowS + 300n;
    const ticket = { orderHash, filler: fill.address, attempt: 0, validFrom: String(validFrom), validUntil: String(validUntil) };
    const ticketSig = await ticketSigner.signTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: ticket });
    const fromId = String(Date.now() - 1);
    const command = {
      fillerId: FILLER_ID,
      fillerAddress: fill.address,
      orderHash,
      attempt: 0,
      order,
      amountOut: '99',
      validFrom: String(validFrom),
      validUntil: String(validUntil),
      acceptBy: Date.now() + 10_000,
      destination: 'eip155:1',
      form: 'evm',
      issueOnIntent: true,
      ticketSig,
    };
    await redis(REDIS_URL!, 'XADD', 'intent:tickets', '*', 'kind', 'ticket.offer', 'data', JSON.stringify(command));
    const record = () => store.withOrder(orderHash, (tx) => tx.getTicket(0));
    return { filler, orderHash, fromId, record };
  }

  test('offer → intent → ack → issued → checks → receipt, accepted by filler-gateway', async () => {
    const run = await start(async () => 'accept');
    try {
      await until('the receipt went out', async () => (await run.record())?.state === 'receipted' && (await run.record())?.sentAtMs !== undefined);
      const stored = await run.record();
      expect(stored?.intentAck).toBeDefined();
      await until('filler-gateway recorded the receipt', async () => (await ticketEvents(run.orderHash, run.fromId)).some((e) => e.kind === 'ticket.receipt'));
      const kinds = (await ticketEvents(run.orderHash, run.fromId)).map((e) => e.kind);
      expect(kinds).toEqual(expect.arrayContaining(['ticket.offered', 'ticket.intent', 'ticket.issued', 'ticket.receipt']));
      expect(kinds).not.toContain('ticket.declined');
    } finally {
      await run.filler.stop();
    }
  });

  test('the hook declines: ticket.decline reaches filler-gateway with the reason, no intent', async () => {
    const run = await start(async () => ({ decline: 'RISK_LIMIT' }));
    try {
      await until('filler-gateway recorded the decline', async () => (await ticketEvents(run.orderHash, run.fromId)).some((e) => e.kind === 'ticket.declined'));
      const events = await ticketEvents(run.orderHash, run.fromId);
      expect(events.find((e) => e.kind === 'ticket.declined')?.data).toMatchObject({ reason: 'RISK_LIMIT' });
      expect(events.map((e) => e.kind)).not.toContain('ticket.intent');
      expect((await run.record())?.state).toBe('declined');
    } finally {
      await run.filler.stop();
    }
  });
});
