import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DECLINE_REASONS, DRAW_CLOSED_BY, ERROR_CODES, ERROR_HTTP_STATUS, EXEMPT_REASONS, EXPIRED_RESULTS, PENALTY_STEPS, QUOTE_ACK_STATUSES,
  QUOTE_FINAL_STATUSES, TICKET_LIST_STATUSES,
} from './messages';
import { MESSAGE_DIRECTIONS, messageSchemaRef, PROTOCOL_SCHEMAS, REST_ENDPOINTS, SCHEMA_VOCABULARY } from './schemas';

type Frame = Record<string, unknown>;
type Defs = Record<string, Record<string, unknown>>;
const { examples } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'spec', 'protocol', 'vectors', 'messages.json'), 'utf8')) as { examples: Record<string, Frame[]> };
const defs = (s: unknown) => (s as { $defs: Defs }).$defs;

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addVocabulary([...SCHEMA_VOCABULARY]);
for (const s of Object.values(PROTOCOL_SCHEMAS)) ajv.addSchema(s as object);
const errorsOf = (type: string, frame: unknown, dir?: 'S2F' | 'F2S') => (ajv.validate(messageSchemaRef(type, dir), frame) ? [] : ajv.errors!);
const example = (type: string, i = 0): Frame => structuredClone(examples[type]![i]!);
/** The S→F copy of a frame type: the example carrying the gateway sig. */
const s2fExample = (type: string): Frame => structuredClone(examples[type]!.find((e) => 'sig' in e)!);
const OPEN = { $ref: 'messages.schema.json#/$defs/futureEnumValue' };
const OPEN_LOCAL = { $ref: '#/$defs/futureEnumValue' };
const OPEN_FORM = { type: 'string', pattern: '^[a-z][a-z0-9-]*$' };
/** The known values of an open enum: `anyOf: [{enum: known}, futureEnumValue]`. */
const known = (node: unknown) => {
  const [head, open] = (node as { anyOf: [{ enum: unknown[] }, unknown] }).anyOf;
  expect([OPEN, OPEN_LOCAL, OPEN_FORM]).toContainEqual(open);
  return head.enum;
};

test('the three schemas compile in strict mode, every $def of every one', () => {
  for (const [name, schema] of Object.entries(PROTOCOL_SCHEMAS)) {
    const id = (schema as { $id: string }).$id;
    expect(id).toBe(`https://cancore.io/schemas/filler-protocol/v1/${name}.schema.json`);
    for (const def of Object.keys(defs(schema))) expect(() => ajv.getSchema(`${id}#/$defs/${def}`)).not.toThrow();
  }
});

test('23 frame types, each with a direction and at least one valid example', () => {
  expect(Object.keys(MESSAGE_DIRECTIONS)).toHaveLength(23);
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

describe('D-C: every S→F frame is addressed, timed and signed, heartbeats included', () => {
  const s2f = Object.entries(MESSAGE_DIRECTIONS).filter(([, d]) => d !== 'F2S').map(([t]) => t);
  test.each(s2f)('%s', (type) => {
    const frame = s2fExample(type);
    expect(errorsOf(type, frame, 'S2F')).toEqual([]);
    for (const field of ['sentAt', 'sig']) expect(errorsOf(type, { ...frame, [field]: undefined }, 'S2F').length).toBeGreaterThan(0);
    expect(errorsOf(type, { ...frame, sentAt: 1790000000 }, 'S2F').length).toBeGreaterThan(0); // seconds, not ms
    const unaddressed = errorsOf(type, { ...frame, fillerId: undefined }, 'S2F');
    expect(unaddressed.length > 0).toBe(!['auth.challenge', 'error'].includes(type));
  });
  test.each(['ping', 'pong'])('%s: the F→S copy stays unsigned, and the S→F one is signed', (type) => {
    const f2s = examples[type]!.find((e) => !('sig' in e))!;
    expect(errorsOf(type, f2s, 'F2S')).toEqual([]);
    expect(errorsOf(type, f2s, 'S2F').length).toBeGreaterThan(0);
    expect(errorsOf(type, s2fExample(type))).toEqual([]);
  });
});

describe('conditional shapes', () => {
  test('ticket.issued: form discriminates; extra fields of the other shape are ignored (V-2)', () => {
    const evm = example('ticket.issued', 0);
    const canton = example('ticket.issued', 1);
    expect(errorsOf('ticket.issued', { ...evm, form: 'canton' }).length).toBeGreaterThan(0);
    expect(errorsOf('ticket.issued', { ...evm, form: undefined }).length).toBeGreaterThan(0);
    expect(errorsOf('ticket.issued', { ...canton, ticket: evm.ticket, ticketSig: evm.ticketSig, form: 'evm' })).toEqual([]);
    expect(errorsOf('ticket.issued', { ...canton, deliveryOrderCid: undefined }).length).toBeGreaterThan(0);
  });
  test('ticket.issued: a form added within v1 is checked against the common fields only (V-2)', () => {
    const { ticket: _t, ticketSig: _s, ...base } = example('ticket.issued', 0);
    expect(errorsOf('ticket.issued', { ...base, form: 'solana', programId: 'x' })).toEqual([]);
    expect(errorsOf('ticket.issued', { ...base, form: 'Sol Ana' }).length).toBeGreaterThan(0);
    expect(errorsOf('ticket.issued', { ...base, form: 'solana', sig: undefined }).length).toBeGreaterThan(0);
    expect(errorsOf('ticket.issued', { ...base, form: 'solana', orderHash: undefined }).length).toBeGreaterThan(0);
  });
  test('ticket.expired EXEMPT needs its reason; an unknown reason is accepted (V-2)', () => {
    expect(errorsOf('ticket.expired', { ...example('ticket.expired', 1), exemptReason: undefined }).length).toBeGreaterThan(0);
    expect(errorsOf('ticket.expired', { ...example('ticket.expired', 1), exemptReason: 'SOLAR_FLARE' })).toEqual([]);
    expect(errorsOf('ticket.expired', { ...example('ticket.expired', 1), exemptReason: 'solar flare' }).length).toBeGreaterThan(0);
  });
  test('quote.reconfirm.reply: an accept is signed, a decline need not be', () => {
    expect(errorsOf('quote.reconfirm.reply', { ...example('quote.reconfirm.reply', 0), sig: undefined }).length).toBeGreaterThan(0);
    expect(errorsOf('quote.reconfirm.reply', example('quote.reconfirm.reply', 1))).toEqual([]);
  });
  test.each([
    ['quote', 'requestId', 'has space'],
    ['auth.response', 'fillerId', 'Acme'],
    ['auth.response', 'nonce', '0x01'],
    ['quote', 'nonce', '01'],
    ['quote', 'amountOut', '1'.repeat(79)],
    ['ticket.intent', 'attempt', 2 ** 32],
    ['quote.request', 'route', { src: 'eip155:01', dst: 'canton:cancore' }],
    ['quote', 'sig', `0x${'00'.repeat(65)}`],
    ['quote', 'sig', `0x${'00'.repeat(64)}01`],
    ['ticket.decline', 'reason', 'no_inventory'],
    ['error', 'code', '9_BAD'],
  ])('%s.%s = %j is refused', (type, field, bad) => {
    expect(errorsOf(type, { ...example(type), [field]: bad }).length).toBeGreaterThan(0);
  });
  test('sig65: v is 27 or 28', () => {
    for (const v of ['1b', '1c']) expect(errorsOf('quote', { ...example('quote'), sig: `0x${'00'.repeat(64)}${v}` })).toEqual([]);
  });
  test('order.feeBps is a uint16', () => {
    const offer = example('ticket.offer');
    const withFee = (feeBps: string) => errorsOf('ticket.offer', { ...offer, order: { ...(offer.order as object), feeBps } });
    for (const ok of ['0', '9', '30', '9999', '10000', '59999', '65099', '65529', '65535']) expect([ok, withFee(ok)]).toEqual([ok, []]);
    for (const bad of ['65536', '65540', '65600', '66000', '70000', '99999', '100000', '030']) expect([bad, withFee(bad).length > 0]).toEqual([bad, true]);
  });
});

// V-2: a value added to an enum within v1 is accepted, and the receiver treats it as OTHER/generic.
test.each([
  ['ticket.decline', 'reason', 'NEW_REASON'],
  ['error', 'code', 'SLOW_DOWN_2'],
  ['ticket.expired', 'result', 'CANCELLED'],
  ['quote.ack', 'status', 'THROTTLED'],
  ['penalty.applied', 'step', 'L5'],
])('V-2 %s.%s = %j (unknown) is accepted', (type, field, value) => {
  expect(errorsOf(type, { ...example(type), [field]: value })).toEqual([]);
});

test('the enums of the schemas are the exported constants', () => {
  const m = defs(PROTOCOL_SCHEMAS.messages);
  const r = defs(PROTOCOL_SCHEMAS.rest);
  const rec = defs(PROTOCOL_SCHEMAS.records);
  expect(known(m.declineReason)).toEqual([...DECLINE_REASONS]);
  expect(known(m.errorCode)).toEqual([...ERROR_CODES]);
  expect(known(m.expiredResult)).toEqual([...EXPIRED_RESULTS]);
  expect(known(m.exemptReason)).toEqual([...EXEMPT_REASONS]);
  expect(known(m.quoteAckStatus)).toEqual([...QUOTE_ACK_STATUSES]);
  expect(known(m.penaltyStep)).toEqual([...PENALTY_STEPS]);
  expect(known((r.quoteRecord!.properties as Defs).status)).toEqual([...QUOTE_FINAL_STATUSES]);
  expect(known((rec.drawAttempt!.properties as Defs).closedBy)).toEqual([...DRAW_CLOSED_BY, null]);
  expect(known((rec.drawAttempt!.properties as Defs).fallbackReason)).toEqual(['DRAW_FALLBACK', null]);
  expect(known((m['ticket.issued']!.properties as Defs).form)).toEqual(['evm', 'canton']);
  expect((r.ticketListQuery!.properties as Defs).status!.enum).toEqual([...TICKET_LIST_STATUSES]);
  expect((PROTOCOL_SCHEMAS.rest as Record<string, unknown>)['x-error-status']).toEqual(ERROR_HTTP_STATUS);
});

// A closed enum is allowed only where the gateway owns the value (a request filter); every other enum is open (V-2).
const CLOSED_ENUMS = ['rest/$defs/ticketListQuery/properties/status'];
test('V-2: no object is closed, and no enum outside the allow-list is closed', () => {
  const closedEnums: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    expect([path, n.additionalProperties]).not.toEqual([path, false]);
    expect([path, n.unevaluatedProperties]).not.toEqual([path, false]);
    expect([path, n.maxProperties]).not.toEqual([path, 0]);
    if ('propertyNames' in n) expect(path).toBe('records/$defs/epochRecord/properties/snapshotBlocks'); // a value constraint on caip2 keys
    if ('enum' in n && !path.endsWith('/anyOf/0')) closedEnums.push(path);
    if ('enum' in n && path.endsWith('/anyOf/0')) expect(known(ancestorAt(path))).toEqual(n.enum);
    for (const [k, v] of Object.entries(n)) walk(v, `${path}/${k}`);
  };
  const ancestorAt = (path: string) => path.split('/').slice(0, -2).reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], PROTOCOL_SCHEMAS);
  for (const [name, schema] of Object.entries(PROTOCOL_SCHEMAS)) walk(schema, name);
  expect(closedEnums.sort()).toEqual([...CLOSED_ENUMS].sort());
});

describe('REST', () => {
  const rest = (def: string, value: unknown) => ajv.validate(`https://cancore.io/schemas/filler-protocol/v1/rest.schema.json#/$defs/${def}`, value);
  test('every endpoint names schemas that resolve', () => {
    expect(REST_ENDPOINTS).toHaveLength(14);
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
    expect(rest('empty', { receivedAt: 1790000000000 })).toBe(true); // a field added within v1 (V-2)
    expect(rest('ticketListQuery', { status: 'OFFERED', limit: '50' })).toBe(true);
    expect(rest('ticketListQuery', { status: 'EXPIRED' })).toBe(false); // a request filter: the gateway owns the list
    expect(rest('quoteRecord', { quote: example('quote'), ack: example('quote.ack'), status: 'EXPIRED_LATER' })).toBe(true);
  });
});
