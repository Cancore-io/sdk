/**
 * On-disk format version of a persisted wallet record.
 *
 * Its own module because it is not a property of the key+password flow: the
 * passkey record has the same wrapped-seed shape and will carry the same stamp,
 * and any future migration reads the version before it knows which flow wrote
 * the record.
 */

/**
 * Version stamped on records this build writes.
 *
 * v1 — one PBKDF2-derived key wraps both the seed and the recovery phrase, no
 *      additional data. Still readable; nothing writes it any more.
 * v2 — PBKDF2 then HKDF, a separate key per secret, and each ciphertext bound
 *      to its record and role through AES-GCM's additional data. Written from
 *      the 2026-09-04 key-storage audit (KS-4, KS-5); a v1 record is upgraded
 *      the first time it is unlocked.
 */
export const WALLET_RECORD_VERSION = 2;

/**
 * Version of a record as read from storage. Records written before the field
 * existed carry no `version` and are version 1 by definition — the oldest
 * format, not the current one, which is the whole reason readers go through
 * here instead of touching `record.version`.
 *
 * The stamp exists because the format outlives the code: once the package is
 * published (CAN-778) a record another app's user cannot read is a wallet they
 * cannot spend from, and semver on the API says nothing about data on disk.
 */
export const LEGACY_WALLET_RECORD_VERSION = 1;

export function walletRecordVersion(record: { version?: number }): number {
  return record.version ?? LEGACY_WALLET_RECORD_VERSION;
}
