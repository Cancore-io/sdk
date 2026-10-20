/**
 * The filler's own routes (protocol §3.20): Cancore staff approve the routes
 * a filler may serve; the filler switches each approved route on or off
 * itself with a `routes.set` sealed by its message key, applied at once. A
 * route that is not approved refuses the whole request (`ROUTE_NOT_APPROVED`)
 * and nothing changes. Over REST, with a login of its own: a node command run
 * outside the filler session.
 */
import type { Hex, RouteRef, RoutesSet, RoutesState } from '@cancore/contracts';
import { FillerConfigError } from './errors';
import { createSealer, type Sealer } from './protocol/envelope';
import { GatewayRest } from './protocol/rest';
import { silentLogger, systemClock, type Clock, type HttpFetch, type Logger } from './runtime';
import type { QuoteSigner } from './signer';

const CAIP2 = /^(eip155:[1-9][0-9]*|canton:(mainnet|testnet|devnet))$/;
/** The schema's cap on one `routes.set`. */
export const MAX_ROUTES = 50;

export interface FillerRoutesOptions {
  rest: Pick<GatewayRest, 'getRoutes' | 'postRoutes'>;
  seal: Sealer;
  nextId: () => string;
}

export class FillerRoutes {
  constructor(private readonly options: FillerRoutesOptions) {}

  /** Every route approved for this filler and whether it serves it now. */
  async state(): Promise<RoutesState> {
    return (await this.options.rest.getRoutes()).frame as unknown as RoutesState;
  }

  /**
   * Serve exactly `routes` from now on: approved routes not listed are switched
   * off. Duplicates are dropped; a malformed route is refused here, before anything is signed.
   */
  async set(routes: readonly RouteRef[]): Promise<RoutesState> {
    const unique = new Map<string, RouteRef>();
    for (const [i, r] of routes.entries()) {
      if (!CAIP2.test(String(r?.src)) || !CAIP2.test(String(r?.dst))) throw new FillerConfigError(`routes[${i}]`, 'expected {src, dst}, each a CAIP-2 chain id');
      unique.set(`${r.src}>${r.dst}`, { src: r.src, dst: r.dst });
    }
    if (unique.size > MAX_ROUTES) throw new FillerConfigError('routes', `at most ${MAX_ROUTES} routes`);
    const message = await this.options.seal<RoutesSet>({ type: 'routes.set', id: this.options.nextId(), routes: [...unique.values()] });
    return (await this.options.rest.postRoutes(message)).frame as unknown as RoutesState;
  }
}

export interface FillerRoutesConfig {
  /** `wss://<filler-gateway host>/v1`; the routes are REST on the same host. */
  gatewayUrl: string;
  fillerId: string;
  /** The pinned filler-gateway signer (`FILLER_GATEWAYS[env].gateway`). */
  gatewaySigner: Hex;
  /** The message key: logs in and seals `routes.set`. */
  messageSigner: QuoteSigner;
  /** Defaults to the global `fetch`. */
  fetch?: HttpFetch;
  clock?: Clock;
  logger?: Logger;
  /** Distinguishes this process's message ids; defaults to a random UUID. */
  instanceId?: string;
}

export function createFillerRoutes(config: FillerRoutesConfig): FillerRoutes {
  const clock = config.clock ?? systemClock;
  const logger = config.logger ?? silentLogger;
  const fetch = config.fetch ?? ((globalThis as { fetch?: HttpFetch }).fetch as HttpFetch | undefined);
  if (typeof fetch !== 'function') throw new FillerConfigError('fetch', 'no global fetch; pass an HttpFetch');
  const prefix = `${(config.instanceId ?? globalThis.crypto.randomUUID()).slice(0, 36)}:${clock.now().toString(36)}:routes`;
  let sequence = 0;
  const nextId = () => `${prefix}:${(sequence++).toString(36)}`;
  const seal = createSealer({ fillerId: config.fillerId, messageSigner: config.messageSigner, clock });
  const rest = new GatewayRest({
    gatewayUrl: config.gatewayUrl,
    fillerId: config.fillerId,
    gatewaySigner: config.gatewaySigner,
    quoteSigner: config.messageSigner,
    seal,
    fetch,
    clock,
    logger,
    nextId,
  });
  return new FillerRoutes({ rest, seal, nextId });
}
