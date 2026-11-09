import { decodePreparedTransaction, fromBase64, hashPreparedTransactionV2 } from './hashing';
import { checkIntentTransaction, IntentTransactionRefusedError, type IntentRoot, type IntentSigningPolicy } from './intentPolicy';
import { transactionView } from './transaction';
import type { CantonTransaction } from './transactionTypes';

/** A base64 prepared transaction as plain data, with the V2 hash its bytes really have. */
export interface ReadPreparedTransaction {
  transaction: CantonTransaction;
  hash: Uint8Array;
}

export function readPreparedTransaction(preparedTransactionB64: string): ReadPreparedTransaction {
  const prepared = decodePreparedTransaction(preparedTransactionB64);
  return { transaction: transactionView(prepared), hash: hashPreparedTransactionV2(prepared) };
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * The intent root `preparedTransactionB64` is for, once its recomputed hash is `expectedHashB64`
 * and {@link checkIntentTransaction} holds; otherwise {@link IntentTransactionRefusedError}.
 * Signs nothing: a wallet asks this before it shows the transaction or signs it unattended.
 */
export function verifyPreparedTransaction(preparedTransactionB64: string, expectedHashB64: string, policy: IntentSigningPolicy): IntentRoot {
  let read: ReadPreparedTransaction;
  try {
    read = readPreparedTransaction(preparedTransactionB64);
  } catch (cause) {
    throw new IntentTransactionRefusedError(`the prepared transaction does not decode (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  let expected: Uint8Array;
  try {
    expected = fromBase64(expectedHashB64);
  } catch {
    throw new IntentTransactionRefusedError('the expected hash is not base64');
  }
  if (!sameBytes(read.hash, expected)) throw new IntentTransactionRefusedError('the hash is not the hash of the prepared transaction');
  return checkIntentTransaction(read.transaction, policy);
}
