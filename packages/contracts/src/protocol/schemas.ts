/**
 * The JSON Schemas (draft 2020-12) and the AsyncAPI 3.0 document of filler
 * protocol v1, bundled into the package; the same files ship under
 * `@cancore/contracts/spec/protocol/*` for tools that read JSON. Every export
 * is typed by hand so the declaration files do not inline the JSON.
 *
 * Validating with ajv: `new Ajv2020()`, `ajv.addVocabulary([...SCHEMA_VOCABULARY])`,
 * `addSchema` the three schemas, then `ajv.validate(messageSchemaRef(frame.type, 'S2F'), frame)`
 * (a taker; the gateway passes 'F2S').
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
  /** An unsigned refusal body (`unsignedErrorBody`) this endpoint may answer instead of the signed `error` (the login routes). Every 429 is one, on every route. */
  errorBody?: string;
}

export const PROTOCOL_SCHEMAS: { readonly messages: JsonSchema; readonly rest: JsonSchema; readonly records: JsonSchema } = { messages, rest, records };

export const ASYNCAPI: JsonSchema = asyncapi;

/** The annotation keywords the schemas use; a strict validator must be told they exist. */
export const SCHEMA_VOCABULARY: readonly string[] = ['x-direction', 'x-rest-only', 'x-endpoints', 'x-error-status'];

/** Frame type → who sends it: S2F gateway to taker, F2S taker to gateway, both. */
export const MESSAGE_DIRECTIONS: Readonly<Record<string, MessageDirection>> = Object.fromEntries(
  Object.entries(messages.$defs as Record<string, { 'x-direction'?: MessageDirection }>)
    .filter(([, def]) => def['x-direction'])
    .map(([type, def]) => [type, def['x-direction']!]),
);

/**
 * Frame types that travel only as REST bodies — the login, `auth.challenge` and `auth.response` —
 * never on the WebSocket, which is authenticated by the bearer token offered on the upgrade.
 */
export const REST_ONLY_TYPES: readonly string[] = Object.entries(messages.$defs as Record<string, { 'x-rest-only'?: boolean }>)
  .filter(([, def]) => def['x-rest-only'] === true)
  .map(([type]) => type);

export const REST_ENDPOINTS: readonly RestEndpoint[] = rest['x-endpoints'] as RestEndpoint[];

/**
 * The absolute `$ref` of a frame type's schema (or any other `$def` of messages.schema.json).
 * `direction` picks the copy of a type that goes both ways: `ping`/`pong` from the gateway are
 * signed (`pingS2F`), from a taker they are not (`pingF2S`); without it, either copy passes.
 */
export function messageSchemaRef(type: string, direction?: 'S2F' | 'F2S'): string {
  const def = direction && MESSAGE_DIRECTIONS[type] === 'both' ? `${type}${direction}` : type;
  return `${messages.$id}#/$defs/${def}`;
}
