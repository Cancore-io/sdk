import { bytesToBinaryString, hexToBytes } from './bytes';

/**
 * `@cancore/wallet/operations` — the wallet's client for the Cancore operations
 * envelope (CAN-1040).
 *
 * The core signs; this asks WHAT to sign and says what came back. It is a
 * separate entry point for the same reason `./web` is one: the core promises to
 * run anywhere, and anywhere includes runtimes with no `fetch` and no notion of
 * an authenticated session. So the transport is INJECTED — this module holds no
 * base URL, no token, no cookie, and no opinion about how a request is
 * authorised. A browser app hands it the fetch wrapper it already has; a CLI or
 * an MCP server (CAN-612) hands it something else entirely and gets the same
 * ceremony.
 *
 * What lives here is the part every consumer would otherwise re-derive and get
 * subtly wrong: sign each prepared transaction, address each signature to ITS
 * leg, submit them together.
 */

/** One prepared transaction to sign. `legId` is the handle the submit answers to. */
export interface OperationLeg {
  legId: string;
  /** Base64 prepared-transaction hash, as the participant returned it. */
  hash: string;
  /**
   * What this leg is FOR, for the window that shows it. A CC send prepares TWO
   * — the transfer and its network fee — and one action to a user is still two
   * things to authorise.
   */
  kind: 'transfer' | 'fee' | 'escrow' | 'setup' | 'topology';
}

export interface PreparedOperation<TMeta = Record<string, unknown>> {
  operationId: string;
  /** Empty is a legal success: an operation with nothing left to do says so in `meta`. */
  legs: OperationLeg[];
  meta: TMeta | null;
}

export interface OperationSignature {
  legId: string;
  signature: string;
}

/**
 * Asked between "we know what is prepared" and "we sign it" (CAN-1113). Every
 * ceremony on the envelope shares this one gap — `execute` otherwise goes
 * prepare -> sign -> submit in a single call with nowhere to put a screen.
 *
 * A refusal (`false`) means nothing is signed and nothing is submitted:
 * `execute` throws {@link OperationDeclinedError} instead of proceeding.
 * Optional, so every caller that does not pass one keeps working unchanged.
 */
export type OperationConfirm = (
  legs: OperationLeg[],
  meta: unknown,
) => Promise<boolean>;

/**
 * Thrown by `execute` when `confirm` refuses. A distinct type rather than a
 * plain rejection: a caller has to be able to tell "the user said no" apart
 * from every other way a prepare or a submit can fail, without parsing a
 * message string to do it.
 */
export class OperationDeclinedError extends Error {
  constructor() {
    super('Signing was not confirmed — nothing was signed or submitted.');
    this.name = 'OperationDeclinedError';
  }
}

/**
 * Thrown before anything is signed, when the legs a prepare answered are not
 * ones this wallet signs for that operation (CAN-2399). A distinct type for the
 * same reason as {@link OperationDeclinedError}: "the server asked for
 * something it should not have" is not a network failure, and a caller must be
 * able to say so without reading a message.
 */
export class UnexpectedLegError extends Error {
  constructor(message: string) {
    super(`${message} — nothing was signed.`);
    this.name = 'UnexpectedLegError';
  }
}

/** The one operation that prepares a topology leg: it brings the account's party into being. */
export const TOPOLOGY_OPERATION = 'wallet.topology';

export interface OperationCatalogueEntry {
  type: string;
  params: string;
  flags: string[];
}

/**
 * What can sign a prepared-transaction hash.
 *
 * `signPreparedHash` is the shape-checked path (REQ-WAL-12 domain separation)
 * and every wallet provider this SDK builds implements it. `signMessage` is the
 * older escape hatch, kept because external providers still only offer that.
 */
export interface HashSigner {
  /** @deprecated fallback path — prefer {@link HashSigner.signPreparedHash}. */
  signMessage(message: string): Promise<string>;
  signPreparedHash?(preparedTransactionHashB64: string): Promise<string>;
}

/**
 * The one request shape this module makes: a JSON POST (or a bare GET) to a
 * path on the Cancore API, answered with parsed JSON.
 *
 * Deliberately NOT `typeof fetch`: a consumer's client already knows the base
 * URL and how to authorise, and asking it for a `Response` would mean this
 * module decided what an error is. It doesn't — a rejected promise is a failed
 * request, whatever the consumer's client considers failure.
 */
export type WalletRequest = <T>(
  endpoint: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<T>;

/** Standard (non-URL) base64 of raw bytes. */
function bytesToBase64(bytes: Uint8Array): string {
  return btoa(bytesToBinaryString(bytes));
}

/** Base64 (standard, padded) to the latin1 binary string, one char per byte. */
export function base64ToBinaryString(b64: string): string {
  return atob(b64);
}

/** A lowercase-hex signature to the base64 SIGNATURE_FORMAT_CONCAT Canton takes. */
export function hexSignatureToBase64(hex: string): string {
  return bytesToBase64(hexToBytes(hex.trim().replace(/^0x/i, '')));
}

/**
 * Sign one interactive-submission prepared hash and return the base64 signature
 * the submit expects.
 *
 * Canton's interactive submission takes SIGNATURE_FORMAT_CONCAT as base64 while
 * everything else in the flow speaks hex, and that single mismatch is the whole
 * reason this function exists in one place: a wrong encoding is a rejected
 * transaction, not a retry.
 */
export async function signPreparedHashBase64(
  signer: HashSigner,
  preparedTransactionHashB64: string,
): Promise<string> {
  if (signer.signPreparedHash) {
    return signer.signPreparedHash(preparedTransactionHashB64);
  }
  const rawHex = await signer.signMessage(base64ToBinaryString(preparedTransactionHashB64));
  return hexSignatureToBase64(rawHex);
}

/**
 * The bytes a topology leg has the key sign, or a refusal: a sha2-256 multihash
 * is `0x12` (the function), `0x20` (its 32 bytes), then the digest — 34 bytes.
 */
function topologyMultihash(leg: OperationLeg): string {
  const binary = base64ToBinaryString(leg.hash);
  if (binary.length !== 34 || binary.charCodeAt(0) !== 0x12 || binary.charCodeAt(1) !== 0x20) {
    throw new UnexpectedLegError('A topology leg must be a 34-byte sha2-256 multihash');
  }
  return binary;
}

/**
 * Topology legs are NOT prepared transactions, and this is where that costs
 * something: a topology hash is a 34-byte multihash (`0x12 0x20` + sha256),
 * while {@link HashSigner.signPreparedHash} takes strictly 32 bytes and refuses
 * the rest (REQ-WAL-12 domain separation). So they go through the raw path
 * explicitly, chosen BY KIND — a length check would sooner or later reclassify a
 * real prepared transaction, which is the one mistake that separation exists to
 * prevent.
 *
 * `kind` is the server's word, though, and the raw path signs whatever bytes it
 * is handed (CAN-2399): a leg marked `topology` used to get a signature over a
 * login challenge, a consent text, anything. The kind picks the path and the
 * bytes have to be what that path is for — a multihash and nothing else.
 */
async function signLeg(signer: HashSigner, leg: OperationLeg): Promise<string> {
  if (leg.kind !== 'topology') return signPreparedHashBase64(signer, leg.hash);
  const rawHex = await signer.signMessage(topologyMultihash(leg));
  return hexSignatureToBase64(rawHex);
}

/**
 * Whether these legs are ones the wallet signs — for `operation`, when the
 * caller says which operation prepared them (CAN-2399).
 *
 * A topology leg is signed raw, so it is held to the one ceremony that has
 * one: `wallet.topology` prepares exactly one leg, a topology leg, and no
 * other operation prepares a topology leg at all. Without this a server (or
 * whatever answers in its place) could put a transfer in front of a user who
 * asked to create their party, or a raw signature into a send.
 *
 * Throws {@link UnexpectedLegError}. No legs is always fine: an operation with
 * nothing left to do says so in `meta`.
 */
export function assertOperationLegs(legs: OperationLeg[], operation?: string): void {
  const topology = legs.filter((leg) => leg.kind === 'topology');
  if (topology.length > 0 && legs.length !== 1) {
    throw new UnexpectedLegError('A topology leg is signed alone, and there is only ever one');
  }
  topology.forEach(topologyMultihash);
  if (operation === undefined) return;
  if (operation === TOPOLOGY_OPERATION ? topology.length !== legs.length : topology.length > 0) {
    throw new UnexpectedLegError(`"${operation}" prepared a transaction of a kind it does not have`);
  }
}

export interface SignLegsOptions {
  /**
   * Wait this long between legs.
   *
   * Zero for every ceremony this SDK serves today — the signer is one unlocked
   * key and back-to-back calls are fine. The exception is a signer that opens a
   * UI per signature: a browser extension asked twice in the same tick can drop
   * the second prompt, and the ceremony then hangs on a signature the user was
   * never shown. Callers that have met that pass a pause; nobody else pays for
   * it.
   */
  pauseMsBetweenLegs?: number;
  /**
   * The operation these legs were prepared for (`type` of the prepare). Give
   * it whenever it is known: the legs are then also held to what that
   * operation may prepare — see {@link assertOperationLegs}. `execute` does.
   */
  operation?: string;
}

/**
 * Sign every leg on the one unlocked key.
 *
 * Sequential rather than `Promise.all`: the signer is one key, some providers
 * serialise anyway, and a parallel burst buys nothing a user can perceive while
 * making a failure mid-way harder to attribute. One prompt, whatever the count —
 * asking twice for one action teaches the user that a second prompt is normal,
 * which is the habit an attacker needs.
 */
export async function signLegs(
  signer: HashSigner,
  legs: OperationLeg[],
  options: SignLegsOptions = {},
): Promise<OperationSignature[]> {
  // Before the first signature: a set that is refused must not be half signed.
  assertOperationLegs(legs, options.operation);
  const signed: OperationSignature[] = [];
  for (const leg of legs) {
    if (signed.length > 0 && options.pauseMsBetweenLegs) {
      await new Promise((resolve) => setTimeout(resolve, options.pauseMsBetweenLegs));
    }
    signed.push({ legId: leg.legId, signature: await signLeg(signer, leg) });
  }
  return signed;
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export interface WalletOperations {
  /** Every operation this wallet serves, by name. */
  list(): Promise<OperationCatalogueEntry[]>;
  prepare<TMeta = Record<string, unknown>>(
    type: string,
    params?: Record<string, unknown>,
  ): Promise<PreparedOperation<TMeta>>;
  submit<TResult = unknown>(operationId: string, signatures: OperationSignature[]): Promise<TResult>;
  /**
   * The whole ceremony: prepare, [confirm], sign every leg, submit.
   *
   * NOT for the operations that can legitimately prepare NOTHING — a preapproval
   * that already exists, a wallet with nothing to consolidate. Those answer in
   * `meta`, and the caller has to read it before deciding to submit, so they
   * compose `prepare` and `submit` themselves.
   *
   * `confirm` (CAN-1113) runs after prepare and before any signature. Omit it
   * and this is exactly the call it always was.
   */
  execute<TResult = unknown>(
    signer: HashSigner,
    type: string,
    params?: Record<string, unknown>,
    confirm?: OperationConfirm,
  ): Promise<TResult>;
}

/**
 * The client, once this consumer has bound its transport.
 *
 * Call sites import THIS — `import { wallet } from '@cancore/wallet/operations'`
 * — and never a local re-export, so what a reader sees at the call site is the
 * SDK itself. The one thing the SDK cannot know is how a given consumer
 * authenticates, so that is bound once at startup with
 * {@link configureWalletOperations}; using `wallet` before then is a programming
 * error and says so rather than silently doing nothing.
 */
let bound: WalletOperations | null = null;

/** The transport this consumer already has, handed to the SDK once. */
export function configureWalletOperations(request: WalletRequest): WalletOperations {
  bound = createWalletOperations(request);
  return bound;
}

function client(): WalletOperations {
  if (!bound) {
    throw new Error(
      '@cancore/wallet: call configureWalletOperations(request) before using `wallet` — ' +
        'the SDK holds no transport of its own',
    );
  }
  return bound;
}

export const wallet: WalletOperations = {
  list: () => client().list(),
  prepare: (type, params) => client().prepare(type, params),
  submit: (operationId, signatures) => client().submit(operationId, signatures),
  execute: (signer, type, params, confirm) => client().execute(signer, type, params, confirm),
};

/**
 * A client of its own, for a consumer that wants one instead of the shared
 * `wallet` — a test, or a process serving several accounts at once.
 */
export function createWalletOperations(request: WalletRequest): WalletOperations {
  const prepare = <TMeta = Record<string, unknown>>(
    type: string,
    params?: Record<string, unknown>,
  ): Promise<PreparedOperation<TMeta>> =>
    // An absent `params` and an empty one are not the same request: the backend
    // validates `params` against the operation's own DTO, and an operation that
    // takes no arguments should not be handed an empty shape to validate.
    request<PreparedOperation<TMeta>>('/wallet/operations/prepare', json({ type, ...(params ? { params } : {}) }));

  const submit = <TResult = unknown>(
    operationId: string,
    signatures: OperationSignature[],
  ): Promise<TResult> => request<TResult>('/wallet/operations/submit', json({ operationId, signatures }));

  return {
    list: () => request<OperationCatalogueEntry[]>('/wallet/operations'),
    prepare,
    submit,
    async execute<TResult = unknown>(
      signer: HashSigner,
      type: string,
      params?: Record<string, unknown>,
      confirm?: OperationConfirm,
    ): Promise<TResult> {
      const prepared = await prepare(type, params);
      // Before the screen: a user is not asked to confirm what will not be signed.
      assertOperationLegs(prepared.legs, type);
      if (confirm && !(await confirm(prepared.legs, prepared.meta))) {
        throw new OperationDeclinedError();
      }
      return submit<TResult>(prepared.operationId, await signLegs(signer, prepared.legs, { operation: type }));
    },
  };
}
