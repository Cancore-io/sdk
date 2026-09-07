import { matchPhraseToParty } from './restoreScheme';
import { deriveWalletKey } from './mnemonic';
import { cantonFingerprint } from './cantonFingerprint';

// A phrase the tests own outright — never a real wallet.
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const OTHER_PHRASE = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

const partyFor = (publicKeyHex: string) => `someone_abc123::${cantonFingerprint(publicKeyHex)}`;

describe('matchPhraseToParty', () => {
  it('matches a party created on the standard (BIP44) derivation', () => {
    const standard = deriveWalletKey(PHRASE, 'standard');

    const verdict = matchPhraseToParty(PHRASE, partyFor(standard.publicKeyHex));

    expect(verdict.matched?.scheme).toBe('standard');
    expect(verdict.matched?.seedHex).toBe(standard.seedHex);
  });

  it('still matches a wallet created before the BIP44 switch (legacy scheme)', () => {
    const legacy = deriveWalletKey(PHRASE, 'legacy');

    const verdict = matchPhraseToParty(PHRASE, partyFor(legacy.publicKeyHex));

    // The whole point: the phrase IS right, only the derivation is older —
    // this is what a plain deriveWalletKey() call reports as "does not match".
    expect(verdict.matched?.scheme).toBe('legacy');
    expect(verdict.matched?.seedHex).toBe(legacy.seedHex);
  });

  it('reports a mismatch, with what the phrase actually produces', () => {
    const otherWallet = deriveWalletKey(OTHER_PHRASE, 'standard');

    const verdict = matchPhraseToParty(PHRASE, partyFor(otherWallet.publicKeyHex));

    expect(verdict.matched).toBeNull();
    expect(verdict.expectedFingerprint).toBe(cantonFingerprint(otherWallet.publicKeyHex));
    // Both derivations are surfaced so the UI can show them side by side.
    expect(verdict.attempted.map((a) => a.scheme)).toEqual(['standard', 'legacy']);
    expect(verdict.attempted.every((a) => a.fingerprint !== verdict.expectedFingerprint)).toBe(true);
  });

  it('never claims a match for a party id with no namespace', () => {
    expect(matchPhraseToParty(PHRASE, 'malformed').matched).toBeNull();
  });
});
