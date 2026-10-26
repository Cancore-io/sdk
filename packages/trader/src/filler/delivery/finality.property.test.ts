import { FILL_TICKET_DOMAIN, FILL_TICKET_TYPES, fillerIdHash, repayToFromEvm, type Hex, type OrderJson, type TicketJson } from '@cancore/contracts';
import { ChainClient, FillerChains, fillDepth, hashOrder, readAtDepth, type ChainConfig, type OpenDepth } from '../chain';
import type { TicketRecord } from '../store';
import { createRecordingEventSink, createRecordingLogger, createTestFillSigner, createTestTypedDataSigner, FakeChain, FakeClock, InMemoryFillerStore } from '../testing';
import { Executor, type DeliveryOptions } from './executor';

/** Fixed, so a failing draw replays from the seed its message prints. */
const SEED = 0xca2893;
const PURE_DRAWS = 200;
const DELIVERY_DRAWS = 12;

type Rng = () => number;

function seededRandom(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rng: Rng, low: number, high: number): number => low + Math.floor(rng() * (high - low + 1));
const chance = (rng: Rng, probability: number): boolean => rng() < probability;
const pick = <T>(rng: Rng, items: readonly T[]): T => items[between(rng, 0, items.length - 1)]!;

async function forDraws(draws: number, check: (rng: Rng) => void | Promise<void>): Promise<void> {
  const rng = seededRandom(SEED);
  for (let draw = 0; draw < draws; draw++) {
    try {
      await check(rng);
    } catch (error) {
      throw new Error(`seed 0x${SEED.toString(16)}, draw ${draw}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Finality is monotone: once met, a later head or tag cannot unmeet the depth. */
const risesOnce = (verdicts: readonly boolean[]): boolean => {
  const first = verdicts.indexOf(true);
  return first < 0 || verdicts.slice(first).every(Boolean);
};

const ascending = (values: readonly bigint[]): bigint[] => [...values].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

const DST = 'eip155:1' as const;
const DST_ROUTER: Hex = '0x1111111111111111111111111111111111111111';
const BASE_CHAIN: ChainConfig = { router: DST_ROUTER, openConfirmations: 3, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30, minGasWei: 0n };
const chainWith = (openConfirmations: OpenDepth, fillConfirmations?: number): ChainConfig => ({ ...BASE_CHAIN, openConfirmations, fillConfirmations });

describe('fillDepth', () => {
  test('CAN-2893: fillDepth never reads below one confirmation, whatever integer the config holds, with or without fillConfirmations (RX-1)', async () => {
    await forDraws(PURE_DRAWS, (rng) => {
      const zeroOrNegative = -between(rng, 0, 50);
      expect(fillDepth(chainWith(zeroOrNegative))).toBe(1);
      expect(fillDepth(chainWith(3, zeroOrNegative))).toBe(1);
      const positive = between(rng, 1, 50);
      expect(fillDepth(chainWith(positive))).toBe(positive);
    });
  });

  test('CAN-2893: fillDepth reads fillConfirmations when it is set (0 included), else openConfirmations; a tag passes through', async () => {
    await forDraws(PURE_DRAWS, (rng) => {
      const open: OpenDepth = chance(rng, 0.4) ? pick(rng, ['safe', 'finalized'] as const) : between(rng, 0, 12);
      const fill = chance(rng, 0.5) ? undefined : between(rng, 0, 12);
      const source = fill ?? open;
      expect(fillDepth(chainWith(open, fill))).toBe(typeof source === 'number' ? Math.max(1, source) : source);
    });
  });
});

describe('readAtDepth', () => {
  test('CAN-2893: readAtDepth names N confirmations as N; the client reads head − (N − 1) for them, and at t = h − d + 1 the numeric and the tag read agree', async () => {
    await forDraws(PURE_DRAWS, async (rng) => {
      const head = BigInt(between(rng, 30, 300));
      const depth = between(rng, 1, 20);
      const tag = pick(rng, ['safe', 'finalized'] as const);
      const boundaryBlock = head - BigInt(depth) + 1n;
      const chain = new FakeChain(1n);
      chain.head = head;
      chain[tag] = boundaryBlock;
      const client = new ChainClient({ chain: DST, endpoints: [chain], maxHeadLagBlocks: 5, logger: createRecordingLogger() });
      expect(readAtDepth(depth)).toEqual({ confirmations: depth });
      expect(readAtDepth(tag)).toBe(tag);
      expect(await client.resolve(readAtDepth(depth))).toBe(boundaryBlock);
      expect(await client.resolve(readAtDepth(tag))).toBe(boundaryBlock);
    });
  });
});

const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TICKET_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const SRC_ROUTER: Hex = '0x5656565656565656565656565656565656565656';
const TOKEN: Hex = '0x00000000000000000000000000000000000000aa';
const RECIPIENT: Hex = `0x${'0b'.repeat(20)}`;
const FILLER = 'acme-1';
const fillSigner = createTestFillSigner(FILL_KEY);
const ticketSigner = createTestTypedDataSigner(TICKET_KEY);
const TIMING: DeliveryOptions = { pollIntervalMs: 1_000, replaceAfterMs: 10_000, nonceLeaseTtlMs: 5_000 };

/** The delivery world of executor.test.ts, copied: that file does not export it, and this change adds one file only. */
async function deliveryWorld(chain: ChainConfig) {
  const clock = new FakeClock();
  const nowS = BigInt(Math.floor(clock.now() / 1000));
  const dst = new FakeChain(1n, 'eth');
  dst.setTimestamp(dst.head, nowS);
  dst.blockTime = 1n;
  const store = new InMemoryFillerStore(clock);
  const order: OrderJson = {
    user: '0x2222222222222222222222222222222222222222',
    originChainId: '56',
    inputToken: '0x0000000000000000000000000000000000000056',
    inputAmount: '105',
    destination: `0x${'00'.repeat(31)}01`,
    outputAsset: `0x${'00'.repeat(12)}${TOKEN.slice(2)}`,
    minReceived: '99',
    recipient: `0x${'00'.repeat(12)}${RECIPIENT.slice(2)}`,
    createdAt: String(nowS - 60n),
    fillDeadline: String(nowS + 3_600n),
    feeBps: '500',
    fillerId: fillerIdHash(FILLER),
  };
  const orderHash = hashOrder(order, { chainId: 56n, router: SRC_ROUTER });
  const ticket: TicketJson = {
    orderHash,
    fillerId: fillerIdHash(FILLER),
    deliveryKey: fillSigner.address.toLowerCase() as Hex,
    repayTo: repayToFromEvm(fillSigner.address),
    attempt: 0,
    validFrom: String(nowS - 5n),
    validUntil: String(nowS + 300n),
  };
  const ticketSig = await ticketSigner.signTypedData({ domain: FILL_TICKET_DOMAIN, types: FILL_TICKET_TYPES, primaryType: 'FillTicket', message: { ...ticket } });
  const record: TicketRecord = {
    orderHash,
    attempt: 0,
    state: 'receipted',
    offer: { type: 'ticket.offer', id: 'o1', fillerId: FILLER, sentAt: clock.now(), sig: '0x', orderHash, attempt: 0, order, amountOut: '100', validFrom: ticket.validFrom, validUntil: ticket.validUntil, acceptBy: clock.now() } as never,
    issued: { type: 'ticket.issued', id: 'i1', fillerId: FILLER, sentAt: clock.now(), sig: '0x', form: 'evm', orderHash, attempt: 0, ticket, ticketSig } as never,
    receipt: { type: 'ticket.receipt', id: 'r1' } as never,
    sentAtMs: clock.now(),
    updatedAtMs: clock.now(),
  };
  await store.withOrder(orderHash, (tx) => tx.putTicket(record));
  dst.router(DST_ROUTER);
  dst.token(TOKEN).setBalance(fillSigner.address, 1_000n).approve(fillSigner.address, DST_ROUTER, 1_000n);
  const logger = createRecordingLogger();
  const chains = new FillerChains({ [DST]: [dst] }, { [DST]: chain }, logger);
  const receipted = async (hash: Hex, attempt: number): Promise<TicketRecord | undefined> => {
    const r = await store.withOrder(hash, (tx) => tx.getTicket(attempt));
    return r?.state === 'receipted' && r.sentAtMs !== undefined && r.receipt ? r : undefined;
  };
  const executor = new Executor({ store, chains, fillSigners: { [DST]: fillSigner }, fillerId: FILLER, receipted, instanceId: 'r1', clock, logger, events: createRecordingEventSink(), delivery: TIMING });
  return { dst, store, clock, executor, orderHash };
}

type DeliveryWorld = Awaited<ReturnType<typeof deliveryWorld>>;

const flush = async () => {
  for (let i = 0; i < 80; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function deliverOnce(w: DeliveryWorld): Promise<Hex> {
  await w.executor.start();
  const result = await w.executor.deliver(w.orderHash, 0);
  expect(result).toMatchObject({ status: 'sent' });
  return result.txHash!;
}

/** The tag is set after the mine and before the poll, so one poll sees one head and one tag. */
async function step(w: DeliveryWorld, setTag?: () => void): Promise<boolean> {
  w.dst.mine();
  setTag?.();
  w.clock.advance(1_000);
  await flush();
  const fill = await w.store.withOrder(w.orderHash, (tx) => tx.getFill(0));
  return fill?.state === 'confirmed';
}

const includedBlock = (w: DeliveryWorld, txHash: Hex): bigint => w.dst.minedTransactions.get(txHash)!.blockNumber;

describe('delivery finality through Executor', () => {
  test('CAN-2893: a numeric depth d is met at head h exactly when h − b + 1 ≥ d, and once met stays met', async () => {
    await forDraws(DELIVERY_DRAWS, async (rng) => {
      const depth = between(rng, 1, 6);
      const w = await deliveryWorld(chainWith(depth));
      const txHash = await deliverOnce(w);
      const met: boolean[] = [];
      const heads: bigint[] = [];
      for (let i = 0; i < depth + 3; i++) {
        met.push(await step(w));
        heads.push(w.dst.head);
      }
      const b = includedBlock(w, txHash);
      expect(met).toEqual(heads.map((h) => h - b + 1n >= BigInt(depth)));
      expect(risesOnce(met)).toBe(true);
      w.executor.stop();
    });
  }, 60_000);

  test.each(['safe', 'finalized'] as const)('CAN-2893: a %s tag is met exactly when the inclusion block b is at or below its block t: b = t is met, b = t + 1 is not', async (tag) => {
    await forDraws(DELIVERY_DRAWS, async (rng) => {
      const w = await deliveryWorld(chainWith(tag));
      w.dst[tag] = 0n;
      const txHash = await deliverOnce(w);
      expect(await step(w)).toBe(false);
      const b = includedBlock(w, txHash);
      const schedule = ascending([b - 1n, b, ...Array.from({ length: 3 }, () => b + BigInt(between(rng, -3, 3)))]);
      const met: boolean[] = [];
      for (const t of schedule) met.push(await step(w, () => (w.dst[tag] = t)));
      expect(met).toEqual(schedule.map((t) => b <= t));
      expect(risesOnce(met)).toBe(true);
      w.executor.stop();
    });
  }, 60_000);

  test.each(['safe', 'finalized'] as const)('CAN-2893: the numeric and the %s verdicts agree at t = h − d + 1, for every head and inclusion block', async (tag) => {
    await forDraws(DELIVERY_DRAWS, async (rng) => {
      const depth = between(rng, 1, 6);
      const numeric = await deliveryWorld(chainWith(depth));
      const byTag = await deliveryWorld(chainWith(tag));
      const numericTx = await deliverOnce(numeric);
      const tagTx = await deliverOnce(byTag);
      const numericMet: boolean[] = [];
      const tagMet: boolean[] = [];
      for (let i = 0; i < depth + 3; i++) {
        numericMet.push(await step(numeric));
        tagMet.push(await step(byTag, () => (byTag.dst[tag] = byTag.dst.head - BigInt(depth) + 1n)));
      }
      expect(includedBlock(byTag, tagTx)).toBe(includedBlock(numeric, numericTx));
      expect(tagMet).toEqual(numericMet);
      numeric.executor.stop();
      byTag.executor.stop();
    });
  }, 60_000);
});
