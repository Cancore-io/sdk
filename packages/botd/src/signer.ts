import { bytesToHex, createPasskeySigningProvider, ed25519PublicKeyFromSeed } from '@cancore/wallet';
import type { BotSigner } from './types';

/** Ed25519 signer over a raw 32-byte private key; the caller hands over ownership of the bytes. */
export function createSigner(privateKey: Uint8Array): BotSigner {
  if (privateKey.length !== 32) throw new Error('createSigner: expected a 32-byte Ed25519 key');
  // Copy into a Buffer we own and wipe the caller's bytes, so exactly one copy exists.
  const key = Buffer.from(privateKey);
  privateKey.fill(0);
  // The noble backend signs straight from `key`, so zero-filling it on destroy really wipes the key.
  const provider = createPasskeySigningProvider({ kind: 'noble', seed: key }, bytesToHex(ed25519PublicKeyFromSeed(key)));
  let destroyed = false;
  const alive = (): void => {
    if (destroyed) throw new Error('signer destroyed');
  };
  const signer: BotSigner = {
    public_key: provider.public_key,
    async signMessage(message) {
      alive();
      return provider.signMessage(message);
    },
    async signChallenge(challenge) {
      alive();
      return provider.signChallenge!(challenge);
    },
    async signPreparedHash(hashB64) {
      alive();
      return provider.signPreparedHash!(hashB64);
    },
    destroy() {
      key.fill(0);
      destroyed = true;
    },
  };
  // Keep key material out of JSON.stringify / util.inspect even if someone attaches it later.
  Object.defineProperty(signer, Symbol.for('nodejs.util.inspect.custom'), { value: () => `BotSigner(${signer.public_key})` });
  Object.defineProperty(signer, 'toJSON', { value: () => ({ public_key: signer.public_key }) });
  return signer;
}
