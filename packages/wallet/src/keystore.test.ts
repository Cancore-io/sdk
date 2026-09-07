import { MemoryKeyStore } from './keystore';

describe('MemoryKeyStore', () => {
  it('round-trips a record by account id', async () => {
    const store = new MemoryKeyStore<{ wrapped: string }>();
    await store.put('acc-1', { wrapped: 'ciphertext' });

    expect(await store.get('acc-1')).toEqual({ wrapped: 'ciphertext' });
  });

  it('returns null for an unknown account instead of throwing', async () => {
    const store = new MemoryKeyStore<string>();

    expect(await store.get('missing')).toBeNull();
  });

  it('overwrites the record of an existing account', async () => {
    const store = new MemoryKeyStore<string>();
    await store.put('acc-1', 'first');
    await store.put('acc-1', 'second');

    expect(await store.get('acc-1')).toBe('second');
    expect(await store.list()).toHaveLength(1);
  });

  it('lists every stored record with its account id', async () => {
    const store = new MemoryKeyStore<string>();
    await store.put('acc-1', 'a');
    await store.put('acc-2', 'b');

    expect(await store.list()).toEqual(
      expect.arrayContaining([
        { accountId: 'acc-1', record: 'a' },
        { accountId: 'acc-2', record: 'b' },
      ]),
    );
  });

  it('deletes one account without touching the others', async () => {
    const store = new MemoryKeyStore<string>();
    await store.put('acc-1', 'a');
    await store.put('acc-2', 'b');
    await store.delete('acc-1');

    expect(await store.get('acc-1')).toBeNull();
    expect(await store.list()).toEqual([{ accountId: 'acc-2', record: 'b' }]);
  });

  it('deleting an unknown account is a no-op', async () => {
    const store = new MemoryKeyStore<string>();
    await store.put('acc-1', 'a');
    await store.delete('nope');

    expect(await store.list()).toHaveLength(1);
  });
});

/**
 * The point of the whole extraction: the crypto the core needs is present in
 * plain Node, with no jsdom and no polyfill. If this fails, moving the 11 files
 * in A.2 is not the mechanical step the plan assumes.
 */
describe('headless runtime', () => {
  it('exposes WebCrypto with the primitives the core uses', async () => {
    expect(typeof globalThis.crypto?.getRandomValues).toBe('function');
    expect(typeof globalThis.crypto?.subtle?.importKey).toBe('function');

    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);

    expect(key).toBeDefined();
  });
});
