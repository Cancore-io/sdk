import type { PersistedPasskeyWalletRecord } from '../types';

/**
 * Minimal IndexedDB keystore for wrapped-seed wallet records. Ported from the
 * proven PoC (poc/passkey/lib/idb.ts), extended in v2 with a multi-account
 * store for key+password wallets.
 *
 * Stores:
 * - `wrapped-wallet` (v1, single fixed key): legacy slot, now used only by the
 *   passkey/PRF record. Historic pbkdf2 records are migrated out on upgrade.
 * - `wallet-accounts` (v2, keyed by publicKeyHex): one record per saved
 *   key+password wallet, so several accounts can coexist on one device and the
 *   login screen can offer them ("continue as <email>").
 */

const DB_NAME = 'cancore-passkey-wallet';
const DB_VERSION = 2;
const STORE_NAME = 'wrapped-wallet';
const ACCOUNTS_STORE_NAME = 'wallet-accounts';
const RECORD_KEY = 'primary';

/**
 * A saved key+password wallet plus its login-screen metadata. `email` is the
 * human label ("continue as ..."): known at registration/restore, backfilled
 * after the first successful login for migrated legacy records (null until
 * then). Generic over the wrapped record shape to keep this module free of a
 * dependency on the crypto layer.
 */
export interface StoredWalletAccount<T> {
  record: T;
  email: string | null;
  /** CAN-1050: partyName given at emailless signup — login-screen label when email is null. */
  label?: string | null;
  lastUsedAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(ACCOUNTS_STORE_NAME)) {
        db.createObjectStore(ACCOUNTS_STORE_NAME);
        // v1 -> v2: move a pbkdf2 record out of the single legacy slot into the
        // multi-account store (passkey/PRF records have no `method` field and
        // stay put). Runs inside the versionchange transaction, so the read and
        // both writes commit atomically with the schema change.
        const tx = request.transaction;
        if (tx) {
          const legacyRead = tx.objectStore(STORE_NAME).get(RECORD_KEY);
          legacyRead.onsuccess = () => {
            const legacy = legacyRead.result as
              | { method?: string; publicKeyHex?: string; createdAt?: string }
              | undefined;
            if (legacy?.method === 'pbkdf2' && legacy.publicKeyHex) {
              tx.objectStore(ACCOUNTS_STORE_NAME).put(
                {
                  record: legacy,
                  email: null,
                  lastUsedAt: legacy.createdAt ?? new Date().toISOString(),
                } satisfies StoredWalletAccount<unknown>,
                legacy.publicKeyHex,
              );
              tx.objectStore(STORE_NAME).delete(RECORD_KEY);
            }
          };
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

// The single wallet slot holds ONE wrapped-seed record — since v2, only the
// passkey/PRF record (pbkdf2 records live in the accounts store below).
export async function putPersistedWallet<T = PersistedPasskeyWalletRecord>(record: T): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record, RECORD_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to persist wallet record'));
  });
  db.close();
}

export async function getPersistedWallet<T = PersistedPasskeyWalletRecord>(): Promise<T | null> {
  const db = await openDb();
  const record = await new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(RECORD_KEY);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error('Failed to read wallet record'));
  });
  db.close();
  return record;
}

export async function clearPersistedWallet(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(RECORD_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to clear wallet record'));
  });
  db.close();
}

/** All saved key+password wallet accounts on this device (unsorted). */
export async function listWalletAccounts<T>(): Promise<Array<StoredWalletAccount<T>>> {
  const db = await openDb();
  const accounts = await new Promise<Array<StoredWalletAccount<T>>>((resolve, reject) => {
    const tx = db.transaction(ACCOUNTS_STORE_NAME, 'readonly');
    const request = tx.objectStore(ACCOUNTS_STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result as Array<StoredWalletAccount<T>>) ?? []);
    request.onerror = () => reject(request.error ?? new Error('Failed to list wallet accounts'));
  });
  db.close();
  return accounts;
}

/** Create or replace the saved account keyed by its wallet public key. */
export async function putWalletAccount<T>(
  publicKeyHex: string,
  account: StoredWalletAccount<T>,
): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ACCOUNTS_STORE_NAME, 'readwrite');
    tx.objectStore(ACCOUNTS_STORE_NAME).put(account, publicKeyHex);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to persist wallet account'));
  });
  db.close();
}

/** Remove one saved account from this device (its key stays recoverable via the phrase). */
export async function deleteWalletAccount(publicKeyHex: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ACCOUNTS_STORE_NAME, 'readwrite');
    tx.objectStore(ACCOUNTS_STORE_NAME).delete(publicKeyHex);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to delete wallet account'));
  });
  db.close();
}
