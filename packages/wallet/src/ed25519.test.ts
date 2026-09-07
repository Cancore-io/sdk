import { ed25519 } from '@noble/curves/ed25519';
import {
  createEd25519Signer,
  generateEd25519KeyPair,
  importSubtleVerifyKey,
  isSubtleEd25519Supported,
  signWithEd25519Signer,
  signWithSubtle,
  verifyEd25519,
  verifyWithSubtle,
} from './ed25519';

// Core "noble vs subtle" comparison from the PoC's unlock+sign step
// (poc/passkey/lib/ed25519WebCrypto.test.ts), ported here without any
// WebAuthn dependency. If this runtime's `crypto.subtle` doesn't support
// Ed25519, the subtle-specific assertions are skipped and only the noble
// path (our guaranteed fallback) is asserted.
describe('Ed25519: subtle vs @noble/curves', () => {
  const seed = new Uint8Array(ed25519.utils.randomSecretKey());
  const publicKey = new Uint8Array(ed25519.getPublicKey(seed));
  const message = new Uint8Array(32).fill(0x2a); // stand-in for a preparedTransactionHash / signMessage payload

  it('produces an identical signature to @noble/curves for the same seed + message when subtle is available', async () => {
    const nobleSignature = new Uint8Array(ed25519.sign(message, seed));
    if (!isSubtleEd25519Supported()) {
      expect(ed25519.verify(nobleSignature, message, publicKey)).toBe(true);
      return;
    }
    const signer = await createEd25519Signer(seed);
    if (signer.kind !== 'subtle') {
      // subtle.subtle exists but this runtime doesn't support the Ed25519 algorithm.
      expect(ed25519.verify(nobleSignature, message, publicKey)).toBe(true);
      return;
    }
    const subtleSignature = await signWithSubtle(signer.key, message);
    expect(subtleSignature).toEqual(nobleSignature);
  });

  it('verifies a subtle-produced signature with both noble and subtle', async () => {
    if (!isSubtleEd25519Supported()) return;
    const signer = await createEd25519Signer(seed);
    if (signer.kind !== 'subtle') return;

    const signature = await signWithSubtle(signer.key, message);
    expect(ed25519.verify(signature, message, publicKey)).toBe(true);

    const verifyKey = await importSubtleVerifyKey(publicKey);
    expect(await verifyWithSubtle(verifyKey, signature, message)).toBe(true);
  });

  it('rejects a signature over a different message', async () => {
    const signer = await createEd25519Signer(seed);
    const signature = await signWithEd25519Signer(signer, message);
    const otherMessage = new Uint8Array(32).fill(0x99);
    expect(await verifyEd25519(publicKey, signature, otherMessage)).toBe(false);
  });

  it('falls back to noble when the seed cannot be imported into subtle', async () => {
    // A too-short "seed" can never import as PKCS8 — forces the noble branch
    // regardless of what this runtime's subtle otherwise supports.
    const badSeed = new Uint8Array(16);
    const signer = await createEd25519Signer(badSeed);
    expect(signer.kind).toBe('noble');
  });
});

describe('createEd25519Signer + signWithEd25519Signer (round-trip via generateEd25519KeyPair)', () => {
  it('produces a signature verifiable by both backends', async () => {
    const keyPair = generateEd25519KeyPair();
    expect(keyPair.seed).toHaveLength(32);
    expect(keyPair.publicKey).toHaveLength(32);

    const signer = await createEd25519Signer(keyPair.seed);
    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const signature = await signWithEd25519Signer(signer, message);

    expect(await verifyEd25519(keyPair.publicKey, signature, message)).toBe(true);
    expect(ed25519.verify(signature, message, keyPair.publicKey)).toBe(true);
  });

  it('two independently-generated keypairs produce different public keys', () => {
    const a = generateEd25519KeyPair();
    const b = generateEd25519KeyPair();
    expect(a.publicKey).not.toEqual(b.publicKey);
    expect(a.seed).not.toEqual(b.seed);
  });
});
