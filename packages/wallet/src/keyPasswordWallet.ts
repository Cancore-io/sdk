import {
  bytesToHex,
  hexToBytes,
  binaryStringToBytes,
  bytesToBinaryString,
  type Bytes,
} from './bytes';
import { wrapSeed, unwrapSeed } from './aesGcm';
import {
  ed25519PublicKeyFromSeed,
  createEd25519Signer,
  signWithEd25519Signer,
  verifyEd25519,
  type Ed25519Signer,
} from './ed25519';
import {
  deriveKeyFromPassword,
  deriveRecordKeks,
  PBKDF2_ITERATIONS,
  type KekRole,
} from './passwordKek';
import {
  LEGACY_WALLET_RECORD_VERSION,
  WALLET_RECORD_VERSION,
  walletRecordVersion,
} from './recordVersion';

export { WALLET_RECORD_VERSION, walletRecordVersion } from './recordVersion';

/**
 * Loop-parity self-custody wallet: a random Ed25519 seed IS the private key.
 * The user is shown the seed (their portable "private key") and sets a password
 * that wraps it at rest. On another device they re-enter private key + password
 * and are back in — the server stores nothing. Both this path and the passkey
 * path produce the same kind of wrapped-seed record and the same signer.
 *
 * These functions are pure crypto: no IndexedDB, no network. Persistence and
 * React state live in the hook that consumes them.
 */

const SALT_BYTES = 16;
const SEED_BYTES = 32;

/**
 * What each ciphertext is authenticated against: the record it lives in and the
 * secret it holds. Not encrypted — an attacker reading the store already knows
 * all of it. What it buys is that bytes moved between records, or between the
 * two fields of one record, fail to decrypt (KS-5).
 */
function recordAad(publicKeyHex: string, role: KekRole): Bytes {
  return new TextEncoder().encode(`cancore/wallet/v2|pbkdf2|${publicKeyHex}|${role}`);
}

/** Both secrets of a record, opened according to the version that wrote it. */
async function openRecord(
  record: PersistedKeyPasswordWalletRecord,
  password: string,
): Promise<{ seed: Bytes; mnemonic?: string }> {
  const salt = hexToBytes(record.saltHex);
  const legacy = walletRecordVersion(record) <= LEGACY_WALLET_RECORD_VERSION;

  // v1 wrapped both secrets under one key and authenticated neither; v2 gives
  // each its own key and binds it to this record. The branch is what lets a
  // wallet written by an older release keep opening.
  const keks = legacy
    ? (() => null)()
    : await deriveRecordKeks(password, salt, record.iterations);
  const legacyKek = legacy ? await deriveKeyFromPassword(password, salt, record.iterations) : null;

  const seedKek = keks ? keks.seed : legacyKek!;
  const seedAad = legacy ? undefined : recordAad(record.publicKeyHex, 'seed');

  let seed: Bytes;
  try {
    seed = await unwrapSeed(
      seedKek,
      { ivHex: record.wrappedIvHex, ciphertextHex: record.wrappedCiphertextHex },
      seedAad,
    );
  } catch {
    // AES-GCM decryption throws on a bad auth tag — i.e. wrong password. It also
    // throws when the additional data does not match, which is a record that was
    // edited underneath us; both are "this does not open", and telling them
    // apart out loud would only tell an attacker which of the two they achieved.
    throw new WrongPasswordError();
  }

  if (!record.mnemonicIvHex || !record.mnemonicCiphertextHex) return { seed };

  const mnemonicKek = keks ? keks.mnemonic : legacyKek!;
  const mnemonicBytes = await unwrapSeed(
    mnemonicKek,
    { ivHex: record.mnemonicIvHex, ciphertextHex: record.mnemonicCiphertextHex },
    legacy ? undefined : recordAad(record.publicKeyHex, 'mnemonic'),
  );
  return { seed, mnemonic: bytesToBinaryString(mnemonicBytes) };
}

/** True when the record was written by an older format or weaker parameters. */
function isStale(record: PersistedKeyPasswordWalletRecord, target: number): boolean {
  return walletRecordVersion(record) < WALLET_RECORD_VERSION || record.iterations < target;
}

/** Wrong-password unlock: AES-GCM auth tag failed to verify. */
export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect password');
    this.name = 'WrongPasswordError';
  }
}

/** Malformed private key on import (not 32 bytes of hex). */
export class InvalidPrivateKeyError extends Error {
  constructor(message = 'Invalid private key: expected 32 bytes (64 hex characters)') {
    super(message);
    this.name = 'InvalidPrivateKeyError';
  }
}

/** The unlocked key cannot sign for the public key it claims — see assertKeyBinding. */
export class KeyBindingError extends Error {
  constructor() {
    super('This key does not sign for its own public key — the wallet was not set up correctly');
    this.name = 'KeyBindingError';
  }
}

/**
 * Prove the key actually signs for `publicKeyHex`: sign a fixed, domain-separated
 * probe and verify it right here. Registering (or unlocking) a wallet whose key
 * cannot sign for its own party leaves the user permanently locked out — the
 * party namespace IS the key fingerprint and there is no reset — so the binding
 * is checked before the public key is handed to anyone.
 *
 * The probe is prefixed so it can never be mistaken for a Canton transaction
 * hash: the signature it produces is worthless outside this check.
 */
async function assertKeyBinding(signer: Ed25519Signer, publicKeyHex: string): Promise<void> {
  const probe = new TextEncoder().encode(`cancore:key-binding-check:${publicKeyHex}`);
  const signature = await signWithEd25519Signer(signer, probe);
  if (!(await verifyEd25519(hexToBytes(publicKeyHex), signature, probe))) {
    throw new KeyBindingError();
  }
}

/**
 * Persisted record for a password-unlocked wallet. Shares the wrapped-seed
 * shape with the passkey record; `method` discriminates how the KEK is derived
 * so a single keystore can hold either.
 */
export interface PersistedKeyPasswordWalletRecord {
  method: 'pbkdf2';
  /**
   * On-disk format version. Optional because records written before this field
   * existed are still on users' devices — absent means 1, see
   * {@link walletRecordVersion}. It is stamped now, while the format is still
   * internal: once the package is published (CAN-778) the shape is a contract
   * with other people's users, and a record they cannot read is a wallet they
   * cannot spend from. Semver on the API says nothing about data written by an
   * older release.
   */
  version?: number;
  publicKeyHex: string;
  wrappedIvHex: string;
  wrappedCiphertextHex: string;
  saltHex: string;
  iterations: number;
  createdAt: string;
  /**
   * The BIP39 recovery phrase, wrapped so it can be re-revealed later (Profile >
   * reveal recovery phrase). Since v2 it is wrapped under its OWN KEK, split
   * from the same PBKDF2 output by HKDF — the phrase is the more dangerous of
   * the two secrets to leak, and one key for both made that impossible to say.
   * Optional:
   * legacy records and Profile-created wallets have only the seed — those reveal
   * the private-key hex instead. The mnemonic cannot be reconstructed from the
   * seed (mnemonic -> seed is a one-way HMAC), which is why it is persisted here.
   */
  mnemonicIvHex?: string;
  mnemonicCiphertextHex?: string;
}

export interface UnlockedKeyPasswordWallet {
  record: PersistedKeyPasswordWalletRecord;
  publicKeyHex: string;
  signer: Ed25519Signer;
  /**
   * A rebuilt record when the one on disk was behind — an older format, or
   * fewer PBKDF2 iterations than this build uses. **Persist it**: the upgrade is
   * only real once it is written back, and the caller is the only one holding
   * the keystore.
   *
   * Absent when the record was already current, which is the ordinary case.
   */
  upgraded?: PersistedKeyPasswordWalletRecord;
}

interface BuildOpts {
  iterations?: number;
  /** Injectable clock for deterministic tests; defaults to now. */
  now?: () => string;
}

async function buildRecord(
  seed: Bytes,
  publicKey: Bytes,
  password: string,
  mnemonic?: string,
  opts?: BuildOpts,
): Promise<PersistedKeyPasswordWalletRecord> {
  const iterations = opts?.iterations ?? PBKDF2_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const publicKeyHex = bytesToHex(publicKey);
  const keks = await deriveRecordKeks(password, salt, iterations);
  const wrapped = await wrapSeed(keks.seed, seed, recordAad(publicKeyHex, 'seed'));
  // The recovery phrase gets its OWN key, not the seed's (KS-4). It is the more
  // portable secret of the two — a seed is ours, a phrase types into any BIP39
  // wallet — and one key for both meant one mistake could hand over either.
  // (BIP39 words are ASCII, so latin1 bytes round-trip exactly.)
  const wrappedMnemonic = mnemonic
    ? await wrapSeed(keks.mnemonic, binaryStringToBytes(mnemonic), recordAad(publicKeyHex, 'mnemonic'))
    : null;
  return {
    method: 'pbkdf2',
    version: WALLET_RECORD_VERSION,
    publicKeyHex,
    wrappedIvHex: wrapped.ivHex,
    wrappedCiphertextHex: wrapped.ciphertextHex,
    saltHex: bytesToHex(salt),
    iterations,
    createdAt: opts?.now ? opts.now() : new Date().toISOString(),
    ...(wrappedMnemonic
      ? { mnemonicIvHex: wrappedMnemonic.ivHex, mnemonicCiphertextHex: wrappedMnemonic.ciphertextHex }
      : {}),
  };
}

/**
 * Import an existing wallet from a user-supplied private key (the seed) on a new
 * device. The public key — and thus the Canton party — is fully determined by
 * the seed, so re-wrapping under a (possibly new) password yields the same party.
 *
 * `mnemonic` is optional: registration and restore-from-phrase have the original
 * recovery phrase and pass it so it can be re-revealed later; a raw private-key
 * import (Profile) has no phrase and stores only the seed.
 */
export async function importKeyPasswordWallet(
  privateKeyHex: string,
  password: string,
  opts?: BuildOpts,
  mnemonic?: string,
): Promise<UnlockedKeyPasswordWallet> {
  let seed: Bytes;
  try {
    seed = hexToBytes(privateKeyHex);
  } catch {
    throw new InvalidPrivateKeyError();
  }
  if (seed.length !== SEED_BYTES) throw new InvalidPrivateKeyError();

  const publicKey = ed25519PublicKeyFromSeed(seed);
  const record = await buildRecord(seed, publicKey, password, mnemonic, opts);
  const signer = await createEd25519Signer(seed);
  const publicKeyHex = bytesToHex(publicKey);
  await assertKeyBinding(signer, publicKeyHex);
  return { record, publicKeyHex, signer };
}

/**
 * Unlock a persisted record with the password. Throws WrongPasswordError on
 * mismatch.
 *
 * Re-wraps the record when it is behind the current format or iteration count
 * and hands the result back as `upgraded`. That is what makes a parameter bump
 * a migration instead of an announcement: the cost is paid once, by the person
 * whose wallet it is, at a moment when the password is in hand — the only
 * moment a re-wrap is possible at all.
 */
export async function unlockKeyPasswordWallet(
  record: PersistedKeyPasswordWalletRecord,
  password: string,
  opts?: BuildOpts,
): Promise<UnlockedKeyPasswordWallet> {
  const { seed, mnemonic } = await openRecord(record, password);

  const signer = await createEd25519Signer(seed);
  // The record's public key is stored, not recomputed — check the unwrapped seed
  // really signs for it before the session starts using it.
  await assertKeyBinding(signer, record.publicKeyHex);

  if (!isStale(record, opts?.iterations ?? PBKDF2_ITERATIONS)) {
    return { record, publicKeyHex: record.publicKeyHex, signer };
  }

  const rebuilt = await buildRecord(seed, hexToBytes(record.publicKeyHex), password, mnemonic, opts);
  return {
    record,
    publicKeyHex: record.publicKeyHex,
    signer,
    // Creation time belongs to the wallet, not to the wrapping.
    upgraded: { ...rebuilt, createdAt: record.createdAt },
  };
}

/** The recoverable secret behind a wallet, revealed after a password check. */
export interface RevealedWalletSecret {
  /** The raw seed as hex — always available (it is what the record wraps). */
  privateKeyHex: string;
  /**
   * The original BIP39 recovery phrase, or `null` for legacy/private-key-only
   * records that never persisted one (caller falls back to `privateKeyHex`).
   */
  mnemonic: string | null;
}

/**
 * Re-reveal a wallet's backup secret after verifying the password. Read-only:
 * it does not touch the signer or persisted record. Throws WrongPasswordError
 * when the password does not decrypt the seed.
 */
export async function revealWalletSecret(
  record: PersistedKeyPasswordWalletRecord,
  password: string,
): Promise<RevealedWalletSecret> {
  const { seed, mnemonic } = await openRecord(record, password);
  return { privateKeyHex: bytesToHex(seed), mnemonic: mnemonic ?? null };
}

/**
 * Change the wallet password: decrypt the seed (and recovery phrase, if stored)
 * with the old password, then re-wrap both under a fresh KEK derived from the
 * new password + a new salt. The party (public key) and creation time are
 * preserved — only the encryption changes. Throws WrongPasswordError when the
 * old password is incorrect. The caller persists the returned record.
 */
export async function changeKeyPasswordWalletPassword(
  record: PersistedKeyPasswordWalletRecord,
  oldPassword: string,
  newPassword: string,
  opts?: BuildOpts,
): Promise<PersistedKeyPasswordWalletRecord> {
  const { seed, mnemonic } = await openRecord(record, oldPassword);
  const publicKey = hexToBytes(record.publicKeyHex);
  const rebuilt = await buildRecord(seed, publicKey, newPassword, mnemonic, opts);
  // Only the wrapping changed — keep the original creation timestamp.
  return { ...rebuilt, createdAt: record.createdAt };
}
