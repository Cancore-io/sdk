/**
 * What the mock does wrong on purpose. One mode at a time, switched from the
 * test (`POST /__mock/scenario`, `gw.scenario(mode)`). The expected taker
 * reaction to each is in conformance.ts. Out of the mock (need a chain or a
 * participant, CAN-1876 stand): ESCROW_*, PROOF_WINDOW_TOO_SHORT,
 * SKEW_MARGIN_TOO_SHORT. DUP_ACK is not a mode: a repeated intent already
 * gets the identical ack (B10).
 */
export const MODES = [
  'HAPPY',
  'LATE_ISSUED',
  'FOREIGN_TICKET_SIG',
  'FIELD_MISMATCH',
  'SHORT_TTL',
  'BEYOND_DEADLINE',
  'WRONG_DRAW',
  'BAD_GATEWAY_SIG',
  'UNSUPPORTED_VERSION',
  'DROP_CONNECTION',
  'NO_ISSUED',
  'CANTON_DESTINATION',
  'UNKNOWN_S2F_TYPE',
] as const;

export type Mode = (typeof MODES)[number];

export class UnknownModeError extends Error {
  override name = 'UnknownModeError';
  readonly allowed: Mode[] = [...MODES];
  constructor(value: unknown) {
    super(`unknown scenario ${JSON.stringify(value)}; allowed: ${MODES.join(', ')}`);
  }
}

export function parseMode(value: unknown): Mode {
  if (typeof value === 'string' && (MODES as readonly string[]).includes(value)) return value as Mode;
  throw new UnknownModeError(value);
}
