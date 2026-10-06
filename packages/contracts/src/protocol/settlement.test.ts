import Ajv2020 from 'ajv/dist/2020';
import { recoverAddress, Signature, TypedDataEncoder } from 'ethers';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pkg from '../index';
import {
  fillerEnvelopeError, fillerIdHash, hashFillerKeyRegistration, hashFillerMessage, hashFillerQuote, hashFillTicket, hashTicketIntent,
  evmAddressFromRepayTo, isEoaSignature, isEvmRepayTo, repayToFromEvm, repayToFromParty,
} from './index';
import { messageSchemaRef, PROTOCOL_SCHEMAS, SCHEMA_VOCABULARY } from './schemas';
import {
  FILL_TICKET_DOMAIN, FILL_TICKET_TYPES, FILLER_KEY_REGISTRATION_TYPES, FILLER_PROTOCOL_DOMAIN, type FillerKeyRegistration, type FillTicket,
  type Hex, type TicketIntent,
} from './typedData';

// The settlement design of variant A (protocol.md §3.3, §3.4, §3.15, §3.16; CAN-2139):
// fillerId, deliveryKey and repayTo travel with the ticket; every filler message is
// signed; one message key, registered with proof of possession, no rotation type.

const spec = join(__dirname, '..', '..', 'spec');
const load = <T>(...p: string[]): T => JSON.parse(readFileSync(join(spec, ...p), 'utf8')) as T;
type Vector<M> = { note: string; message: M; digest: string; signature?: string; body?: Record<string, unknown> };
const vectors = <M>(...p: string[]) => load<{ vectors: Vector<M>[] }>(...p).vectors;

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const ADDR = '0x742d35cc6634c0532925a3b844bc454e4438f44e';

describe('fillerId and repayTo in on-chain form', () => {
  test('fillerIdHash is keccak256(utf8(fillerId)), the protocol.md §3.3 check value', () => {
    expect(fillerIdHash('acme')).toBe('0xe29dae06ef4c3e336b7538b6d4f52ca1ecec009b1df6fb501320e11b223aeeaf');
  });
  test.each([[''], ['Acme'], ['-acme'], ['acme markets'], ['a'.repeat(64)], ['acmé']])('fillerIdHash refuses %j: not a fillerId', (id) => {
    expect(() => fillerIdHash(id)).toThrow();
  });
  test('repayToFromEvm left-pads to 32 bytes, lowercase, and refuses the zero address', () => {
    expect(repayToFromEvm('0x742D35Cc6634C0532925a3b844Bc454e4438f44e')).toBe(`0x${'00'.repeat(12)}${ADDR.slice(2)}`);
    expect(() => repayToFromEvm(`0x${'00'.repeat(20)}`)).toThrow();
    expect(() => repayToFromEvm('0x1234')).toThrow();
  });
  test('repayToFromParty is keccak256(utf8(partyId)), refusing an empty id', () => {
    const ticket = vectors<FillTicket>('typed-data', 'FillTicket.json').find((v) => (v as { repayToParty?: string }).repayToParty)!;
    expect(repayToFromParty((ticket as unknown as { repayToParty: string }).repayToParty)).toBe(ticket.message.repayTo);
    expect(() => repayToFromParty('')).toThrow();
  });
  test('an EVM-source repayTo has zero top 12 bytes and is not zero: what settle pays, and nothing settle reverts on', () => {
    const padded = repayToFromEvm(ADDR);
    expect(isEvmRepayTo(padded)).toBe(true);
    expect(evmAddressFromRepayTo(padded)).toBe(ADDR);
    for (const bad of [`0x01${padded.slice(4)}`, `0x${'00'.repeat(11)}ff${ADDR.slice(2)}`, `0x${'00'.repeat(32)}`, repayToFromParty('alice::1220ab')]) {
      expect([bad, isEvmRepayTo(bad)]).toEqual([bad, false]);
      expect(() => evmAddressFromRepayTo(bad)).toThrow();
    }
  });
});

describe('one digest helper per type, equal to the golden vectors and to ethers', () => {
  test('hashFillTicket: every FillTicket vector, the router\'s hashTicket', () => {
    for (const v of vectors<FillTicket>('typed-data', 'FillTicket.json')) {
      expect(hashFillTicket(v.message)).toBe(v.digest);
      expect(TypedDataEncoder.hash(FILL_TICKET_DOMAIN, JSON.parse(JSON.stringify(FILL_TICKET_TYPES)), v.message)).toBe(v.digest);
    }
  });
  test('hashTicketIntent and hashFillerQuote: every vector', () => {
    for (const v of vectors<TicketIntent>('protocol', 'typed-data', 'TicketIntent.json')) expect(hashTicketIntent(v.message)).toBe(v.digest);
    for (const v of vectors<pkg.FillerQuote>('protocol', 'typed-data', 'FillerQuote.json')) expect(hashFillerQuote(v.message)).toBe(v.digest);
  });
  test('hashFillerMessage: the digest msgSig is over, from the message itself', () => {
    for (const v of vectors<{ bodyHash: Hex }>('protocol', 'typed-data', 'FillerMessage.json')) expect(hashFillerMessage(v.body!)).toBe(v.digest);
  });
  test('the ticket the gateway issues carries exactly the deliveryKey and repayTo of the signed intent (S-22)', () => {
    const intent = vectors<TicketIntent>('protocol', 'typed-data', 'TicketIntent.json')[0]!.message;
    const ticket = vectors<FillTicket>('typed-data', 'FillTicket.json')[1]!.message;
    expect(ticket.orderHash).toBe(intent.orderHash);
    expect(ticket.fillerId).toBe(fillerIdHash(intent.fillerId));
    expect([ticket.deliveryKey, ticket.repayTo, ticket.attempt, ticket.validFrom, ticket.validUntil]).toEqual([intent.deliveryKey, intent.repayTo, intent.attempt, intent.validFrom, intent.validUntil]);
    expect(hashFillTicket({ ...ticket, repayTo: repayToFromEvm(`0x${'99'.repeat(20)}`) })).not.toBe(hashFillTicket(ticket));
  });
});

describe('FillerKeyRegistration: proof of possession by an EOA', () => {
  const signed = vectors<FillerKeyRegistration>('protocol', 'typed-data', 'FillerKeyRegistration.json').filter((v) => v.signature);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addVocabulary([...SCHEMA_VOCABULARY]);
  for (const s of Object.values(PROTOCOL_SCHEMAS)) ajv.addSchema(s as object);
  const record = (v: Vector<FillerKeyRegistration>, sig = v.signature) => ({ ...v.message, sig });
  const valid = (value: unknown) => ajv.validate(messageSchemaRef('fillerKeyRegistration'), value);

  test('onboarding and a manual key change are the same type; each signature recovers to its messageKey', () => {
    expect(signed).toHaveLength(2);
    expect(signed[0]!.message.fillerId).toBe(signed[1]!.message.fillerId);
    expect(signed[0]!.message.messageKey).not.toBe(signed[1]!.message.messageKey);
    for (const v of signed) {
      const d = hashFillerKeyRegistration(v.message);
      expect(d).toBe(v.digest);
      expect(d).toBe(TypedDataEncoder.hash(FILLER_PROTOCOL_DOMAIN, JSON.parse(JSON.stringify(FILLER_KEY_REGISTRATION_TYPES)), v.message));
      expect(recoverAddress(d, v.signature!).toLowerCase()).toBe(v.message.messageKey);
      expect(isEoaSignature(v.signature)).toBe(true);
      expect(valid(record(v))).toBe(true);
    }
  });
  test('the other key\'s registration does not recover to this key: possession of each key is proven separately', () => {
    const [a, b] = signed;
    expect(recoverAddress(a!.digest, b!.signature!).toLowerCase()).not.toBe(a!.message.messageKey);
  });
  test('the high-s twin of a valid signature (the same key\'s, by malleability) is refused (low-s), as OpenZeppelin and ethers refuse it', () => {
    const v = signed[0]!;
    const sig = Signature.from(v.signature!);
    const highS = `0x${sig.r.slice(2)}${word(N - BigInt(sig.s))}${sig.v === 27 ? '1c' : '1b'}`;
    expect(BigInt(`0x${highS.slice(66, 130)}`) + BigInt(sig.s)).toBe(N);
    expect(() => recoverAddress(v.digest, highS)).toThrow(/non-canonical s/);
    expect(isEoaSignature(highS)).toBe(false);
    expect(valid(record(v, highS))).toBe(false);
  });
  // r = 0 and s = 0 are 65 bytes with a valid v and a low top nibble: the schema
  // pattern lets them through, the exact check refuses them.
  const r0OrS0 = (sig: string) => sig.length === 132 && /^(1b|1c)$/.test(sig.slice(130)) && (/^0x0{64}/.test(sig) || sig.slice(66, 130) === '0'.repeat(64));
  test.each([
    ['v = 0', (s: string) => `${s.slice(0, 130)}00`],
    ['v = 1', (s: string) => `${s.slice(0, 130)}01`],
    ['64 bytes (EIP-2098 compact)', (s: string) => s.slice(0, 130)],
    ['an EIP-1271 smart-wallet signature: arbitrary bytes, not 65', (s: string) => `${s}${'00'.repeat(32)}`],
    ['r = 0', (s: string) => `0x${'00'.repeat(32)}${s.slice(66)}`],
    ['s = 0', (s: string) => `${s.slice(0, 66)}${'00'.repeat(32)}${s.slice(130)}`],
  ])('refused: %s', (_n, mutate) => {
    const v = signed[0]!;
    const bad = mutate(v.signature!);
    expect(isEoaSignature(bad)).toBe(false);
    expect(valid(record(v, bad))).toBe(r0OrS0(bad));
  });
  test('s = n/2 is the largest low-s value; n/2 + 1 is high', () => {
    const r = word(1n);
    expect(isEoaSignature(`0x${r}${word(N / 2n)}1b`)).toBe(true);
    expect(isEoaSignature(`0x${r}${word(N / 2n + 1n)}1b`)).toBe(false);
    expect(isEoaSignature(`0x${word(N)}${word(1n)}1b`)).toBe(false);
  });
  test('every field is required', () => {
    const v = signed[0]!;
    for (const field of ['fillerId', 'messageKey', 'issuedAt', 'sig']) expect([field, valid({ ...record(v), [field]: undefined })]).toEqual([field, false]);
  });
});

describe('fillerEnvelopeError: the key-free checks of §3.4, in order', () => {
  // ticket.decline from the FillerMessage vectors, with a well-formed signature in place of the placeholder
  const signedFrame: Record<string, unknown> = {
    ...vectors<{ bodyHash: Hex }>('protocol', 'typed-data', 'FillerMessage.json')[1]!.body!,
    msgSig: vectors<FillerKeyRegistration>('protocol', 'typed-data', 'FillerKeyRegistration.json')[0]!.signature!,
  };
  const ctx = { fillerId: 'acme-markets', receivedAt: (signedFrame.sentAt as number) + 1500, maxMessageAgeMs: 30000 };

  test('a well-formed message passes; recovery and the replay check stay with the receiver', () => {
    expect(fillerEnvelopeError(signedFrame, ctx)).toBeNull();
  });
  test.each([
    ['no msgSig', { msgSig: undefined }, 'BAD_SIGNATURE'],
    ['a malformed msgSig', { msgSig: '0x1234' }, 'BAD_SIGNATURE'],
    ['another filler\'s fillerId', { fillerId: 'zeta-liquidity' }, 'UNAUTHENTICATED'],
    ['no fillerId', { fillerId: undefined }, 'UNAUTHENTICATED'],
    ['sentAt in seconds', { sentAt: 1790000027 }, 'BAD_REQUEST'],
    ['sentAt as a string', { sentAt: '1790000027001' }, 'BAD_REQUEST'],
    ['sentAt older than maxMessageAgeMs', { sentAt: ctx.receivedAt - 30001 }, 'STALE_MESSAGE'],
    ['sentAt too far ahead', { sentAt: ctx.receivedAt + 30001 }, 'STALE_MESSAGE'],
    ['no id', { id: undefined }, 'BAD_REQUEST'],
    ['an id over 64 characters', { id: 'x'.repeat(65) }, 'BAD_REQUEST'],
  ])('%s → %s', (_n, change, code) => {
    expect(fillerEnvelopeError({ ...signedFrame, ...change }, ctx)).toBe(code);
  });
  test('sentAt exactly maxMessageAgeMs away is still fresh', () => {
    expect(fillerEnvelopeError({ ...signedFrame, sentAt: ctx.receivedAt - 30000 }, ctx)).toBeNull();
  });
});

// D-15 and D-11: key changes are manual (no type, no message) and a refund to another
// address is a call by order.user (no signature) — neither may creep into the package.
test('no key-rotation type or message and no refund-redirect type anywhere in the package', () => {
  const forbidden = /FillerKeyRotation|key\.rotat|KEY_ROTAT|RefundRedirect|REFUND_REDIRECT/i;
  expect(Object.keys(pkg).filter((name) => forbidden.test(name))).toEqual([]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith('.json')) files.push(join(dir, e.name));
    }
  };
  walk(spec);
  expect(files.length).toBeGreaterThan(10);
  for (const f of files) expect([f, forbidden.test(readFileSync(f, 'utf8'))]).toEqual([f, false]);
  expect(Object.keys((PROTOCOL_SCHEMAS.messages as { $defs: object }).$defs).filter((d) => /rotat/i.test(d))).toEqual([]);
});
