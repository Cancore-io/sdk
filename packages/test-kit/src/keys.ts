/**
 * TEST ONLY. Every key here is `keccak256("cancore:test-kit:<role>:v1")`: its
 * private half is public knowledge, printed in this file and derivable by
 * anyone. Never fund an address below, never register one on a real router or
 * gateway. `@cancore/contracts` never carries them (FILLER_GATEWAYS is the
 * real, published set).
 *
 * Signatures are the protocol's (§3.1): 65 bytes `r ‖ s ‖ v`, low-s,
 * `v ∈ {27, 28}` — what OpenZeppelin `ECDSA.recover` accepts, and nothing else.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export type Hex = `0x${string}`;

export interface TestKey {
  /** TEST ONLY — publicly known. */
  privateKey: Hex;
  address: Hex;
}

export type TestKeyRole = 'gateway' | 'ticketSigner' | 'foreignSigner' | 'acmeQuote' | 'acmeFiller' | 'zetaQuote' | 'zetaFiller';

export class BadSignatureError extends Error {
  override name = 'BadSignatureError';
}

const hex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`;
const HALF_N = secp256k1.CURVE.n / 2n;

export function addressOf(privateKey: Hex): Hex {
  const pub = secp256k1.getPublicKey(hexToBytes(privateKey.slice(2)), false);
  return hex(keccak_256(pub.subarray(1)).subarray(12));
}

/** The TEST key of a role: `keccak256("cancore:test-kit:<role>:v1")`. */
export function testKey(role: string): TestKey {
  const privateKey = hex(keccak_256(utf8ToBytes(`cancore:test-kit:${role}:v1`)));
  return { privateKey, address: addressOf(privateKey) };
}

const ROLES: TestKeyRole[] = ['gateway', 'ticketSigner', 'foreignSigner', 'acmeQuote', 'acmeFiller', 'zetaQuote', 'zetaFiller'];

/**
 * TEST ONLY, publicly known, never fund. The mock's gateway key, its one
 * ticket signer, a "foreign" signer outside `ticketSigners`, and the quote and
 * filler keys of the two fixture takers `acme-markets` and `zeta-liquidity`.
 */
export const TEST_KEYS: Readonly<Record<TestKeyRole, TestKey>> = Object.freeze(Object.fromEntries(ROLES.map((r) => [r, testKey(r)])) as Record<TestKeyRole, TestKey>);

/** 65-byte `r ‖ s ‖ v` over a 32-byte digest; low-s, v ∈ {27, 28}. */
export function sign(digest: Hex, privateKey: Hex): Hex {
  const s = secp256k1.sign(hexToBytes(digest.slice(2)), hexToBytes(privateKey.slice(2)), { lowS: true });
  return `0x${s.toCompactHex()}${(27 + s.recovery).toString(16)}`;
}

/** The address that signed `digest`. Rejects what `ECDSA.recover` rejects: high-s, v ∉ {27, 28}, a wrong length. */
export function recover(digest: Hex, sig: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new BadSignatureError('signature must be 65 bytes of hex');
  const v = parseInt(sig.slice(130), 16);
  if (v !== 27 && v !== 28) throw new BadSignatureError(`v must be 27 or 28, got ${v}`);
  const parsed = secp256k1.Signature.fromCompact(sig.slice(2, 130));
  if (parsed.s > HALF_N) throw new BadSignatureError('high-s signature');
  try {
    const pub = parsed.addRecoveryBit(v - 27).recoverPublicKey(hexToBytes(digest.slice(2)));
    return hex(keccak_256(pub.toRawBytes(false).subarray(1)).subarray(12));
  } catch (e) {
    throw new BadSignatureError(`signature does not recover: ${(e as Error).message}`);
  }
}
