import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestGrant } from './auth';
import { createBridgeClient } from './bridge';
import { createHttp } from './http';
import { createSelfCustody } from './selfcustody';
import { SDK_ERROR_CODES } from './sdk-error-codes';
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
 * `/auto-trader/*` used to be outside the document, then in it as routes only;
 * its fields arrived with the snapshot refresh of CAN-2029, so the
 * three pool-trade routes are held to their fields like the rest. The
 * device-flow routes are still held for the part the document does not carry.
 */
interface Spec {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[]; enum?: string[] }> };
}
interface Operation {
  parameters?: Array<{ name: string }>;
  requestBody?: { content: Record<string, { schema?: { $ref?: string } }> };
  responses?: Record<string, { content?: unknown }>;
}
const spec = JSON.parse(readFileSync(join(__dirname, '..', 'spec', 'openapi.json'), 'utf8')) as Spec;

const ORDER_REPLY = { id: 'o1', status: 'completed', submissionKey: 'k', preparedTransactionHash: 'h' };
/** What the self-custody account reads off a reply to get to its next call. */
const SELF_CUSTODY_REPLIES: Record<string, unknown> = {
  '/auth/challenge': { challenge: 'Welcome to Cancore 2026-01-01 sig:0' },
  '/auth/register-challenge': { challenge: 'Welcome to Cancore 2026-01-01 sig:0' },
  '/auth/login-signature': { token: 'h.e30.s', user: { id: 'u' } },
  '/auth/register': { token: 'h.e30.s', user: { id: 'u' } },
  '/auth/me': { id: 'u', partyId: 'p' },
  '/wallet/operations/prepare': { operationId: 'op', legs: [], meta: {} },
  '/partner/cashback/claims': [],
  '/tokens/transfer-requests/incoming': [],
};
const DEVICE_REPLY = { deviceCode: 'd', userCode: 'U', verificationUri: '/w', expiresIn: 600, interval: 5, status: 'granted', token: 't' };

/** Drive every method once; collect `METHOD /path` with ids folded back to `{id}`. */
async function routesTheClientCalls(): Promise<string[]> {
  const seen = new Set<string>();
  const request = async (url: string, init: RequestInit) => {
    const raw = new URL(url).pathname;
    const path = raw
      .replace(/\/o1(?=\/|$)/, '/{id}')
      .replace(/^\/tokens\/balance\/[^/]+\/[^/]+$/, '/tokens/balance/{partyId}/{instrumentId}');
    seen.add(`${(init.method ?? 'GET').toLowerCase()} ${path}`);
    const reply = SELF_CUSTODY_REPLIES[raw] ?? (path.startsWith('/auth/device/') ? DEVICE_REPLY : ORDER_REPLY);
    return new Response(JSON.stringify(reply));
  };
  const http = createHttp({ baseUrl: 'https://api.example', request });
  const s = createSwapClient(http);
  const b = createBridgeClient(http);
  const offer = {
    sourceNetwork: 'canton', sourceTokenAddress: 'CC', sourceTokenName: 'CC', sourceAmount: '1',
    targetNetwork: 'sepolia', targetTokenAddress: '0x0', targetTokenName: 'USDC', targetAmount: '1',
  };
  // The self-custody account's own calls. Its two orchestrators (`make`, `take`)
  // run on swap state, so they are driven by the settled-swap test in
  // selfcustody.test.ts, which checks every route they touch the same way.
  const signer = { public_key: '00'.repeat(32), signMessage: async () => '00', signChallenge: async () => '00' };
  const acct = createSelfCustody({ baseUrl: 'https://api.example', signer, fetchImpl: request });
  const doc = { key: 'terms-of-use', version: 'v', url: '/legal/terms-of-use' };
  await acct.session.login();
  await acct.session.register({ inviteCode: 'ABCD-EFGH-JKMN' });
  await Promise.all([
    acct.me(), acct.onboard(), acct.legalStatus(), acct.acceptTerms('v', [doc]), acct.execute('tokens.consolidate'),
    acct.swapState('o1'), acct.incoming(), acct.acceptIncoming(), acct.consolidate(), acct.balance('CC'),
    acct.send({ receiverPartyId: 'p', amount: '1' }),
    acct.cashback.summary(), acct.cashback.claims(), acct.cashback.claim(), acct.cashback.collect(),
    acct.faucet(),
  ]);
  await Promise.all([
    s.listOpen(), s.listMine(), s.get('o1'), s.create(offer),
    s.createForPair({ tradingPairId: 'p', sourceAmount: '1', targetAmount: '1' }),
    s.accept('o1'), s.cancel('o1'), s.pairs(), s.quote({ pairConfigId: 'p', sourceAmount: 1 }), s.execute('q'),
    s.track('o1', { sleep: async () => {} }),
    b.limits(), b.history(), b.checkOnboarding(), b.estimateCost({ operation: 'burn', amount: '1' }),
    b.mint({}), b.burn({ amount: '1', ethRecipient: '0x0' }),
    b.prepareInteractive({ operation: 'burn', amount: '1' }), b.submitInteractive({ submissionKey: 'k', signature: 's' }),
    requestGrant({
      baseUrl: 'https://api.example', request, appName: 'a', scopes: ['orders:write'],
      limits: { maxOrderUsd: 1, windowUsd: 1, windowSeconds: 60 },
    }).then((grant) => grant.wait()),
  ]);
  return [...seen].sort();
}

test('every route the client actually calls exists in the gateway document, with that method', async () => {
  const called = await routesTheClientCalls();
  expect(called.length).toBeGreaterThanOrEqual(20); // a vacuous pass would be worse than a failure
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
 * The device-flow routes are in the document in part: `DeviceAuthorizeDto` and
 * `GrantLimitsDto` carry their fields and are held below like every other
 * request type, but `DevicePollDto` comes out with no properties and neither
 * route types its answer (the token route declares an object with no fields).
 * So the poll body and both answers in auth.ts are written from what the
 * service returns, and this pin turns the day they arrive into a red test.
 */
test('the device-flow routes are documented in part, so the field checks cannot reach all of them', () => {
  const arrived = [
    Object.keys(spec.components.schemas.DevicePollDto?.properties ?? {}).length > 0 && 'DevicePollDto has properties',
    ...['/auth/device/authorize', '/auth/device/token'].map((path) => {
      const op = spec.paths[path]?.post as Operation | undefined;
      expect(op).toBeDefined();
      // `{ type: 'object' }` with nothing in it is a body, not a type.
      const typed = Object.values(op?.responses ?? {}).some((r) => /"\$ref"|"properties"/.test(JSON.stringify(r.content ?? {})));
      return typed && `${path} types a response`;
    }),
  ].filter((found): found is string => typeof found === 'string');
  if (arrived.length > 0) {
    throw new Error(
      `${arrived.join('; ')}. This is the expected signal, not a regression: put those fields in REQUEST_FIELDS ` +
        'or RESPONSE_FIELDS below so the client is held to them, and drop them from this test.',
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
  DeviceAuthorizeDto: ['appName', 'scopes', 'limits'],
  GrantLimitsDto: ['maxOrderUsd', 'windowUsd', 'windowSeconds', 'pairIds'],
  ChallengeRequestDto: ['publicKey'],
  LoginSignatureDto: ['publicKey', 'signature', 'challenge'],
  RefreshTokenDto: ['refreshToken'],
  RedeemInviteDto: ['code'],
  RecordLegalConsentDto: ['version', 'documents', 'issuedAt', 'signature'],
  ConsentedDocumentDto: ['key', 'version', 'url'],
  PrepareOperationDto: ['type', 'params'],
  SubmitOperationDto: ['operationId', 'signatures'],
  OperationSignatureDto: ['legId', 'signature'],
  ClaimHtlcDto: ['preimage'],
  // The DvP path of make/take (selfcustody.ts): the maker's trade request, and every signed step.
  CreateProposalDto: ['orderId', 'dvp', 'tokenId', 'amount', 'receiver', 'hashLock', 'timeoutHours'],
  PrepareCommandDto: ['operationType', 'params'],
  SignedCommandDto: [
    'commandId', 'operationType', 'actAs', 'commands', 'signature', 'signatures', 'publicKey',
    'applicationId', 'serializedForSigning', 'hashForSigning',
  ],
  QuoteDto: ['pairConfigId', 'sourceAmount'],
  ExecuteDto: ['quoteToken'],
  FaucetClaimRequestDto: ['agreementSignature', 'agreementTimestamp'],
};

/**
 * Sign-up is the one body the document declares inline rather than as a DTO.
 * Its `required` list says `email`, which the API does not enforce for a
 * self-custody (passkey) sign-up — the check here is the same subset one.
 */
test('the sign-up body sends only fields the document declares', () => {
  const op = spec.paths['/auth/register']?.post as { requestBody: { content: Record<string, { schema: { properties: Record<string, unknown> } }> } };
  const known = Object.keys(op.requestBody.content['application/json']!.schema.properties);
  const sent = ['signingMethod', 'publicKey', 'challenge', 'signature', 'partyName', 'email', 'inviteCode'];
  expect(sent.filter((f) => !known.includes(f))).toEqual([]);
});

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
  '/auto-trader/pairs': ['sourceToken', 'targetToken', 'sortBy', 'sortDir'],
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
  AuthResponseDto: ['token', 'refreshToken', 'user'],
  ChallengeResponseDto: ['challenge'],
  UserResponseDto: ['id', 'partyId', 'partyName', 'roles', 'status', 'signingMethod', 'email', 'walletPublicKey'],
  HtlcSwapResponseDto: [
    'id', 'status', 'sender', 'receiver', 'tokenId', 'amount', 'counterTokenId', 'counterAmount',
    'hashLock', 'timeout', 'counterTimeout', 'rejectReason', 'proposalContractId',
  ],
  FullSwapInfoDto: ['swap', 'legs', 'dvp'],
  SwapLegDto: ['role', 'sender', 'receiver', 'tokenId', 'amount', 'lockRef'],
  DvpSwapFactsDto: ['tradeCid', 'awaitingApprovalFrom', 'allocateBefore', 'settleBefore'],
  DvpInstrumentDto: ['id'],
  PreparedCommandDto: [
    'commandId', 'operationType', 'actAs', 'commands', 'applicationId', 'serializedForSigning',
    'hashForSigning', 'preparedTransactionHash', 'preparedTransactions',
  ],
  SignedCommandResponseDto: ['success', 'error', 'errorCode'],
  TransferInstructionResponseDto: [
    'contractId', 'templateId', 'transferId', 'sender', 'receiver', 'amount', 'instrumentId',
    'instrumentAdmin', 'memo', 'requestedAt', 'executeBefore', 'swapContext',
  ],
  TransferSwapContextDto: ['swapId', 'orderId', 'swapStatus', 'leg'],
  LegalConsentStatusDto: ['accepted', 'requiredVersion'],
  PreimageResponseDto: ['preimage', 'senderPreimage'],
  TokenBalanceDto: ['balance', 'holdingsCount'],
  PairListItemDto: [
    'id', 'sourceToken', 'targetToken', 'sourceInstrumentId', 'targetInstrumentId', 'spreadPercent',
    'minAmountUsd', 'maxAmountUsd', 'timeoutHours', 'marketRate', 'quotedRate', 'sourcePriceUsd',
    'volume24hUsd', 'trades24h', 'availableTargetAmount', 'availableTargetUsd', 'availableSourceAmount',
    'effectiveSpreadPercent', 'targetSkew', 'amountPrecision', 'pricePrecision',
  ],
  QuoteResultDto: [
    'quoteToken', 'pairConfigId', 'sourceToken', 'sourceAmount', 'targetToken', 'targetAmount',
    'marketRate', 'quotedRate', 'spreadPercent', 'subsidized', 'expiresInSec',
  ],
  ExecuteResultDto: ['orderId', 'recordId'],
  FaucetClaimResponseDto: ['success', 'amountCc', 'recipientParty', 'txId', 'nextEligibleAt', 'remainingPoolCc'],
};

/**
 * Routes the self-custody account reads whose answers the document does not
 * type: the envelope's prepare/submit, the fee and timeout lookups, and the
 * partner cashback routes. Their shapes in selfcustody.ts are written from the
 * services. Pinned so the day a schema lands is a red test with the next step in it.
 */
const UNTYPED_ANSWERS: Array<[string, string]> = [
  ['post', '/wallet/operations/prepare'],
  ['post', '/wallet/operations/submit'],
  ['get', '/htlc/fee-config'],
  ['get', '/htlc/timeout-options'],
  ['get', '/partner/cashback/me'],
  ['get', '/partner/cashback/claims'],
  ['post', '/partner/cashback/claim'],
];

test('the self-custody routes whose answers are untyped are still untyped', () => {
  const typed = UNTYPED_ANSWERS.filter(([method, path]) => {
    const op = spec.paths[path]?.[method] as Operation | undefined;
    expect(op).toBeDefined();
    return Object.entries(op?.responses ?? {}).some(
      ([code, r]) => code.startsWith('2') && /"\$ref"|"properties"/.test(JSON.stringify(r.content ?? {})),
    );
  });
  if (typed.length > 0) {
    throw new Error(
      `${typed.map(([m, p]) => `${m.toUpperCase()} ${p}`).join(', ')} now type(s) the answer. This is the expected ` +
        'signal, not a regression: hold the matching type in selfcustody.ts to it in RESPONSE_FIELDS and drop the route here.',
    );
  }
});

test.each(Object.entries(RESPONSE_FIELDS))('%s: every field the client types is a field the DTO has', (dto, fields) => {
  const known = Object.keys(spec.components.schemas[dto]?.properties ?? {});
  expect(known.length).toBeGreaterThan(0);
  expect(fields.filter((f) => !known.includes(f))).toEqual([]);
});

test('SDK_ERROR_CODES is the SdkErrorCode enum of the document, in its order', () => {
  // `sdk-error-codes.ts` is written by `npm run spec:refresh` from this same document; a hand edit or a
  // snapshot refreshed without it is what this catches.
  const published = spec.components.schemas.SdkErrorCode?.enum;
  expect(published).toBeDefined();
  expect([...SDK_ERROR_CODES]).toEqual(published);
  expect(new Set(SDK_ERROR_CODES).size).toBe(SDK_ERROR_CODES.length);
});
