import { deriveWrappingKey } from './hkdf';
import { wrapSeed } from './aesGcm';

// Non-extractable CryptoKey means we can't inspect the derived key bytes
// directly. Determinism / domain-separation are instead proven indirectly:
// encrypting the same plaintext under the same IV with two independently
// derived keys must match iff HKDF's (ikm, salt, info) inputs match.
describe('deriveWrappingKey (HKDF-SHA256 -> AES-256-GCM KEK)', () => {
  const prfOutput = new Uint8Array(32).fill(0x42); // stand-in for a real PRF eval output
  const salt = new Uint8Array(32).fill(0x07);
  const fixedIv = new Uint8Array(12).fill(0x09);
  const seed = new Uint8Array(32).fill(0x11);

  async function encryptWithFixedIv(kek: CryptoKey): Promise<Uint8Array> {
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fixedIv }, kek, seed);
    return new Uint8Array(ct);
  }

  it('is deterministic for identical (prfOutput, salt, info)', async () => {
    const kekA = await deriveWrappingKey(prfOutput, salt);
    const kekB = await deriveWrappingKey(prfOutput, salt);
    expect(await encryptWithFixedIv(kekA)).toEqual(await encryptWithFixedIv(kekB));
  });

  // Per-user salt: this is what makes two users' wrapping keys diverge even
  // if (hypothetically) their PRF output collided — see PersistedPasskeyWalletRecord.saltHex.
  it('produces a different key for a different salt (per-user salt)', async () => {
    const kekA = await deriveWrappingKey(prfOutput, salt);
    const kekB = await deriveWrappingKey(prfOutput, new Uint8Array(32).fill(0x08));
    expect(await encryptWithFixedIv(kekA)).not.toEqual(await encryptWithFixedIv(kekB));
  });

  it('produces the same key when the same salt is reused across two unlocks', async () => {
    // Simulates register() deriving the KEK, then a later unlock() re-deriving
    // it from the persisted salt — must land on the identical key.
    const registerKek = await deriveWrappingKey(prfOutput, salt);
    const unlockKek = await deriveWrappingKey(prfOutput, salt);
    expect(await encryptWithFixedIv(registerKek)).toEqual(await encryptWithFixedIv(unlockKek));
  });

  it('produces a different key for a different info string (domain separation)', async () => {
    const kekA = await deriveWrappingKey(prfOutput, salt, 'cancore/passkey-wallet/ed25519-wrap/v1');
    const kekB = await deriveWrappingKey(prfOutput, salt, 'some-other-protocol/v1');
    expect(await encryptWithFixedIv(kekA)).not.toEqual(await encryptWithFixedIv(kekB));
  });

  it('produces a non-extractable key usable end-to-end with wrapSeed', async () => {
    const kek = await deriveWrappingKey(prfOutput, salt);
    expect(kek.extractable).toBe(false);
    const wrapped = await wrapSeed(kek, seed);
    expect(wrapped.ivHex).toMatch(/^[0-9a-f]{24}$/); // 12-byte IV
    expect(wrapped.ciphertextHex.length).toBeGreaterThan(0);
  });
});
