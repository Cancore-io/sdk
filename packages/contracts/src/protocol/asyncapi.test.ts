import Ajv2020 from 'ajv/dist/2020';
import { ASYNCAPI, MESSAGE_DIRECTIONS, PROTOCOL_SCHEMAS, SCHEMA_VOCABULARY } from './schemas';

// Structural checks instead of an AsyncAPI parser dependency: the document is
// generated from the schemas, so what can drift is the wiring between them.
type Op = { action: string; channel: { $ref: string }; messages: { $ref: string }[] };
type Msg = { name: string; payload: { schemaFormat: string; schema: { $ref: string } }; examples: { payload: unknown }[] };
const doc = ASYNCAPI as unknown as {
  asyncapi: string;
  channels: Record<string, { address: string; messages: Record<string, { $ref: string }> }>;
  operations: Record<string, Op>;
  components: { messages: Record<string, Msg> };
};

/** Resolve a local JSON pointer (`#/a/b`) inside the document. */
const resolve = (ref: string): unknown =>
  ref.slice(2).split('/').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);

test('AsyncAPI 3.0, one channel on /v1 carrying every frame type', () => {
  expect(doc.asyncapi).toBe('3.0.0');
  expect(doc.channels.filler!.address).toBe('/v1');
  expect(Object.keys(doc.channels.filler!.messages).sort()).toEqual(Object.keys(MESSAGE_DIRECTIONS).sort());
  expect(Object.keys(doc.components.messages).sort()).toEqual(Object.keys(MESSAGE_DIRECTIONS).sort());
});

test('operations are the gateway\'s: it sends S2F frames and receives F2S frames; ping and pong go both ways', () => {
  const byType = new Map<string, string[]>();
  for (const op of Object.values(doc.operations)) {
    expect(resolve(op.channel.$ref)).toBe(doc.channels.filler);
    for (const m of op.messages) {
      const type = m.$ref.split('/').pop()!;
      expect(resolve(m.$ref)).toBeDefined();
      byType.set(type, [...(byType.get(type) ?? []), op.action].sort());
    }
  }
  for (const [type, dir] of Object.entries(MESSAGE_DIRECTIONS)) {
    const expected = dir === 'both' ? ['receive', 'send'] : [dir === 'S2F' ? 'send' : 'receive'];
    expect([type, byType.get(type)]).toEqual([type, expected]);
  }
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
  for (const [type, msg] of Object.entries(doc.components.messages)) {
    expect(msg.name).toBe(type);
    expect(msg.payload.schemaFormat).toBe('application/schema+json;version=draft-2020-12');
    expect(msg.payload.schema.$ref).toBe(`messages.schema.json#/$defs/${type}`);
    expect(defs[type]).toBeDefined();
  }
});

test('every example of the document validates against its payload schema', () => {
  const ajv = new Ajv2020({ strict: true });
  ajv.addVocabulary([...SCHEMA_VOCABULARY]);
  for (const s of Object.values(PROTOCOL_SCHEMAS)) ajv.addSchema(s as object);
  for (const [type, msg] of Object.entries(doc.components.messages)) {
    expect(msg.examples.length).toBeGreaterThan(0);
    for (const e of msg.examples) expect([type, ajv.validate(`https://cancore.io/schemas/filler-protocol/v1/messages.schema.json#/$defs/${type}`, e.payload)]).toEqual([type, true]);
  }
});
