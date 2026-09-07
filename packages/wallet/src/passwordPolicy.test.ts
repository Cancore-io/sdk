import { assessWalletPassword, WALLET_PASSWORD_MIN_LENGTH } from './passwordPolicy';

describe('assessWalletPassword', () => {
  /**
   * The audit's KS-1: for a record at rest the password is the whole defence,
   * and the rule it had was eight characters with digits-or-letters rejected —
   * which `Password1!` satisfies and a wordlist finds in minutes.
   */
  it('refuses what the old eight-character rule allowed', () => {
    expect(assessWalletPassword('Password1!')).toBe('too-short');
    expect(WALLET_PASSWORD_MIN_LENGTH).toBeGreaterThan(8);
  });

  it('refuses length spent on a pattern', () => {
    // Long enough to pass a length check, worthless against a rules-based run.
    expect(assessWalletPassword('password12345')).toBe('common');
    expect(assessWalletPassword('aaaaaaaaaaaaaa')).toBe('single-class');
    expect(assessWalletPassword('ab1ab1ab1ab1ab1')).toBe('repeated');
    expect(assessWalletPassword('0123456789abc')).toBe('sequence');
  });

  it('refuses a single character class at any length', () => {
    expect(assessWalletPassword('7482910473829')).toBe('single-class');
    expect(assessWalletPassword('correcthorsebattery')).toBe('single-class');
  });

  it('accepts a passphrase a person can actually remember', () => {
    // The shape we want people to reach for: length from words, not from
    // punctuation nobody recalls.
    expect(assessWalletPassword('correct horse battery staple')).toBeNull();
    expect(assessWalletPassword('7 rusty bicycles')).toBeNull();
  });

  it('says empty is empty rather than short', () => {
    // The form shows a different message for "you have not typed anything".
    expect(assessWalletPassword('')).toBe('empty');
  });
});
