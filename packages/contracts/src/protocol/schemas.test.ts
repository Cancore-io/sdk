import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DECLINE_REASONS, DRAW_CLOSED_BY, ERROR_CODES, ERROR_HTTP_STATUS, EXEMPT_REASONS, EXPIRED_RESULTS, PENALTY_STEPS, QUOTE_ACK_STATUSES,
  QUOTE_FINAL_STATUSES,
} from './messages';
import { MESSAGE_DIRECTIONS, messageSchemaRef, PROTOCOL_SCHEMAS, REST_ENDPOINTS, SCHEMA_VOCABULARY } from './schemas';

type Frame = Record<string, unknown>;
type Defs = Record<string, Record<string, unknown>>;
const { examples } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'spec', 'protocol', 'vectors', 'messages.json'), 'utf8')) as { examples: Record<string, Frame[]> };
const defs = (s: unknown) => (s as { $defs: Defs }).$defs;

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addVocabulary([...SCHEMA_VOCABULARY]);
for (const s of Object.values(PROTOCOL_SCHEMAS)) ajv.addSchema(s as object);
const errorsOf = (type: string, frame: unknown) => (ajv.validate(messageSchemaRef(type), frame) ? [] : ajv.errors!);
const example = (type: string, i = 0): Frame => structuredClone(examples[type]![i]!);

test('the three schemas compile in strict mode, every $def of every one', () => {
  for (const [name, schema] of Object.entries(PROTOCOL_SCHEMAS)) {
    const id = (schema as { $id: string }).$id;
    expect(id).toBe(`https://cancore.io/schemas/filler-protocol/v1/${name}.schema.json`);
    for (const def of Object.keys(defs(schema))) expect(() => ajv.getSchema(`${id}#/$defs/${def}`)).not.toThrow();
  }
});

test('22 frame types, each with a direction and at least one valid example', () => {
  expect(Object.keys(MESSAGE_DIRECTIONS)).toHaveLength(22);
  expect(MESSAGE_DIRECTIONS['ticket.offer']).toBe('S2F');
  expect(MESSAGE_DIRECTIONS['ticket.intent']).toBe('F2S');
  expect(MESSAGE_DIRECTIONS.ping).toBe('both');
  for (const type of Object.keys(MESSAGE_DIRECTIONS)) {
    expect(examples[type]?.length).toBeGreaterThan(0);
    for (const frame of examples[type]!) expect(errorsOf(type, frame)).toEqual([]);
  }
});

// A3: a wrong value type is refused, and the error names the field.
test.each([
  ['quote', 'amountOut', 999000000],
  ['ticket.intent', 'attempt', '0'],
  ['quote', 'filler', '0x742D35CC6634C0532925A3B844BC454E4438F44F'],
  ['ticket.offer', 'orderHash', 'ab'.repeat(32)],
  ['quote.request', 'windowCloseAt', '1789999992'],
  ['quote.request', 'windowCloseAt', 1789999992],
])('A3 %s.%s = %j is refused, naming the field', (type, field, bad) => {
  const frame = { ...example(type), [field]: bad };
  const errors = errorsOf(type, frame);
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.map((e) => e.instancePath)).toContain(`/${field}`);
});

test('A4: an unknown field is ignored, and an unknown S→F type passes the envelope a taker checks first', () => {
  expect(errorsOf('ticket.offer', { ...example('ticket.offer'), x: 1 })).toEqual([]);
  const future = { type: 'future.info', fillerId: 'acme-markets', sentAt: 1790000000000, sig: example('ticket.offer').sig, note: 'new in v1.1' };
  expect(ajv.validate(messageSchemaRef('s2fEnvelope'), future)).toBe(true);
});

describe('D-C: every S→F frame is addressed, timed and signed', () => {
  const s2f = Object.entries(MESSAGE_DIRECTIONS).filter(([, d]) => d === 'S2F').map(([t]) => t);
  test.each(s2f)('%s', (type) => {
    const frame = example(type);
    for (const field of ['sentAt', 'sig']) expect(errorsOf(type, { ...frame, [field]: undefined }).length).toBeGreaterThan(0);
    expect(errorsOf(type, { ...frame, sentAt: 1790000000 }).length).toBeGreaterThan(0); // seconds, not ms
    const unaddressed = errorsOf(type, { ...frame, fillerId: undefined });
    expect(unaddressed.length > 0).toBe(!['auth.challenge', 'error'].includes(type));
  });
});

describe('conditional shapes', () => {
  test('ticket.issued: the form discriminates, and a form mixing both shapes is refused', () => {
    const evm = example('ticket.issued', 0);
    const canton = example('ticket.issued', 1);
    expect(errorsOf('ticket.issued', { ...evm, form: 'canton' }).length).toBeGreaterThan(0);
    expect(errorsOf('ticket.issued', { ...evm, form: undefined }).length).toBeGreaterThan(0);
    expect(errorsOf('ticket.issued', { ...canton, ticket: evm.ticket, ticketSig: evm.ticketSig, form: 'evm' })).toEqual([]);
    expect(errorsOf('ticket.issued', { ...canton, deliveryOrderCid: undefined }).length).toBeGreaterThan(0);
  });
  test('ticket.expired EXEMPT needs its reason', () => {
    expect(errorsOf('ticket.expired', { ...example('ticket.expired', 1), exemptReason: undefined }).length).toBeGreaterThan(0);
    expect(errorsOf('ticket.expired', { ...example('ticket.expired', 1), exemptReason: 'SOLAR_FLARE' }).length).toBeGreaterThan(0);
  });
  test('quote.reconfirm.reply: an accept is signed, a decline need not be', () => {
    expect(errorsOf('quote.reconfirm.reply', { ...example('quote.reconfirm.reply', 0), sig: undefined }).length).toBeGreaterThan(0);
    expect(errorsOf('quote.reconfirm.reply', example('quote.reconfirm.reply', 1))).toEqual([]);
  });
  test.each([
    ['quote', 'requestId', 'has space'],
    ['auth.response', 'fillerId', 'Acme'],
    ['quote', 'nonce', '01'],
    ['quote', 'amountOut', '1'.repeat(79)],
    ['ticket.intent', 'attempt', 2 ** 32],
    ['quote.request', 'route', { src: 'eip155:01', dst: 'canton:cancore' }],
  ])('%s.%s = %j is refused', (type, field, bad) => {
    expect(errorsOf(type, { ...example(type), [field]: bad }).length).toBeGreaterThan(0);
  });
});

test('the enums of the schemas are the exported constants', () => {
  const m = defs(PROTOCOL_SCHEMAS.messages);
  const r = defs(PROTOCOL_SCHEMAS.rest);
  const rec = defs(PROTOCOL_SCHEMAS.records);
  expect(m.declineReason!.enum).toEqual([...DECLINE_REASONS]);
  expect(m.errorCode!.enum).toEqual([...ERROR_CODES]);
  expect(m.expiredResult!.enum).toEqual([...EXPIRED_RESULTS]);
  expect(m.exemptReason!.enum).toEqual([...EXEMPT_REASONS]);
  expect(m.quoteAckStatus!.enum).toEqual([...QUOTE_ACK_STATUSES]);
  expect(m.penaltyStep!.enum).toEqual([...PENALTY_STEPS]);
  expect((r.quoteRecord!.properties as Defs).status!.enum).toEqual([...QUOTE_FINAL_STATUSES]);
  expect((rec.drawAttempt!.properties as Defs).closedBy!.enum).toEqual([...DRAW_CLOSED_BY, null]);
  expect((PROTOCOL_SCHEMAS.rest as Record<string, unknown>)['x-error-status']).toEqual(ERROR_HTTP_STATUS);
});

test('V-2: no object anywhere is closed with additionalProperties: false', () => {
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    expect((node as Record<string, unknown>).additionalProperties).not.toBe(false);
    Object.values(node).forEach(walk);
  };
  Object.values(PROTOCOL_SCHEMAS).forEach(walk);
});

describe('REST', () => {
  const rest = (def: string, value: unknown) => ajv.validate(`https://cancore.io/schemas/filler-protocol/v1/rest.schema.json#/$defs/${def}`, value);
  test('every endpoint names schemas that resolve', () => {
    expect(REST_ENDPOINTS).toHaveLength(13);
    const base = 'https://cancore.io/schemas/filler-protocol/v1/';
    for (const e of REST_ENDPOINTS) {
      for (const ref of [e.request, e.query, e.response].filter((x): x is string => !!x)) {
        const abs = ref.startsWith('#') ? `${base}rest.schema.json${ref}` : `${base}${ref}`;
        expect(ajv.getSchema(abs)).toBeDefined();
      }
    }
    expect(REST_ENDPOINTS.find((e) => e.path === '/v1/gateway')?.auth).toBe('none');
    expect(REST_ENDPOINTS.filter((e) => e.path.startsWith('/v1/filler/tickets')).every((e) => e.auth === 'bearer')).toBe(true);
  });
  test('bodies: ticket list, token, error, empty', () => {
    expect(rest('ticketList', { items: [example('ticket.offer'), example('ticket.issued')], nextCursor: null })).toBe(true);
    expect(rest('ticketList', { items: [example('quote.ack')], nextCursor: null })).toBe(false);
    expect(rest('authToken', { token: 't', expiresAt: 1790000900000 })).toBe(true);
    expect(rest('authToken', { token: 't', expiresAt: 1790000900 })).toBe(false);
    expect(rest('errorBody', example('error'))).toBe(true);
    expect(rest('empty', {})).toBe(true);
    expect(rest('empty', { a: 1 })).toBe(false);
    expect(rest('ticketListQuery', { status: 'OFFERED', limit: '50' })).toBe(true);
    expect(rest('ticketListQuery', { status: 'EXPIRED' })).toBe(false);
  });
});
