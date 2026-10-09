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

/**
 * A refusal from filler-gateway: the `error` frame on WebSocket, or the error
 * body of a non-2xx REST reply (protocol §3.5 «Errors»). `code` is open (V-2):
 * a code this SDK does not know is kept as received, with `known` false, and
 * handled as a generic refusal.
 */
export class GatewayError extends Error {
  override readonly name: string = 'GatewayError';
  constructor(
    /** The protocol error code as received, e.g. `BAD_SIGNATURE`, `TICKET_CLOSED`. */
    readonly code: string,
    /** Whether `code` is one of `ERROR_CODES` of `@cancore/contracts`. */
    readonly known: boolean,
    message: string,
    /** The `id` of the filler → filler-gateway message it answers, when it answers one. */
    readonly re?: string,
    /** The HTTP status, when it came over REST. */
    readonly httpStatus?: number,
    /**
     * With `RATE_LIMITED`: how long, in ms, nothing of the refused rate class
     * may be sent — the error's `retryAfterMs`, else the `Retry-After` header.
     * The SDK holds that class back for this long by itself.
     */
    readonly retryAfterMs?: number,
  ) {
    super(`filler-gateway ${code}: ${message}`);
  }
}

/**
 * filler-gateway does not serve the protocol version this SDK speaks (V-1). The
 * session is not retried: reconnecting cannot help until the SDK is upgraded.
 * `start()` rejects with it.
 */
export class UnsupportedVersionError extends GatewayError {
  override readonly name = 'UnsupportedVersionError';
}

/** `stop()` was called while `start()` was still waiting for the first login. */
export class FillerStoppedError extends Error {
  override readonly name = 'FillerStoppedError';
  constructor() {
    super('@cancore/trader/filler: stopped before the first login completed');
  }
}
