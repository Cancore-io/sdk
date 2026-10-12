/**
 * `@cancore/trader/filler/testing` — fixtures for tests of the filler entry and
 * of filler nodes built on it. Nothing here belongs in production: the store is
 * in memory, the signer takes a raw test key.
 */
export { InMemoryFillerStore } from './memoryStore';
export { errorSelector, FakeChain, FakeEndpoint, FakeRouter, FakeToken, routerEventTopic } from './fakeChain';
export type { FakeEndpointOptions, FakeIntent, FakeMinedTransaction, FakePendingTransaction } from './fakeChain';
export { createTestFillSigner, decodeSignedTransaction, rlpDecode, rlpEncode } from './transactions';
export type { DecodedTransaction } from './transactions';
export {
  createFakeFetch,
  createFakeGatewayLogin,
  createFakeWebSocketFactory,
  createTestGatewaySigner,
  createRecordingEventSink,
  createRecordingLogger,
  createTestTypedDataSigner,
  FakeClock,
  FakeEvmRpc,
  FakeSocket,
} from './fakes';
export type { FakeAnswer, FakeGatewayLoginOptions, FakeRoute, FrameBody, LogEntry, RecordedRequest, RpcHandler, TestGatewaySigner } from './fakes';
