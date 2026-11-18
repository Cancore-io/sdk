import Ajv2020 from 'ajv/dist/2020';
import { FILLER_GATEWAYS, PROTOCOL_VERSION } from './gateway';
import * as protocol from './index';
import type { GatewayInfo } from './messages';
import { MESSAGE_DIRECTIONS, PROTOCOL_SCHEMAS, SCHEMA_VOCABULARY } from './schemas';

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addVocabulary([...SCHEMA_VOCABULARY]);
for (const s of Object.values(PROTOCOL_SCHEMAS)) ajv.addSchema(s as object);
const valid = (def: string, value: unknown) => ajv.validate(`https://cancore.io/schemas/filler-protocol/v1/records.schema.json#/$defs/${def}`, value);

test('A6: a gateway identity built from FILLER_GATEWAYS is what GET /v1/gateway returns', () => {
  const info: GatewayInfo = { env: 'devnet', gateway: `0x${'ab'.repeat(20)}`, ticketSigners: [`0x${'cd'.repeat(20)}`], protocolVersion: PROTOCOL_VERSION, maxMessageAgeMs: 30000 };
  expect(valid('gatewayInfo', info)).toBe(true);
  const { maxMessageAgeMs: _m, ...withoutAge } = info;
  expect(valid('gatewayInfo', withoutAge)).toBe(false); // the freshness bound of §3.4 is published
  expect(valid('gatewayInfo', { ...info, protocolVersion: '2' })).toBe(false);
  expect(valid('gatewayInfo', { ...info, gateway: info.gateway.toUpperCase().replace('0X', '0x') })).toBe(false);
  expect(Object.keys(FILLER_GATEWAYS).sort()).toEqual(['devnet', 'mainnet', 'testnet']);
});

// There is no draw: the user picks the filler (operator decision 2026-10-12), so its arithmetic, records and routes are gone.
test('TC-CAN-2532-01: the protocol surface carries no draw — no functions, records, epoch frame or /v1/draws route', () => {
  for (const name of ['drawValue', 'drawWinner', 'firstRoundAtOrAfter', 'DRAND_QUICKNET', 'DRAW_CLOSED_BY']) expect(protocol).not.toHaveProperty(name);
  expect(Object.keys((PROTOCOL_SCHEMAS.records as { $defs: object }).$defs)).toEqual(['gatewayInfo']);
  expect(MESSAGE_DIRECTIONS).not.toHaveProperty('epoch.weights');
  const paths = ((PROTOCOL_SCHEMAS.rest as Record<string, unknown>)['x-endpoints'] as { path: string }[]).map((e) => e.path);
  expect(paths.filter((p) => p.startsWith('/v1/draws'))).toEqual([]);
});
