/**
 * `@cancore/test-kit` — a mock Cancore filler gateway for a taker's CI:
 * protocol v1 over WebSocket (`/v1`) and REST, every S→F message signed with
 * the TEST gateway key, a frozen clock the test moves, failure modes switched
 * from the test, and the harness that checks the taker's reaction.
 *
 * TEST ONLY: the keys are public (keys.ts). A taker under test must trust
 * `TEST_KEYS.gateway.address` and `TEST_KEYS.ticketSigner.address` in place
 * of `FILLER_GATEWAYS` from `@cancore/contracts`.
 */
import { assertTakerReaction } from './conformance';
import type { LogEntry } from './conformance';
import { drop, health } from './control';
import { DEFAULT_CONFIG, MockGateway } from './gateway';
import type { MockConfig, Signed } from './gateway';
import { rfq } from './quoting';
import type { RfqOptions } from './quoting';
import { parseMode } from './scenario';
import type { Mode } from './scenario';
import { serve } from './server';
import { offerFixture } from './ticketing';

export { TEST_KEYS, testKey, sign, recover, addressOf, BadSignatureError } from './keys';
export type { Hex, TestKey, TestKeyRole } from './keys';
export { MODES, parseMode, UnknownModeError } from './scenario';
export type { Mode } from './scenario';
export { TAKER_EXPECTATIONS, assertTakerReaction, issuedLate, TakerConformanceError } from './conformance';
export type { LogEntry, TakerExpectation } from './conformance';
export { gatewaySigner, signGateway } from './protocol';
export { FIXTURE_ORDER, FIXTURE_T0, DEFAULT_FILLERS, DEFAULT_LEAVES, SOURCE, DESTINATION } from './fixtures';
export type { FillerConfig } from './fixtures';
export { DEFAULT_CONFIG } from './gateway';
export type { MockConfig } from './gateway';
export type { RfqOptions } from './quoting';

export interface MockGatewayOptions extends Partial<MockConfig> {
  /** Default 127.0.0.1. */
  host?: string;
  /** Protocol port (WebSocket `/v1` + REST); 0 = ephemeral. Default 8787. */
  port?: number;
  /** `/__mock/*`; 0 = ephemeral. Default 8788. */
  controlPort?: number;
}

export interface MockGatewayHandle {
  /** `ws://host:port/v1` */
  url: string;
  httpUrl: string;
  controlUrl: string;
  config: Readonly<MockConfig>;
  /** Read or switch the scenario; an unknown one throws `UnknownModeError` (with `allowed`). */
  scenario(mode?: string): Mode;
  now(): number;
  /** Move the clock and run what fell due; returns the new time. */
  advance(ms: number): number;
  reset(): void;
  rfq(opts?: RfqOptions): { requestId: string; windowCloseAt: number; quoteTtlMs: number };
  /** Offer the session's fixture order (next attempt) to a taker. */
  offer(fillerId?: string): Signed;
  drop(fillerId?: string): number;
  log(): LogEntry[];
  health(): ReturnType<typeof health>;
  assertTakerReaction(mode: Mode, opts?: { fillerId?: string }): void;
  close(): Promise<void>;
}

export async function startMockGateway(opts: MockGatewayOptions = {}): Promise<MockGatewayHandle> {
  const { host = '127.0.0.1', port = 8787, controlPort = 8788, ...cfg } = opts;
  const gw = new MockGateway({ ...DEFAULT_CONFIG, ...cfg });
  const net = await serve(gw, { host, port, controlPort });
  return {
    url: net.url,
    httpUrl: net.httpUrl,
    controlUrl: net.controlUrl,
    config: gw.cfg,
    scenario: (mode) => (mode === undefined ? gw.mode : (gw.mode = parseMode(mode))),
    now: () => gw.now(),
    advance: (ms) => (gw.clock.advance(ms), gw.now()),
    reset: () => gw.reset(),
    rfq: (o) => rfq(gw, o),
    offer: (fillerId = 'acme-markets') => offerFixture(gw, fillerId),
    drop: (fillerId) => drop(gw, fillerId),
    log: () => [...gw.entries],
    health: () => health(gw),
    assertTakerReaction: (mode, o) => assertTakerReaction(gw.entries, mode, o),
    close: () => (gw.reset(), net.close()),
  };
}
