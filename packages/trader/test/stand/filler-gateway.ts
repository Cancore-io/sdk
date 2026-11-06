/**
 * The intent stand as the filler-gateway specs drive it (Cancore-io/meta docs/runbooks/intent-stand.md): the real
 * filler-gateway, its Redis and anvil with the stand's CancoreRouter. A spec plays `trading` where it needs an
 * offer, an issue or an expiry nothing else would send: filler-gateway reads its commands from the Redis Streams
 * `intent:quote-requests` and `intent:tickets` and answers on `intent:quotes` and `intent:ticket-events`
 * (backend libs/common intents/filler-gateway-commands.ts). Every order such a spec makes up names the stand
 * filler and is never opened unless the spec opens it: trading ignores what it did not ticket.
 *
 * One SDK filler per spec at a time: each logs in as STAND_FILLER_ID and stops before the next starts.
 */
import { connect } from 'node:net';
import {
  CANCORE_ROUTER_ABI,
  encodeCantonAmount,
  encodeCantonDestination,
  encodeCantonOutputAsset,
  encodeCantonRecipient,
  FILL_TICKET_DOMAIN,
  FILL_TICKET_TYPES,
  fillerIdHash,
  hashPermitWitness,
  QUOTE_TYPES,
  routerDomain,
  type Hex,
  type OrderJson,
  type TicketIntentMessage,
} from '@cancore/contracts';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import type { CantonTransferFactory } from '../../src/filler/canton/factories';
import { encodeFunctionCall, entryOf, type AbiEntry } from '../../src/filler/chain/abi';
import { hashOrder } from '../../src/filler/chain/hashes';
import type { EvmChainId } from '../../src/filler/chains';
import { createFiller, type Filler, type QuoteRequestHook, type ReconfirmHook, type TicketOfferHook } from '../../src/filler/filler';
import type { EvmRpc } from '../../src/filler/rpc';
import type { WebSocketFactory } from '../../src/filler/runtime';
import { createRecordingEventSink, createRecordingLogger, createTestFillSigner, createTestTypedDataSigner, InMemoryFillerStore } from '../../src/filler/testing';
import { env } from './canton-ledger';

export const STAND = process.env.INTENT_STAND_ENV;

/** What every filler-gateway spec reads. */
export const GATEWAY_KEYS = [
  'CANTON_CHAIN', 'CANTON_PARTICIPANT_UID', 'CANTON_PROOF_WINDOW_S', 'CANTON_TRANSFER_FACTORIES_JSON', 'CNRX_ADMIN_PARTY',
  'EVM_CHAIN_ID', 'EVM_RPC_URL', 'FILLER_GATEWAY_SIGNER', 'FILLER_GATEWAY_URL', 'FILLER_GATEWAY_WS_URL', 'INPUT_TOKEN_ADDRESS', 'INTENT_ROUTER_ADDRESS',
  'MAKER_EVM_ADDRESS', 'STAND_CANTON_RECIPIENT_PARTY', 'STAND_FILLER_CANTON_PARTY', 'STAND_FILLER_CANTON_PARTY_KEY', 'STAND_FILLER_EVM_KEY',
  'STAND_FILLER_ID', 'STAND_FILLER_MESSAGE_KEY', 'TICKET_SIGNERS',
] as const;

/**
 * A suite of the intent stand: skipped without INTENT_STAND_ENV, failed naming every missing key when the stand is
 * named but its env is incomplete — on the stand a skip is never a pass.
 */
export function standSuite(name: string, keys: readonly string[], body: () => void): void {
  describe(name, () => {
    if (!STAND) {
      test.skip(`${name}: needs the intent stand (INTENT_STAND_ENV)`, () => undefined);
      return;
    }
    const missing = keys.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      test(`${name}: the intent-stand env is complete`, () => {
        throw new Error(`INTENT_STAND_ENV is set but the stand env lacks: ${missing.join(', ')}`);
      });
      return;
    }
    body();
  });
}

export const standChain = (): EvmChainId => `eip155:${env('EVM_CHAIN_ID')}` as EvmChainId;
export const standRouter = (): Hex => env('INTENT_ROUTER_ADDRESS').toLowerCase() as Hex;
export const gatewayHttp = (): string => env('FILLER_GATEWAY_URL').replace(/^ws/, 'http').replace(/\/v1\/?$/, '');

export const httpRpc = (url: string): EvmRpc => {
  let id = 0;
  return {
    label: 'stand-anvil',
    async request<T>({ method, params = [] }: { method: string; params?: readonly unknown[] }): Promise<T> {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      const body = (await response.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
      if (body.error) throw body.error;
      return body.result as T;
    },
  };
};

export const nativeWebSocket: WebSocketFactory = (url, h, protocols) => {
  const ws = new WebSocket(url, [...protocols]);
  ws.addEventListener('open', () => h.onOpen());
  ws.addEventListener('message', (e) => void (typeof e.data === 'string' ? h.onMessage(e.data) : undefined));
  ws.addEventListener('close', (e) => h.onClose(e.code, e.reason));
  ws.addEventListener('error', (e) => h.onError(e));
  return { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) };
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until<T>(what: string, read: () => Promise<T | undefined>, timeoutMs = 60_000, diagnostics: () => string = () => ''): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${diagnostics()}`);
    await sleep(500);
  }
}

// -- Redis: the streams filler-gateway reads and writes -------------------------------------------

export const STREAMS = { quoteRequests: 'intent:quote-requests', tickets: 'intent:tickets', quotes: 'intent:quotes', ticketEvents: 'intent:ticket-events' } as const;
type Resp = string | number | null | Resp[];

/** The stand publishes its Redis on the runner's loopback (compose REDIS_HOST_PORT); STAND_REDIS_URL names another. */
const redisUrl = () => process.env.STAND_REDIS_URL || 'redis://127.0.0.1:6379';

function redis(...args: string[]): Promise<Resp> {
  const { hostname, port, password } = new URL(redisUrl());
  const commands = [...(password ? [['AUTH', decodeURIComponent(password)]] : []), args];
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port || 6379), hostname);
    let buffer = '';
    const replies: Resp[] = [];
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      try {
        for (;;) {
          const [value, rest] = parse(buffer);
          if (rest === undefined) return;
          replies.push(value);
          buffer = rest;
          if (replies.length === commands.length) {
            socket.end();
            resolve(replies.at(-1)!);
            return;
          }
        }
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
    socket.on('error', reject);
    socket.write(commands.map((c) => `*${c.length}\r\n${c.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`).join(''));
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
      if (n < 0) return [null, after];
      const items: Resp[] = [];
      let rest: string | undefined = after;
      for (let i = 0; i < n; i++) {
        const [item, next]: [Resp, string | undefined] = parse(rest!);
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

/** A command to filler-gateway, as trading writes it. */
export async function command(stream: typeof STREAMS.quoteRequests | typeof STREAMS.tickets, kind: string, data: unknown): Promise<void> {
  await redis('XADD', stream, '*', 'kind', kind, 'data', JSON.stringify(data));
}

/** The id of the newest entry of `stream`: the events a spec waits for come after it. */
export async function cursor(stream: string): Promise<string> {
  const last = (await redis('XREVRANGE', stream, '+', '-', 'COUNT', '1')) as Array<[string, string[]]> | null;
  return last?.[0]?.[0] ?? '0-0';
}

export interface StreamEvent {
  kind: string;
  data: Record<string, unknown>;
}

/** Every event of `stream` after `from` that `match` keeps. */
export async function eventsAfter(stream: string, from: string, match: (e: StreamEvent) => boolean = () => true): Promise<StreamEvent[]> {
  const entries = ((await redis('XRANGE', stream, `(${from}`, '+')) as Array<[string, string[]]> | null) ?? [];
  return entries
    .map(([, fields]) => {
      const record: Record<string, string> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) record[fields[i]!] = fields[i + 1]!;
      return { kind: record.kind ?? '', data: JSON.parse(record.data ?? 'null') as Record<string, unknown> };
    })
    .filter(match);
}

export const ofOrder = (orderHash: Hex) => (e: StreamEvent) => String(e.data?.orderHash ?? '').toLowerCase() === orderHash.toLowerCase();

// -- Orders and commands ---------------------------------------------------------------------------

/**
 * An EVM → Canton order of the stand's one route that names `fillerId` (the stand filler by default), with its hash
 * in the stand router's domain; never opened. `salt` keeps orders apart within a run, the clock across runs.
 */
export function standOrder(salt: number, fillerId = env('STAND_FILLER_ID')): { order: OrderJson; orderHash: Hex; nowS: number } {
  const nowS = Math.floor(Date.now() / 1000);
  const order: OrderJson = {
    user: env('MAKER_EVM_ADDRESS').toLowerCase() as Hex,
    originChainId: env('EVM_CHAIN_ID'),
    inputToken: env('INPUT_TOKEN_ADDRESS').toLowerCase() as Hex,
    inputAmount: String(10n ** 19n + BigInt(Date.now()) * 1000n + BigInt(salt)),
    destination: encodeCantonDestination('devnet'),
    outputAsset: encodeCantonOutputAsset({ admin: env('CNRX_ADMIN_PARTY'), id: 'CNRX' }),
    minReceived: encodeCantonAmount('5').toString(),
    recipient: encodeCantonRecipient(env('STAND_CANTON_RECIPIENT_PARTY')),
    createdAt: String(nowS - 5),
    fillDeadline: String(nowS + 1_800),
    feeBps: '30',
    fillerId: fillerIdHash(fillerId),
  };
  return { order, orderHash: hashOrder(order, { chainId: BigInt(env('EVM_CHAIN_ID')), router: standRouter() }), nowS };
}

/** An EVM → EVM order on the stand chain with an EVM-form ticket, what the SDK reads on the stand router; never opened. */
export function standEvmOrder(salt: number): { order: OrderJson; orderHash: Hex; nowS: number } {
  const { nowS, order: base } = standOrder(salt);
  const order: OrderJson = {
    ...base,
    destination: `0x${BigInt(env('EVM_CHAIN_ID')).toString(16).padStart(64, '0')}` as Hex,
    outputAsset: `0x${'00'.repeat(12)}${env('INPUT_TOKEN_ADDRESS').slice(2).toLowerCase()}` as Hex,
    recipient: `0x${'00'.repeat(12)}${'61'.repeat(20)}` as Hex,
  };
  return { nowS, order, orderHash: hashOrder(order, { chainId: BigInt(env('EVM_CHAIN_ID')), router: standRouter() }) };
}

/** The stand's ticket signer: anvil's default mnemonic, index 16 (TICKETSIGNER of the runbook) — a test key. */
export const STAND_TICKET_SIGNER_KEY: Hex = '0xea6c44ac03bff858b476bba40716402b03e41b8e97e276d1baec7c37d42484a0';

/**
 * Offers an EVM-form ticket of `o` to `s`, waits for the intent ack and issues the ticket signed by `signerKey`, as
 * trading would; returns the ticket-events cursor taken before the offer.
 */
export async function issueEvmTicket(s: StandFiller, o: { order: OrderJson; orderHash: Hex; nowS: number }, signerKey: Hex): Promise<string> {
  const from = await cursor(STREAMS.ticketEvents);
  await command(STREAMS.tickets, 'ticket.offer', offerCommand(o, { destination: standChain(), form: 'evm' }));
  const acked = await until('the intent acked', async () => {
    const t = await s.store.withOrder(o.orderHash, (tx) => tx.getTicket(0));
    return t?.intentAck ? t : undefined;
  }, 60_000, s.diagnostics);
  const intent = acked.intent as TicketIntentMessage;
  const fillTicket = {
    orderHash: o.orderHash, fillerId: fillerIdHash(env('STAND_FILLER_ID')), deliveryKey: intent.deliveryKey, repayTo: intent.repayTo, attempt: 0, validFrom: String(o.nowS), validUntil: String(o.nowS + 900),
  };
  const ticketSig = await createTestTypedDataSigner(signerKey).signTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: fillTicket });
  await command(STREAMS.tickets, 'ticket.issue', { orderHash: o.orderHash, attempt: 0, ticketSig, deliveryKey: intent.deliveryKey, repayTo: intent.repayTo });
  return from;
}

const signDigest = (key: Hex, digest: Hex): Hex => {
  const sig = secp256k1.sign(hexToBytes(digest.slice(2)), hexToBytes(key.slice(2)), { lowS: true });
  return `0x${bytesToHex(sig.toCompactRawBytes())}${(27 + sig.recovery).toString(16)}`;
};

/**
 * Opens `o` on the stand router as the maker (MAKER_EVM_KEY, Permit2-approved on the stand's test tokens) with a
 * quote of the stand's quote signer (QUOTE_SIGNER_KEY): the escrow a ticket's checks read past V-E2.
 */
export async function openOnStand(o: { order: OrderJson; orderHash: Hex }): Promise<void> {
  const rpc = httpRpc(env('EVM_RPC_URL'));
  const chainId = BigInt(env('EVM_CHAIN_ID'));
  const router = standRouter();
  const makerKey = env('MAKER_EVM_KEY') as Hex;
  const latest = BigInt((await rpc.request<{ timestamp: string }>({ method: 'eth_getBlockByNumber', params: ['latest', false] })).timestamp);
  const quoteDeadline = latest + 300n;
  const quoteSig = await createTestTypedDataSigner(env('QUOTE_SIGNER_KEY') as Hex).signTypedData({ domain: routerDomain(chainId, router), types: QUOTE_TYPES, primaryType: 'Quote', message: { orderHash: o.orderHash, quoteDeadline } });
  const permit = { permitted: { token: o.order.inputToken, amount: o.order.inputAmount }, nonce: BigInt(`0x${bytesToHex(keccak_256(utf8ToBytes(o.orderHash)))}`) >> 8n, deadline: o.order.fillDeadline };
  const permitSig = signDigest(makerKey, hashPermitWitness({ ...permit, spender: router, witness: o.order }, chainId, env('PERMIT2_ADDRESS') as Hex));
  const data = encodeFunctionCall(entryOf(CANCORE_ROUTER_ABI as unknown as readonly AbiEntry[], 'function', 'openFor'), [o.order, permit, permitSig, quoteDeadline, quoteSig]);
  const maker = createTestFillSigner(makerKey);
  const nonce = BigInt(await rpc.request<string>({ method: 'eth_getTransactionCount', params: [maker.address, 'pending'] }));
  const raw = await maker.signTransaction({ chainId, nonce, to: router, data, value: 0n, gasLimit: 1_500_000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
  const tx = await rpc.request<Hex>({ method: 'eth_sendRawTransaction', params: [raw] });
  const receipt = await until('the open mined', async () => (await rpc.request<{ status: string } | null>({ method: 'eth_getTransactionReceipt', params: [tx] })) ?? undefined, 60_000);
  if (receipt.status !== '0x1') throw new Error(`openFor of ${o.orderHash} reverted`);
}

/** `ticket.offer` of `order` as trading sends it after the pick: attempt 0, a 15 min ticket, 15 s to accept. */
export function offerCommand(o: { order: OrderJson; orderHash: Hex; nowS: number }, over: { attempt?: number; acceptBy?: number; fillerId?: string; destination?: string; form?: 'evm' | 'canton' } = {}) {
  return {
    fillerId: over.fillerId ?? env('STAND_FILLER_ID'),
    orderHash: o.orderHash,
    attempt: over.attempt ?? 0,
    order: o.order,
    amountOut: o.order.minReceived,
    validFrom: String(o.nowS),
    validUntil: String(o.nowS + 900),
    acceptBy: over.acceptBy ?? Date.now() + 15_000,
    destination: over.destination ?? env('CANTON_CHAIN'),
    form: over.form ?? 'canton',
  };
}

// -- The SDK filler on the stand's filler id -------------------------------------------------------

export interface StandFillerOptions {
  quote?: QuoteRequestHook;
  reconfirm?: ReconfirmHook;
  offer?: TicketOfferHook;
  /** Ticket signers the SDK pins; the stand's by default. */
  ticketSigners?: Hex[];
  /** The filler-gateway key the SDK pins; the stand's by default. */
  gatewaySigner?: Hex;
  /** EVM endpoints of the stand chain; anvil by default. */
  rpc?: EvmRpc[];
  store?: InMemoryFillerStore;
}

export interface StandFiller {
  filler: Filler;
  store: InMemoryFillerStore;
  events: ReturnType<typeof createRecordingEventSink>;
  logger: ReturnType<typeof createRecordingLogger>;
  /** The SDK's stages, declines and warnings, for a red run. */
  diagnostics: () => string;
}

/** The SDK filler as the stand provisions it (canton-delivery.stand.int.test.ts), with the spec's hooks; not started. */
export function standFiller(options: StandFillerOptions = {}): StandFiller {
  const chain = standChain();
  const store = options.store ?? new InMemoryFillerStore();
  const events = createRecordingEventSink();
  const logger = createRecordingLogger();
  const proofWindowSec = Number(env('CANTON_PROOF_WINDOW_S'));
  const seed = hexToBytes(env('STAND_FILLER_CANTON_PARTY_KEY').replace(/^0x/, ''));
  const filler = createFiller({
    gatewayUrl: env('FILLER_GATEWAY_WS_URL'),
    fillerId: env('STAND_FILLER_ID'),
    gatewaySigner: options.gatewaySigner ?? (env('FILLER_GATEWAY_SIGNER') as Hex),
    ticketSigners: options.ticketSigners ?? env('TICKET_SIGNERS').split(',').map((s) => s.trim() as Hex),
    quoteSigner: createTestTypedDataSigner(env('STAND_FILLER_MESSAGE_KEY') as Hex),
    fillSigners: { [chain]: createTestFillSigner(env('STAND_FILLER_EVM_KEY') as Hex) },
    rpc: { [chain]: options.rpc ?? [httpRpc(env('EVM_RPC_URL'))] },
    chains: { [chain]: { router: standRouter(), openConfirmations: 1, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: proofWindowSec, sendGuardSec: 10, minGasWei: 0n, fillConfirmations: 1 } },
    tickets: { deltaIssueMs: 3_000 },
    canton: {
      party: env('STAND_FILLER_CANTON_PARTY'),
      partySigner: { publicKey: `0x${bytesToHex(ed25519.getPublicKey(seed))}` as Hex, signHash: async (hash) => `0x${bytesToHex(ed25519.sign(hash, seed))}` as Hex },
      participantUid: env('CANTON_PARTICIPANT_UID'),
      destination: { minTicketTtlSec: 60, requiredProofWindowSec: proofWindowSec, sendGuardSec: 20 },
      registries: JSON.parse(env('CANTON_TRANSFER_FACTORIES_JSON')) as Record<string, CantonTransferFactory[]>,
    },
    store,
    webSocket: nativeWebSocket,
    logger,
    events,
  });
  filler.onQuoteRequest(options.quote ?? (async () => null));
  filler.onReconfirm(options.reconfirm ?? (async () => false));
  filler.onTicketOffer(options.offer ?? (async () => 'decline'));
  const diagnostics = () =>
    [
      ...events.events.filter((e) => e.type === 'stage' || e.type === 'declined').map((e) => JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
      ...logger.entries.filter((l) => l.level !== 'debug').slice(-40).map((l) => `${l.level} ${l.message} ${JSON.stringify(l.fields ?? {})}`),
    ].join('\n');
  return { filler, store, events, logger, diagnostics };
}
