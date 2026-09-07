import {
  newMnemonic,
  isValidMnemonic,
  normalizeMnemonic,
  mnemonicToEd25519Seed,
  deriveWalletKey,
  describeMnemonicError,
  slip10DeriveEd25519,
  CANTON_DERIVATION_PATH,
} from './mnemonic';
import { ed25519PublicKeyFromSeed } from './ed25519';
import { bytesToHex, hexToBytes } from './bytes';

describe('mnemonic (BIP39 self-custody recovery phrase)', () => {
  it('generates a valid 12-word phrase by default', () => {
    const m = newMnemonic();
    expect(m.split(' ')).toHaveLength(12);
    expect(isValidMnemonic(m)).toBe(true);
  });

  it('generates a valid 24-word phrase for 256-bit strength', () => {
    const m = newMnemonic(256);
    expect(m.split(' ')).toHaveLength(24);
    expect(isValidMnemonic(m)).toBe(true);
  });

  it('rejects an invalid phrase (bad checksum / non-wordlist)', () => {
    expect(isValidMnemonic('not a real recovery phrase at all nope nope nope nope')).toBe(false);
    expect(isValidMnemonic('')).toBe(false);
  });

  it('BUG-449: ignores an unsupported language tag instead of rejecting a genuinely valid phrase', () => {
    // 'ru' has no BIP39 wordlist (MNEMONIC_LANGUAGES = en/zh/ko/es/fr). A UI
    // locale outside that set is not a reason to reject an otherwise-valid
    // English phrase — validity depends on the phrase, not on a language tag
    // this module doesn't recognize. This is a live footgun: any caller doing
    // `isValidMnemonic(m, i18n.language)` would instantly lock out ru/de/ar
    // users restoring a valid phrase.
    const m = newMnemonic();
    expect(isValidMnemonic(m, 'ru')).toBe(true);
    expect(isValidMnemonic(m, 'de')).toBe(true);
    expect(isValidMnemonic(m, 'ar')).toBe(true);
    // A genuinely invalid phrase must still be rejected regardless — 12 words
    // (the right count) so this actually exercises the dictionary check rather
    // than getting rejected on word count before the wordlist is ever consulted.
    const gibberish = Array(12).fill('zzzz').join(' ');
    expect(isValidMnemonic(gibberish, 'ru')).toBe(false);
  });

  it('normalizes case and whitespace so copy/paste variance is stable', () => {
    expect(normalizeMnemonic('  Legal   WINNER thank\tyear ')).toBe('legal winner thank year');
  });

  it('derives the Ed25519 seed deterministically (same phrase → same key)', () => {
    const m = newMnemonic();
    const a = bytesToHex(mnemonicToEd25519Seed(m));
    const b = bytesToHex(mnemonicToEd25519Seed(m));
    expect(a).toBe(b);
    expect(a).toHaveLength(64); // 32-byte seed
  });

  it('is insensitive to surrounding whitespace/case when deriving', () => {
    const m = newMnemonic();
    expect(bytesToHex(mnemonicToEd25519Seed(m))).toBe(
      bytesToHex(mnemonicToEd25519Seed(`  ${m.toUpperCase()}  `)),
    );
  });

  describe('describeMnemonicError (import-your-own-phrase validation)', () => {
    it('returns null for a valid generated phrase (12 and 24 words)', () => {
      expect(describeMnemonicError(newMnemonic())).toBeNull();
      expect(describeMnemonicError(newMnemonic(256))).toBeNull();
    });

    it('tolerates case/whitespace variance', () => {
      const m = newMnemonic();
      expect(describeMnemonicError(`  ${m.toUpperCase().split(' ').join('   ')}  `)).toBeNull();
    });

    // CAN-749: the verdict is a translation key + params, not English prose —
    // the import screen has to render it in the language the user set.
    it('reports empty input', () => {
      expect(describeMnemonicError('')?.code).toBe('wallet.recoveryPhrase.errors.empty');
      expect(describeMnemonicError('   ')?.code).toBe('wallet.recoveryPhrase.errors.empty');
    });

    it('reports wrong word count', () => {
      const err = describeMnemonicError('legal winner thank');
      expect(err?.code).toBe('wallet.recoveryPhrase.errors.wordCount');
      expect(err?.params).toEqual(expect.objectContaining({ count: 3 }));
    });

    it('names words that are not in the BIP39 wordlist', () => {
      const err = describeMnemonicError(
        'legal winner thank year wave sausage worth useful legal winner thank zzzz',
      );
      expect(err?.code).toBe('wallet.recoveryPhrase.errors.unknownWords');
      expect(String(err?.params?.words)).toContain('zzzz');
    });

    it('reports a checksum mismatch when all words are valid but the phrase is not', () => {
      // 12x "abandon" is all-wordlist but fails the checksum (valid phrase ends "about").
      const err = describeMnemonicError(Array(12).fill('abandon').join(' '));
      expect(err?.code).toBe('wallet.recoveryPhrase.errors.checksum');
    });
  });

  describe('SLIP-0010 ed25519 derivation (CAN-539)', () => {
    // Official SLIP-0010 test vector 1 for ed25519 (seed 000102…0f) — proves the
    // CKD implementation against the spec, independent of our own code.
    const TV1_SEED = hexToBytes('000102030405060708090a0b0c0d0e0f');

    it('reproduces the official SLIP-0010 vector: master key (path m)', () => {
      expect(bytesToHex(slip10DeriveEd25519(TV1_SEED, 'm'))).toBe(
        '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7',
      );
    });

    it("reproduces the official SLIP-0010 vector: m/0'/1'/2'/2'/1000000000'", () => {
      expect(bytesToHex(slip10DeriveEd25519(TV1_SEED, "m/0'/1'/2'/2'/1000000000'"))).toBe(
        '8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793',
      );
    });

    it('rejects a non-hardened path segment (SLIP-0010 ed25519 is hardened-only)', () => {
      expect(() => slip10DeriveEd25519(TV1_SEED, "m/44'/6767'/0/0/0")).toThrow(/hardened/i);
    });

    it("uses the registered Canton coin type in the standard path", () => {
      expect(CANTON_DERIVATION_PATH).toBe("m/44'/6767'/0'/0'/0'");
    });
  });

  describe('derivation schemes (standard BIP44 path vs legacy master key)', () => {
    const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

    it('defaults to the standard scheme', () => {
      expect(bytesToHex(mnemonicToEd25519Seed(PHRASE))).toBe(
        bytesToHex(mnemonicToEd25519Seed(PHRASE, 'standard')),
      );
    });

    it("standard scheme derives along m/44'/6767'/0'/0'/0' (regression lock)", () => {
      // Reference computed with an independent SLIP-0010 implementation, itself
      // verified against the official spec vectors above.
      expect(bytesToHex(mnemonicToEd25519Seed(PHRASE, 'standard'))).toBe(
        'ea0c6ec4f117bc2bf28f3d84718033f6f3d55ce1f6beffb3dc70334ac85ba4dd',
      );
    });

    it('legacy scheme reproduces pre-BIP44 wallets (regression lock — party id must survive)', () => {
      const seed = mnemonicToEd25519Seed(PHRASE, 'legacy');
      expect(bytesToHex(seed)).toBe(
        'ccbb1d273f83520ab802ae6c5fb5c7ccee16350a8bbbb9e8c93b7d26f02ac626',
      );
      expect(bytesToHex(ed25519PublicKeyFromSeed(seed))).toBe(
        '17813e6cc6b9a7317ee78a311385d52dd0cb3b3831cfa44db9a0fde1a2afbf09',
      );
    });

    it('the two schemes yield different keys for the same phrase (the CAN-539 divergence)', () => {
      expect(bytesToHex(mnemonicToEd25519Seed(PHRASE, 'standard'))).not.toBe(
        bytesToHex(mnemonicToEd25519Seed(PHRASE, 'legacy')),
      );
    });
  });

  describe('deriveWalletKey — the single phrase → key-material entry point', () => {
    const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

    it('standard (default): full key material matches the regression-locked vectors', () => {
      const key = deriveWalletKey(PHRASE);
      expect(key.scheme).toBe('standard');
      expect(key.seedHex).toBe('ea0c6ec4f117bc2bf28f3d84718033f6f3d55ce1f6beffb3dc70334ac85ba4dd');
      expect(bytesToHex(key.seed)).toBe(key.seedHex);
      // Same vector locks the e2e SDK (backend tests/specs/SDK/canton-signer.kat.spec.ts).
      expect(key.publicKeyHex).toBe('c47d675577a37c065bcffc534386fa1cd4c08746d24558361c8b407b640b8d68');
    });

    it('legacy: full key material matches the pre-BIP44 regression lock', () => {
      const key = deriveWalletKey(PHRASE, 'legacy');
      expect(key.scheme).toBe('legacy');
      expect(key.seedHex).toBe('ccbb1d273f83520ab802ae6c5fb5c7ccee16350a8bbbb9e8c93b7d26f02ac626');
      expect(key.publicKeyHex).toBe('17813e6cc6b9a7317ee78a311385d52dd0cb3b3831cfa44db9a0fde1a2afbf09');
    });

    it('agrees with mnemonicToEd25519Seed for both schemes (single source of truth)', () => {
      for (const scheme of ['standard', 'legacy'] as const) {
        expect(deriveWalletKey(PHRASE, scheme).seedHex).toBe(
          bytesToHex(mnemonicToEd25519Seed(PHRASE, scheme)),
        );
      }
    });
  });
});
