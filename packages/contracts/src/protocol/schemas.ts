/**
 * The JSON Schemas (draft 2020-12) and the AsyncAPI 3.0 document of filler
 * protocol v1, bundled into the package; the same files ship under
 * `@cancore/contracts/spec/protocol/*` for tools that read JSON. Every export
 * is typed by hand so the declaration files do not inline the JSON.
 *
 * Validating with ajv: `new Ajv2020()`, `ajv.addVocabulary([...SCHEMA_VOCABULARY])`,
 * `addSchema` the three schemas, then `ajv.validate(messageSchemaRef(frame.type), frame)`.
 */
import asyncapi from '../../spec/protocol/asyncapi.json';
import messages from '../../spec/protocol/messages.schema.json';
import records from '../../spec/protocol/records.schema.json';
import rest from '../../spec/protocol/rest.schema.json';

export type JsonSchema = Readonly<Record<string, unknown>>;
export type MessageDirection = 'S2F' | 'F2S' | 'both';

export interface RestEndpoint {
  method: 'GET' | 'POST';
  path: string;
  auth: 'none' | 'bearer';
  /** A `$ref` into rest.schema.json (`#/…`) or a sibling schema (`messages.schema.json#/…`). */
  request?: string;
  query?: string;
  response: string;
}

export const PROTOCOL_SCHEMAS: { readonly messages: JsonSchema; readonly rest: JsonSchema; readonly records: JsonSchema } = { messages, rest, records };

export const ASYNCAPI: JsonSchema = asyncapi;

/** The annotation keywords the schemas use; a strict validator must be told they exist. */
export const SCHEMA_VOCABULARY: readonly string[] = ['x-direction', 'x-endpoints', 'x-error-status'];

/** Frame type → who sends it: S2F gateway to taker, F2S taker to gateway, both. */
export const MESSAGE_DIRECTIONS: Readonly<Record<string, MessageDirection>> = Object.fromEntries(
  Object.entries(messages.$defs as Record<string, { 'x-direction'?: MessageDirection }>)
    .filter(([, def]) => def['x-direction'])
    .map(([type, def]) => [type, def['x-direction']!]),
);

export const REST_ENDPOINTS: readonly RestEndpoint[] = rest['x-endpoints'] as RestEndpoint[];

/** The absolute `$ref` of a frame type's schema (or any other `$def` of messages.schema.json). */
export function messageSchemaRef(type: string): string {
  return `${messages.$id}#/$defs/${type}`;
}
