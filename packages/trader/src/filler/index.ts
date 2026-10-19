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
  CantonConfig,
  CantonDestinationPolicy,
  DrawVerification,
  Filler,
  FillerConfig,
  FillerStatsSnapshot,
  QuoteDecision,
  QuoteRequestHook,
  ReconfirmHook,
  SelfSettleResult,
  TicketPolicy,
  OfferDeclineReason,
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
  signFillerKeyRegistration,
  signTypedDataChecked,
} from './signer';
export type { EvmTransactionRequest, FillSigner, QuoteSigner, StakingSigner, TransactionSigner, TypedDataSigner } from './signer';

export type { EvmRpc, EvmRpcMap, EvmRpcRequest } from './rpc';

export { TicketVerifier } from './tickets/checks';
export { DEFAULT_OFFER_REPLY_MARGIN_MS, OFFER_DECLINE_REASONS } from './tickets/desk';
export type { EscrowVerification, TicketCheckId, TicketCheckInput, TicketCheckResult, TicketVerifierOptions } from './tickets/checks';
export type { CantonSourceReader } from './tickets/canton-source';
export { chainsOf, fillTicketOf, identityFor, ticketMismatch } from './tickets/terms';
export type { OfferTerms, OrderChains, TicketIdentity } from './tickets/terms';

export {
  AbiDecodeError,
  ChainClient,
  ChainReadError,
  hashFillProof,
  hashOrder,
  hashTicket,
  INTENT_STATUS,
  ROUTER_EVENTS,
  RouterEventWatcher,
  RouterReader,
} from './chain';
export type {
  AttestorSetRecord,
  BlockHeader,
  ChainConfig,
  ChainReadFailure,
  EndpointHealth,
  IntentRecord,
  ReadAt,
  RouterEventName,
  RouterEventUpdate,
  RouterEventWatcherOptions,
  RouterLog,
  SourceRouter,
} from './chain';

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
  FillState,
  InclusionProof,
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
  QuoteContent,
  StoredQuote,
  TicketRecord,
  TicketState,
} from './store';

export { DEFAULT_DELIVERY, DEFAULT_SETTLE_URGENCY_MS } from './delivery/executor';
export { FeeCeilingError, REPLACEMENT_FEE_CAP_MULTIPLE, ReplacementCapError } from './delivery/transactions';
export type { DeliveryOptions, DeliveryResult, FillAmountHook, FillAmountInput, FillRefusal } from './delivery/executor';

export { DEFAULT_SETTLEMENT, SettleError } from './settlement/settler';
export type { SettlementOptions, SettleRefusal } from './settlement/settler';
export { collectAttestations, verifyAttestations } from './settlement/attestations';
export type { AttestationAnswer, AttestationVerification, AttestorSetView, CollectedAttestations, RejectedReason, RejectedSignature } from './settlement/attestations';

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

// Canton operations of the filler's own party (§3.19, CAN-2352): what the node checks before its party key signs.
export { CantonRefusal, cantonFingerprint, HASH_PURPOSE, HASHING_SCHEME_V2, legKind, participantId, verifyTopologyLeg, verifyTransactionLeg } from './canton/legs';
export type { PartyExpectation } from './canton/legs';
export type { CantonTransaction, CreateNode, DamlValue, ExerciseNode, FetchNode, RollbackNode, TransactionNode } from './canton/transaction';
export { CantonOperations, createCantonOperations, signatureHex } from './canton/operations';
export type { CantonClientConfig, CantonOperationsOptions, CantonOpCheck, CantonPartySigner, PreparedOf, SubmittedOf } from './canton/operations';
export { canonicalDecimal, checkHoldingsTransfer, checkRegistryAccept, checkTransferExercise, isOwnParty } from './canton/checks';
export type { TransferExpectation } from './canton/checks';
export { CANTON_ALLOCATION_TEMPLATES, CANTON_TRANSFER_FACTORIES } from './canton/factories';
export type { CantonTransferFactory } from './canton/factories';
