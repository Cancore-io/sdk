/**
 * Typed errors of `@cancore/trader/filler`. Each carries a machine-readable
 * field, so a filler node can branch on it without parsing messages.
 */

/** A required dependency is missing or a config value is malformed. Thrown by `createFiller` and `start()`. */
export class FillerConfigError extends Error {
  override readonly name = 'FillerConfigError';
  constructor(
    /** The config field (or hook) at fault, e.g. `webSocket`, `fillSigners.eip155:1`, `onQuoteRequest`. */
    readonly field: string,
    message: string,
  ) {
    super(`createFiller: ${field}: ${message}`);
  }
}

/**
 * What is wrong with a signature, per the wire rule of protocol §3.1:
 * 65 bytes `r ‖ s ‖ v`, low-s, `v ∈ {27, 28}`.
 */
export type SignatureViolation =
  | 'not-hex'
  | 'length'
  | 'zero-r-or-s'
  | 'r-out-of-range'
  | 'high-s'
  | 'v'
  /** Well-formed, but recovers to another address than the signer claims. */
  | 'signer-mismatch';

/** A signature broke the signer contract. The signature is never used after this is thrown. */
export class SignatureContractError extends Error {
  override readonly name = 'SignatureContractError';
  constructor(
    readonly violation: SignatureViolation,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The store cannot be reached. A `FillerStore` implementation throws this (and
 * only this) for an outage, so the SDK can tell an outage from a bug and take
 * no work until the store is back (filler-node N-36).
 */
export class FillerStoreUnavailableError extends Error {
  override readonly name = 'FillerStoreUnavailableError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** A method of the public skeleton whose implementation lands in a later task. */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
  constructor(
    readonly method: string,
    /** The Linear task that implements it. */
    readonly task: string,
  ) {
    super(`@cancore/trader/filler: ${method}() is not implemented yet (${task})`);
  }
}
