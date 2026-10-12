import { createHash } from 'node:crypto';
import { newPreimage, postClaimCounter, sha256Hex } from './selfcustody';
import type { HtlcSwap } from './selfcustody';
import type { Http } from './http';

describe('newPreimage', () => {
  test('a preimage is 32 random bytes as hex text', async () => {
    const { preimage } = await newPreimage();
    expect(preimage).toMatch(/^[0-9a-f]{64}$/);
  });

  test('two calls never give the same preimage', async () => {
    const first = await newPreimage();
    const second = await newPreimage();
    expect(first.preimage).not.toBe(second.preimage);
  });

  test('the hash lock is the SHA-256 of the preimage text, as the ledger computes it', async () => {
    const { preimage, hashLock } = await newPreimage();
    expect(hashLock).toBe(createHash('sha256').update(preimage, 'utf8').digest('hex'));
    expect(hashLock).toBe(await sha256Hex(preimage));
  });
});

describe('postClaimCounter', () => {
  test('posts the preimage to the counter claim of the swap and returns the swap', async () => {
    const swap = { id: 'swap-1', status: 'both_claimed' } as unknown as HtlcSwap;
    const post = jest.fn().mockResolvedValue(swap);
    const http = { post } as unknown as Pick<Http, 'post'>;

    await expect(postClaimCounter(http, 'swap/1', 'secret')).resolves.toBe(swap);
    expect(post).toHaveBeenCalledWith('/htlc/swap%2F1/claim-counter', { preimage: 'secret' });
  });

  test('refuses an empty preimage before any request is made', async () => {
    const post = jest.fn();
    await expect(postClaimCounter({ post } as unknown as Pick<Http, 'post'>, 'swap-1', '')).rejects.toThrow(/preimage/);
    expect(post).not.toHaveBeenCalled();
  });

  test('never writes the preimage to the console, even when the request fails', async () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = methods.map((method) => jest.spyOn(console, method).mockImplementation(() => undefined));
    try {
      const post = jest.fn().mockRejectedValue(new Error('network down'));
      const http = { post } as unknown as Pick<Http, 'post'>;

      await expect(postClaimCounter(http, 'swap-1', 'top-secret-preimage')).rejects.toThrow('network down');
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain('top-secret-preimage');
        }
      }
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
