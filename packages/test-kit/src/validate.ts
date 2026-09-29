/**
 * The protocol's own JSON Schemas (from `@cancore/contracts`) over what goes
 * in and out of the mock: an F→S frame that fails is BAD_REQUEST naming the
 * field; the integration suite runs every S→F frame through the same check.
 */
import { MESSAGE_DIRECTIONS, messageSchemaRef, PROTOCOL_SCHEMAS, SCHEMA_VOCABULARY } from '@cancore/contracts';
import type { ErrorObject } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';

const ajv = new Ajv2020({ allErrors: false });
ajv.addVocabulary([...SCHEMA_VOCABULARY]);
for (const schema of Object.values(PROTOCOL_SCHEMAS)) ajv.addSchema(schema as Record<string, unknown>);

const RECORDS_ID = (PROTOCOL_SCHEMAS.records as { $id: string }).$id;

export const directionOf = (type: string) => MESSAGE_DIRECTIONS[type];

/** `null` when valid, else `<field> <what is wrong>` of the first error. */
export function validate(ref: string, value: unknown): string | null {
  const check = ajv.getSchema(ref);
  if (!check) return `type: no schema ${ref}`;
  if (check(value)) return null;
  return describe(check.errors![0]!);
}

function describe(e: ErrorObject): string {
  const missing = (e.params as { missingProperty?: string }).missingProperty;
  const field = missing ? `${e.instancePath}/${missing}` : e.instancePath || '/';
  return `${field} ${e.message ?? 'is invalid'}`;
}

/** A frame against `messages.schema.json#/$defs/<type>`; `direction` picks the signed or unsigned copy of ping/pong. */
export const validateMessage = (msg: Record<string, unknown>, direction?: 'S2F' | 'F2S') =>
  directionOf(String(msg.type)) ? validate(messageSchemaRef(String(msg.type), direction), msg) : `type: unknown frame type ${JSON.stringify(msg.type)}`;

/** A public record against `records.schema.json#/$defs/<name>`. */
export const validateRecord = (name: 'drawRecord' | 'epochRecord' | 'gatewayInfo', value: unknown) => validate(`${RECORDS_ID}#/$defs/${name}`, value);
