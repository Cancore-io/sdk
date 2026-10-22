import { API_NETWORKS, networkOf, type DvpNetwork } from '@cancore/client/selfcustody';
import type { BotConfig } from './config';

/**
 * The network the daemon trades on, refused before any engine or API call exists. The host decides, whatever
 * `network` says: the network picks the pinned venue, fee pools and instrument admins, so a label must not move a
 * host onto another network's pins.
 */
export function tradingNetwork(config: Pick<BotConfig, 'baseUrl' | 'network'>): DvpNetwork {
  // TLS too: the API answers carry the prices the USD caps and the price corridor trust.
  const tls = (() => { try { return new URL(config.baseUrl).protocol === 'https:'; } catch { return false; } })();
  if (!tls) throw new Error(`cancore-botd: ${config.baseUrl} must be an https URL`);
  const byHost = networkOf(config.baseUrl);
  if (!byHost) throw new Error(`cancore-botd: ${config.baseUrl} is not a Cancore API host (${Object.keys(API_NETWORKS).join(', ')})`);
  if (config.network !== undefined && config.network !== byHost) {
    throw new Error(`cancore-botd: network ${config.network} does not match ${config.baseUrl}, which is ${byHost}`);
  }
  return byHost;
}

/** Why a make came back without an order, which decides what its intent and hourly slot become. */
export type MakeFailure = 'throttled' | 'refused' | 'lost';

export function makeFailure(err: unknown): MakeFailure {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return 'lost';
  // 429 is the platform's per-person hourly order limit, which the API checks before order creation writes
  // anything (CAN-2979): a definite no, not a lost answer.
  if (status === 429) return 'throttled';
  // A 4xx answer (not a timeout) is the API's refusal: it made no order. Anything else may have made one.
  return status >= 400 && status < 500 && status !== 408 ? 'refused' : 'lost';
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
