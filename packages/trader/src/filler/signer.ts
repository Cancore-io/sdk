/**
 * Signers and the signature contract.
 *
 * The package holds no keys. A filler node builds its signers from keys in its
 * `.env`, one key per purpose (filler-node N-5, N-6):
 *
 * - quote key — `QuoteSigner`: signs `FillerAuth` at login and `FillerQuote`, nothing else;
 * - fill key per EVM chain — `FillSigner`: signs `TicketIntent` / `TicketReceipt`
 *   (and `CantonTicketReceipt`) and the `fill` / `settle` transactions;
 * - staking key — `StakingSigner`: signs one `StakeBinding`, passed to `bindStake` only.
 *
 * Every signature a signer returns goes through `assertSignature` and a
 * recovery check before the SDK uses it, so a misbehaving signer (64 bytes,
 * high-s, `v` of 0/1, the wrong key) fails loudly instead of producing a frame
 * `filler-gateway` or the router rejects.
 */
import { hashTypedData, type Hex, type TypedDataInput } from '@cancore/contracts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { SignatureContractError } from './errors';

/**
 * Signs EIP-712 typed data. The input is exactly what `@cancore/contracts`
 * builds (`FILLER_PROTOCOL_DOMAIN`, `FILLER_QUOTE_TYPES`, …); the signer signs
 * `hashTypedData(input)`.
 *
 * Contract: resolves to 65 bytes `r ‖ s ‖ v` as `0x`-hex, with `s ≤ n/2`
 * (low-s) and `v ∈ {27, 28}` (protocol §3.1). Never logs the input or the result.
 */
export interface TypedDataSigner {
  /** The address the key derives to, `0x` + 40 hex. */
  readonly address: Hex;
  signTypedData(input: TypedDataInput): Promise<Hex>;
}

/** An EIP-1559 transaction the SDK asks a fill key to sign. */
export interface EvmTransactionRequest {
  chainId: bigint;
  nonce: bigint;
  to: Hex;
  data: Hex;
  value: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * Signs EVM transactions. Resolves to the raw signed transaction (`0x02…`),
 * which the SDK broadcasts itself through `EvmRpc` (`eth_sendRawTransaction`)
 * on a nonce it leased from the store — the signer never broadcasts and never
 * picks a nonce.
 */
export interface TransactionSigner {
  readonly address: Hex;
  signTransaction(tx: EvmTransactionRequest): Promise<Hex>;
}

/** The fill key of one EVM chain: its address is the filler address of protocol §3.2. */
export interface FillSigner extends TypedDataSigner, TransactionSigner {}

/** The quote key. */
export type QuoteSigner = TypedDataSigner;

/** The staking key; used once per `StakeBinding`, never loaded by a running node. */
export type StakingSigner = TypedDataSigner;

const CURVE_N = secp256k1.CURVE.n;
const HALF_N = CURVE_N >> 1n;
const SIG_RE = /^0x[0-9a-fA-F]*$/;

/**
 * Holds a signature to the wire rule: 65 bytes `r ‖ s ‖ v`, `0 < r < n`,
 * `0 < s ≤ n/2`, `v ∈ {27, 28}`. Returns it lowercased; throws
 * `SignatureContractError` otherwise.
 */
export function assertSignature(signature: unknown): Hex {
  if (typeof signature !== 'string' || !SIG_RE.test(signature) || signature.length % 2 !== 0) {
    throw new SignatureContractError('not-hex', 'signature: expected 0x-prefixed hex');
  }
  const bytes = hexToBytes(signature.slice(2));
  if (bytes.length !== 65) throw new SignatureContractError('length', `signature: expected 65 bytes, got ${bytes.length}`);
  const r = BigInt(`0x${bytesToHex(bytes.subarray(0, 32))}`);
  const s = BigInt(`0x${bytesToHex(bytes.subarray(32, 64))}`);
  const v = bytes[64]!;
  if (r === 0n || s === 0n) throw new SignatureContractError('zero-r-or-s', 'signature: r and s must be non-zero');
  if (r >= CURVE_N) throw new SignatureContractError('r-out-of-range', 'signature: r is not below the curve order');
  if (s > HALF_N) throw new SignatureContractError('high-s', 'signature: s is in the upper half of the curve order (high-s)');
  if (v !== 27 && v !== 28) throw new SignatureContractError('v', `signature: v must be 27 or 28, got ${v}`);
  return `0x${bytesToHex(bytes)}`;
}

/** The address (lowercase) that signed `digest` (32 bytes), from a signature that passed `assertSignature`. */
export function recoverAddress(digest: Hex, signature: Hex): Hex {
  const sig = hexToBytes(assertSignature(signature).slice(2));
  const point = secp256k1.Signature.fromCompact(sig.subarray(0, 64))
    .addRecoveryBit(sig[64]! - 27)
    .recoverPublicKey(hexToBytes(digest.slice(2)));
  return addressOfPublicKey(point.toRawBytes(false));
}

/** The signer of EIP-712 typed data (lowercase address). */
export const recoverTypedDataSigner = (input: TypedDataInput, signature: Hex): Hex =>
  recoverAddress(hashTypedData(input), signature);

/**
 * Asks `signer` to sign `input` and holds the result to the contract: the wire
 * rule (`assertSignature`) and recovery to `signer.address`. The only way the
 * SDK obtains a signature.
 */
export async function signTypedDataChecked(signer: TypedDataSigner, input: TypedDataInput): Promise<Hex> {
  const signature = assertSignature(await signer.signTypedData(input));
  const recovered = recoverTypedDataSigner(input, signature);
  if (recovered !== signer.address.toLowerCase()) {
    throw new SignatureContractError('signer-mismatch', `signature: recovers to ${recovered}, signer claims ${signer.address}`);
  }
  return signature;
}

/** Ethereum address of an uncompressed (65-byte) secp256k1 public key. */
export function addressOfPublicKey(uncompressed: Uint8Array): Hex {
  if (uncompressed.length !== 65 || uncompressed[0] !== 4) throw new TypeError('expected a 65-byte uncompressed public key');
  return `0x${bytesToHex(keccak_256(uncompressed.subarray(1)).subarray(12))}`;
}
