import type { LogEntry } from './conformance';
import type { Mode } from './scenario';
export { TEST_KEYS, sign, recover, addressOf } from './keys';
export interface MockGatewayOptions { port?: number; controlPort?: number; host?: string }
export interface MockGatewayHandle {
  url: string; httpUrl: string; controlUrl: string;
  scenario(mode?: string): Mode; now(): number; advance(ms: number): number;
  offer(fillerId: string): Record<string, unknown>; log(): LogEntry[];
  assertTakerReaction(mode: Mode, opts?: { fillerId?: string }): void; close(): Promise<void>;
}
export async function startMockGateway(_o: MockGatewayOptions = {}): Promise<MockGatewayHandle> { throw new Error('not implemented'); }
