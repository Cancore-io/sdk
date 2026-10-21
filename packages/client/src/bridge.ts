/**
 * `@cancore/client/bridge` — USDCx between an EVM chain and Canton.
 *
 * Three ways in and out, one per kind of party:
 *  - CUSTODIAL (the backend holds the key): the DIRECT routes, `mint` and `burn`.
 *    The backend signs and completes the operation.
 *  - SELF-CUSTODY on our participant: the INTERACTIVE pair (`prepareInteractive`
 *    → your signer → `submitInteractive`). The backend prepares a transaction,
 *    hands back a hash, you sign it with a key this client never sees, and it
 *    submits the signature.
 *  - LOOP wallet (hosted on Loop's participant): `executeLoop`. Our participant
 *    cannot see the party's contracts, so you read the contract ids from the
 *    Loop wallet, the backend builds the command, the Loop wallet submits it,
 *    and the outcome is reported back.
 *
 * Bookkeeping is part of the protocol. A mint starts with `registerDeposit`
 * right after the EVM deposit confirms, and a Loop mint or burn ends with its
 * report (`executeLoop` sends it). Without them the user's history, the stuck
 * detector and the mint monitoring see a deposit that is PENDING forever: for a
 * Loop party the report is the only thing that closes its row.
 *
 * Shapes are the gateway's DTOs (`spec/openapi.json`, checked by spec.test.ts),
 * with exceptions read from the controller because the document leaves them
 * untyped: `limits`, the fact that `history` is paginated, and the answers of
 * `registerDeposit`, `depositAttestation` and `buildLoopCommand`.
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

/**
 * `BridgeRegisterDepositDto` — the EVM deposit, recorded as a PENDING mint. Idempotent only while
 * that deposit is PENDING: call it once, before the mint.
 */
export interface RegisterDepositInput {
  amount: string;
  evmTxHash: string;
  sourceChainId: string;
}

/** `POST /canton-wallet/bridge/deposit-attestation` */
export interface DepositAttestation {
  found: boolean;
  attestationCid?: string;
}

export type LoopBridgeOperation = 'bridgeMint' | 'bridgeBurn';

/**
 * What a Loop command is built from. The contract ids are read by the Loop
 * wallet off its own participant; the rest is what the report closes the row by.
 */
export interface LoopBridgeParams {
  agreementCid: string;
  /** Mint: the DepositAttestation to claim. */
  attestationCid?: string;
  /** Burn: the USDCx holdings to burn from; the change comes back. */
  holdingCids?: string[];
  amount?: string;
  /** Mint: the deposit's hash, so the report closes that deposit's row and not another. */
  evmTxHash?: string;
  sourceChainId?: string;
  /** Burn. */
  ethRecipient?: string;
  destinationChainId?: string;
  [key: string]: unknown;
}

/** `PrepareCommandDto`, as `bridge/loop-command` takes it. */
export interface LoopCommandInput {
  operationType: LoopBridgeOperation;
  params: LoopBridgeParams;
}

/** The command the Loop wallet submits on its own participant. */
export interface LoopCommand {
  commands: unknown[];
  actAs: string[];
  readAs: string[];
  packageIdSelectionPreference?: string[];
  disclosedContracts: Array<Record<string, unknown>>;
}

/** `BridgeLoopResultDto` — what the Loop wallet answered. */
export interface LoopResult {
  operationType: LoopBridgeOperation;
  success: boolean;
  transactionId?: string;
  error?: string;
  amount?: string;
  evmTxHash?: string;
  sourceChainId?: string;
  ethRecipient?: string;
  destinationChainId?: string;
}

/** The part of the Loop SDK's wait-mode answer (`RunTransactionResponse`) this client reads. */
export interface LoopSubmitAnswer {
  update_id?: string;
  status?: string;
  error?: { error_message?: string };
}

/**
 * Submits a built command through the Loop wallet and waits for the ledger:
 * `(command) => provider.submitAndWaitForTransaction(command, { message })` fits.
 * A rejection and a `status: 'failed'` answer are both a failed submit.
 */
export type LoopSubmitter = (command: LoopCommand) => Promise<LoopSubmitAnswer | undefined>;

/** What `executeLoop` asks before it reports a failed submit. Both read the Loop wallet, which this package cannot. */
export interface LoopSubmitChecks {
  /**
   * Loop can reject a transaction that did commit. True when the contract the
   * operation consumes (mint: `params.attestationCid`, burn: `params.holdingCids[0]`)
   * is gone from the wallet: the submit is then reported, and resolves, as a
   * success without a `transactionId`. A probe that rejects counts as false.
   */
  landed?: (input: LoopCommandInput) => Promise<boolean>;
  /** True for a cancellation in the wallet (request rejected, popup closed): thrown as it is, not reported. */
  isCancelled?: (err: unknown) => boolean;
}

/**
 * The Loop wallet answered, but bridge history did not take the report.
 * `result` is that answer (`result.success` says whether the transaction
 * went through); do not resubmit a mint or burn that succeeded. Sending
 * `result` again with `reportLoopResult` is safe when `result.transactionId`
 * is set, or when `cause` is a `CancoreApiError` with a 4xx status (refused
 * before anything was written). Otherwise the first report may have been
 * recorded: read `history()` before sending it again.
 */
export class LoopReportError extends Error {
  constructor(
    readonly result: LoopResult,
    readonly cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`${result.operationType} ${result.success ? 'succeeded' : 'failed'} in the Loop wallet, but its report was not recorded: ${reason}`);
    this.name = 'LoopReportError';
  }
}

// The report DTO rejects unknown fields and an error over 2000 characters: either would lose the
// report to a 400, so the contract ids in the params stay out and the error is cut.
const REPORTED_FIELDS = ['amount', 'evmTxHash', 'sourceChainId', 'ethRecipient', 'destinationChainId'] as const;
const REPORTED_ERROR_MAX = 2000;

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
  /** Every party: record the EVM deposit as a PENDING mint right after it confirms. */
  registerDeposit(input: RegisterDepositInput): Promise<{ id: string | null }>;
  /** The DepositAttestation to claim, narrowed by `amount`. Reads our participant: a Loop party reads its own wallet. */
  depositAttestation(query?: { amount?: string }): Promise<DepositAttestation>;
  /** Loop, step one: the command for the Loop wallet to submit. */
  buildLoopCommand(input: LoopCommandInput): Promise<LoopCommand>;
  /** Loop, step two: what the Loop wallet answered. The only writer of a Loop party's history row. */
  reportLoopResult(result: LoopResult): Promise<void>;
  /**
   * Loop, both steps, with your submitter in between. The outcome is reported
   * whether the submit succeeded or not; a failed submit is then rethrown, and a
   * failed report throws `LoopReportError`. Resolves with the report it sent.
   * `checks` keep a cancellation out of history and a rejected submit that
   * landed from being recorded as a failure.
   */
  executeLoop(input: LoopCommandInput, submit: LoopSubmitter, checks?: LoopSubmitChecks): Promise<LoopResult>;
}

export function createBridgeClient(http: Http): BridgeClient {
  const prepareInteractive = (input: PrepareInteractiveInput) =>
    http.post<PreparedInteractive>('/canton-wallet/bridge/prepare-interactive', input);
  const submitInteractive = (input: { submissionKey: string; signature: string }) =>
    http.post<unknown>('/canton-wallet/bridge/submit-interactive', input);
  const buildLoopCommand = (input: LoopCommandInput) => http.post<LoopCommand>('/canton-wallet/bridge/loop-command', input);
  const reportLoopResult = (result: LoopResult) => http.post<void>('/canton-wallet/bridge/loop-result', result);

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
    // The chain recorder stores the node's lowercase hash, and both sides dedup by the exact string.
    registerDeposit: (input) =>
      http.post('/canton-wallet/bridge/history/pending-deposit', { ...input, evmTxHash: input.evmTxHash.toLowerCase() }),
    depositAttestation: (query = {}) => http.post('/canton-wallet/bridge/deposit-attestation', query),
    buildLoopCommand,
    reportLoopResult,
    async executeLoop(input, submit, checks = {}) {
      const command = await buildLoopCommand(input);
      const reported = Object.fromEntries(
        REPORTED_FIELDS.filter((k) => input.params[k] != null).map((k) => [k, input.params[k]]),
      );
      let result: LoopResult;
      let submitError: unknown;
      try {
        const answer = await submit(command);
        if (answer?.status === 'failed') {
          throw new Error(answer.error?.error_message || 'The Loop wallet reported the transaction failed');
        }
        result = { operationType: input.operationType, success: true, transactionId: answer?.update_id, ...reported };
      } catch (err) {
        if (checks.isCancelled?.(err)) throw err;
        if (await checks.landed?.(input).catch(() => false)) {
          result = { operationType: input.operationType, success: true, ...reported };
        } else {
          submitError = err;
          const error = (err instanceof Error ? err.message : String(err)).slice(0, REPORTED_ERROR_MAX);
          result = { operationType: input.operationType, success: false, error, ...reported };
        }
      }
      await reportLoopResult(result).catch((err: unknown) => {
        throw new LoopReportError(result, err);
      });
      if (!result.success) throw submitError;
      return result;
    },
  };
}

/** A bridge client on its own, without assembling the whole client. */
export function bridge(options: ClientOptions): BridgeClient {
  return createBridgeClient(createHttp(options));
}
