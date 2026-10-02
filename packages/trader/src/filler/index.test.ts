import type { Hex, QuoteReconfirm, QuoteRequest, StakeBindingRequest, TicketIssued, TicketOffer } from '@cancore/contracts';
import {
  createFiller,
  FillerConfigError,
  NotImplementedError,
  type DrawVerification,
  type EscrowVerification,
  type Filler,
  type FillerConfig,
  type FillerStatsSnapshot,
  type FillSigner,
  type SelfSettleResult,
} from './index';
import { createFakeWebSocketFactory, createTestTypedDataSigner, FakeEvmRpc, InMemoryFillerStore } from './testing';

const QUOTE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const fillSigner = (key: Hex): FillSigner => ({
  ...createTestTypedDataSigner(key),
  signTransaction: async () => '0x02',
});

const baseConfig = (): FillerConfig => ({
  gatewayUrl: 'wss://filler-gateway.example/v1',
  fillerId: 'acme-1',
  gatewaySigner: '0x1111111111111111111111111111111111111111',
  ticketSigners: ['0x2222222222222222222222222222222222222222'],
  quoteSigner: createTestTypedDataSigner(QUOTE_KEY),
  fillSigners: { 'eip155:1': fillSigner(FILL_KEY) },
  rpc: { 'eip155:1': [new FakeEvmRpc('a'), new FakeEvmRpc('b')] },
  store: new InMemoryFillerStore(),
  webSocket: createFakeWebSocketFactory().factory,
  instanceId: 'replica-1',
});

/** A store whose `part` is an empty object: present, but implementing nothing. */
const storeWithout = (part: 'quotes' | 'nonces') => {
  const store = new InMemoryFillerStore();
  return Object.assign(Object.create(Object.getPrototypeOf(store) as object) as InMemoryFillerStore, store, { [part]: {} });
};

const configErrorField = (make: () => unknown): string => {
  try {
    make();
  } catch (error) {
    expect(error).toBeInstanceOf(FillerConfigError);
    return (error as FillerConfigError).field;
  }
  throw new Error('expected FillerConfigError');
};

describe('createFiller: injected dependencies are validated up front', () => {
  test('a complete config builds a filler and opens no connection', () => {
    const ws = createFakeWebSocketFactory();
    const filler = createFiller({ ...baseConfig(), webSocket: ws.factory });
    expect(filler.fillerId).toBe('acme-1');
    expect(filler.instanceId).toBe('replica-1');
    expect(ws.sockets).toHaveLength(0);
  });

  test('without a WebSocket factory: a FillerConfigError naming it, not a ReferenceError', () => {
    const { webSocket: _omitted, ...rest } = baseConfig();
    expect(configErrorField(() => createFiller(rest as FillerConfig))).toBe('webSocket');
  });

  test.each([
    ['store', { store: undefined }],
    ['store.nonces', { store: storeWithout('nonces') }],
    ['store.quotes', { store: storeWithout('quotes') }],
    ['quoteSigner', { quoteSigner: undefined }],
    ['fillSigners', { fillSigners: {} }],
    ['gatewayUrl', { gatewayUrl: 'https://filler-gateway.example/v1' }],
    ['fillerId', { fillerId: 'Acme' }],
    ['gatewaySigner', { gatewaySigner: '0x1234' }],
    ['ticketSigners', { ticketSigners: [] }],
    ['rpc.eip155:1', { rpc: {} }],
    ['instanceId', { instanceId: '' }],
  ])('%s is checked', (field, patch) => {
    expect(configErrorField(() => createFiller({ ...baseConfig(), ...patch } as FillerConfig))).toBe(field);
  });

  test('a fill-signer key that is not an eip155 chain id is refused', () => {
    const config = { ...baseConfig(), fillSigners: { 'canton:mainnet': fillSigner(FILL_KEY) } } as unknown as FillerConfig;
    expect(configErrorField(() => createFiller(config))).toBe('fillSigners.canton:mainnet');
  });

  test('a fill signer without signTransaction is refused', () => {
    const config = { ...baseConfig(), fillSigners: { 'eip155:1': createTestTypedDataSigner(FILL_KEY) } } as unknown as FillerConfig;
    expect(configErrorField(() => createFiller(config))).toBe('fillSigners.eip155:1');
  });

  test('the quote key and a fill key must be different keys (N-6)', () => {
    const config = { ...baseConfig(), fillSigners: { 'eip155:1': fillSigner(QUOTE_KEY) } };
    expect(configErrorField(() => createFiller(config))).toBe('fillSigners.eip155:1');
  });

  test('instanceId defaults to a fresh UUID per filler', () => {
    const { instanceId: _omitted, ...rest } = baseConfig();
    const a = createFiller(rest);
    const b = createFiller(rest);
    expect(a.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.instanceId).not.toBe(b.instanceId);
  });
});

describe('the skeleton of sdk.md §3.6', () => {
  const withHooks = (): Filler => {
    const filler = createFiller(baseConfig());
    filler.onQuoteRequest(async () => null);
    filler.onReconfirm(async () => true);
    filler.onTicketOffer(async () => 'decline');
    return filler;
  };

  test('start() requires every hook first', async () => {
    const filler = createFiller(baseConfig());
    await expect(filler.start()).rejects.toMatchObject({ name: 'FillerConfigError', field: 'onQuoteRequest' });
    filler.onQuoteRequest(async () => null);
    await expect(filler.start()).rejects.toMatchObject({ field: 'onReconfirm' });
    filler.onReconfirm(async () => true);
    await expect(filler.start()).rejects.toMatchObject({ field: 'onTicketOffer' });
  });

  test('a hook that is not a function is refused at registration', () => {
    expect(configErrorField(() => createFiller(baseConfig()).onTicketOffer('accept' as never))).toBe('onTicketOffer');
  });

  test.each([
    ['selfSettle', 'CAN-1856', (f: Filler) => f.selfSettle('0x00')],
    ['verifyDraw', 'CAN-1848', (f: Filler) => f.verifyDraw('0x00')],
    ['verifyEscrow', 'CAN-1854', (f: Filler) => f.verifyEscrow({} as TicketIssued)],
    ['bindStake', 'CAN-1857', (f: Filler) => f.bindStake(createTestTypedDataSigner(FILL_KEY), { chain: 'eip155:1' })],
    ['stats', 'CAN-1940', (f: Filler) => f.stats()],
  ])('%s() names the task that implements it (%s)', async (method, task, call) => {
    const error = await call(withHooks()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NotImplementedError);
    expect(error).toMatchObject({ method, task });
  });

  test('start() without any fetch is a config error, not a ReferenceError', async () => {
    const original = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      await expect(withHooks().start()).rejects.toMatchObject({ name: 'FillerConfigError', field: 'fetch' });
    } finally {
      (globalThis as { fetch?: unknown }).fetch = original;
    }
  });

  test('a malformed transport option is refused up front', () => {
    expect(configErrorField(() => createFiller({ ...baseConfig(), transport: { heartbeatMisses: 0 } }))).toBe('transport.heartbeatMisses');
    expect(configErrorField(() => createFiller({ ...baseConfig(), transport: { reconnect: { maxDelayMs: -1 } } }))).toBe('transport.reconnect.maxDelayMs');
  });

  test('stop() is safe before start()', async () => {
    await expect(withHooks().stop()).resolves.toBeUndefined();
  });

  // Compile-time: the public signatures are the ones sdk.md §3.6 documents.
  // `npm run typecheck` fails if any of them drifts.
  test('types', () => {
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const assert = <T extends true>(): T => true as T;
    assert<Equal<Parameters<Filler['onQuoteRequest']>[0], (request: QuoteRequest) => Promise<{ amountOut: bigint | string; validUntil: bigint | string } | null>>>();
    assert<Equal<Parameters<Filler['onReconfirm']>[0], (reconfirm: QuoteReconfirm) => Promise<boolean>>>();
    assert<Equal<Parameters<Filler['onTicketOffer']>[0], (offer: TicketOffer) => Promise<'accept' | 'decline'>>>();
    assert<Equal<ReturnType<Filler['start']>, Promise<void>>>();
    assert<Equal<ReturnType<Filler['selfSettle']>, Promise<SelfSettleResult>>>();
    assert<Equal<SelfSettleResult, { txHash: Hex }>>();
    assert<Equal<ReturnType<Filler['verifyDraw']>, Promise<DrawVerification>>>();
    assert<Equal<keyof DrawVerification, 'winner' | 'recomputedWinner' | 'match' | 'drandRound'>>();
    assert<Equal<ReturnType<Filler['verifyEscrow']>, Promise<EscrowVerification>>>();
    assert<Equal<ReturnType<Filler['bindStake']>, Promise<StakeBindingRequest>>>();
    assert<Equal<keyof FillerStatsSnapshot, 'won' | 'delivered' | 'noShow' | 'reliability' | 'capacityUsd' | 'inFlightUsd'>>();
    expect(true).toBe(true);
  });
});
