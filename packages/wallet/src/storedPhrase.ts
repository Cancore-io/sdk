import { bytesToBinaryString, type Bytes } from './bytes';
import { isValidMnemonic, MNEMONIC_LANGUAGES, wordlistFor } from './mnemonic';

/**
 * What a record's phrase bytes hold (BUG-1612). Releases before the fix stored the phrase as latin1,
 * which kept only the low byte of every UTF-16 unit: ASCII and NFC Latin-1 phrases survived, NFKD
 * ko/es/fr ones are low bytes that map back to exactly one wordlist word each (`restored`), and zh
 * ones do not (2048 words share 256 low bytes: `lost`). A copy of a restored or lost phrase taken from
 * the profile before the fix is wrong, which is what the wallet has to tell its user.
 */
export type StoredPhrase =
  | { state: 'intact'; mnemonic: string }
  | { state: 'restored'; mnemonic: string }
  | { state: 'lost'; bytes: Bytes };

/** A phrase is only returned when it is a valid BIP39 mnemonic: a damaged one must not be shown as a backup. */
export function storedPhrase(bytes: Bytes): StoredPhrase {
  const utf8 = utf8Of(bytes);
  if (utf8 !== undefined && isValidMnemonic(utf8)) return { state: 'intact', mnemonic: utf8 };
  const latin1 = bytesToBinaryString(bytes);
  if (isValidMnemonic(latin1)) return { state: 'intact', mnemonic: latin1 };
  const restored = latin1Restored(latin1);
  return restored === undefined ? { state: 'lost', bytes } : { state: 'restored', mnemonic: restored };
}

/** The bytes a re-wrapped record keeps: the phrase as UTF-8, or a lost phrase's bytes as they are, so the loss stays detectable. */
export function phraseBytesOf(phrase: StoredPhrase): Bytes {
  return phrase.state === 'lost' ? phrase.bytes : new TextEncoder().encode(phrase.mnemonic);
}

function utf8Of(bytes: Bytes): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

const lowBytes = (word: string): string => Array.from(word, (c) => String.fromCharCode(c.charCodeAt(0) & 0xff)).join('');

function latin1Restored(stored: string): string | undefined {
  const tokens = stored.split(' ');
  for (const language of MNEMONIC_LANGUAGES) {
    const byLowBytes = new Map<string, string | null>();
    for (const word of wordlistFor(language)) {
      const nfkd = word.normalize('NFKD');
      const key = lowBytes(nfkd);
      byLowBytes.set(key, byLowBytes.has(key) ? null : nfkd);
    }
    const words = tokens.map((token) => byLowBytes.get(token));
    if (!words.every((word): word is string => typeof word === 'string')) continue;
    const phrase = words.join(' ');
    if (isValidMnemonic(phrase, language)) return phrase;
  }
  return undefined;
}
