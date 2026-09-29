export type JsonSchema = Readonly<Record<string, unknown>>;
export type MessageDirection = 'S2F' | 'F2S' | 'both';

export interface RestEndpoint {
  method: 'GET' | 'POST';
  path: string;
  auth: 'none' | 'bearer';
  request?: string;
  query?: string;
  response: string;
}

export const PROTOCOL_SCHEMAS: { readonly messages: JsonSchema; readonly rest: JsonSchema; readonly records: JsonSchema } = { messages: {}, rest: {}, records: {} };
export const ASYNCAPI: JsonSchema = {};
export const SCHEMA_VOCABULARY: readonly string[] = [];
export const MESSAGE_DIRECTIONS: Readonly<Record<string, MessageDirection>> = {};
export const REST_ENDPOINTS: readonly RestEndpoint[] = [];
export function messageSchemaRef(_type: string): string {
  throw new Error('not implemented');
}
