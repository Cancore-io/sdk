/**
 * `@cancore/trader/filler/testing` — fixtures for tests of the filler entry and
 * of filler nodes built on it. Nothing here belongs in production: the store is
 * in memory, the signer takes a raw test key.
 */
export { InMemoryFillerStore } from './memoryStore';
export {
  createFakeWebSocketFactory,
  createRecordingEventSink,
  createRecordingLogger,
  createTestTypedDataSigner,
  FakeClock,
  FakeEvmRpc,
  FakeSocket,
} from './fakes';
export type { LogEntry, RpcHandler } from './fakes';
