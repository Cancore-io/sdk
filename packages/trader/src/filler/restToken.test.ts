import type { Hex } from '@cancore/contracts';
import { TOKEN_MARGIN_MS } from './protocol/rest';
import { createFiller, type Filler, type FillSigner } from './index';
import { createFakeFetch, createFakeGatewayLogin, createFakeWebSocketFactory, createTestGatewaySigner, createTestTypedDataSigner, FakeClock, FakeEvmRpc, InMemoryFillerStore } from './testing';

const GATEWAY_KEY: Hex = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';
const QUOTE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FILL_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const FILLER = 'acme-1';
const TOKEN_TTL_MS = 600_000;

function harness() {
  const clock = new FakeClock();
  const gateway = createTestGatewaySigner(GATEWAY_KEY, clock);
  const login = createFakeGatewayLogin(gateway, { fillerId: FILLER, clock, tokenTtlMs: TOKEN_TTL_MS });
  const http = createFakeFetch(login.routes);
  const fillSigner: FillSigner = { ...createTestTypedDataSigner(FILL_KEY), signTransaction: async () => '0x02' };
  const filler: Filler = createFiller({
    gatewayUrl: 'wss://filler-gateway.example/v1',
    fillerId: FILLER,
    gatewaySigner: gateway.address,
    ticketSigners: ['0x2222222222222222222222222222222222222222'],
    quoteSigner: createTestTypedDataSigner(QUOTE_KEY),
    fillSigners: { 'eip155:1': fillSigner },
    rpc: { 'eip155:1': [new FakeEvmRpc('a')] },
    chains: { 'eip155:1': { router: '0x3333333333333333333333333333333333333333', openConfirmations: 3, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30, minGasWei: 10n ** 15n } },
    tickets: { deltaIssueMs: 3_000 },
    store: new InMemoryFillerStore(clock),
    webSocket: createFakeWebSocketFactory().factory,
    fetch: http.fetch,
    clock,
    instanceId: 'replica-1',
  });
  return { clock, login, filler };
}

describe('BUG-1602 restToken(): a REST bearer that never goes stale while nothing else calls REST', () => {
  test('BUG-1602-01: the held token is handed out again while it has more than the margin left', async () => {
    const h = harness();
    expect(await h.filler.restToken()).toBe('tok-1');
    h.clock.advance(TOKEN_TTL_MS - TOKEN_MARGIN_MS - 1);
    expect(await h.filler.restToken()).toBe('tok-1');
    expect(h.login.challenges()).toBe(1);
  });

  test('BUG-1602-02: once the held token is within the margin of its expiry, the next call logs in and returns a fresh one', async () => {
    const h = harness();
    expect(await h.filler.restToken()).toBe('tok-1');
    h.clock.advance(TOKEN_TTL_MS - TOKEN_MARGIN_MS);
    expect(await h.filler.restToken()).toBe('tok-2');
    expect(h.login.issued()).toEqual(['tok-1', 'tok-2']);
  });

  test('BUG-1602-03: concurrent callers share one login', async () => {
    const h = harness();
    const tokens = await Promise.all([h.filler.restToken(), h.filler.restToken(), h.filler.restToken()]);
    expect(tokens).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(h.login.challenges()).toBe(1);
  });
});
