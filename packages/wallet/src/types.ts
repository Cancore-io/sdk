/** Shared types for the production passkey/PRF self-custody wallet foundation. */

export interface RegisterResult {
  credentialIdB64Url: string;
  prfEnabled: boolean;
  authenticatorAttachment: string | null;
  transports: string[];
}

/**
 * Everything needed to re-derive the wrapping key and unwrap the Ed25519 seed
 * later, including after a full page reload (React state is gone, IndexedDB
 * isn't). `saltHex` is a random 32-byte per-user PRF salt generated once at
 * registration — NOT a fixed/static value — and must be reused verbatim on
 * every subsequent `evalPrf` call for this wallet.
 */
export interface PersistedPasskeyWalletRecord {
  credentialIdB64Url: string;
  rpId: string;
  saltHex: string;
  publicKeyHex: string;
  wrappedIvHex: string;
  wrappedCiphertextHex: string;
  createdAt: string;
}
