import type { DeploymentEnv } from '../deployments';
import type { Hex } from './typedData';

/** The protocol major this package describes: the `/v1` path and `auth.response.protocolVersion`. */
export const PROTOCOL_VERSION = '1';

/**
 * The WebSocket subprotocol of filler protocol v1. A filler offers it on the
 * upgrade of `/v1` together with `bearer.<token>`; filler-gateway answers with
 * this one only and never echoes the token.
 */
export const FILLER_WS_SUBPROTOCOL = 'cancore-filler.v1';
/** Prefix of the second subprotocol a filler offers: `bearer.` + the token of `POST /v1/filler/auth`. */
export const FILLER_WS_BEARER_PREFIX = 'bearer.';

/**
 * The subprotocols a filler offers on the upgrade (`Sec-WebSocket-Protocol`):
 * `['cancore-filler.v1', 'bearer.<token>']`. In a browser
 * `new WebSocket(url, fillerWsProtocols(token))`; with `ws` the same array.
 * The second entry carries the bearer token: never log it.
 */
export function fillerWsProtocols(token: string): readonly [string, string] {
  return [FILLER_WS_SUBPROTOCOL, `${FILLER_WS_BEARER_PREFIX}${token}`];
}

/** Close codes filler-gateway closes a filler session with (protocol §3.1). */
export const FILLER_CLOSE_CODES = {
  /** filler-gateway is shutting down. */
  GOING_AWAY: 1001,
  /** The filler missed its heartbeats. */
  HEARTBEAT_MISSED: 4000,
  /** A newer session of this fillerId superseded this one. */
  SUPERSEDED: 4001,
  /** Cancore staff changed the message key the session was opened with: log in again with the new key. */
  KEY_CHANGED: 4002,
  /** The filler is no longer `ACTIVE` (suspended). */
  NOT_ACTIVE: 4003,
  /** This session's inbound queue overflowed (count or bytes); only this session is closed. */
  QUEUE_OVERFLOW: 4008,
  /**
   * Sustained excess over the rate limits: every session of the fillerId is
   * closed and its upgrades and bearer requests are refused for a cooldown;
   * the `error RATE_LIMITED` sent just before carries `retryAfterMs` = the
   * remaining cooldown.
   */
  RATE_LIMITED: 4029,
} as const;
export type FillerCloseCode = (typeof FILLER_CLOSE_CODES)[keyof typeof FILLER_CLOSE_CODES];

/**
 * HTTP statuses filler-gateway refuses the WebSocket upgrade with — a plain
 * HTTP response, no WebSocket, nothing signed. A client sees the upgrade fail
 * before the socket opens.
 */
export const FILLER_UPGRADE_REFUSALS = {
  /** `cancore-filler.v1` not offered, or not exactly one `bearer.` entry. */
  400: 'BAD_REQUEST',
  /** The token is missing, unknown or expired, or the message key changed. */
  401: 'UNAUTHENTICATED',
  /** The filler is unknown or not `ACTIVE`. */
  403: 'NOT_ACTIVE',
  /** The login rate class is over its limit, or the fillerId is cooling down; `Retry-After` in seconds. */
  429: 'RATE_LIMITED',
  /** The replica is at its connection limit, or the fillerId already holds its maximum of live sessions. */
  503: 'UNAVAILABLE',
} as const;

export interface FillerGateway {
  /** The key every S→F message is signed with (`GatewayMessage`); null until the environment has one. */
  gateway: Hex | null;
  /** Keys that sign `FillTicket`; the same set is registered on every router of the environment. */
  ticketSigners: readonly Hex[];
}

/**
 * The published gateway key and ticket signers per environment — the release
 * data a taker checks every S→F signature and every ticket against, and never
 * takes from a gateway message. Empty in the RC: the keys do not exist yet
 * (O-6); the gateway release fills them in. Test keys never appear here.
 */
export const FILLER_GATEWAYS: Readonly<Record<DeploymentEnv, FillerGateway>> = {
  mainnet: { gateway: null, ticketSigners: [] },
  testnet: { gateway: null, ticketSigners: [] },
  devnet: { gateway: null, ticketSigners: [] },
};
