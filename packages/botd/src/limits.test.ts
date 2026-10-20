import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dec } from './decimal';
import { emptyLimits, loadLimits, parseLimits } from './limits';

const good = {
  allowedPairs: ['CC/USDCx'],
  maxOrderAmount: { CC: '100' },
  maxOrderNotional: { USDCx: '20.5' },
  maxDailyVolume: { CC: '1000' },
  maxPosition: { CC: '500' },
  maxOpenOrders: 5,
  maxPriceDeviationBps: 100,
  maxCommandsPerMinute: 10,
  perOrderUsd: '50',
  perDayUsd: '500',
  usdCapsOptOut: false,
};

describe('parseLimits', () => {
  it('accepts a valid file', () => expect(parseLimits(good)).toEqual(good));
  it('fills omitted fields with nothing-allowed', () => expect(parseLimits({})).toEqual(emptyLimits()));
  it.each([
    ['unknown key', { ...good, extra: 1 }],
    ['float amount', { ...good, maxOrderAmount: { CC: 100 } }],
    ['zero cap', { ...good, maxOrderAmount: { CC: '0' } }],
    ['negative cap', { ...good, maxOrderAmount: { CC: '-1' } }],
    ['too many decimals', { ...good, maxOrderAmount: { CC: '1.00000000001' } }],
    ['absurd cap', { ...good, maxOrderAmount: { CC: '1000000000000000' } }],
    ['bad pair', { ...good, allowedPairs: ['CCUSDCx'] }],
    ['fractional count', { ...good, maxOpenOrders: 1.5 }],
    ['bps over 100%', { ...good, maxPriceDeviationBps: 10_001 }],
    ['not an object', 'x'],
  ])('rejects %s', (_, raw) => expect(() => parseLimits(raw)).toThrow());
});

describe('emptyLimits', () => {
  it('allows nothing', () =>
    expect(emptyLimits()).toEqual({
      allowedPairs: [], maxOrderAmount: {}, maxOrderNotional: {}, maxDailyVolume: {}, maxPosition: {},
      maxOpenOrders: 0, maxPriceDeviationBps: 0, maxCommandsPerMinute: 0, usdCapsOptOut: false,
    }));
});

describe('dec', () => {
  it('is exact', () => expect(dec('0.1') + dec('0.2')).toBe(dec('0.3')));
  it('handles sign', () => expect(dec('-1.5')).toBe(-15_000_000_000n));
  it.each(['1e3', '1.', '', '0x10', '1.12345678901'])('rejects %s', (s) => expect(() => dec(s)).toThrow());
});

describe('loadLimits', () => {
  let dir: string;
  beforeEach(async () => (dir = await fs.mkdtemp(path.join(os.tmpdir(), 'botd-limits-'))));
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));
  const write = async (mode: number, body: unknown = good) => {
    const f = path.join(dir, 'limits.json');
    await fs.writeFile(f, JSON.stringify(body));
    await fs.chmod(f, mode);
    return f;
  };

  it('loads an owner-only file', async () => expect(await loadLimits(await write(0o600))).toEqual(good));
  it('loads a world-readable file', async () => expect(await loadLimits(await write(0o644))).toEqual(good));
  it.each([0o620, 0o602, 0o666])('refuses mode %o', async (mode) => {
    await expect(loadLimits(await write(mode))).rejects.toThrow(/writable/);
  });
  it('refuses a directory', async () => expect(loadLimits(dir)).rejects.toThrow(/regular file/));
  it('refuses malformed contents', async () => expect(loadLimits(await write(0o600, { extra: 1 }))).rejects.toThrow());
});
