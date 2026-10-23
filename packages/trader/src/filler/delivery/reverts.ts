import { CANCORE_ROUTER_ERRORS, describeRevert } from '@cancore/contracts';
import { ChainReadError } from '../chain/client';

/** The message of an error, or its string form. */
export const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The custom error a reverted call names, from the revert data of the RPC error. */
export function revertName(error: unknown): string {
  const cause = error instanceof ChainReadError ? error.cause : error;
  const data = typeof cause === 'object' && cause !== null ? (cause as { data?: unknown }).data : undefined;
  const hex = typeof data === 'string' ? data : typeof data === 'object' && data !== null && typeof (data as { data?: unknown }).data === 'string' ? (data as { data: string }).data : undefined;
  const name = hex && /^0x[0-9a-fA-F]{8}/.test(hex) ? describeRevert(hex, [CANCORE_ROUTER_ERRORS]) : undefined;
  return name ?? reasonOf(error);
}

/** A transport failure, or a revert a later block lifts: the latest block short of `validFrom` (CAN-2986). */
export const retryableEstimateFailure = (error: unknown): boolean => !(error instanceof ChainReadError) || error.reason !== 'reverted' || revertName(error).startsWith('TicketNotYetValid');
