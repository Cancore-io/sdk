import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { wordlist as spanishWordlist } from '@scure/bip39/wordlists/spanish';
import { wordlist as frenchWordlist } from '@scure/bip39/wordlists/french';
import { wordlist as koreanWordlist } from '@scure/bip39/wordlists/korean';
import { wordlist as simplifiedChineseWordlist } from '@scure/bip39/wordlists/simplified-chinese';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import type { Bytes } from './bytes';
import { bytesToHex } from './bytes';
import { ed25519PublicKeyFromSeed } from './ed25519';

/**
 * BIP39 recovery phrase support for the self-custody (key+password) wallet.
 *
 * The wallet key is a raw 32-byte Ed25519 seed. To give users a human-writable
 * backup, we generate a BIP39 mnemonic and derive the Ed25519 seed from it
 * deterministically. Two schemes exist (CAN-539):
 *
 * - 'standard' (default): full SLIP-0010 hardened derivation along
 *   m/44'/6767'/0'/0'/0' — coin type 6767 is Canton Coin's registered
 *   SLIP-0044 entry, so the phrase is portable to standard BIP39 tooling.
 * - 'legacy': the pre-BIP44 scheme — SLIP-0010 master key with no CKD steps
 *   (mnemonic → PBKDF2 → HMAC-SHA512("ed25519 seed") → left 32 bytes). Wallets
 *   created before the standard path shipped derive this way; restore flows
 *   fall back to it so their phrases keep reproducing the same key + party id.
 */

// Byte literal (not TextEncoder) so the constant is a Uint8Array in this
// module's realm — noble's abytes check rejects cross-realm Uint8Arrays, which
// jsdom/TextEncoder can otherwise produce ("expected Uint8Array, got object").
const ED25519_SLIP10_KEY = Uint8Array.from('ed25519 seed', (c) => c.charCodeAt(0));

/**
 * Languages a recovery phrase can be written in (CAN-749). Five of the eight
 * interface languages have an official BIP39 wordlist; de/ru/ar have none, and
 * inventing one would mint a Cancore-only dialect no other wallet could
 * restore — so the interface is translated into eight and the phrase stays
 * portable in five. Declared here rather than imported from the app: this
 * package is runtime-agnostic and knows nothing about i18n.
 */
export type MnemonicLanguage = 'en' | 'zh' | 'ko' | 'es' | 'fr';

const WORDLISTS: Record<MnemonicLanguage, readonly string[]> = {
  en: wordlist,
  zh: simplifiedChineseWordlist,
  ko: koreanWordlist,
  es: spanishWordlist,
  fr: frenchWordlist,
};

/** Phrase languages, in the order the interface lists them. */
export const MNEMONIC_LANGUAGES: readonly MnemonicLanguage[] = ['en', 'zh', 'ko', 'es', 'fr'];

function asMnemonicLanguage(language?: string): MnemonicLanguage | undefined {
  return MNEMONIC_LANGUAGES.find((code) => code === language);
}

/** The 2048-word BIP39 wordlist for a language that has one. */
export function wordlistFor(language: string): readonly string[] {
  const code = asMnemonicLanguage(language);
  if (!code) throw new Error(`BIP39 defines no wordlist for "${language}"`);
  return WORDLISTS[code];
}

/** Generate a fresh BIP39 mnemonic. 128 bits → 12 words, 256 bits → 24 words. */
export function newMnemonic(strengthBits: 128 | 256 = 128, language: string = 'en'): string {
  return generateMnemonic(wordlistFor(language) as string[], strengthBits);
}

/**
 * Whether a phrase is a valid BIP39 mnemonic. Without a language it is valid
 * when ANY supported wordlist accepts it. With a language we recognize, only
 * that wordlist counts; an unrecognized language tag (e.g. a UI locale with no
 * BIP39 wordlist) is ignored and falls back to "valid in any wordlist we know".
 */
export function isValidMnemonic(mnemonic: string, language?: string): boolean {
  const normalized = normalizeMnemonic(mnemonic);
  if (language !== undefined) {
    const code = asMnemonicLanguage(language);
    if (code) return validateMnemonic(normalized, WORDLISTS[code] as string[]);
    // BUG-449: an unsupported language tag (e.g. a UI locale with no BIP39
    // wordlist, like 'ru') is not a reason to reject the phrase — validity
    // depends on the phrase, not on a language argument we don't recognize.
    // Fall through to "valid in any wordlist we know", same as no language given.
  }
  return MNEMONIC_LANGUAGES.some((code) =>
    validateMnemonic(normalized, WORDLISTS[code] as string[]),
  );
}

/**
 * Which language a phrase is written in, or null when no wordlist accepts it.
 *
 * English and French share 100 words, so a phrase can be genuinely valid in
 * both — the only ambiguous pair among the five. `preferred` (the language the
 * user is reading the UI in) wins when the phrase is valid in it, because that
 * is whose hints will be useful; otherwise the first covered language in
 * interface order. Guessing wrong costs hints, never a key: derivation is
 * PBKDF2 over the phrase text and takes no wordlist at all.
 */
export function detectMnemonicLanguage(
  mnemonic: string,
  preferred?: string,
): MnemonicLanguage | null {
  const wanted = asMnemonicLanguage(preferred);
  if (wanted && isValidMnemonic(mnemonic, wanted)) return wanted;
  return MNEMONIC_LANGUAGES.find((code) => isValidMnemonic(mnemonic, code)) ?? null;
}

/** A failure the UI can render in the language the user is actually reading. */
export interface MnemonicErrorReport {
  /** i18next key under `wallet.recoveryPhrase.errors.*`. */
  code: string;
  /** Interpolation values for that key. */
  params?: Record<string, string | number>;
}

/** i18next namespace for the import diagnostics. */
const ERROR_KEY_PREFIX = 'wallet.recoveryPhrase.errors';

/** Phrase lengths BIP39 allows that this wallet offers. */
const VALID_WORD_COUNTS: readonly number[] = [12, 24];

/**
 * Why a phrase is not a valid BIP39 mnemonic, or null when it is valid.
 *
 * Returns a translation key, not a sentence (CAN-749): the import flow is the
 * one place a user meets the phrase, and telling a Korean-speaking user in
 * English that their perfectly valid Korean phrase is "not BIP39 words" is the
 * failure this replaces. Checks run in order of most actionable feedback —
 * emptiness, word count, wordlist membership (naming the offending words),
 * checksum. This package stays i18n-free: it names the key, the app renders it.
 */
export function describeMnemonicError(
  mnemonic: string,
  language?: string,
): MnemonicErrorReport | null {
  const normalized = normalizeMnemonic(mnemonic);
  if (!normalized) return { code: `${ERROR_KEY_PREFIX}.empty` };

  const words = normalized.split(' ');
  if (!VALID_WORD_COUNTS.includes(words.length)) {
    return { code: `${ERROR_KEY_PREFIX}.wordCount`, params: { count: words.length } };
  }

  // Judge against the language the phrase looks like when none was given, so a
  // Spanish phrase is not reported as "not English words".
  const resolved = asMnemonicLanguage(language) ?? detectMnemonicLanguage(normalized) ?? 'en';
  const wordset = new Set<string>(WORDLISTS[resolved]);
  const unknown = [...new Set(words.filter((word) => !wordset.has(word)))];
  if (unknown.length > 0) {
    return {
      code: `${ERROR_KEY_PREFIX}.unknownWords`,
      params: { words: unknown.slice(0, 3).join(', '), count: unknown.length },
    };
  }

  if (!isValidMnemonic(normalized, resolved)) {
    return { code: `${ERROR_KEY_PREFIX}.checksum` };
  }
  return null;
}

/**
 * Lowercase + collapse whitespace + NFKD, so copy/paste variance cannot change
 * the seed. NFKD is not cosmetic once accented wordlists ship (CAN-749): the
 * same Spanish phrase typed on macOS (NFD) and pasted from an NFC source is two
 * different byte strings, and BIP39 hashes the NFKD form — without this one of
 * the two restores an empty wallet.
 */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).join(' ').normalize('NFKD');
}

/** How a mnemonic maps to the wallet key. See the module doc for the two schemes. */
export type DerivationScheme = 'standard' | 'legacy';

/** BIP44-shaped SLIP-0010 path on Canton Coin's registered SLIP-0044 coin type. */
export const CANTON_DERIVATION_PATH = "m/44'/6767'/0'/0'/0'";

const HARDENED_OFFSET = 0x80000000;

/** Parse a hardened-only path ("m" or "m/44'/…'") into child indices. */
function parseHardenedPath(path: string): number[] {
  const segments = path.split('/');
  if (segments[0] !== 'm') throw new Error(`Invalid derivation path: ${path}`);
  return segments.slice(1).map((segment) => {
    // SLIP-0010 defines no normal (non-hardened) derivation for ed25519.
    if (!segment.endsWith("'")) {
      throw new Error(`Non-hardened segment "${segment}" — ed25519 derivation is hardened-only`);
    }
    const index = Number(segment.slice(0, -1));
    if (!Number.isInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
      throw new Error(`Invalid path segment "${segment}" in ${path}`);
    }
    return index;
  });
}

/**
 * SLIP-0010 ed25519 private-key derivation: master key from the seed, then one
 * hardened CKD step per path segment. Returns the 32-byte private key (IL).
 */
export function slip10DeriveEd25519(seed: Bytes, path: string): Bytes {
  let I = hmac(sha512, ED25519_SLIP10_KEY, Uint8Array.from(seed));
  for (const index of parseHardenedPath(path)) {
    // Hardened CKD data: 0x00 ‖ parent key ‖ ser32(index + 2^31), keyed by the
    // parent chain code (the right 32 bytes of the previous HMAC).
    const data = new Uint8Array(37);
    data.set(I.slice(0, 32), 1);
    const hardened = index + HARDENED_OFFSET;
    data[33] = (hardened >>> 24) & 0xff;
    data[34] = (hardened >>> 16) & 0xff;
    data[35] = (hardened >>> 8) & 0xff;
    data[36] = hardened & 0xff;
    I = hmac(sha512, I.slice(32), data);
  }
  return Uint8Array.from(I.slice(0, 32));
}

/** Derive the wallet's raw 32-byte Ed25519 seed from a BIP39 mnemonic. */
export function mnemonicToEd25519Seed(
  mnemonic: string,
  scheme: DerivationScheme = 'standard',
): Bytes {
  // Coerce the BIP39 seed into this realm's Uint8Array before handing it to
  // noble (see ED25519_SLIP10_KEY note).
  const bip39Seed = Uint8Array.from(mnemonicToSeedSync(normalizeMnemonic(mnemonic)));
  if (scheme === 'legacy') {
    const I = hmac(sha512, ED25519_SLIP10_KEY, bip39Seed);
    return Uint8Array.from(I.slice(0, 32));
  }
  return slip10DeriveEd25519(bip39Seed, CANTON_DERIVATION_PATH);
}

/** Key material derived from a recovery phrase — the wallet's key identity. */
export interface DerivedWalletKey {
  scheme: DerivationScheme;
  /** Raw 32-byte Ed25519 seed (the wallet private key). */
  seed: Bytes;
  /** Hex form of the seed, the shape the key store imports/persists. */
  seedHex: string;
  /** Hex public key — what the backend registers and authenticates against. */
  publicKeyHex: string;
}

/**
 * THE single phrase → wallet-key generation entry point (CAN-539). Every flow
 * that turns a recovery phrase into key material — signup, the migration
 * wizard, restore/login, profile import — must call this instead of composing
 * `mnemonicToEd25519Seed` + `ed25519PublicKeyFromSeed` by hand, so scheme
 * selection and key shape can never diverge between flows again. The e2e SDK
 * (`backend/tests/sdk/CantonSigner.fromMnemonic`) mirrors this function; the
 * parity is locked by the shared KAT vectors in mnemonic.test.ts.
 */
export function deriveWalletKey(
  mnemonic: string,
  scheme: DerivationScheme = 'standard',
): DerivedWalletKey {
  const seed = mnemonicToEd25519Seed(mnemonic, scheme);
  return {
    scheme,
    seed,
    seedHex: bytesToHex(seed),
    publicKeyHex: bytesToHex(ed25519PublicKeyFromSeed(seed)),
  };
}
