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
 * `/auto-trader/*` used to be outside the document entirely. It is in now, so
 * the three pool-trade routes take the same route/method check as the rest —
 * but only the routes: their fields are still undocumented, and the test below
 * pins that so the day they arrive is a red test rather than nobody noticing.
 */
interface Spec {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
}
interface Operation {
  parameters?: Array<{ name: string }>;
  requestBody?: { content: Record<string, { schema?: { $ref?: string } }> };
  responses?: Record<string, { content?: unknown }>;
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
    s.accept('o1'), s.cancel('o1'), s.pairs(), s.quote({ pairConfigId: 'p', sourceAmount: 1 }), s.execute('q'),
    s.track('o1', { sleep: async () => {} }),
    b.limits(), b.history(), b.checkOnboarding(), b.estimateCost({ operation: 'burn', amount: '1' }),
    b.mint({}), b.burn({ amount: '1', ethRecipient: '0x0' }),
    b.prepareInteractive({ operation: 'burn', amount: '1' }), b.submitInteractive({ submissionKey: 'k', signature: 's' }),
  ]);
  return [...seen].sort();
}

test('every route the client actually calls exists in the gateway document, with that method', async () => {
  const called = await routesTheClientCalls();
  expect(called.length).toBeGreaterThanOrEqual(18); // a vacuous pass would be worse than a failure
  const missing = called.filter((route) => {
    const [method, path] = route.split(' ') as [string, string];
    return spec.paths[path]?.[method] === undefined;
  });
  expect(missing).toEqual([]);
});

/**
 * The document carries the whole auto-trader service, its operator surface
 * included. Wrapping one of those here would pass the check above — it is in
 * the document — and hand an admin API to every third-party dApp that installs
 * this package. Existing in the document is not a reason to wrap something.
 */
test('the client wraps no operator route', async () => {
  const called = await routesTheClientCalls();
  expect(called.filter((route) => /\/(auto-trader\/admin|bot-admin)\//.test(route))).toEqual([]);
});

/**
 * The three pool-trade routes are in the document as routes and nothing more:
 * `QuoteDto` and `ExecuteDto` come out with no properties, `GET /auto-trader/pairs`
 * declares no parameters, and none of the three types a response. So there is
 * nothing for `ListPairsQuery`, `Pair`, `Quote` and `Executed` to be held to,
 * and they stay written from what the service returns. That gap is the
 * document's, not these routes' alone — plenty of its DTOs are empty and most
 * of its operations type no response.
 *
 * Pinning it here means the day the detail arrives is a red test with the next
 * step in it, which is what the old "they are outside the document" assertion
 * bought before the routes landed.
 */
const POOL_TRADE: Array<[string, string]> = [
  ['get', '/auto-trader/pairs'],
  ['post', '/auto-trader/quote'],
  ['post', '/auto-trader/execute'],
];

test('the pool-trade routes are documented as routes only, so the field checks cannot reach them', () => {
  const arrived = POOL_TRADE.flatMap(([method, path]) => {
    const op = spec.paths[path]?.[method] as Operation | undefined;
    expect(op).toBeDefined();
    const dto = op?.requestBody?.content['application/json']?.schema?.$ref?.split('/').pop();
    return [
      (op?.parameters ?? []).length > 0 && `${path} declares query parameters`,
      dto && Object.keys(spec.components.schemas[dto]?.properties ?? {}).length > 0 && `${dto} has properties`,
      Object.values(op?.responses ?? {}).some((r) => r.content) && `${path} types a response`,
    ].filter((found): found is string => typeof found === 'string');
  });
  if (arrived.length > 0) {
    throw new Error(
      `${arrived.join('; ')}. This is the expected signal, not a regression: put those fields in QUERY_FIELDS, ` +
        'REQUEST_FIELDS or RESPONSE_FIELDS below so the client is held to them, and drop the route from POOL_TRADE.',
    );
  }
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

/**
 * Query types: every field of a list query must be a parameter the route
 * declares. This is the check that would have caught `status` where the API
 * says `statusFilter` — found by the first consumer, not by this test, which
 * is the wrong order and the reason the check exists now.
 */
const QUERY_FIELDS: Record<string, string[]> = {
  '/orders': ['page', 'pageSize', 'sortBy', 'sortDir', 'sourceNetwork', 'targetNetwork', 'sourceTokenAddress', 'targetTokenAddress', 'statusFilter'],
  '/orders/my': ['page', 'pageSize', 'sortBy', 'sortDir', 'sourceNetwork', 'targetNetwork', 'sourceTokenAddress', 'targetTokenAddress', 'statusFilter'],
  '/canton-wallet/bridge/history': ['page', 'pageSize'],
};

test.each(Object.entries(QUERY_FIELDS))('GET %s: every query field the client types is a parameter the route declares', (path, fields) => {
  const declared = ((spec.paths[path]?.get as { parameters?: Array<{ name: string }> } | undefined)?.parameters ?? []).map((p) => p.name);
  expect(declared.length).toBeGreaterThan(0);
  expect(fields.filter((f) => !declared.includes(f))).toEqual([]);
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
