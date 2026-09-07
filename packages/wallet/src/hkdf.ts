import type { Bytes } from './bytes';

/**
 * HKDF-SHA256(PRF_output, salt, info) -> non-extractable AES-256-GCM KEK.
 * The PRF output is the IKM, never touches storage, and only the derived KEK
 * (as a CryptoKey, not raw bytes) is used to wrap/unwrap the Ed25519 seed.
 * Ported from the proven PoC (poc/passkey/lib/hkdf.ts).
 */

export const WRAP_INFO = 'cancore/passkey-wallet/ed25519-wrap/v1';

export async function deriveWrappingKey(
  prfOutput: Bytes,
  salt: Bytes,
  info: string = WRAP_INFO,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
