import { deriveRecordKeks, deriveKeyFromPassword } from './passwordKek';
import { wrapSeed, unwrapSeed } from './aesGcm';

const SALT = new Uint8Array(16).map((_, i) => i);
const SECRET = new Uint8Array(32).map((_, i) => (i * 11) & 0xff);
const OPTS_ITERATIONS = 1000;

describe('deriveRecordKeks', () => {
  /**
   * The property KS-4 is about, tested where it lives rather than through a
   * record: the two keys must be genuinely different keys. Checked WITHOUT
   * additional data on purpose — with AAD in play a swap fails for the other
   * reason (KS-5), and a test that cannot tell the two defences apart passes
   * when one of them is removed.
   */
  it('gives the seed and the phrase keys that cannot open each other', async () => {
    const keks = await deriveRecordKeks('correct horse', SALT, OPTS_ITERATIONS);

    const wrappedForPhrase = await wrapSeed(keks.mnemonic, SECRET);

    await expect(unwrapSeed(keks.seed, wrappedForPhrase)).rejects.toThrow();
    await expect(unwrapSeed(keks.mnemonic, wrappedForPhrase)).resolves.toEqual(SECRET);
  });

  it('derives the same two keys for the same password, salt and cost', async () => {
    // Determinism is the whole basis of unlocking: a KEK that varies per call
    // is a wallet that opens once.
    const first = await deriveRecordKeks('correct horse', SALT, OPTS_ITERATIONS);
    const second = await deriveRecordKeks('correct horse', SALT, OPTS_ITERATIONS);

    const wrapped = await wrapSeed(first.seed, SECRET);
    await expect(unwrapSeed(second.seed, wrapped)).resolves.toEqual(SECRET);
  });

  it('is not the legacy key, so v1 and v2 cannot be confused', async () => {
    // If the v2 seed key happened to equal the v1 key, a v1 record would open
    // through the v2 path and the version branch would be untested cosmetics.
    const legacy = await deriveKeyFromPassword('correct horse', SALT, OPTS_ITERATIONS);
    const keks = await deriveRecordKeks('correct horse', SALT, OPTS_ITERATIONS);

    const wrappedByLegacy = await wrapSeed(legacy, SECRET);

    await expect(unwrapSeed(keks.seed, wrappedByLegacy)).rejects.toThrow();
  });
});
