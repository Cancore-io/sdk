/**
 * EIP-1559 transactions for tests: a `FillSigner` over a test key that signs
 * real type-2 transactions, and the decoder `FakeChain` reads them back with.
 * Test keys only; a filler node builds its signers from `.env`.
 */
import type { Hex } from '@cancore/contracts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils';
import { addressOfPublicKey, type EvmTransactionRequest, type FillSigner } from '../signer';
import { createTestTypedDataSigner } from './fakes';

type RlpItem = Uint8Array | RlpItem[];

const bytesOfInt = (n: bigint): Uint8Array => (n === 0n ? new Uint8Array(0) : hexToBytes(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0')));
const intOfBytes = (b: Uint8Array): bigint => (b.length === 0 ? 0n : BigInt(`0x${bytesToHex(b)}`));

function length(len: number, offset: number): Uint8Array {
  if (len <= 55) return Uint8Array.of(offset + len);
  const l = bytesOfInt(BigInt(len));
  return concatBytes(Uint8Array.of(offset + 55 + l.length), l);
}

export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0]! < 0x80) return item;
    return concatBytes(length(item.length, 0x80), item);
  }
  const payload = concatBytes(...item.map(rlpEncode));
  return concatBytes(length(payload.length, 0xc0), payload);
}

export function rlpDecode(data: Uint8Array): RlpItem {
  const [item, rest] = decodeOne(data);
  if (rest.length !== 0) throw new Error('rlp: trailing bytes');
  return item;
}

function decodeOne(data: Uint8Array): [RlpItem, Uint8Array] {
  const p = data[0];
  if (p === undefined) throw new Error('rlp: empty');
  if (p < 0x80) return [data.subarray(0, 1), data.subarray(1)];
  const span = (short: number, long: number): [number, number] => {
    if (p <= long) return [1, p - short];
    const ll = p - long;
    return [1 + ll, Number(intOfBytes(data.subarray(1, 1 + ll)))];
  };
  if (p < 0xc0) {
    const [head, len] = span(0x80, 0xb7);
    return [data.subarray(head, head + len), data.subarray(head + len)];
  }
  const [head, len] = span(0xc0, 0xf7);
  let payload = data.subarray(head, head + len);
  const items: RlpItem[] = [];
  while (payload.length > 0) {
    const [item, rest] = decodeOne(payload);
    items.push(item);
    payload = rest;
  }
  return [items, data.subarray(head + len)];
}

const unsignedFields = (tx: EvmTransactionRequest): RlpItem[] => [
  bytesOfInt(tx.chainId),
  bytesOfInt(tx.nonce),
  bytesOfInt(tx.maxPriorityFeePerGas),
  bytesOfInt(tx.maxFeePerGas),
  bytesOfInt(tx.gasLimit),
  hexToBytes(tx.to.slice(2)),
  bytesOfInt(tx.value),
  hexToBytes(tx.data.slice(2)),
  [],
];

/** A decoded, signed type-2 transaction. */
export interface DecodedTransaction extends EvmTransactionRequest {
  from: Hex;
  hash: Hex;
}

/** Decodes a raw `0x02…` transaction and recovers its sender. */
export function decodeSignedTransaction(raw: Hex): DecodedTransaction {
  const bytes = hexToBytes(raw.slice(2));
  if (bytes[0] !== 2) throw new Error('not an EIP-1559 transaction');
  const fields = rlpDecode(bytes.subarray(1));
  if (!Array.isArray(fields) || fields.length !== 12) throw new Error('malformed EIP-1559 transaction');
  const b = fields as Uint8Array[];
  const tx: EvmTransactionRequest = {
    chainId: intOfBytes(b[0]!),
    nonce: intOfBytes(b[1]!),
    maxPriorityFeePerGas: intOfBytes(b[2]!),
    maxFeePerGas: intOfBytes(b[3]!),
    gasLimit: intOfBytes(b[4]!),
    to: `0x${bytesToHex(b[5]!)}`,
    value: intOfBytes(b[6]!),
    data: `0x${bytesToHex(b[7]!)}`,
  };
  const digest = keccak_256(concatBytes(Uint8Array.of(2), rlpEncode(unsignedFields(tx))));
  const signature = new secp256k1.Signature(intOfBytes(b[10]!), intOfBytes(b[11]!)).addRecoveryBit(Number(intOfBytes(b[9]!)));
  const from = addressOfPublicKey(signature.recoverPublicKey(digest).toRawBytes(false));
  return { ...tx, from, hash: `0x${bytesToHex(keccak_256(bytes))}` };
}

/** A `FillSigner` over a test key: EIP-712 like `createTestTypedDataSigner`, and real signed EIP-1559 transactions. */
export function createTestFillSigner(privateKey: Hex): FillSigner {
  const key = hexToBytes(privateKey.slice(2));
  const typed = createTestTypedDataSigner(privateKey);
  return {
    address: addressOfPublicKey(secp256k1.getPublicKey(key, false)),
    signTypedData: typed.signTypedData,
    async signTransaction(tx: EvmTransactionRequest): Promise<Hex> {
      const fields = unsignedFields(tx);
      const digest = keccak_256(concatBytes(Uint8Array.of(2), rlpEncode(fields)));
      const sig = secp256k1.sign(digest, key, { lowS: true });
      const signed = rlpEncode([...fields, bytesOfInt(BigInt(sig.recovery)), bytesOfInt(sig.r), bytesOfInt(sig.s)]);
      return `0x02${bytesToHex(signed)}`;
    },
  };
}
