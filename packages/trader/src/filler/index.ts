/**
 * `@cancore/trader/filler` — filler protocol v1 for a filler node (sdk.md §3.6).
 *
 * Everything external is injected: signers, EVM RPC, the Canton ledger, the
 * store, clock, logger, events, the WebSocket factory and HTTP. The package
 * holds no keys and no state of its own. Protocol frame shapes and EIP-712
 * types come from `@cancore/contracts`; nothing here re-types them.
 */
export { createFiller } from './filler';
export type {
  BindStakeOptions,
  DrawVerification,
  EscrowVerification,
  Filler,
  FillerConfig,
  FillerStatsSnapshot,
  QuoteDecision,
  QuoteRequestHook,
  ReconfirmHook,
  SelfSettleResult,
  TicketOfferDecision,
  TicketOfferHook,
  TransportOptions,
} from './filler';

export {
  FillerConfigError,
  FillerStoppedError,
  FillerStoreUnavailableError,
  GatewayError,
  NotImplementedError,
  SignatureContractError,
  UnsupportedVersionError,
} from './errors';

export { gatewayMessageDigest, verifyGatewayText } from './protocol/frames';
export type { FrameCheck, FrameExpectations, FrameRejection, GatewayFrame, VerifiedFrame } from './protocol/frames';
export type { ReconnectPolicy } from './protocol/session';

export { cantonFillerPayout, evmFillerPayout } from './quotes';
export type { FillerQuoteRequest, FillerReconfirm, QuoteSkipReason, ReconfirmDeclineReason } from './quotes';
export type { SignatureViolation } from './errors';

export { evmChainNumber, isEvmChainId } from './chains';
export type { Caip2, CantonChainId, EvmChainId } from './chains';

export {
  addressOfPublicKey,
  assertSignature,
  recoverAddress,
  recoverTypedDataSigner,
  signTypedDataChecked,
} from './signer';
export type { EvmTransactionRequest, FillSigner, QuoteSigner, StakingSigner, TransactionSigner, TypedDataSigner } from './signer';

export type { EvmRpc, EvmRpcMap, EvmRpcRequest } from './rpc';

export type {
  CantonActiveContractsQuery,
  CantonContract,
  CantonExerciseCommand,
  CantonExerciseResult,
  CantonLedger,
} from './ledger';

export type {
  AttestationChannel,
  AttestationRecord,
  EvidenceDirection,
  EvidenceEntry,
  FillerStore,
  FillRecord,
  InFlightKind,
  InFlightTransaction,
  NonceAllocation,
  NonceLease,
  NonceLeases,
  NonceRecord,
  OrderTransaction,
  QuoteLedger,
  RuntimeOverrides,
  SettlementRecord,
  SettlementState,
  StoredQuote,
  TicketRecord,
  TicketState,
} from './store';

export { noopEventSink } from './events';
export type {
  AttestedEvent,
  DeclinedEvent,
  EventSink,
  FilledEvent,
  FillerEvent,
  FillerStage,
  PenaltyEvent,
  SettledEvent,
  StageEvent,
} from './events';

export { silentLogger, systemClock } from './runtime';
export type {
  Cancel,
  Clock,
  FillerSocket,
  FillerSocketHandlers,
  HttpFetch,
  HttpRequest,
  HttpResponse,
  LogFields,
  Logger,
  WebSocketFactory,
} from './runtime';
