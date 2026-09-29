import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drawValue, drawWinner, firstRoundAtOrAfter } from './draw';
import { FILLER_GATEWAYS, PROTOCOL_VERSION } from './gateway';
import type { DrawRecord, EpochRecord, GatewayInfo } from './messages';
import { PROTOCOL_SCHEMAS, SCHEMA_VOCABULARY } from './schemas';

type Unsigned<T> = Omit<T, 'sig'>;
const records = JSON.parse(readFileSync(join(__dirname, '..', '..', 'spec', 'protocol', 'vectors', 'records.json'), 'utf8')) as {
  draw: Unsigned<DrawRecord>;
  epoch: Unsigned<EpochRecord>;
};
const SIG = `0x${'00'.repeat(65)}` as const;

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addVocabulary([...SCHEMA_VOCABULARY]);
for (const s of Object.values(PROTOCOL_SCHEMAS)) ajv.addSchema(s as object);
const valid = (def: string, value: unknown) => ajv.validate(`https://cancore.io/schemas/filler-protocol/v1/records.schema.json#/$defs/${def}`, value);

test('the fixture draw and epoch records validate once signed, and not without the signature', () => {
  expect(valid('drawRecord', { ...records.draw, sig: SIG })).toBe(true);
  expect(valid('epochRecord', { ...records.epoch, sig: SIG })).toBe(true);
  expect(valid('drawRecord', records.draw)).toBe(false);
  expect(valid('epochRecord', { ...records.epoch, sig: SIG, epochId: 20717 })).toBe(false);
});

// A8 on the fixture: everything a verifier recomputes from public data, except
// the BLS check of the round (CAN-1848) and the gateway signature (test-kit).
describe('verifying the fixture draw from its records', () => {
  const { draw, epoch } = records;
  const a = draw.attempts[0]!;

  test('the epoch contains t0 and its weightsRoot is the StandardMerkleTree root of the leaves', () => {
    expect(BigInt(epoch.startsAt) <= BigInt(draw.t0) && BigInt(draw.t0) < BigInt(epoch.endsAt)).toBe(true);
    expect(draw.epochId).toBe(epoch.epochId);
    const tree = StandardMerkleTree.of(epoch.leaves.map((l) => [l.fillerId, l.base, l.tier, l.reliabilityBps]), ['string', 'uint256', 'uint8', 'uint16']);
    expect(tree.root).toBe(epoch.weightsRoot);
  });

  test('each candidate weight is (base + step(tier)) × reliabilityBps of its leaf (A-11)', () => {
    const step = new Map(epoch.stakeSteps.map((s) => [s.tier, BigInt(s.step)]));
    const weight = new Map(epoch.leaves.map((l) => [l.fillerId, (BigInt(l.base) + step.get(l.tier)!) * BigInt(l.reliabilityBps)]));
    for (const c of a.candidates) expect(BigInt(c.weight)).toBe(weight.get(c.fillerId));
  });

  test('the round follows from t0 + deltaDrand, and r and the winner from the round', () => {
    expect(firstRoundAtOrAfter(BigInt(a.tBase) + BigInt(draw.deltaDrand))).toBe(BigInt(a.drandRound));
    expect(drawWinner(drawValue(a.drandRandomness, draw.orderHash, a.attempt), a.candidates)).toEqual({ r: BigInt(a.r), winnerFillerId: a.winnerFillerId });
    expect(a.winnerFillerId).toBe('acme-markets');
  });
});

test('A6: a gateway identity built from FILLER_GATEWAYS is what GET /v1/gateway returns', () => {
  const info: GatewayInfo = { env: 'devnet', gateway: `0x${'ab'.repeat(20)}`, ticketSigners: [`0x${'cd'.repeat(20)}`], protocolVersion: PROTOCOL_VERSION };
  expect(valid('gatewayInfo', info)).toBe(true);
  expect(valid('gatewayInfo', { ...info, protocolVersion: '2' })).toBe(false);
  expect(valid('gatewayInfo', { ...info, gateway: info.gateway.toUpperCase().replace('0X', '0x') })).toBe(false);
  expect(Object.keys(FILLER_GATEWAYS).sort()).toEqual(['devnet', 'mainnet', 'testnet']);
});
