import {
  deriveCandidates,
  resolveRestoredSeed,
  makeChallengeAccountProbe,
  isNoAccountError,
} from './restoreScheme';
import { mnemonicToEd25519Seed } from './mnemonic';
import { ed25519PublicKeyFromSeed } from './ed25519';
import { bytesToHex } from './bytes';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

function pubkeyOf(scheme: 'standard' | 'legacy'): string {
  return bytesToHex(ed25519PublicKeyFromSeed(mnemonicToEd25519Seed(PHRASE, scheme)));
}

describe('restoreScheme (CAN-539 dual-scheme restore)', () => {
  describe('deriveCandidates', () => {
    it('returns standard first, then legacy — the restore priority order', () => {
      const candidates = deriveCandidates(PHRASE);
      expect(candidates.map((c) => c.scheme)).toEqual(['standard', 'legacy']);
    });

    it('each candidate carries the seed and its public key', () => {
      const [standard, legacy] = deriveCandidates(PHRASE);
      expect(standard.publicKeyHex).toBe(pubkeyOf('standard'));
      expect(legacy.publicKeyHex).toBe(pubkeyOf('legacy'));
      expect(standard.publicKeyHex).not.toBe(legacy.publicKeyHex);
      expect(bytesToHex(standard.seed)).toBe(bytesToHex(mnemonicToEd25519Seed(PHRASE, 'standard')));
    });
  });

  describe('resolveRestoredSeed', () => {
    it('picks standard when its account exists (never probes legacy)', async () => {
      const probe = jest.fn().mockResolvedValue(true);
      const resolved = await resolveRestoredSeed(PHRASE, probe);
      expect(resolved?.scheme).toBe('standard');
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledWith(pubkeyOf('standard'));
    });

    it('falls back to legacy when the standard key has no account (pre-BIP44 wallet restore)', async () => {
      const probe = jest.fn((pk: string) => Promise.resolve(pk === pubkeyOf('legacy')));
      const resolved = await resolveRestoredSeed(PHRASE, probe);
      expect(resolved?.scheme).toBe('legacy');
      expect(probe).toHaveBeenCalledTimes(2);
    });

    it('returns null when neither derivation matches an account', async () => {
      const resolved = await resolveRestoredSeed(PHRASE, jest.fn().mockResolvedValue(false));
      expect(resolved).toBeNull();
    });

    it('propagates probe failures (network errors must not be mistaken for "no account")', async () => {
      const probe = jest.fn().mockRejectedValue(new Error('fetch failed'));
      await expect(resolveRestoredSeed(PHRASE, probe)).rejects.toThrow('fetch failed');
    });
  });

  describe('makeChallengeAccountProbe', () => {
    it('treats a successful challenge as an existing account', async () => {
      const probe = makeChallengeAccountProbe(jest.fn().mockResolvedValue({ challenge: 'x' }));
      await expect(probe('aabb')).resolves.toBe(true);
    });

    it.each([
      'User not found',
      'No user for this key',
      // The real fallback shape requestChallenge builds when the body isn't
      // JSON (canton-signing.service.ts): `Challenge request failed:
      // ${response.statusText}` — status TEXT, never a bare code (BUG-651 PR
      // review, Mike).
      'Challenge request failed: Not Found',
      'Challenge request failed: Unauthorized',
    ])(
      'classifies "%s" as no-account (returns false, does not throw)',
      async (message) => {
        const probe = makeChallengeAccountProbe(jest.fn().mockRejectedValue(new Error(message)));
        await expect(probe('aabb')).resolves.toBe(false);
      },
    );

    it('rethrows unclassified errors (backend down ≠ account missing)', async () => {
      const probe = makeChallengeAccountProbe(
        jest.fn().mockRejectedValue(new Error('NetworkError: connection refused')),
      );
      await expect(probe('aabb')).rejects.toThrow('connection refused');
    });
  });

  // BUG-651 secondary: the shared predicate must not match the bare word
  // "challenge" — that made ordinary infra failures (timeouts, network errors
  // while sending a challenge) look like "no account".
  describe('isNoAccountError (BUG-651 Scenario Outline, @risk:10)', () => {
    it.each([
      ['No Cancore account is linked to this wallet. Sign up to create', true],
      ['Network error while sending challenge to the signing device', false],
      ['Timeout waiting for challenge response from relay', false],
      // Real texts makeChallengeAccountProbe's own suite already relies on
      // (packages/wallet/src/restoreScheme.test.ts:65-71) — must still classify
      // the same way once the shared predicate replaces the bare-word regex.
      // These are the actual `Challenge request failed: ${statusText}` shapes
      // requestChallenge produces on a non-JSON body, not fabricated numeric
      // codes (BUG-651 PR review, Mike) — "Unauthorized" is the case the old
      // bare-word-"challenge" regex used to catch by accident.
      ['User not found', true],
      ['No user for this key', true],
      ['Challenge request failed: Not Found', true],
      ['Challenge request failed: Unauthorized', true],
    ])('classifies "%s" as no-account = %s', (message, expected) => {
      expect(isNoAccountError(message)).toBe(expected);
    });
  });
});
