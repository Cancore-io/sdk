import type { Bytes } from './bytes';

/**
 * Password-derived KEK for the Loop-parity key+password wallet.
 *
 * PBKDF2-SHA256(password, salt) -> non-extractable AES-256-GCM KEK, the same
 * shape of key `deriveWrappingKey` (PRF path) produces, so both unlock methods
 * wrap/unwrap the SAME Ed25519 seed via aesGcm.
 *
 * Argon2id (rollout plan §3.1) is the hardening target — memory-hard, better
 * against GPU cracking — but it needs a wasm dependency. PBKDF2 ships today via
 * native WebCrypto with no dependency. The iteration count is stored per wallet
 * record, and `unlockKeyPasswordWallet` re-wraps a record whose parameters are
 * behind the current ones — so bumping the count, or moving to Argon2id, is a
 * migration that happens on the next successful unlock rather than a breaking
 * change. (That re-wrap did not exist when this comment first claimed it did;
 * the key-storage audit of 2026-09-04 found the gap, KS-2.)
 */

export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_HASH = 'SHA-256';

/**
 * What a derived key is allowed to open.
 *
 * A record holds two secrets — the seed and, when the wallet was created from
 * one, the BIP39 phrase. Until v2 both were wrapped under the SAME key, so
 * nothing distinguished the two ciphertexts: they were interchangeable inputs
 * to the same unwrap, and a bug (or an edited store) that confused them
 * decrypted successfully and failed later somewhere less obvious.
 *
 * The phrase is the more dangerous of the two to leak: a seed is ours, a phrase
 * types into any BIP39 wallet on any device.
 */
export type KekRole = 'seed' | 'mnemonic';

const HKDF_INFO: Record<KekRole, string> = {
  seed: 'cancore/wallet/kek/seed/v2',
  mnemonic: 'cancore/wallet/kek/mnemonic/v2',
};

/**
 * The two KEKs of a v2 record: PBKDF2 for the cost, HKDF for the separation.
 *
 * PBKDF2 is what makes a guess expensive and it runs ONCE; HKDF then splits its
 * output per role, which is free. Doing the split with a second PBKDF2 pass
 * would double the unlock time to buy exactly nothing.
 */
export async function deriveRecordKeks(
  password: string,
  salt: Bytes,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<Record<KekRole, CryptoKey>> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const stretched = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: PBKDF2_HASH },
    material,
    256,
  );
  const ikm = await crypto.subtle.importKey('raw', stretched, 'HKDF', false, ['deriveKey']);
  const derive = (role: KekRole) =>
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(HKDF_INFO[role]) },
      ikm,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  const [seed, mnemonic] = await Promise.all([derive('seed'), derive('mnemonic')]);
  return { seed, mnemonic };
}

/**
 * The v1 KEK: PBKDF2 straight to one AES key, used for both secrets.
 *
 * Kept because records written that way are on people's devices and must keep
 * opening. Nothing writes v1 any more — `unlockKeyPasswordWallet` upgrades a v1
 * record the first time it is opened.
 */
export async function deriveKeyFromPassword(
  password: string,
  salt: Bytes,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: PBKDF2_HASH },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
