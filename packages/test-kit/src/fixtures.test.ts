import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Order } from '@cancore/contracts';
import { epochAt, FIXTURE_ORDER, FIXTURE_T0, orderAt, SOURCE } from './fixtures';
import { orderHash } from './protocol';

const orderSpec = JSON.parse(readFileSync(join(__dirname, '..', '..', 'contracts', 'spec', 'typed-data', 'Order.json'), 'utf8')) as {
  vectors: { note: string; chainId: string; verifyingContract: string; message: Record<string, string>; digest: string }[];
};
const vector = orderSpec.vectors.find((v) => v.note.includes('@cancore/test-kit'))!;

test('the fixture order is the EVM-source vector of @cancore/contracts, field for field and by digest', () => {
  expect(FIXTURE_ORDER).toEqual(vector.message);
  expect([SOURCE.chainId, SOURCE.router]).toEqual([vector.chainId, vector.verifyingContract]);
  expect(orderHash(FIXTURE_ORDER as Order, SOURCE.chainId, SOURCE.router)).toBe(vector.digest);
});

test('orderAt: exact at the fixture t0, re-timed (and re-hashed) elsewhere', () => {
  expect(orderAt(FIXTURE_T0)).toEqual(FIXTURE_ORDER);
  const later = orderAt(FIXTURE_T0 + 100, { minReceived: '1', canton: true });
  expect(later).toMatchObject({ createdAt: String(FIXTURE_T0 + 100), fillDeadline: String(FIXTURE_T0 + 700), minReceived: '1' });
  expect(later.destination).not.toBe(FIXTURE_ORDER.destination);
});

test('the epoch contains t0 and gives a taker added by --filler a default leaf', () => {
  const e = epochAt(FIXTURE_T0, [{ fillerId: 'omega-desk', quoteKey: '0x01', fillerAddress: '0x02' }]);
  expect(Number(e.startsAt) <= FIXTURE_T0 && FIXTURE_T0 < Number(e.endsAt)).toBe(true);
  expect(e.leaves.map((l) => l.fillerId)).toEqual(['acme-markets', 'cancore-reserve', 'zeta-liquidity', 'omega-desk']);
});
