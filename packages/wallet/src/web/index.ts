/**
 * `@cancore/wallet/web` — the parts that genuinely need a browser.
 *
 * `idb` is the IndexedDB-backed store for wallet records; `webauthn` runs the
 * WebAuthn create/get ceremonies and returns a PRF output — key-encryption
 * material, not a signature (see the boundary note in `../signer.ts`).
 */
export * from './idb';
export * from './webauthn';
