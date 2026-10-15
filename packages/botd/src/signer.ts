import type { BotSigner } from './types';

/** Ed25519 signer over a raw 32-byte private key; the caller hands over ownership of the bytes. */
export function createSigner(privateKey: Uint8Array): BotSigner {
  void privateKey;
  throw new Error('not implemented');
}
