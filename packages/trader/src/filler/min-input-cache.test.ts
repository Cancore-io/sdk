import type { Hex } from '@cancore/contracts';
import { FillerChains } from './chain';
import { MIN_INPUT_CACHE_TTL_MS, MinInputCache, routerMinInputSource } from './min-input-cache';
import { silentLogger } from './runtime';
import { FakeChain, FakeClock } from './testing';

const ROUTER: Hex = '0x5555555555555555555555555555555555555555';
const TOKEN: Hex = '0x0000000000000000000000000000000000000056';
const KEY = { chain: 'eip155:56', router: ROUTER, token: TOKEN };

function countingRead(values: Array<bigint | Error>) {
  const read = { calls: 0, next: async (): Promise<bigint> => {
    const value = values[Math.min(read.calls++, values.length - 1)]!;
    if (value instanceof Error) throw value;
    return value;
  } };
  return read;
}

describe('MinInputCache (BUG-1396)', () => {
  test('a read is reused until the TTL passes, then read again', async () => {
    const clock = new FakeClock();
    const cache = new MinInputCache(clock);
    const read = countingRead([105n, 106n]);
    await expect(cache.get(KEY, read.next)).resolves.toBe(105n);
    clock.advance(MIN_INPUT_CACHE_TTL_MS - 1);
    await expect(cache.get(KEY, read.next)).resolves.toBe(105n);
    expect(read.calls).toBe(1);
    clock.advance(1);
    await expect(cache.get(KEY, read.next)).resolves.toBe(106n);
    expect(read.calls).toBe(2);
  });

  test('a failed read is never kept: the next quote reads again', async () => {
    const cache = new MinInputCache(new FakeClock());
    const read = countingRead([new Error('no endpoint answered'), 105n]);
    await expect(cache.get(KEY, read.next)).rejects.toThrow('no endpoint answered');
    await expect(cache.get(KEY, read.next)).resolves.toBe(105n);
    await expect(cache.get(KEY, read.next)).resolves.toBe(105n);
    expect(read.calls).toBe(2);
  });

  test('chain, router and token each key their own read; address case does not', async () => {
    const cache = new MinInputCache(new FakeClock(), 1_000);
    const read = countingRead([1n, 2n, 3n, 4n]);
    await cache.get(KEY, read.next);
    await cache.get({ ...KEY, token: TOKEN.toUpperCase().replace('0X', '0x') }, read.next);
    expect(read.calls).toBe(1);
    await expect(cache.get({ ...KEY, chain: 'eip155:1' }, read.next)).resolves.toBe(2n);
    await expect(cache.get({ ...KEY, router: '0x6666666666666666666666666666666666666666' }, read.next)).resolves.toBe(3n);
    await expect(cache.get({ ...KEY, token: '0x0000000000000000000000000000000000000057' }, read.next)).resolves.toBe(4n);
  });
});

describe('routerMinInputSource (T-16, N-12)', () => {
  function source() {
    const bsc = new FakeChain(56n, 'bsc');
    bsc.router(ROUTER).minInput.set(TOKEN, 105n);
    const chains = new FillerChains(
      { 'eip155:56': [bsc] },
      { 'eip155:56': { router: ROUTER, openConfirmations: 1, maxHeadLagBlocks: 5, minTicketTtlSec: 60, requiredProofWindowSec: 2_700, sendGuardSec: 30, minGasWei: 0n } },
      silentLogger,
    );
    const minInputCalls = () => bsc.calls.filter((c) => c.method === 'eth_call').length;
    return { minInput: routerMinInputSource(chains, new MinInputCache(new FakeClock())), minInputCalls };
  }

  test('the router floor is read once for two quotes in a row', async () => {
    const s = source();
    await expect(s.minInput('eip155:56', TOKEN)).resolves.toBe(105n);
    const afterFirst = s.minInputCalls();
    expect(afterFirst).toBeGreaterThan(0);
    await expect(s.minInput('eip155:56', TOKEN)).resolves.toBe(105n);
    expect(s.minInputCalls()).toBe(afterFirst);
  });

  test('a Canton source has no floor; a token that is not an address has none to read', async () => {
    const s = source();
    await expect(s.minInput('canton:devnet', TOKEN)).resolves.toBeUndefined();
    await expect(s.minInput('eip155:56', { admin: 'dso', id: 'CC' })).resolves.toBeUndefined();
    expect(s.minInputCalls()).toBe(0);
  });

  test('an EVM source with no configured router is refused, not read', async () => {
    await expect(source().minInput('eip155:137', TOKEN)).rejects.toThrow('no router configured for the source eip155:137');
  });
});
