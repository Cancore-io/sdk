/**
 * Where a wallet record lives at rest.
 *
 * The record shape is the caller's (`PersistedKeyPasswordWalletRecord`,
 * `PersistedPasskeyWalletRecord`, ...) — this contract only says how records are
 * addressed and persisted, so the core never depends on IndexedDB, a file, or a
 * vault. `accountId` is whatever the caller already keys records by today: the
 * wallet public key in hex for saved accounts, a fixed slot name for the single
 * legacy passkey record.
 *
 * Deliberately no `has`/`clear`/batch methods: every one of them is expressible
 * with the four below, and each extra method is one more thing every
 * implementation (browser, node, memory) has to get right.
 */
export interface StoredRecord<TRecord> {
  accountId: string;
  record: TRecord;
}

export interface KeyStore<TRecord> {
  get(accountId: string): Promise<TRecord | null>;
  put(accountId: string, record: TRecord): Promise<void>;
  delete(accountId: string): Promise<void>;
  /** Every record in the store, unordered. */
  list(): Promise<Array<StoredRecord<TRecord>>>;
}

/**
 * In-memory keystore for core tests. Not a fallback for production code: losing
 * the process loses the wrapped seed, and a wallet whose record is gone is a
 * wallet whose party is unreachable.
 */
export class MemoryKeyStore<TRecord> implements KeyStore<TRecord> {
  private readonly records = new Map<string, TRecord>();

  async get(accountId: string): Promise<TRecord | null> {
    return this.records.get(accountId) ?? null;
  }

  async put(accountId: string, record: TRecord): Promise<void> {
    this.records.set(accountId, record);
  }

  async delete(accountId: string): Promise<void> {
    this.records.delete(accountId);
  }

  async list(): Promise<Array<StoredRecord<TRecord>>> {
    return Array.from(this.records, ([accountId, record]) => ({ accountId, record }));
  }
}
