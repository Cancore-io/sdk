import { binaryStringToBytes, bytesToBinaryString, bytesToHex, type Bytes } from './bytes';
import { signWithEd25519Signer, type Ed25519Signer } from './ed25519';

/**
 * Fixed prefix of the backend's signature-login challenge
 * (`ChallengeService.generateChallenge`: `Welcome to Cancore <date> sig:<nonce>`).
 * `signChallenge` refuses anything that doesn't carry it — the client half of
 * the login/transaction domain separation (REQ-WAL-12).
 */
export const LOGIN_CHALLENGE_PREFIX = 'Welcome to Cancore ';

const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;
const PREPARED_HASH_BYTES = 32;

/**
 * Structural subset of `LoopProvider` (see src/services/loop.service.ts)
 * that `canton-signing.service.ts` actually calls for message signing:
 * `public_key` + `signMessage`. Every current call site
 * (`loginWithLoopProvider`, `signPreparedCommandWithLoop`, and the local
 * signing in `useExternalPartySetup.ts`) only touches these two members, so
 * this is enough to be a drop-in replacement there. Loop-specific
 * transaction methods (`submitAndWaitForTransaction`, `transfer`,
 * `getHolding`, ...) are Canton-validator/backend features, out of scope for
 * this foundation increment.
 *
 * Domain separation (REQ-WAL-12): the same key signs both login challenges
 * and prepared transactions, and the two message spaces are only kept apart
 * by shape. Prefer the shape-checked methods — `signChallenge` for the
 * `/auth/challenge` string, `signPreparedHash` for interactive-submission
 * hashes. They are optional on the interface so existing structural mocks
 * and the Loop provider still type-check; `createPasskeySigningProvider`
 * always implements them.
 */
export interface PasskeySigningProvider {
  public_key: string;
  /**
   * Sign arbitrary raw bytes (binary-string convention, one char code = one
   * byte), returning a lowercase 128-char hex signature.
   *
   * @deprecated For login challenges use {@link signChallenge}; for
   * interactive-submission prepared hashes use {@link signPreparedHash} —
   * both enforce the message shape they sign (REQ-WAL-12). This stays for
   * messages with no fixed shape (e.g. hex topology hashes in
   * `useExternalPartySetup.ts`) and for LoopProvider structural parity.
   */
  signMessage(message: string): Promise<string>;
  /**
   * Sign a signature-login challenge. Refuses any message that is not a
   * printable-ASCII string with the {@link LOGIN_CHALLENGE_PREFIX} — a
   * prepared-transaction hash can never satisfy that, so a login signature
   * cannot be coaxed out of a transaction payload or vice versa.
   * @returns lowercase 128-char hex signature (as `/auth/login-signature` expects).
   */
  signChallenge?(challenge: string): Promise<string>;
  /**
   * Sign an interactive-submission `preparedTransactionHash` (standard
   * base64, exactly 32 raw bytes once decoded). Refuses anything else —
   * including 34-byte topology multihashes and ASCII text.
   * @returns standard-base64 64-byte signature (SIGNATURE_FORMAT_CONCAT), as
   * the `submit-signature`/`submit` endpoints expect.
   */
  signPreparedHash?(preparedTransactionHashB64: string): Promise<string>;
}

/**
 * Build a passkey-backed signing provider from an already-unlocked signer.
 *
 * `message` follows the exact convention every existing `signMessage` caller
 * relies on: a "binary string" where each char code is one raw byte (see the
 * local `hexToBytes` in `useExternalPartySetup.ts`, and `bufferToBase64Url`
 * in `./bytes.ts`) — NOT UTF-8 text decoding, which would corrupt bytes
 * outside the ASCII range. Ed25519 signs those raw bytes directly (no extra
 * hashing layer added here), matching `signHashHex` in `src/lib/safeCrypto.ts`
 * byte-for-byte. The returned signature is a lowercase 128-char hex string
 * (64 raw bytes), which `signatureToHex` in `canton-signing.service.ts`
 * already passes through unchanged (its hex fast path).
 */
export function createPasskeySigningProvider(
  signer: Ed25519Signer,
  publicKeyHex: string,
): PasskeySigningProvider {
  async function signBytes(bytes: Bytes): Promise<Uint8Array> {
    return signWithEd25519Signer(signer, bytes);
  }

  return {
    public_key: publicKeyHex,
    async signMessage(message: string): Promise<string> {
      return bytesToHex(await signBytes(binaryStringToBytes(message)));
    },
    async signChallenge(challenge: string): Promise<string> {
      if (!challenge.startsWith(LOGIN_CHALLENGE_PREFIX) || !PRINTABLE_ASCII_RE.test(challenge)) {
        throw new Error(
          'signChallenge: refusing to sign — not a Cancore login challenge (expected printable ASCII starting with the challenge prefix)',
        );
      }
      return bytesToHex(await signBytes(binaryStringToBytes(challenge)));
    },
    async signPreparedHash(preparedTransactionHashB64: string): Promise<string> {
      let hash: Bytes;
      try {
        hash = binaryStringToBytes(atob(preparedTransactionHashB64));
      } catch {
        throw new Error('signPreparedHash: refusing to sign — not valid base64');
      }
      if (hash.length !== PREPARED_HASH_BYTES) {
        throw new Error(
          `signPreparedHash: refusing to sign — expected a ${PREPARED_HASH_BYTES}-byte prepared-transaction hash, got ${hash.length} bytes`,
        );
      }
      return btoa(bytesToBinaryString(await signBytes(hash)));
    },
  };
}
