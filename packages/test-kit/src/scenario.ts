export const MODES = ['HAPPY'] as const;
export type Mode = 'HAPPY' | 'LATE_ISSUED' | 'FOREIGN_TICKET_SIG' | 'FIELD_MISMATCH' | 'SHORT_TTL' | 'BEYOND_DEADLINE' | 'WRONG_DRAW' | 'BAD_GATEWAY_SIG' | 'UNSUPPORTED_VERSION' | 'DROP_CONNECTION' | 'NO_ISSUED' | 'CANTON_DESTINATION' | 'UNKNOWN_S2F_TYPE';
export class UnknownModeError extends Error { allowed: Mode[] = []; }
export function parseMode(_x: unknown): Mode { throw new Error('not implemented'); }
