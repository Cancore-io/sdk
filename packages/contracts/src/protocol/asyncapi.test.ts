import Ajv2020 from 'ajv/dist/2020';
import { FILLER_CLOSE_CODES, FILLER_UPGRADE_REFUSALS, FILLER_WS_BEARER_PREFIX, FILLER_WS_SUBPROTOCOL, fillerWsProtocols } from './gateway';
import { ASYNCAPI, MESSAGE_DIRECTIONS, PROTOCOL_SCHEMAS, REST_ONLY_TYPES, SCHEMA_VOCABULARY } from './schemas';

// Structural checks instead of an AsyncAPI parser dependency: the document is
// generated from the schemas, so what can drift is the wiring between them.
type Op = { action: string; channel: { $ref: string }; messages: { $ref: string }[] };
type Msg = { name: string; payload: { schemaFormat: string; schema: { $ref: string } }; examples: { payload: unknown }[] };
const doc = ASYNCAPI as unknown as {
  asyncapi: string;
  channels: Record<string, {
    address: string;
    messages: Record<string, { $ref: string }>;
    bindings: { ws: { headers: { required: string[]; properties: Record<string, { pattern: string }> } } };
    'x-close-codes': Record<string, string>;
    'x-upgrade-refusals': Record<string, string>;
  }>;
  operations: Record<string, Op>;
  components: { messages: Record<string, Msg> };
};

/** Resolve a local JSON pointer (`#/a/b`) inside the document. */
const resolve = (ref: string): unknown =>
  ref.slice(2).split('/').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);

/** A message key is the frame type, or `<type>S2F` / `<type>F2S` for the two copies of a heartbeat. The login is REST only. */
const MESSAGE_KEYS = Object.entries(MESSAGE_DIRECTIONS).filter(([t]) => !REST_ONLY_TYPES.includes(t)).flatMap(([t, d]) => (d === 'both' ? [`${t}S2F`, `${t}F2S`] : [t])).sort();
const wireType = (key: string) => (MESSAGE_DIRECTIONS[key] ? key : key.slice(0, -3));
const directionOf = (key: string) => (MESSAGE_DIRECTIONS[key] ?? key.slice(-3)) as 'S2F' | 'F2S';

test('AsyncAPI 3.0, one channel on /v1 carrying every frame type, heartbeats once per direction', () => {
  expect(doc.asyncapi).toBe('3.0.0');
  expect(doc.channels.filler!.address).toBe('/v1');
  expect(MESSAGE_KEYS).toEqual(expect.arrayContaining(['pingS2F', 'pingF2S', 'pongS2F', 'pongF2S']));
  expect(Object.keys(doc.channels.filler!.messages).sort()).toEqual(MESSAGE_KEYS);
  expect(Object.keys(doc.components.messages).sort()).toEqual(MESSAGE_KEYS);
});

test('the login never travels on the channel; auth.ok does, first', () => {
  const keys = Object.keys(doc.channels.filler!.messages);
  expect(keys).not.toContain('auth.challenge');
  expect(keys).not.toContain('auth.response');
  expect(keys).toContain('auth.ok');
  expect(Object.keys(doc.components.messages)).not.toContain('auth.response');
});

test('connect: cancore-filler.v1 plus bearer.<token> on the upgrade; the refusals and close codes are the exported ones', () => {
  const channel = doc.channels.filler!;
  const header = new RegExp(channel.bindings.ws.headers.properties['Sec-WebSocket-Protocol']!.pattern);
  expect(channel.bindings.ws.headers.required).toEqual(['Sec-WebSocket-Protocol']);
  expect(fillerWsProtocols('dG9rZW4tMQ')).toEqual([FILLER_WS_SUBPROTOCOL, `${FILLER_WS_BEARER_PREFIX}dG9rZW4tMQ`]);
  expect(header.test(fillerWsProtocols('dG9rZW4tMQ').join(', '))).toBe(true);
  expect(header.test([...fillerWsProtocols('dG9rZW4tMQ')].reverse().join(','))).toBe(true);
  expect(header.test('cancore-filler.v1')).toBe(false);
  expect(header.test('bearer.a, bearer.b')).toBe(false);
  expect(header.test('cancore-filler.v1, bearer.a b')).toBe(false);
  expect(Object.keys(channel['x-close-codes']).map(Number).sort()).toEqual(Object.values(FILLER_CLOSE_CODES).sort());
  expect(Object.keys(channel['x-upgrade-refusals']).map(Number)).toEqual(Object.keys(FILLER_UPGRADE_REFUSALS).map(Number));
});

test('operations are the gateway\'s: it sends S2F frames (a signed ping and pong among them) and receives F2S frames', () => {
  const byKey = new Map<string, string[]>();
  for (const op of Object.values(doc.operations)) {
    expect(resolve(op.channel.$ref)).toBe(doc.channels.filler);
    for (const m of op.messages) {
      const key = m.$ref.split('/').pop()!;
      expect(resolve(m.$ref)).toBeDefined();
      byKey.set(key, [...(byKey.get(key) ?? []), op.action].sort());
    }
  }
  for (const key of MESSAGE_KEYS) expect([key, byKey.get(key)]).toEqual([key, [directionOf(key) === 'S2F' ? 'send' : 'receive']]);
});

test('every local $ref resolves, and every payload names a $def of messages.schema.json', () => {
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const ref = (node as { $ref?: unknown }).$ref;
    if (typeof ref === 'string' && ref.startsWith('#/')) expect([ref, resolve(ref) !== undefined]).toEqual([ref, true]);
    Object.values(node).forEach(walk);
  };
  walk(doc);
  const defs = (PROTOCOL_SCHEMAS.messages as { $defs: Record<string, unknown> }).$defs;
  for (const [key, msg] of Object.entries(doc.components.messages)) {
    expect(msg.name).toBe(wireType(key));
    expect(msg.payload.schemaFormat).toBe('application/schema+json;version=draft-2020-12');
    expect(msg.payload.schema.$ref).toBe(`messages.schema.json#/$defs/${key}`);
    expect(defs[key]).toBeDefined();
  }
});

test('every example of the document validates against its payload schema', () => {
  const ajv = new Ajv2020({ strict: true });
  ajv.addVocabulary([...SCHEMA_VOCABULARY]);
  for (const s of Object.values(PROTOCOL_SCHEMAS)) ajv.addSchema(s as object);
  for (const [key, msg] of Object.entries(doc.components.messages)) {
    expect(msg.examples.length).toBeGreaterThan(0);
    for (const e of msg.examples) {
      expect([key, ajv.validate(`https://cancore.io/schemas/filler-protocol/v1/messages.schema.json#/$defs/${key}`, e.payload)]).toEqual([key, true]);
      // every S→F example carries the gateway sig; the taker's heartbeat carries none (F→S frames may carry their own)
      if (directionOf(key) === 'S2F' || !MESSAGE_DIRECTIONS[key]) expect([key, 'sig' in (e.payload as object)]).toEqual([key, directionOf(key) === 'S2F']);
    }
  }
});
