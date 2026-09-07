/**
 * What can sign for a party.
 *
 * Raw bytes in, raw signature out — no hex, no base64, no message shape. The
 * shape-checked wrappers (`signChallenge`, `signPreparedHash` in
 * `packages/wallet/src/provider.ts`, REQ-WAL-12 domain separation) sit ABOVE this
 * interface and stay there: a signer that also decides what is safe to sign is
 * a signer every new backend has to re-implement that judgement in.
 *
 * `publicKey` is a property, not a method: every current backend (WebCrypto
 * subtle key, @noble seed, and later vault-transit/Ledger) knows it at
 * construction time.
 */
export interface Signer {
  readonly publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * NOTE on the boundary, checked against the existing code before this file was
 * written (CAN-744, A.1):
 *
 * `packages/wallet/src/web/webauthn.ts` does NOT implement this interface and should not be
 * made to. It runs the WebAuthn create/get ceremonies and returns a PRF output
 * — key-encryption material, not a signature. The passkey path derives a KEK
 * from that output, unwraps the Ed25519 seed, and only then builds a `Signer`.
 * So the browser entry point contributes a KeyStore (IndexedDB) and a secret
 * source (PRF), while every Signer implementation lives in the core.
 *
 * The PRF source has exactly one implementation and one caller, so it gets no
 * interface of its own until a second source exists.
 */
