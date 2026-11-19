import { bytesToBinaryString, type Bytes } from './bytes';
import { isValidMnemonic, MNEMONIC_LANGUAGES, wordlistFor } from './mnemonic';

/**
 * The recovery phrase a record holds, or `undefined` when it cannot be read back.
 *
 * Records are UTF-8 since BUG-1612. Before that the phrase was stored as latin1, which kept only
 * the low byte of every UTF-16 unit: an ASCII (English) phrase survived, a ko/es/fr one is a
 * string of low bytes that maps back to exactly one word of its wordlist, and a zh one does not
 * (2048 words share 256 low bytes). A phrase is only returned when it is a valid BIP39 mnemonic:
 * a corrupted one must not be shown as a backup.
 */
export function storedPhrase(bytes: Bytes): string | undefined {
  const utf8 = utf8Of(bytes);
  if (utf8 !== undefined && isValidMnemonic(utf8)) return utf8;
  return latin1Repaired(bytesToBinaryString(bytes));
}

function utf8Of(bytes: Bytes): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

const lowBytes = (word: string): string =>
  Array.from(word.normalize('NFKD'), (c) => String.fromCharCode(c.charCodeAt(0) & 0xff)).join('');

function latin1Repaired(stored: string): string | undefined {
  const tokens = stored.split(' ');
  for (const language of MNEMONIC_LANGUAGES) {
    const byLowBytes = new Map<string, string | null>();
    for (const word of wordlistFor(language)) {
      const key = lowBytes(word);
      byLowBytes.set(key, byLowBytes.has(key) ? null : word.normalize('NFKD'));
    }
    const words = tokens.map((token) => byLowBytes.get(token));
    if (!words.every((word): word is string => typeof word === 'string')) continue;
    const phrase = words.join(' ');
    if (isValidMnemonic(phrase, language)) return phrase;
  }
  return undefined;
}
