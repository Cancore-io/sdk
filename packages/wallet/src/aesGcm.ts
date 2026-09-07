import { bytesToHex, hexToBytes, type Bytes } from './bytes';

/**
 * AES-256-GCM wrap/unwrap of the raw Ed25519 seed under the HKDF-derived KEK.
 * Ported from the proven PoC (poc/passkey/lib/aesGcm.ts).
 *
 * `aad` is the record this ciphertext belongs to, authenticated but not
 * encrypted (KS-5 of the 2026-09-04 key-storage audit). Without it the bytes
 * are bound to nothing: salt + iv + ciphertext transplanted from another record
 * decrypt happily under that record's password, and the mistake only surfaces
 * later, as a key that does not match its party. With it, GCM refuses at the
 * point that exists for refusing.
 */

export interface WrappedSeed {
  ivHex: string;
  ciphertextHex: string;
}

const IV_BYTES = 12;

export async function wrapSeed(kek: CryptoKey, seed: Bytes, aad?: Bytes): Promise<WrappedSeed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const params: AesGcmParams = { name: 'AES-GCM', iv, ...(aad ? { additionalData: aad } : {}) };
  const ciphertext = await crypto.subtle.encrypt(params, kek, seed);
  return { ivHex: bytesToHex(iv), ciphertextHex: bytesToHex(new Uint8Array(ciphertext)) };
}

export async function unwrapSeed(kek: CryptoKey, wrapped: WrappedSeed, aad?: Bytes): Promise<Bytes> {
  const iv = hexToBytes(wrapped.ivHex);
  const ciphertext = hexToBytes(wrapped.ciphertextHex);
  const params: AesGcmParams = { name: 'AES-GCM', iv, ...(aad ? { additionalData: aad } : {}) };
  const plaintext = await crypto.subtle.decrypt(params, kek, ciphertext);
  return new Uint8Array(plaintext);
}
