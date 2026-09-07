import { deriveWrappingKey } from './hkdf';
import { unwrapSeed, wrapSeed } from './aesGcm';

describe('wrapSeed / unwrapSeed', () => {
  const prfOutput = new Uint8Array(32).fill(0xab);
  const salt = new Uint8Array(32).fill(0xcd);
  const seed = new Uint8Array(32).map((_, i) => i); // 0..31, distinguishable bytes

  it('round-trips the seed through wrap -> unwrap (same salt+seed -> same key)', async () => {
    const kek = await deriveWrappingKey(prfOutput, salt);
    const wrapped = await wrapSeed(kek, seed);
    const unwrapped = await unwrapSeed(kek, wrapped);
    expect(unwrapped).toEqual(seed);
  });

  it('round-trips across independently-derived KEKs for the same salt (register -> unlock)', async () => {
    const registerKek = await deriveWrappingKey(prfOutput, salt);
    const wrapped = await wrapSeed(registerKek, seed);
    const unlockKek = await deriveWrappingKey(prfOutput, salt);
    expect(await unwrapSeed(unlockKek, wrapped)).toEqual(seed);
  });

  it('uses a fresh random IV per call (no nonce reuse)', async () => {
    const kek = await deriveWrappingKey(prfOutput, salt);
    const a = await wrapSeed(kek, seed);
    const b = await wrapSeed(kek, seed);
    expect(a.ivHex).not.toBe(b.ivHex);
    expect(a.ciphertextHex).not.toBe(b.ciphertextHex);
  });

  it('rejects the wrong key (fails GCM auth tag)', async () => {
    const kek = await deriveWrappingKey(prfOutput, salt);
    const wrongKek = await deriveWrappingKey(prfOutput, new Uint8Array(32).fill(0xee));
    const wrapped = await wrapSeed(kek, seed);
    await expect(unwrapSeed(wrongKek, wrapped)).rejects.toThrow();
  });

  it('detects ciphertext tampering', async () => {
    const kek = await deriveWrappingKey(prfOutput, salt);
    const wrapped = await wrapSeed(kek, seed);
    const tampered =
      wrapped.ciphertextHex.slice(0, -2) + (wrapped.ciphertextHex.slice(-2) === '00' ? '01' : '00');
    await expect(unwrapSeed(kek, { ...wrapped, ciphertextHex: tampered })).rejects.toThrow();
  });
});
