import { FILLER_PROTOCOL_DOMAIN, FILLER_QUOTE_TYPES, hashTypedData, requestIdHash, type Hex, type TypedDataInput } from '@cancore/contracts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { Wallet } from 'ethers';
import { SignatureContractError } from './errors';
import { assertSignature, recoverAddress, recoverTypedDataSigner, signTypedDataChecked, type TypedDataSigner } from './signer';
import { createTestTypedDataSigner } from './testing';

// Hardhat's well-known account #0 and #1: public test keys, never funded on a real network.
const KEY_A: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS_A = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const KEY_B: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const quote: TypedDataInput = {
  domain: FILLER_PROTOCOL_DOMAIN,
  types: FILLER_QUOTE_TYPES,
  primaryType: 'FillerQuote',
  message: {
    requestId: requestIdHash('req-1'),
    filler: ADDRESS_A,
    amountOut: '1000000',
    validUntil: '1790000060',
    nonce: '1',
  },
};

const N = secp256k1.CURVE.n;
const hex = (n: bigint) => n.toString(16).padStart(64, '0');
const split = (sig: Hex) => ({ r: BigInt(`0x${sig.slice(2, 66)}`), s: BigInt(`0x${sig.slice(66, 130)}`), v: parseInt(sig.slice(130), 16) });

/** A signer that returns whatever `mangle` makes of a correct signature. */
const mangled = (mangle: (sig: Hex) => string): TypedDataSigner => {
  const inner = createTestTypedDataSigner(KEY_A);
  return { address: inner.address, signTypedData: async (input) => mangle(await inner.signTypedData(input)) as Hex };
};

const violationOf = async (signer: TypedDataSigner) => {
  try {
    await signTypedDataChecked(signer, quote);
  } catch (error) {
    expect(error).toBeInstanceOf(SignatureContractError);
    return (error as SignatureContractError).violation;
  }
  throw new Error('expected SignatureContractError');
};

describe('signer contract: 65 bytes r‖s‖v, low-s, v ∈ {27, 28} (protocol §3.1)', () => {
  test('the test signer derives the right address and passes the contract', async () => {
    const signer = createTestTypedDataSigner(KEY_A);
    expect(signer.address).toBe(ADDRESS_A);
    const sig = await signTypedDataChecked(signer, quote);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect([27, 28]).toContain(split(sig).v);
  });

  test('agrees with an independent EIP-712 implementation (ethers) both ways', async () => {
    const wallet = new Wallet(KEY_A);
    const types = { FillerQuote: FILLER_QUOTE_TYPES.FillerQuote.map((f) => ({ ...f })) };
    const theirs = (await wallet.signTypedData(FILLER_PROTOCOL_DOMAIN, types, quote.message)) as Hex;
    expect(recoverTypedDataSigner(quote, theirs)).toBe(ADDRESS_A);
    const ours = await createTestTypedDataSigner(KEY_A).signTypedData(quote);
    expect(ours).toBe(theirs.toLowerCase()); // RFC 6979: deterministic, so byte-identical
  });

  test('64 bytes is refused', async () => {
    expect(await violationOf(mangled((sig) => sig.slice(0, 130)))).toBe('length');
  });

  test('66 bytes is refused', async () => {
    expect(await violationOf(mangled((sig) => `${sig}00`))).toBe('length');
  });

  test('high-s is refused, although it recovers to the same key', async () => {
    const highS = mangled((sig) => {
      const { r, s, v } = split(sig);
      return `0x${hex(r)}${hex(N - s)}${(v === 27 ? 28 : 27).toString(16)}`;
    });
    // The malleable twin is a valid ECDSA signature by the same key — exactly
    // why the rule exists: OpenZeppelin ECDSA.recover rejects it on chain.
    const twin = (await highS.signTypedData(quote)) as Hex;
    const { r, s, v } = split(twin);
    const recovered = secp256k1.Signature.fromCompact(`${hex(r)}${hex(s)}`).addRecoveryBit(v - 27).recoverPublicKey(hashTypedData(quote).slice(2));
    expect(recovered.toHex(false)).toBe(bytesToHex(secp256k1.getPublicKey(KEY_A.slice(2), false)));
    expect(await violationOf(highS)).toBe('high-s');
  });

  test.each([0, 1, 29, 35])('v = %i is refused', async (v) => {
    expect(await violationOf(mangled((sig) => `${sig.slice(0, 130)}${v.toString(16).padStart(2, '0')}`))).toBe('v');
  });

  test('zero r or s is refused', async () => {
    expect(await violationOf(mangled((sig) => `0x${hex(0n)}${sig.slice(66)}`))).toBe('zero-r-or-s');
    expect(await violationOf(mangled((sig) => `${sig.slice(0, 66)}${hex(0n)}${sig.slice(130)}`))).toBe('zero-r-or-s');
  });

  test('r at or above the curve order is refused', async () => {
    expect(await violationOf(mangled((sig) => `0x${hex(N)}${sig.slice(66)}`))).toBe('r-out-of-range');
  });

  test('non-hex is refused', async () => {
    expect(await violationOf(mangled(() => 'not a signature'))).toBe('not-hex');
    expect(await violationOf(mangled((sig) => sig.slice(2)))).toBe('not-hex');
  });

  test('a signature by another key than the signer claims is refused', async () => {
    const liar: TypedDataSigner = { address: ADDRESS_A, signTypedData: (input) => createTestTypedDataSigner(KEY_B).signTypedData(input) };
    expect(await violationOf(liar)).toBe('signer-mismatch');
  });

  test('accepts an EIP-55 checksummed signer address', async () => {
    const inner = createTestTypedDataSigner(KEY_A);
    const checksummed: TypedDataSigner = { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', signTypedData: inner.signTypedData };
    await expect(signTypedDataChecked(checksummed, quote)).resolves.toMatch(/^0x/);
  });

  test('assertSignature lowercases; recoverAddress refuses a malformed signature', async () => {
    const sig = await createTestTypedDataSigner(KEY_A).signTypedData(quote);
    expect(assertSignature(sig.toUpperCase().replace('0X', '0x'))).toBe(sig);
    expect(() => recoverAddress(hashTypedData(quote), sig.slice(0, 130) as Hex)).toThrow(SignatureContractError);
  });
});
