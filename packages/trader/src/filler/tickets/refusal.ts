import type { DeclineReason } from '@cancore/contracts';

export type TicketCheckId =
  | 'form'
  | 'V-T4'
  | 'V-T2'
  | 'V-T3'
  | 'V-E1'
  | 'V-E2'
  | 'V-E3'
  | 'V-T1'
  | 'V-E4'
  | 'V-E5'
  | 'V-C1'
  | 'V-C2'
  | 'V-C3'
  | 'V-C4'
  | 'V-C5'
  | 'V-C6';

/** A failed check: the issued ticket is declined with `reason`. */
export class Refusal extends Error {
  constructor(
    readonly check: TicketCheckId,
    readonly reason: DeclineReason,
    readonly detail: string,
  ) {
    super(`${check}: ${reason} (${detail})`);
  }
}
