import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fillerIdHash, repayToFromEvm, type AttestationEvm, type FillProofJson, type Hex } from '@cancore/contracts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { hashFillProof } from '../chain/hashes';
import { addressOfPublicKey } from '../signer';
import { collectAttestations, fillProofOf, verifyAttestations, type AttestorSetView } from './attestations';

/** anvil's default test keys. */
const KEYS: Hex[] = [
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
];
const OUTSIDER: Hex = '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356';
const SOURCE = { chainId: 56n, router: '0x5656565656565656565656565656565656565656' as Hex };

const addressOf = (key: Hex): Hex => addressOfPublicKey(secp256k1.getPublicKey(hexToBytes(key.slice(2)), false));
const sign = (key: Hex, digest: Hex): AttestationEvm => {
  const sig = secp256k1.sign(hexToBytes(digest.slice(2)), hexToBytes(key.slice(2)), { lowS: true });
  return { signer: addressOf(key), signature: `0x${bytesToHex(sig.toCompactRawBytes())}${(27 + sig.recovery).toString(16)}` };
};
/** The same signature with `s` mirrored to the upper half: valid ECDSA, refused by `ECDSA.recover`. */
const highS = (entry: AttestationEvm): AttestationEvm => {
  const bytes = hexToBytes(entry.signature.slice(2));
  const s = BigInt(`0x${bytesToHex(bytes.subarray(32, 64))}`);
  const mirrored = secp256k1.CURVE.n - s;
  return { signer: entry.signer, signature: `0x${entry.signature.slice(2, 66)}${mirrored.toString(16).padStart(64, '0')}${bytes[64] === 27 ? '1c' : '1b'}` };
};

const proof: FillProofJson = {
  kind: 1,
  orderHash: `0x${'4f'.repeat(32)}`,
  destination: `0x${'00'.repeat(31)}01`,
  fillRef: `0x${'cc'.repeat(32)}`,
  recipient: `0x${'00'.repeat(12)}${'0b'.repeat(20)}`,
  outputAsset: `0x${'00'.repeat(12)}${'aa'.repeat(20)}`,
  amountDelivered: '100',
  filledAt: '1790000100',
  fillerId: fillerIdHash('acme-1'),
  repayTo: repayToFromEvm('0x70997970c51812dc3a010c7d01b50e0d17dc79c8'),
  attempt: 0,
  setId: 1,
};
const digest = hashFillProof(fillProofOf(proof), SOURCE);
const members = KEYS.slice(0, 3).map(addressOf);
const set: AttestorSetView = { setId: 1, members, threshold: 2, revoked: [] };
const ascending = (entries: AttestationEvm[]) => [...entries].sort((a, b) => (a.signer < b.signer ? -1 : 1));

describe('verifyAttestations — what settle accepts', () => {
  test('k + 1 valid: the lowest k signers go, strictly ascending', () => {
    const all = KEYS.slice(0, 3).map((k) => sign(k, digest));
    const result = verifyAttestations({ proof, source: SOURCE, signatures: [all[2]!, all[0]!, all[1]!], set });
    expect(result.digest).toBe(digest);
    expect(result.valid.map((v) => v.signer)).toEqual(ascending(all).map((v) => v.signer));
    expect(result.selected).toEqual(ascending(all).slice(0, 2));
    expect(result.enough).toBe(true);
  });

  test('an extra invalid signature is dropped, never sent: outsider, revoked, duplicate, high-s, another digest', () => {
    const [a, b, c] = KEYS.slice(0, 3).map((k) => sign(k, digest));
    const otherDigest = hashFillProof(fillProofOf({ ...proof, amountDelivered: '101' }), SOURCE);
    const result = verifyAttestations({
      proof,
      source: SOURCE,
      signatures: [sign(OUTSIDER, digest), a!, a!, highS(b!), c!, { ...sign(KEYS[1]!, otherDigest), signer: addressOf(KEYS[1]!) }, sign(KEYS[0]!, digest)],
      set: { ...set, revoked: [c!.signer] },
    });
    expect(result.rejected.map((r) => r.reason).sort()).toEqual(['duplicate', 'duplicate', 'high-s', 'not-member', 'revoked', 'signer-mismatch']);
    expect(result.valid).toEqual([a]);
    expect(result.enough).toBe(false);
    expect(result.selected).toEqual([]);
  });

  test('fewer than k valid: not enough, nothing selected', () => {
    const result = verifyAttestations({ proof, source: SOURCE, signatures: [sign(KEYS[0]!, digest)], set });
    expect(result).toMatchObject({ enough: false, selected: [] });
  });

  test('a signer claiming another address is refused even when the key is a member', () => {
    const forged = { ...sign(KEYS[0]!, digest), signer: members[1]! };
    expect(verifyAttestations({ proof, source: SOURCE, signatures: [forged], set }).rejected).toEqual([{ signer: members[1]!.toLowerCase(), reason: 'signer-mismatch' }]);
  });
});

describe('collectAttestations — one digest, the filler\'s own', () => {
  test('answers over one digest pool their signatures', () => {
    const [a, b] = KEYS.slice(0, 2).map((k) => sign(k, digest));
    const result = collectAttestations({ answers: [{ proof, signatures: [a!] }, { proof, signatures: [b!] }], source: SOURCE, set, expected: proof });
    expect(result).toMatchObject({ divergent: false, enough: true, digest, proof });
    expect(result.selected).toEqual(ascending([a!, b!]));
  });

  test('two digests: divergent, nothing kept', () => {
    const other = { ...proof, filledAt: '1790000101' };
    const result = collectAttestations({
      answers: [
        { proof, signatures: [sign(KEYS[0]!, digest)] },
        { proof: other, signatures: [sign(KEYS[1]!, hashFillProof(fillProofOf(other), SOURCE))] },
      ],
      source: SOURCE,
      set,
    });
    expect(result).toMatchObject({ divergent: true, enough: false, selected: [] });
    expect(result.digests).toHaveLength(2);
  });

  test('one digest, but not the filler\'s own proof: divergent', () => {
    const other = { ...proof, repayTo: repayToFromEvm('0x00000000000000000000000000000000000000ee') };
    const otherDigest = hashFillProof(fillProofOf(other), SOURCE);
    const result = collectAttestations({ answers: [{ proof: other, signatures: KEYS.slice(0, 2).map((k) => sign(k, otherDigest)) }], source: SOURCE, set, expected: proof });
    expect(result).toMatchObject({ divergent: true, enough: false });
    expect(result.digests).toEqual([otherDigest, digest]);
  });
});

test('the module depends on no transport: no protocol client, session, store or runtime import (a relayer can use it)', () => {
  const source = readFileSync(join(__dirname, 'attestations.ts'), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  expect(imports.filter((i) => /protocol|session|store|runtime|delivery|filler'$/.test(i!))).toEqual([]);
});
