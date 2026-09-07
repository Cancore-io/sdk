/**
 * How strong a password has to be before it is allowed to wrap a key.
 *
 * This lives in the package rather than in one app's form because it is not a
 * UI preference: for a record at rest, the password IS the security. Everything
 * else in this module — 600 000 PBKDF2 iterations, AES-256-GCM, a
 * non-extractable KEK — buys time against guessing, and time is worth nothing
 * against a password that appears in a wordlist.
 *
 * The arithmetic, so the number below is a decision and not a taste: PBKDF2-
 * SHA256 at 600k iterations costs ~1.2M SHA-256 compressions per guess, so one
 * modern GPU makes on the order of 10^4 guesses per second. That defeats brute
 * force over an alphabet and does NOT defeat a wordlist-plus-rules run of ~10^9
 * candidates, which covers most human-chosen passwords and finishes in about a
 * day on a single card. Length is the only cheap defence against that, and a
 * blocklist is the only cheap defence against length spent on `Password1234`.
 *
 * Deliberately dependency-free. A password strength estimator is a 400 kB
 * dictionary; this package ships to other people's wallets and every byte in it
 * is code they cannot audit but must trust.
 */

/** Below this, the wrapped record is not meaningfully protected. */
export const WALLET_PASSWORD_MIN_LENGTH = 12;

/**
 * Patterns that make length a lie. Not a wordlist — the top of one, plus the
 * shapes people reach for when told "longer": a word repeated, a keyboard row,
 * a year appended.
 */
const WEAK_PATTERNS: ReadonlyArray<{ test: RegExp; reason: 'common' | 'repeated' | 'sequence' }> = [
  { test: /^(?:password|passwort|qwerty|iloveyou|admin|welcome|letmein|monkey|dragon|master)/i, reason: 'common' },
  { test: /^(.)\1+$/, reason: 'repeated' },
  { test: /^(.{1,4})\1+$/, reason: 'repeated' },
  { test: /^(?:0123456789|1234567890|123456789|abcdefgh|qwertyui|asdfghjk)/i, reason: 'sequence' },
];

export type WalletPasswordProblem =
  | 'empty'
  | 'too-short'
  | 'single-class'
  | 'common'
  | 'repeated'
  | 'sequence';

/**
 * What is wrong with this password, or null when nothing is.
 *
 * Returns a CODE, not a sentence: the wallet that embeds this package writes its
 * own copy, in its own language, and a message baked in here would be an English
 * string in somebody else's Japanese UI.
 */
export function assessWalletPassword(password: string): WalletPasswordProblem | null {
  if (!password) return 'empty';
  if (password.length < WALLET_PASSWORD_MIN_LENGTH) return 'too-short';
  // A single character class turns the search space back into something a GPU
  // enumerates: all-digits of any length is the classic.
  if (/^[0-9]+$/.test(password) || /^[a-zA-Z]+$/.test(password)) return 'single-class';
  for (const { test, reason } of WEAK_PATTERNS) {
    if (test.test(password)) return reason;
  }
  return null;
}
