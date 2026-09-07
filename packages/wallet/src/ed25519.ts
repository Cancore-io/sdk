import { ed25519 } from '@noble/curves/ed25519';
import type { Bytes } from './bytes';

/**
 * Ed25519 signing with two backends, both proven byte-for-byte identical in
 * the passkey PoC (poc/passkey/lib/ed25519WebCrypto.test.ts):
 *  - WebCrypto `subtle` (Baseline 2025: Chrome 137+/Firefox 130+/Safari 17+).
 *    Preferred — the imported signing key is non-extractable, so the raw
 *    seed never exists as a JS value again once imported.
 *  - `@noble/curves` fallback for runtimes without a working `subtle`
 *    Ed25519 implementation.
 * The choice is feature-detected once per unlock via `createEd25519Signer`.
 */

// PKCS8 DER wrapper for a raw 32-byte Ed25519 seed (RFC 8410). Fixed 16-byte
// ASN.1 prefix followed by the 32-byte seed (48 bytes total) — WebCrypto only
// accepts PKCS8, not the raw seed.
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export function isSubtleEd25519Supported(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
}

async function importSubtleSigningKey(seed: Bytes): Promise<CryptoKey> {
  if (seed.length !== 32) throw new Error('Ed25519 seed must be 32 bytes');
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

export async function importSubtleVerifyKey(publicKey: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
}

export async function signWithSubtle(key: CryptoKey, message: Bytes): Promise<Bytes> {
  const signature = await crypto.subtle.sign('Ed25519', key, message);
  return new Uint8Array(signature);
}

export async function verifyWithSubtle(
  key: CryptoKey,
  signature: Bytes,
  message: Bytes,
): Promise<boolean> {
  return crypto.subtle.verify('Ed25519', key, signature, message);
}

export interface Ed25519KeyPair {
  seed: Bytes;
  publicKey: Bytes;
}

/** Generate a fresh random Ed25519 keypair (noble — sync, no subtle dependency). */
export function generateEd25519KeyPair(): Ed25519KeyPair {
  const seed = new Uint8Array(ed25519.utils.randomSecretKey());
  const publicKey = new Uint8Array(ed25519.getPublicKey(seed));
  return { seed, publicKey };
}

/**
 * Derive the Ed25519 public key from a raw 32-byte seed (noble — sync). Used
 * when importing a wallet from a user-supplied private key (the seed): the
 * public key — and hence the Canton party id — is fully determined by the seed.
 */
export function ed25519PublicKeyFromSeed(seed: Bytes): Bytes {
  return new Uint8Array(ed25519.getPublicKey(seed));
}

/**
 * In-memory handle for an unlocked signing key. Once `kind: 'subtle'`, the
 * raw seed is gone — only the non-extractable CryptoKey remains in scope.
 */
export type Ed25519Signer = { kind: 'subtle'; key: CryptoKey } | { kind: 'noble'; seed: Bytes };

/**
 * Build a signer for a freshly-unwrapped seed. Prefers the non-extractable
 * WebCrypto path; falls back to @noble/curves when the runtime's `subtle`
 * doesn't actually support the `Ed25519` algorithm (feature-detected by
 * attempting the key import itself, not just checking `crypto.subtle` exists).
 */
export async function createEd25519Signer(seed: Bytes): Promise<Ed25519Signer> {
  if (isSubtleEd25519Supported()) {
    try {
      const key = await importSubtleSigningKey(seed);
      return { kind: 'subtle', key };
    } catch {
      // Fall through to noble, e.g. subtle exists but doesn't support Ed25519.
    }
  }
  return { kind: 'noble', seed };
}

/** Sign `message` with an unlocked signer, dispatching to whichever backend it holds. */
export async function signWithEd25519Signer(signer: Ed25519Signer, message: Bytes): Promise<Bytes> {
  if (signer.kind === 'subtle') return signWithSubtle(signer.key, message);
  return new Uint8Array(ed25519.sign(message, signer.seed));
}

/** Verify a signature against a raw hex-free public key, trying subtle first then noble. */
export async function verifyEd25519(
  publicKey: Bytes,
  signature: Bytes,
  message: Bytes,
): Promise<boolean> {
  if (isSubtleEd25519Supported()) {
    try {
      const key = await importSubtleVerifyKey(publicKey);
      return await verifyWithSubtle(key, signature, message);
    } catch {
      // Fall through to noble.
    }
  }
  return ed25519.verify(signature, message, publicKey);
}
