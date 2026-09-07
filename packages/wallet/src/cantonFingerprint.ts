import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes } from './bytes';

/**
 * Canton's `HashPurpose.PublicKeyFingerprint`. The fingerprint is
 * `sha256(int32BE(purpose) || rawKeyBytes)`, rendered as the `1220…` multihash
 * (0x12 = sha256, 0x20 = 32 bytes) that forms the second half of a party id.
 */
const PUBLIC_KEY_FINGERPRINT_PURPOSE = 12;
const MULTIHASH_SHA256_32 = '1220';

/**
 * Fingerprint of an Ed25519 public key, in the exact form a party id carries
 * after `::`.
 *
 * Lets the browser answer "can this device sign for that party?" locally,
 * before preparing anything: a key+password wallet holds several accounts per
 * device with no session binding, so signing for the wrong party is a reachable
 * state — and the ledger's answer to it is an opaque
 * FAILED_TO_EXECUTE_TRANSACTION ("Received 0 valid signatures"), far too late
 * and far too vague to route a user out of (BUG-318).
 */
export function cantonFingerprint(publicKeyHex: string): string {
  const purpose = new Uint8Array(4);
  new DataView(purpose.buffer).setInt32(0, PUBLIC_KEY_FINGERPRINT_PURPOSE, false);
  const key = hexToBytes(publicKeyHex);
  const input = new Uint8Array(purpose.length + key.length);
  input.set(purpose, 0);
  input.set(key, purpose.length);
  return MULTIHASH_SHA256_32 + bytesToHexLower(sha256(input));
}

/** The `::`-suffix of a party id, i.e. the fingerprint its namespace key must have. */
export function partyNamespace(partyId: string): string | null {
  return partyId.split('::')[1] ?? null;
}

/** Whether `publicKeyHex` is the namespace key of `partyId`. */
export function keyOwnsParty(publicKeyHex: string, partyId: string): boolean {
  const namespace = partyNamespace(partyId);
  if (!namespace) return false;
  return cantonFingerprint(publicKeyHex) === namespace;
}

function bytesToHexLower(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
