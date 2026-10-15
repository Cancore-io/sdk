import { inspect } from 'node:util';
import { ed25519 } from '@noble/curves/ed25519';
import { deriveWalletKey, providerFromMnemonic } from '@cancore/wallet';
import { createSigner } from './signer';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const HASH = Buffer.alloc(32, 7).toString('base64');

describe('createSigner', () => {
  it('signs like the SDK provider for the same phrase, and verifies with its public key', async () => {
    const key = deriveWalletKey(PHRASE);
    const signer = createSigner(Uint8Array.from(key.seed));
    const sdk = await providerFromMnemonic(PHRASE);
    expect(signer.public_key).toBe(sdk.public_key);
    expect(await signer.signMessage('\x00\xffhello')).toBe(await sdk.signMessage('\x00\xffhello'));
    expect(await signer.signChallenge!('Welcome to Cancore abc')).toBe(await sdk.signChallenge!('Welcome to Cancore abc'));
    const sig = await signer.signPreparedHash(HASH);
    expect(sig).toBe(await sdk.signPreparedHash!(HASH));
    expect(ed25519.verify(Buffer.from(sig, 'base64'), Buffer.from(HASH, 'base64'), Buffer.from(signer.public_key, 'hex'))).toBe(true);
  });

  it('refuses a non-32-byte hash and a non-challenge', async () => {
    const signer = createSigner(Uint8Array.from(deriveWalletKey(PHRASE).seed));
    await expect(signer.signPreparedHash(Buffer.alloc(34).toString('base64'))).rejects.toThrow(/32-byte/);
    await expect(signer.signChallenge!('transfer all')).rejects.toThrow(/challenge/);
  });

  it('wipes the caller bytes, and every call after destroy throws', async () => {
    const input = Uint8Array.from(deriveWalletKey(PHRASE).seed);
    const signer = createSigner(input);
    expect(input.every((b) => b === 0)).toBe(true);
    signer.destroy();
    await expect(signer.signMessage('x')).rejects.toThrow(/destroyed/);
    await expect(signer.signPreparedHash(HASH)).rejects.toThrow(/destroyed/);
    await expect(signer.signChallenge!('Welcome to Cancore x')).rejects.toThrow(/destroyed/);
  });

  it('never exposes key material through JSON.stringify or inspect', () => {
    const key = deriveWalletKey(PHRASE);
    const signer = createSigner(Uint8Array.from(key.seed));
    for (const out of [JSON.stringify(signer), inspect(signer, { showHidden: true, depth: 10 }), String(signer)]) {
      expect(out).not.toContain(key.seedHex);
      expect(out).not.toContain(Buffer.from(key.seed).toString('base64'));
    }
  });
});
