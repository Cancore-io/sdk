/**
 * The filler's own Canton participant, injected. Provisional: the shape the
 * Canton tasks (CAN-1863 Canton source, CAN-1867 Canton delivery) need to start
 * from — read the active contract set, exercise a choice as the filler's party.
 * Those tasks may widen it; nothing in V1 EVM-to-EVM flow calls it.
 */

/** An active contract as the Ledger API returns it, with the payload already decoded to JSON. */
export interface CantonContract {
  contractId: string;
  /** `<package id>:<module>:<entity>`. */
  templateId: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface CantonActiveContractsQuery {
  templateId: string;
}

export interface CantonExerciseCommand {
  templateId: string;
  contractId: string;
  choice: string;
  argument: Readonly<Record<string, unknown>>;
}

export interface CantonExerciseResult {
  updateId: string;
  /** The completion offset, when the participant reports one. */
  offset?: string;
}

export interface CantonLedger {
  /** The filler's Canton party. */
  readonly party: string;
  activeContracts(query: CantonActiveContractsQuery): Promise<readonly CantonContract[]>;
  exercise(command: CantonExerciseCommand): Promise<CantonExerciseResult>;
}
