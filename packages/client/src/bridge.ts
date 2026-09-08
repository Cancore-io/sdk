/**
 * `@cancore/client/bridge` — USDCx between an EVM chain and Canton.
 *
 * Two ways in and out. The DIRECT routes (`mint`, `burn`) are for a custodial
 * account: the backend holds the signing key and completes the operation. The
 * INTERACTIVE pair (`prepareInteractive` → your signer → `submitInteractive`)
 * is for self-custody: the backend prepares a transaction, hands back a hash,
 * you sign it with a key this client never sees, and it submits the signature.
 *
 * Shapes are the gateway's DTOs (`spec/openapi.json`, checked by spec.test.ts),
 * with two exceptions read from the controller because the document leaves
 * them untyped: `limits`, and the fact that `history` is paginated.
 */
import { createHttp, type ClientOptions, type Http } from './http';
import type { Page } from './swap';

export type BridgeOperation = 'mint' | 'burn';

/** `GET /canton-wallet/bridge/limits` */
export interface BridgeLimits {
  minBurnAmount: number;
  maxBurnAmount: number | null;
}

export interface OnboardingStatus {
  onboarded: boolean;
  agreementCid?: string;
  agreement?: Record<string, unknown>;
}

/** `BridgeCostEstimateResponseDto` */
export interface BridgeCostEstimate {
  operation: BridgeOperation;
  amount: string;
  bridgeFee: string | null;
  netAmount: string | null;
  bridgeFeeSource: 'protocol' | 'observed' | 'unknown';
  bridgeFeeBasis: string | null;
  cantonTrafficCostCc: string | null;
  cantonTrafficCostUsd: string | null;
  estimatedGasFee: string;
  marginPct: number;
  recommendedCostCc: string | null;
  estimateSource: 'profile' | 'payload' | 'unavailable';
}

/** `BridgeHistoryItemDto` */
export interface BridgeHistoryItem {
  id: string;
  transactionId: string | null;
  operation: 'onboard' | 'mint' | 'burn';
  userPartyId: string;
  sourceChainId: string | null;
  destinationChainId: string | null;
  amount: string | null;
  receivedAmount: string | null;
  bridgeFee: string | null;
  instrument: string | null;
  gasFee: string | null;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  errorCode: string | null;
  errorMessage: string | null;
  delaySeconds: number | null;
  path: string | null;
  commandId: string | null;
  retryOf: string | null;
  evmTxHash: string | null;
  depositAttestationCid: string | null;
  cantonTxUrl: string | null;
  evmTxUrl: string | null;
  destinationTxUrl: string | null;
  createdAt: string;
}

export interface BridgeHistoryQuery {
  page?: number;
  pageSize?: number;
}

/** `BridgeMintDirectDto` — the deposit already happened on the EVM side; this claims it on Canton. */
export interface MintInput {
  amount?: string;
  evmTxHash?: string;
  sourceChainId?: string;
  retryOf?: string;
}

/** `BridgeBurnDirectDto` — burn on Canton, receive on the EVM side. */
export interface BurnInput {
  amount: string;
  ethRecipient: string;
  destinationChainId?: string;
  retryOf?: string;
}

/** `PrepareCommandDto` — what the self-custody path asks the backend to prepare. */
export interface PrepareInteractiveInput {
  operation: BridgeOperation;
  amount: string;
  ethRecipient?: string;
  evmTxHash?: string;
  sourceChainId?: string;
  destinationChainId?: string;
  [key: string]: unknown;
}

/** `BridgePreparedInteractiveDto` — sign `preparedTransactionHash`, then submit with the key. */
export interface PreparedInteractive {
  submissionKey: string;
  preparedTransactionHash: string;
}

/** A signer for the interactive path: base64 hash in, base64 signature out. `@cancore/wallet`'s `HashSigner` fits. */
export type PreparedHashSigner = (preparedTransactionHashB64: string) => Promise<string>;

export interface BridgeClient {
  limits(): Promise<BridgeLimits>;
  history(query?: BridgeHistoryQuery): Promise<Page<BridgeHistoryItem>>;
  /** Has this party accepted the bridge agreement? Required once before the first mint or burn. */
  checkOnboarding(): Promise<OnboardingStatus>;
  estimateCost(input: { operation: BridgeOperation; amount: string }): Promise<BridgeCostEstimate>;
  /** Custodial: the backend signs. */
  mint(input: MintInput): Promise<unknown>;
  /** Custodial: the backend signs. */
  burn(input: BurnInput): Promise<unknown>;
  /** Self-custody, step one: a hash to sign. */
  prepareInteractive(input: PrepareInteractiveInput): Promise<PreparedInteractive>;
  /** Self-custody, step two: the signature over that hash. */
  submitInteractive(input: { submissionKey: string; signature: string }): Promise<unknown>;
  /** Self-custody, both steps, with your signer in between. */
  executeInteractive(input: PrepareInteractiveInput, sign: PreparedHashSigner): Promise<unknown>;
}

export function createBridgeClient(http: Http): BridgeClient {
  const prepareInteractive = (input: PrepareInteractiveInput) =>
    http.post<PreparedInteractive>('/canton-wallet/bridge/prepare-interactive', input);
  const submitInteractive = (input: { submissionKey: string; signature: string }) =>
    http.post<unknown>('/canton-wallet/bridge/submit-interactive', input);

  return {
    limits: () => http.get('/canton-wallet/bridge/limits'),
    history: (query) => http.get('/canton-wallet/bridge/history', query),
    checkOnboarding: () => http.post('/canton-wallet/bridge/check-onboarding'),
    estimateCost: (input) => http.post('/canton-wallet/bridge/estimate-cost', input),
    mint: (input) => http.post('/canton-wallet/bridge/mint', input),
    burn: (input) => http.post('/canton-wallet/bridge/burn', input),
    prepareInteractive,
    submitInteractive,
    async executeInteractive(input, sign) {
      const prepared = await prepareInteractive(input);
      const signature = await sign(prepared.preparedTransactionHash);
      return submitInteractive({ submissionKey: prepared.submissionKey, signature });
    },
  };
}

/** A bridge client on its own, without assembling the whole client. */
export function bridge(options: ClientOptions): BridgeClient {
  return createBridgeClient(createHttp(options));
}
