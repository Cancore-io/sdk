import type { DeploymentEnv } from '../deployments';
import type { Hex } from './typedData';

/** The protocol major this package describes: the `/v1` path and `auth.response.protocolVersion`. */
export const PROTOCOL_VERSION = '1';

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
