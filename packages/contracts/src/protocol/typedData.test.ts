import { TypedDataEncoder } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILL_PROOF_TYPES } from '../eip712';
import { encodeType, hashDomain, hashStruct, hashTypedData, type TypedDataDomain, type TypedDataTypes, typeHash } from './hash';
import { FILLER_GATEWAYS, PROTOCOL_VERSION } from './gateway';
import {
  FILL_TICKET_DOMAIN, FILL_TICKET_TYPES, FILLER_AUTH_TYPES, FILLER_KEY_REGISTRATION_TYPES, FILLER_MESSAGE_TYPES, FILLER_PROTOCOL_DOMAIN,
  FILLER_QUOTE_TYPES, GATEWAY_MESSAGE_TYPES, ORDER_TYPES, QUOTE_TYPES, routerDomain, STAKE_BINDING_TYPES, TICKET_INTENT_TYPES, TICKET_RECEIPT_TYPES,
} from './typedData';

type Vector = { note: string; chainId?: number | string; verifyingContract?: string; message: Record<string, unknown>; digest: string };
type Spec = { primaryType: string; domain: { name: string; version: string }; typeString: string; types: TypedDataTypes; vectors: Vector[] };

const spec = join(__dirname, '..', '..', 'spec');
const load = <T = Spec>(...path: string[]): T => JSON.parse(readFileSync(join(spec, ...path), 'utf8')) as T;

// The twelve types of CAN-1842 A1 and CAN-2139, the exported constant each one
// is held to, and the domain its digests are computed in.
const ROUTER = (v: Vector) => routerDomain(v.chainId!, v.verifyingContract as `0x${string}`);
const TABLE: [string, string[], TypedDataTypes, (v: Vector) => TypedDataDomain][] = [
  ['Order', ['typed-data', 'Order.json'], ORDER_TYPES, ROUTER],
  ['Quote', ['typed-data', 'Quote.json'], QUOTE_TYPES, ROUTER],
  ['FillTicket', ['typed-data', 'FillTicket.json'], FILL_TICKET_TYPES, () => FILL_TICKET_DOMAIN],
  ['FillProof', ['typed-data', 'FillProof.json'], FILL_PROOF_TYPES, ROUTER],
  ['FillerQuote', ['protocol', 'typed-data', 'FillerQuote.json'], FILLER_QUOTE_TYPES, () => FILLER_PROTOCOL_DOMAIN],
  ['TicketIntent', ['protocol', 'typed-data', 'TicketIntent.json'], TICKET_INTENT_TYPES, () => FILLER_PROTOCOL_DOMAIN],
  ['TicketReceipt', ['protocol', 'typed-data', 'TicketReceipt.json'], TICKET_RECEIPT_TYPES, () => FILLER_PROTOCOL_DOMAIN],
  ['StakeBinding', ['protocol', 'typed-data', 'StakeBinding.json'], STAKE_BINDING_TYPES, () => FILLER_PROTOCOL_DOMAIN],
  ['FillerAuth', ['protocol', 'typed-data', 'FillerAuth.json'], FILLER_AUTH_TYPES, () => FILLER_PROTOCOL_DOMAIN],
  ['GatewayMessage', ['protocol', 'typed-data', 'GatewayMessage.json'], GATEWAY_MESSAGE_TYPES, () => FILLER_PROTOCOL_DOMAIN],
  ['FillerMessage', ['protocol', 'typed-data', 'FillerMessage.json'], FILLER_MESSAGE_TYPES, () => FILLER_PROTOCOL_DOMAIN],
  ['FillerKeyRegistration', ['protocol', 'typed-data', 'FillerKeyRegistration.json'], FILLER_KEY_REGISTRATION_TYPES, () => FILLER_PROTOCOL_DOMAIN],
];

/** Encoder B: ethers, the library evm-contracts tests the router with. Mutable copies — ethers wants plain arrays. */
const ethersDigest = (domain: TypedDataDomain, types: TypedDataTypes, message: Record<string, unknown>) =>
  TypedDataEncoder.hash(domain as Record<string, string>, JSON.parse(JSON.stringify(types)), message);

describe.each(TABLE)('A1 %s', (name, path, types, domainOf) => {
  const file = load(...path);

  test('the exported types are the vector file, field for field, in order', () => {
    expect(file.primaryType).toBe(name);
    expect(JSON.parse(JSON.stringify(types))).toEqual(file.types);
    expect(encodeType(types, name)).toBe(file.typeString);
    expect(file.vectors.length).toBeGreaterThanOrEqual(3);
  });

  test.each(file.vectors.map((v) => [v.note, v] as const))('%s: two independent encoders reproduce the digest', (_n, v) => {
    const domain = domainOf(v);
    expect(domain.name).toBe(file.domain.name);
    expect(hashTypedData({ domain, types, primaryType: name, message: v.message })).toBe(v.digest);
    expect(ethersDigest(domain, types, v.message)).toBe(v.digest);
    expect(hashStruct(types, name, v.message)).toBe(TypedDataEncoder.hashStruct(name, JSON.parse(JSON.stringify(types)), v.message));
  });
});

test('Order: the canton vector is the Solidity-pinned orderHash of canton-order.json', () => {
  const pinned = load<{ vector: { orderHash: string; order: Record<string, string> } }>('vectors', 'canton-order.json').vector;
  const order = load('typed-data', 'Order.json').vectors[0]!;
  expect(order.digest).toBe(pinned.orderHash);
  expect(pinned.orderHash).toBe('0x770f1ebba8ab5b96e3efbed39c0f630d56f934f9f232771abaccdb0cf17ca204');
  expect(Object.keys(pinned.order)).toEqual(ORDER_TYPES.Order.map((f) => f.name));
});

test('FillTicket: the hashTicket example of protocol.md §3.3', () => {
  const v = load('typed-data', 'FillTicket.json').vectors[0]!;
  expect(v.message.fillerId).toBe('0xe29dae06ef4c3e336b7538b6d4f52ca1ecec009b1df6fb501320e11b223aeeaf'); // keccak256(utf8("acme"))
  expect(v.digest).toBe('0xb751ce266445dfc74d2a1e7ec2b23f51bf36ccc97706f6d0d73e4be74f9d5c33');
});

test('type hashes and domain separators equal the protocol.md §3.3 check values', () => {
  expect(typeHash(ORDER_TYPES, 'Order')).toBe('0x1f93a050ad6e8cc50e77b273767fdc0bfbb439bade69b3ffc73337227024750a');
  expect(typeHash(QUOTE_TYPES, 'Quote')).toBe('0xc76518f4d4ad76a1c01188b552131332d0907df782b6352e36e9523c3d74d249');
  expect(typeHash(FILL_TICKET_TYPES, 'FillTicket')).toBe('0x3b13cc38a5a61268c25e4816e0757e2301dc1d1fba2efe63f42f2fa30673ec82');
  expect(typeHash(FILL_PROOF_TYPES, 'FillProof')).toBe('0xc37e18cdd22fbc1e707c1bcc554d9d29c2e6c5a44bb4a9a4dc38e2c28e2419ae');
  expect(hashDomain(FILL_TICKET_DOMAIN)).toBe('0x35f199e8b545db20000547c99837ff78501f342d6d8836859d30b42646b17d70');
  expect(hashDomain(FILLER_PROTOCOL_DOMAIN)).toBe('0x71b74a11b4e5d1afa966f4dd9f0ecd2c37707e935448452b9b631c3d89038487');
});

// A2: a consumer that swaps two fields of a frozen type computes another
// digest, so its golden-vector test — this one, run in its CI — goes red.
test('A2: swapping validFrom and validUntil in TicketIntent breaks every vector, in both encoders', () => {
  const [f0, f1, f2, f3, ...rest] = TICKET_INTENT_TYPES.TicketIntent;
  const swapped = { TicketIntent: [f0, f1, f3, f2, ...rest] } as const;
  for (const v of load('protocol', 'typed-data', 'TicketIntent.json').vectors) {
    const message = { ...v.message, validFrom: v.message.validUntil, validUntil: v.message.validFrom };
    if (v.message.validFrom === v.message.validUntil) continue; // the zero vector cannot tell
    expect(hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types: swapped, primaryType: 'TicketIntent', message: v.message })).not.toBe(v.digest);
    expect(ethersDigest(FILLER_PROTOCOL_DOMAIN, swapped, v.message)).not.toBe(v.digest);
    // the values swapped with the type: same words, still a different type string
    expect(hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types: swapped, primaryType: 'TicketIntent', message })).not.toBe(v.digest);
  }
});

describe('the encoder refuses what it cannot encode faithfully', () => {
  const at = (message: Record<string, unknown>, types: TypedDataTypes = TICKET_INTENT_TYPES) => () =>
    hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types, primaryType: Object.keys(types)[0]!, message });
  const good = { orderHash: `0x${'ab'.repeat(32)}`, attempt: 1, validFrom: '10', validUntil: 20n, fillerId: 'acme', deliveryKey: `0x${'12'.repeat(20)}`, repayTo: `0x${'00'.repeat(12)}${'12'.repeat(20)}` };

  test('accepts decimal strings, numbers and bigints alike', () => {
    expect(at(good)()).toBe(at({ ...good, validFrom: 10, validUntil: '20' })());
  });
  test.each([
    ['a missing field', { ...good, validUntil: undefined }],
    ['a uint32 out of range', { ...good, attempt: 2 ** 32 }],
    ['a negative integer', { ...good, validFrom: -1 }],
    ['a fractional number', { ...good, attempt: 1.5 }],
    ['a non-decimal string', { ...good, validFrom: '1e3' }],
    ['a short bytes32', { ...good, orderHash: '0xabcd' }],
    ['a bytes32 without 0x', { ...good, orderHash: 'ab'.repeat(32) }],
  ])('throws on %s', (_n, message) => {
    expect(at(message)).toThrow();
  });
  test('throws on a malformed address and on non-string strings', () => {
    expect(at({ ...good, deliveryKey: '0x1234' })).toThrow();
    expect(at({ fillerId: 'acme', messageKey: '0x1234', issuedAt: '1' }, FILLER_KEY_REGISTRATION_TYPES)).toThrow();
    expect(at({ requestId: `0x${'00'.repeat(32)}`, fillerId: 7, amountOut: '1', validUntil: '1', nonce: '1' }, FILLER_QUOTE_TYPES)).toThrow();
    expect(at({ fillerId: 7, nonce: `0x${'00'.repeat(32)}`, expiresAt: '1' }, FILLER_AUTH_TYPES)).toThrow();
  });
  test('throws on nested structs, arrays and types it does not know', () => {
    const nested = { Outer: [{ name: 'inner', type: 'Inner' }], Inner: [{ name: 'x', type: 'uint8' }] };
    expect(() => hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types: nested, primaryType: 'Outer', message: { inner: { x: 1 } } })).toThrow(/flat/);
    expect(at({ xs: [] }, { A: [{ name: 'xs', type: 'uint8[]' }] })).toThrow();
    expect(at({ x: 1 }, { A: [{ name: 'x', type: 'int8' }] })).toThrow();
    expect(() => encodeType(TICKET_INTENT_TYPES, 'Nope')).toThrow();
  });
  test('encodes bool, bytes and uint256 like ethers', () => {
    const types = { Misc: [{ name: 'flag', type: 'bool' }, { name: 'blob', type: 'bytes' }, { name: 'n', type: 'uint256' }] };
    const message = { flag: true, blob: '0xdeadbeef', n: (1n << 255n).toString() };
    expect(hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types, primaryType: 'Misc', message })).toBe(ethersDigest(FILLER_PROTOCOL_DOMAIN, types, message));
  });
  test('a domain with chainId, verifyingContract and salt hashes like ethers', () => {
    const domain = { name: 'X', version: '2', chainId: 5, verifyingContract: `0x${'12'.repeat(20)}`, salt: `0x${'34'.repeat(32)}` };
    expect(hashDomain(domain)).toBe(TypedDataEncoder.hashDomain(domain));
  });
});

test('the published gateway keys are empty in the RC, and the protocol major is "1"', () => {
  expect(PROTOCOL_VERSION).toBe('1');
  for (const env of ['mainnet', 'testnet', 'devnet'] as const) expect(FILLER_GATEWAYS[env]).toEqual({ gateway: null, ticketSigners: [] });
});
