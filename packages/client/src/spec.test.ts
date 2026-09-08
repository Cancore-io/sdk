import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBridgeClient } from './bridge';
import { createHttp } from './http';
import { createSwapClient } from './swap';

/**
 * Every route this client calls must exist in the gateway's OpenAPI document,
 * with that method — and every field a request type declares must be a field
 * the DTO actually has. The document is a snapshot (`npm run spec:refresh`), so
 * this catches the day the API moves out from under the client without anyone
 * touching the client.
 *
 * The routes are not listed by hand: a hand-written list passes for the routes
 * somebody remembered and says nothing about the one they did not. Instead every
 * client method is CALLED against a recording transport, and what it actually
 * requested is what gets checked. Adding a method adds a checked route.
 *
 * `/auto-trader/*` is a separate service the gateway document does not include;
 * those two routes are listed as such rather than silently skipped.
 */
interface Spec {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
}
const spec = JSON.parse(readFileSync(join(__dirname, '..', 'spec', 'openapi.json'), 'utf8')) as Spec;

/** Drive every method once; collect `METHOD /path` with ids folded back to `{id}`. */
async function routesTheClientCalls(): Promise<string[]> {
  const seen = new Set<string>();
  const http = createHttp({
    baseUrl: 'https://api.example',
    request: async (url, init) => {
      const path = new URL(url).pathname.replace(/\/o1(?=\/|$)/, '/{id}');
      seen.add(`${(init.method ?? 'GET').toLowerCase()} ${path}`);
      return new Response(JSON.stringify({ id: 'o1', status: 'completed', submissionKey: 'k', preparedTransactionHash: 'h' }));
    },
  });
  const s = createSwapClient(http);
  const b = createBridgeClient(http);
  const offer = {
    sourceNetwork: 'canton', sourceTokenAddress: 'CC', sourceTokenName: 'CC', sourceAmount: '1',
    targetNetwork: 'sepolia', targetTokenAddress: '0x0', targetTokenName: 'USDC', targetAmount: '1',
  };
  await Promise.all([
    s.listOpen(), s.listMine(), s.get('o1'), s.create(offer),
    s.createForPair({ tradingPairId: 'p', sourceAmount: '1', targetAmount: '1' }),
    s.accept('o1'), s.cancel('o1'), s.quote({ pairConfigId: 'p', sourceAmount: 1 }), s.execute('q'),
    s.track('o1', { sleep: async () => {} }),
    b.limits(), b.history(), b.checkOnboarding(), b.estimateCost({ operation: 'burn', amount: '1' }),
    b.mint({}), b.burn({ amount: '1', ethRecipient: '0x0' }),
    b.prepareInteractive({ operation: 'burn', amount: '1' }), b.submitInteractive({ submissionKey: 'k', signature: 's' }),
  ]);
  return [...seen].sort();
}

/** Outside the gateway document by construction; shapes come from the Cancore app. */
const OUTSIDE_SPEC = ['/auto-trader/quote', '/auto-trader/execute'];

test('every route the client actually calls exists in the gateway document, with that method', async () => {
  const called = await routesTheClientCalls();
  expect(called.length).toBeGreaterThanOrEqual(17); // a vacuous pass would be worse than a failure
  const missing = called
    .filter((route) => !OUTSIDE_SPEC.some((p) => route.endsWith(` ${p}`)))
    .filter((route) => {
      const [method, path] = route.split(' ') as [string, string];
      return spec.paths[path]?.[method] === undefined;
    });
  expect(missing).toEqual([]);
});

test('the routes outside the document really are outside it', () => {
  for (const path of OUTSIDE_SPEC) expect(spec.paths[path]).toBeUndefined();
});

/** Request types this client declares, against the DTO each route takes. */
const REQUEST_FIELDS: Record<string, string[]> = {
  CreateOrderDto: [
    'sourceNetwork', 'sourceTokenAddress', 'sourceTokenName', 'sourceAmount',
    'targetNetwork', 'targetTokenAddress', 'targetTokenName', 'targetAmount',
    'expirationHours', 'description', 'dvp',
  ],
  CreatePairOrderDto: ['tradingPairId', 'sourceAmount', 'targetAmount', 'side', 'expirationHours', 'description'],
  BridgeEstimateCostDto: ['operation', 'amount'],
  BridgeMintDirectDto: ['amount', 'evmTxHash', 'sourceChainId', 'retryOf'],
  BridgeBurnDirectDto: ['amount', 'ethRecipient', 'destinationChainId', 'retryOf'],
  BridgeInteractiveSubmitDto: ['submissionKey', 'signature'],
};

test.each(Object.entries(REQUEST_FIELDS))('%s: the client sends only fields the DTO has, and all it requires', (dto, fields) => {
  const schema = spec.components.schemas[dto];
  expect(schema).toBeDefined();
  const known = Object.keys(schema?.properties ?? {});
  expect(fields.filter((f) => !known.includes(f))).toEqual([]);
  expect((schema?.required ?? []).filter((r) => !fields.includes(r))).toEqual([]);
});

/** Response types: every field the client types must exist on the DTO. */
const RESPONSE_FIELDS: Record<string, string[]> = {
  OrderResponseDto: [
    'id', 'sourceNetwork', 'sourceTokenAddress', 'sourceTokenName', 'sourceAmount',
    'targetNetwork', 'targetTokenAddress', 'targetTokenName', 'targetAmount',
    'initiatorUserId', 'opponentUserId', 'initiator', 'opponent', 'swapId', 'status', 'swapStatus',
    'swapLedgerStatus', 'dvp', 'mainHtlcRefunded', 'counterHtlcRefunded', 'mainHtlcExpired',
    'counterHtlcExpired', 'retakeable', 'swapTimeout', 'swapCounterTimeout', 'tradingPairId',
    'amountPrecision', 'pricePrecision', 'price', 'expiresAt', 'description', 'createdAt', 'updatedAt',
  ],
  PaginatedOrderResponseDto: ['items', 'page', 'pageSize', 'total'],
  BridgeCostEstimateResponseDto: [
    'operation', 'amount', 'bridgeFee', 'netAmount', 'bridgeFeeSource', 'bridgeFeeBasis',
    'cantonTrafficCostCc', 'cantonTrafficCostUsd', 'estimatedGasFee', 'marginPct', 'recommendedCostCc', 'estimateSource',
  ],
  BridgeHistoryItemDto: [
    'id', 'transactionId', 'operation', 'userPartyId', 'sourceChainId', 'destinationChainId', 'amount',
    'receivedAmount', 'bridgeFee', 'instrument', 'gasFee', 'status', 'errorCode', 'errorMessage',
    'delaySeconds', 'path', 'commandId', 'retryOf', 'evmTxHash', 'depositAttestationCid',
    'cantonTxUrl', 'evmTxUrl', 'destinationTxUrl', 'createdAt',
  ],
  BridgePreparedInteractiveDto: ['submissionKey', 'preparedTransactionHash'],
};

test.each(Object.entries(RESPONSE_FIELDS))('%s: every field the client types is a field the DTO has', (dto, fields) => {
  const known = Object.keys(spec.components.schemas[dto]?.properties ?? {});
  expect(known.length).toBeGreaterThan(0);
  expect(fields.filter((f) => !known.includes(f))).toEqual([]);
});
