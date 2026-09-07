import {
  putPersistedWallet,
  getPersistedWallet,
  clearPersistedWallet,
  listWalletAccounts,
  putWalletAccount,
  deleteWalletAccount,
  type StoredWalletAccount,
} from './idb';

interface MockOptions {
  /** Force this store/op combo to fail with the given error instead of succeeding. */
  failOn?: Partial<Record<'wrapped-wallet' | 'wallet-accounts', Partial<Record<'put' | 'get' | 'getAll' | 'delete', Error>>>>;
  /** Seed the legacy 'wrapped-wallet' RECORD_KEY entry, present before the v1->v2 upgrade runs. */
  legacyRecord?: unknown;
  /** Pre-existing store names, so onupgradeneeded's `contains()` check skips createObjectStore. */
  preexistingStores?: string[];
  /** Simulate the defensive `if (tx)` guard being false during onupgradeneeded. */
  noUpgradeTransaction?: boolean;
  /** Force request.onerror on the top-level indexedDB.open() call. */
  failOpen?: Error;
}

/**
 * Minimal but behaviorally-real fake IndexedDB: a single shared Map-backed
 * store keyed by store name, `objectStoreNames.contains` reflects what has
 * actually been created, and onupgradeneeded runs the real migration branch
 * (reading the legacy record, conditionally moving it) so those branches are
 * exercised for real rather than assumed.
 */
function setupMockIndexedDB(options: MockOptions = {}) {
  const stores = new Map<string, Map<string, unknown>>();
  for (const name of options.preexistingStores ?? []) {
    stores.set(name, new Map());
  }
  if (options.legacyRecord !== undefined) {
    stores.set('wrapped-wallet', new Map([['primary', options.legacyRecord]]));
  }

  function makeObjectStore(storeName: string) {
    const storeMap = stores.get(storeName)!;
    const failFor = (op: 'put' | 'get' | 'getAll' | 'delete') =>
      options.failOn?.[storeName as 'wrapped-wallet' | 'wallet-accounts']?.[op];
    // Deferred via a microtask (not a macrotask) so a chain of dependent requests —
    // e.g. the upgrade migration's get() -> put()+delete() — can fully settle within
    // the SAME macrotask the caller (openDb's onupgradeneeded) runs in. The top-level
    // indexedDB.open() request defers its own `onsuccess` by one extra macrotask tick
    // (below) specifically so all such microtask chains drain first, mirroring real
    // IDB's guarantee that the versionchange transaction completes before `success`.
    const schedule = (fn: () => void) => Promise.resolve().then(fn);

    return {
      put: (value: unknown, key: string) => {
        const req: { onsuccess?: () => void; onerror?: () => void; error?: Error } = {};
        const err = failFor('put');
        schedule(() => {
          if (err) {
            req.error = err;
            req.onerror?.();
          } else {
            storeMap.set(key, value);
            req.onsuccess?.();
          }
        });
        return req;
      },
      get: (key: string) => {
        const req: { onsuccess?: () => void; onerror?: () => void; result?: unknown; error?: Error } = {};
        const err = failFor('get');
        schedule(() => {
          if (err) {
            req.error = err;
            req.onerror?.();
          } else {
            req.result = storeMap.get(key);
            req.onsuccess?.();
          }
        });
        return req;
      },
      getAll: () => {
        const req: { onsuccess?: () => void; onerror?: () => void; result?: unknown[]; error?: Error } = {};
        const err = failFor('getAll');
        schedule(() => {
          if (err) {
            req.error = err;
            req.onerror?.();
          } else {
            req.result = Array.from(storeMap.values());
            req.onsuccess?.();
          }
        });
        return req;
      },
      delete: (key: string) => {
        const req: { onsuccess?: () => void; onerror?: () => void; error?: Error } = {};
        const err = failFor('delete');
        schedule(() => {
          if (err) {
            req.error = err;
            req.onerror?.();
          } else {
            storeMap.delete(key);
            req.onsuccess?.();
          }
        });
        return req;
      },
    };
  }

  const mockDb = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    close: () => {},
    createObjectStore: (name: string) => {
      stores.set(name, new Map());
    },
    // Real IDB's transaction(storeName, mode) args aren't needed by this mock —
    // every objectStore() call below resolves the target store by its own name.
    transaction: () => {
      // tx-level errors (put/delete's tx.oncomplete/tx.onerror) share the same
      // failure map as their triggering request — a failed request's tx also fails.
      const tx: { oncomplete?: () => void; onerror?: () => void; error?: Error; objectStore: (n: string) => ReturnType<typeof makeObjectStore> } = {
        objectStore: (name: string) => {
          const store = makeObjectStore(name);
          const wrap = (fn: (...a: unknown[]) => { onsuccess?: () => void; onerror?: () => void; error?: Error }) =>
            (...args: unknown[]) => {
              const req = fn(...args);
              const origSuccess = req.onsuccess;
              const origError = req.onerror;
              req.onsuccess = () => {
                origSuccess?.();
                tx.oncomplete?.();
              };
              req.onerror = () => {
                origError?.();
                tx.error = req.error;
                tx.onerror?.();
              };
              return req;
            };
          return {
            ...store,
            put: wrap(store.put as never) as never,
            delete: wrap(store.delete as never) as never,
          };
        },
      };
      return tx;
    },
  };

  const mockIndexedDB = {
    open: () => {
      const request: {
        result: typeof mockDb;
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
        onerror?: () => void;
        error?: Error;
        transaction: ReturnType<typeof mockDb.transaction> | null;
      } = {
        result: mockDb,
        transaction: null,
      };

      setTimeout(() => {
        if (options.failOpen) {
          request.error = options.failOpen;
          request.onerror?.();
          return;
        }
        request.transaction = options.noUpgradeTransaction ? null : mockDb.transaction();
        request.onupgradeneeded?.();
        // Extra macrotask tick: lets any microtask-queued migration chain (get -> put/delete)
        // triggered synchronously above fully drain before `onsuccess` fires.
        setTimeout(() => request.onsuccess?.(), 0);
      }, 0);

      return request;
    },
  };

  (global as unknown as { indexedDB: typeof mockIndexedDB }).indexedDB = mockIndexedDB;
}

describe('idb keystore', () => {
  beforeEach(() => {
    setupMockIndexedDB();
  });

  it('persists, reads and clears a single wallet record', async () => {
    const record = { prfEnabled: true, credentialId: 'cred-123' };

    await putPersistedWallet(record);

    const retrieved = await getPersistedWallet();
    expect(retrieved).toEqual(record);

    await clearPersistedWallet();
    const afterClear = await getPersistedWallet();
    expect(afterClear).toBeNull();
  });

  it('manages multi-account wallet records', async () => {
    const account1: StoredWalletAccount<{ salt: string }> = {
      record: { salt: 'salt1' },
      email: 'user1@example.com',
      lastUsedAt: new Date().toISOString(),
    };

    await putWalletAccount('pubkey1', account1);

    const accounts = await listWalletAccounts();
    expect(accounts).toEqual([account1]);

    await deleteWalletAccount('pubkey1');
    const emptyAccounts = await listWalletAccounts();
    expect(emptyAccounts).toEqual([]);
  });

  it('skips createObjectStore when both stores already exist (repeat open)', async () => {
    setupMockIndexedDB({ preexistingStores: ['wrapped-wallet', 'wallet-accounts'] });
    // No throw / no crash is the assertion — createObjectStore is a no-op the second time.
    await expect(getPersistedWallet()).resolves.toBeNull();
  });

  it('migrates a legacy pbkdf2 record out of the single-slot store into the accounts store', async () => {
    setupMockIndexedDB({
      legacyRecord: { method: 'pbkdf2', publicKeyHex: 'legacy-pubkey', createdAt: '2020-01-01T00:00:00Z' },
    });
    const accounts = await listWalletAccounts<{ method: string }>();
    expect(accounts).toEqual([
      { record: { method: 'pbkdf2', publicKeyHex: 'legacy-pubkey', createdAt: '2020-01-01T00:00:00Z' }, email: null, lastUsedAt: '2020-01-01T00:00:00Z' },
    ]);
    // The legacy slot itself is now empty — migrated, not duplicated.
    await expect(getPersistedWallet()).resolves.toBeNull();
  });

  it('backfills lastUsedAt with now() when the migrated legacy record has no createdAt', async () => {
    setupMockIndexedDB({ legacyRecord: { method: 'pbkdf2', publicKeyHex: 'legacy-pubkey-2' } });
    const [account] = await listWalletAccounts<{ method: string }>();
    expect(account.lastUsedAt).not.toBeUndefined();
    expect(Number.isNaN(Date.parse(account.lastUsedAt))).toBe(false);
  });

  it('leaves a non-pbkdf2 (passkey/PRF) legacy record in place — no migration', async () => {
    setupMockIndexedDB({ legacyRecord: { prfEnabled: true, credentialId: 'cred-1' } });
    await expect(getPersistedWallet()).resolves.toEqual({ prfEnabled: true, credentialId: 'cred-1' });
    await expect(listWalletAccounts()).resolves.toEqual([]);
  });

  it('leaves a pbkdf2-shaped legacy record without a publicKeyHex in place — nothing to key it by', async () => {
    setupMockIndexedDB({ legacyRecord: { method: 'pbkdf2' } });
    await expect(getPersistedWallet()).resolves.toEqual({ method: 'pbkdf2' });
    await expect(listWalletAccounts()).resolves.toEqual([]);
  });

  it('does not crash the upgrade when request.transaction is unavailable (defensive guard)', async () => {
    setupMockIndexedDB({ noUpgradeTransaction: true, preexistingStores: [] });
    await expect(getPersistedWallet()).resolves.toBeNull();
  });

  it('rejects when the top-level indexedDB.open() call errors', async () => {
    setupMockIndexedDB({ failOpen: new Error('db blocked') });
    await expect(getPersistedWallet()).rejects.toThrow('db blocked');
  });

  it('rejects with a generic message when open() errors without an Error object', async () => {
    (global as unknown as { indexedDB: { open: () => { onerror?: () => void; error?: unknown } } }).indexedDB.open =
      () => {
        const request: { onsuccess?: () => void; onerror?: () => void; error?: unknown } = {};
        setTimeout(() => request.onerror?.(), 0);
        return request;
      };
    await expect(getPersistedWallet()).rejects.toThrow('Failed to open IndexedDB');
  });

  it('rejects on a failed putPersistedWallet (tx error)', async () => {
    setupMockIndexedDB({ failOn: { 'wrapped-wallet': { put: new Error('quota exceeded') } } });
    await expect(putPersistedWallet({ a: 1 })).rejects.toThrow('quota exceeded');
  });

  it('rejects on a failed getPersistedWallet (request error)', async () => {
    setupMockIndexedDB({ failOn: { 'wrapped-wallet': { get: new Error('read failed') } } });
    await expect(getPersistedWallet()).rejects.toThrow('read failed');
  });

  it('rejects on a failed clearPersistedWallet (tx error)', async () => {
    setupMockIndexedDB({ failOn: { 'wrapped-wallet': { delete: new Error('delete failed') } } });
    await expect(clearPersistedWallet()).rejects.toThrow('delete failed');
  });

  it('rejects on a failed listWalletAccounts (request error)', async () => {
    setupMockIndexedDB({ failOn: { 'wallet-accounts': { getAll: new Error('list failed') } } });
    await expect(listWalletAccounts()).rejects.toThrow('list failed');
  });

  it('rejects on a failed putWalletAccount (tx error)', async () => {
    setupMockIndexedDB({ failOn: { 'wallet-accounts': { put: new Error('save failed') } } });
    await expect(
      putWalletAccount('pk', { record: {}, email: null, lastUsedAt: '2026-01-01' }),
    ).rejects.toThrow('save failed');
  });

  it('rejects on a failed deleteWalletAccount (tx error)', async () => {
    setupMockIndexedDB({ failOn: { 'wallet-accounts': { delete: new Error('delete acct failed') } } });
    await expect(deleteWalletAccount('pk')).rejects.toThrow('delete acct failed');
  });
});
