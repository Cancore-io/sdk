import { keccak_256 } from '@noble/hashes/sha3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILL_PROOF_DOMAIN, FILL_PROOF_TYPES, FILL_PROOF_TYPE_STRING, fillProofDomain, PROOF_KIND_ATTESTATION } from './index';
import type { FillProof } from './index';

// The FillProof interface is hand-written; the types are generated. A field
// added, renamed or dropped by `npm run sync` must break the build (CI's
// typecheck covers this file), not ship two exports that disagree.
type SchemaFields = (typeof FILL_PROOF_TYPES)['FillProof'][number]['name'];
const sameFields: [SchemaFields] extends [keyof FillProof] ? ([keyof FillProof] extends [SchemaFields] ? true : never) : never = true;
void sameFields;

// The contract's schema and golden vectors, as synced from evm-contracts, where
// test/CancoreRouter.ts checks the same file against the router itself. This
// suite checks it with an encoder of its own — not the one any consumer uses —
// so a field changed in one place fails here and there.
const spec = JSON.parse(readFileSync(join(__dirname, '..', 'spec', 'typed-data', 'FillProof.json'), 'utf8')) as {
  domain: { name: string; version: string };
  typeString: string;
  types: typeof FILL_PROOF_TYPES;
  vectors: { note: string; chainId: number; verifyingContract: string; message: Record<string, string | number>; digest: string }[];
};

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const keccak = (b: Uint8Array) => keccak_256(b);
const bytes = (h: string) => Uint8Array.from(h.slice(2).match(/../g)!.map((x) => parseInt(x, 16)));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) out.set(p, (i += p.length) - p.length);
  return out;
};
/** One static EIP-712 value as its 32-byte word: uintN and address left-padded, bytes32 as is. */
const word = (type: string, value: string | number) => {
  if (type === 'bytes32') return bytes(String(value));
  const n = type === 'address' ? BigInt(String(value)) : BigInt(value);
  const bits = type === 'address' ? 160 : Number(type.slice(4));
  if (n < 0n || n >= 1n << BigInt(bits)) throw new Error(`${value} does not fit ${type}`);
  return bytes(`0x${n.toString(16).padStart(64, '0')}`);
};

function digest(v: (typeof spec.vectors)[number]) {
  const typeString = `FillProof(${FILL_PROOF_TYPES.FillProof.map((f) => `${f.type} ${f.name}`).join(',')})`;
  const structHash = keccak(concat(keccak(enc.encode(typeString)), ...FILL_PROOF_TYPES.FillProof.map((f) => word(f.type, v.message[f.name]!))));
  const domain = fillProofDomain(v.chainId, v.verifyingContract as `0x${string}`);
  const domainSeparator = keccak(
    concat(
      keccak(enc.encode('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
      keccak(enc.encode(domain.name)),
      keccak(enc.encode(domain.version)),
      word('uint256', domain.chainId),
      word('address', domain.verifyingContract),
    ),
  );
  return `0x${hex(keccak(concat(bytes('0x1901'), domainSeparator, structHash)))}`;
}

test('the exported FillProof types are the synced schema, field for field, in order', () => {
  expect(FILL_PROOF_TYPES).toEqual(spec.types);
  expect(FILL_PROOF_DOMAIN).toEqual({ name: spec.domain.name, version: spec.domain.version });
  expect(FILL_PROOF_TYPE_STRING).toBe(spec.typeString);
  expect(`FillProof(${FILL_PROOF_TYPES.FillProof.map((f) => `${f.type} ${f.name}`).join(',')})`).toBe(FILL_PROOF_TYPE_STRING);
});

test.each(spec.vectors.map((v) => [v.note, v] as const))('golden vector: %s', (_note, v) => {
  expect(digest(v)).toBe(v.digest);
});

test('the vectors cover what a schema drift would hide: extremes, zeros, two routers, two chains', () => {
  const chains = new Set(spec.vectors.map((v) => v.chainId));
  const routers = new Set(spec.vectors.map((v) => v.verifyingContract));
  expect(chains.size).toBeGreaterThan(1);
  expect(routers.size).toBeGreaterThan(1);
  expect(spec.vectors.some((v) => v.message.amountDelivered === ((1n << 256n) - 1n).toString())).toBe(true);
});

test('the domain is the source router, and v1 settles one proof kind', () => {
  expect(fillProofDomain(1, '0x0000000000000000000000000000000000000001')).toEqual({
    name: 'CancoreRouter',
    version: '1',
    chainId: 1,
    verifyingContract: '0x0000000000000000000000000000000000000001',
  });
  expect(PROOF_KIND_ATTESTATION).toBe(1);
});
