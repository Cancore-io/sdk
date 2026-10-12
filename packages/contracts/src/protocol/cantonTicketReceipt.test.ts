import Ajv2020 from 'ajv/dist/2020';
import { keccak256, toUtf8Bytes, TypedDataEncoder } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pkg from '../index';
import { encodeType } from './hash';
import { cantonTicketReceipt, deliveryOrderCidHash, hashCantonTicketReceipt } from './digests';
import { ASYNCAPI, messageSchemaRef, PROTOCOL_SCHEMAS, REST_ENDPOINTS, SCHEMA_VOCABULARY } from './schemas';
import { CANTON_TICKET_RECEIPT_TYPES, FILLER_PROTOCOL_DOMAIN, type CantonTicketReceipt } from './typedData';

// The receipt of a Canton-form ticket (protocol.md §3.3, §3.5, §10 D-O; CAN-2062): a Canton
// destination has no FillTicket and no ticketSig — the DeliveryOrder authorises the delivery —
// so the filler signs the four fields that name the ticket instead. fillerId and repayTo
// travel in ticket.issued and are not part of the receipt.

type Frame = Record<string, unknown>;
type Vector = { note: string; deliveryOrderCid?: string; message: CantonTicketReceipt; digest: string };
const spec = join(__dirname, '..', '..', 'spec');
const load = <T>(...p: string[]): T => JSON.parse(readFileSync(join(spec, ...p), 'utf8')) as T;
const file = load<{ typeString: string; vectors: Vector[] }>('protocol', 'typed-data', 'CantonTicketReceipt.json');
const { examples } = load<{ examples: Record<string, Frame[]> }>('protocol', 'vectors', 'messages.json');
const issued = examples['ticket.issued']!.find((e) => e.form === 'canton')!;
const receipt = examples['ticket.receipt']!.find((e) => e.form === 'canton')!;
const evmReceipt = examples['ticket.receipt']!.find((e) => e.form === undefined)!;

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addVocabulary([...SCHEMA_VOCABULARY]);
for (const s of Object.values(PROTOCOL_SCHEMAS)) ajv.addSchema(s as object);
const errorsOf = (frame: unknown) => (ajv.validate(messageSchemaRef('ticket.receipt', 'F2S'), frame) ? [] : ajv.errors!);

describe('CantonTicketReceipt: the type', () => {
  test('is exactly the string of protocol.md §3.3: four fields, no fillerId, no repayTo', () => {
    const typeString = 'CantonTicketReceipt(bytes32 orderHash,uint32 attempt,bytes32 deliveryOrderCidHash,uint64 validUntil)';
    expect(encodeType(CANTON_TICKET_RECEIPT_TYPES, 'CantonTicketReceipt')).toBe(typeString);
    expect(file.typeString).toBe(typeString);
    const names = CANTON_TICKET_RECEIPT_TYPES.CantonTicketReceipt.map((f) => f.name);
    expect(names).not.toContain('fillerId');
    expect(names).not.toContain('repayTo');
  });

  test.each(file.vectors.map((v) => [v.note, v] as const))('%s: the shipped digest and ethers agree with the vector', (_n, v) => {
    expect(hashCantonTicketReceipt(v.message)).toBe(v.digest);
    const types = JSON.parse(JSON.stringify(CANTON_TICKET_RECEIPT_TYPES)) as Record<string, { name: string; type: string }[]>;
    expect(TypedDataEncoder.hash(FILLER_PROTOCOL_DOMAIN, types, v.message)).toBe(v.digest);
    if (v.deliveryOrderCid !== undefined) expect(deliveryOrderCidHash(v.deliveryOrderCid)).toBe(v.message.deliveryOrderCidHash);
  });

  test('the vectors cover the fixture ticket, a realistic contract id, all ones and zero', () => {
    expect(file.vectors.length).toBeGreaterThanOrEqual(4);
    expect(file.vectors.filter((v) => v.deliveryOrderCid !== undefined).length).toBeGreaterThanOrEqual(2);
  });
});

describe('CantonTicketReceipt: built from the frames', () => {
  test('deliveryOrderCidHash is keccak256(utf8(cid)) of the contract id exactly as sent', () => {
    const cid = issued.deliveryOrderCid as string;
    expect(deliveryOrderCidHash(cid)).toBe(keccak256(toUtf8Bytes(cid)));
    expect(deliveryOrderCidHash(` ${cid}`)).not.toBe(deliveryOrderCidHash(cid));
    expect(deliveryOrderCidHash(cid.toUpperCase())).not.toBe(deliveryOrderCidHash(cid));
    expect(() => deliveryOrderCidHash('')).toThrow();
  });

  test('the filler builds it from ticket.issued and filler-gateway from ticket.receipt: one struct, the vector', () => {
    const fromIssued = cantonTicketReceipt(issued as never);
    expect(cantonTicketReceipt(receipt as never)).toEqual(fromIssued);
    expect(fromIssued).toEqual(file.vectors[0]!.message);
    expect(hashCantonTicketReceipt(fromIssued)).toBe(file.vectors[0]!.digest);
  });

  test('fillerId and repayTo of the frame never reach the signed struct', () => {
    const base = cantonTicketReceipt(issued as never);
    expect(Object.keys(base)).toEqual(['orderHash', 'attempt', 'deliveryOrderCidHash', 'validUntil']);
    expect(cantonTicketReceipt({ ...issued, fillerId: 'other-filler', repayTo: `0x${'ab'.repeat(32)}` } as never)).toEqual(base);
  });

  test('every named field changes the digest', () => {
    const base = cantonTicketReceipt(issued as never);
    const d = hashCantonTicketReceipt(base);
    expect(hashCantonTicketReceipt({ ...base, attempt: base.attempt + 1 })).not.toBe(d);
    expect(hashCantonTicketReceipt({ ...base, validUntil: String(BigInt(base.validUntil) + 1n) })).not.toBe(d);
    expect(hashCantonTicketReceipt({ ...base, orderHash: `0x${'00'.repeat(32)}` })).not.toBe(d);
    expect(hashCantonTicketReceipt({ ...base, deliveryOrderCidHash: deliveryOrderCidHash('00ff#another') })).not.toBe(d);
  });

  test('refuses a frame it cannot name the ticket from', () => {
    expect(() => cantonTicketReceipt({ ...issued, deliveryOrderCid: '' } as never)).toThrow();
    expect(() => cantonTicketReceipt({ ...issued, validUntil: '1790000400.5' } as never)).toThrow();
    expect(() => cantonTicketReceipt({ ...issued, attempt: -1 } as never)).toThrow();
    expect(() => cantonTicketReceipt({ ...issued, orderHash: '0x1234' } as never)).toThrow();
  });

  test('exported from the package root (S4)', () => {
    expect(pkg.CANTON_TICKET_RECEIPT_TYPES).toBe(CANTON_TICKET_RECEIPT_TYPES);
    expect(pkg.hashCantonTicketReceipt).toBe(hashCantonTicketReceipt);
    expect(pkg.cantonTicketReceipt).toBe(cantonTicketReceipt);
    expect(pkg.deliveryOrderCidHash).toBe(deliveryOrderCidHash);
  });
});

describe('ticket.receipt: the Canton form on the wire', () => {
  test('the Canton-form example is valid and names the issued ticket', () => {
    expect(errorsOf(receipt)).toEqual([]);
    expect(receipt).toMatchObject({ form: 'canton', orderHash: issued.orderHash, attempt: issued.attempt, deliveryOrderCid: issued.deliveryOrderCid, validUntil: issued.validUntil });
    expect(receipt).not.toHaveProperty('ticketHash');
    expect(receipt).not.toHaveProperty('repayTo');
  });

  test.each(['deliveryOrderCid', 'validUntil', 'sig', 'msgSig', 'orderHash', 'attempt'])('a Canton-form receipt without %s is refused', (field) => {
    expect(errorsOf({ ...receipt, [field]: undefined }).length).toBeGreaterThan(0);
  });

  test.each([
    ['deliveryOrderCid', ''],
    ['validUntil', 1790000400],
    ['validUntil', '1790000400.5'],
    ['sig', `0x${'00'.repeat(64)}00`],
  ])('a Canton-form receipt with %s = %j is refused', (field, bad) => {
    expect(errorsOf({ ...receipt, [field]: bad }).length).toBeGreaterThan(0);
  });

  test('form discriminates: the EVM form (form absent or "evm") still needs ticketHash and ticketSigHash, the Canton form does not', () => {
    expect(errorsOf(evmReceipt)).toEqual([]);
    expect(errorsOf({ ...evmReceipt, form: 'evm' })).toEqual([]);
    expect(errorsOf({ ...evmReceipt, ticketHash: undefined }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...evmReceipt, form: 'canton' }).length).toBeGreaterThan(0); // EVM fields, no deliveryOrderCid
    expect(errorsOf({ ...receipt, form: undefined }).length).toBeGreaterThan(0); // Canton fields read as the EVM form
    expect(errorsOf({ ...receipt, form: 'Canton' }).length).toBeGreaterThan(0);
  });

  test('fields outside the receipt are ignored, not signed (V-2): repayTo on the frame is not part of CantonTicketReceipt', () => {
    expect(errorsOf({ ...receipt, repayTo: `0x${'ab'.repeat(32)}` })).toEqual([]);
  });

  test('REST POST /v1/filler/tickets/{orderHash}/{attempt}/receipt takes the same body as the WebSocket frame', () => {
    const endpoint = REST_ENDPOINTS.find((e) => e.method === 'POST' && e.path === '/v1/filler/tickets/{orderHash}/{attempt}/receipt')!;
    expect(endpoint.request).toBe('messages.schema.json#/$defs/ticket.receipt');
    const rest = `https://cancore.io/schemas/filler-protocol/v1/${endpoint.request}`;
    expect(ajv.validate(rest, receipt)).toBe(true);
    expect(ajv.validate(rest, evmReceipt)).toBe(true);
    expect(ajv.validate(rest, { ...receipt, deliveryOrderCid: undefined })).toBe(false);
  });

  test('AsyncAPI carries both forms of ticket.receipt', () => {
    const doc = ASYNCAPI as unknown as { components: { messages: Record<string, { examples: { payload: Frame }[] }> } };
    const forms = doc.components.messages['ticket.receipt']!.examples.map((e) => e.payload.form ?? 'evm');
    expect(forms).toEqual(['evm', 'canton']);
  });
});
