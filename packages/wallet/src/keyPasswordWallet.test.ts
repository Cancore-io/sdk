import {
  importKeyPasswordWallet,
  unlockKeyPasswordWallet,
  revealWalletSecret,
  changeKeyPasswordWalletPassword,
  WrongPasswordError,
  InvalidPrivateKeyError,
  KeyBindingError,
  WALLET_RECORD_VERSION,
  walletRecordVersion,
} from './keyPasswordWallet';
import { signWithEd25519Signer, verifyEd25519 } from './ed25519';
import { deriveKeyFromPassword } from './passwordKek';
import { wrapSeed } from './aesGcm';
import type { PersistedKeyPasswordWalletRecord } from './keyPasswordWallet';
import { newMnemonic, mnemonicToEd25519Seed } from './mnemonic';
import { bytesToHex, hexToBytes } from './bytes';

// Keep PBKDF2 cheap in tests — the KDF itself is exercised by the round-trip,
// not its cost factor.
const OPTS = { iterations: 1000, now: () => '2026-07-09T00:00:00.000Z' };
const MESSAGE = new Uint8Array(32).map((_, i) => (i * 7) & 0xff);

async function signsValidly(signer: Parameters<typeof signWithEd25519Signer>[0], publicKeyHex: string) {
  const sig = await signWithEd25519Signer(signer, MESSAGE);
  return verifyEd25519(hexToBytes(publicKeyHex), sig, MESSAGE);
}

/**
 * Build a wallet the way registration does: derive the seed from a recovery
 * phrase and import it. `withMnemonic` controls whether the phrase is persisted
 * (register/restore) or only the seed (raw private-key import / legacy).
 */
async function makeWallet(password: string, withMnemonic = true) {
  const mnemonic = newMnemonic();
  const privateKeyHex = bytesToHex(mnemonicToEd25519Seed(mnemonic));
  const imported = await importKeyPasswordWallet(
    privateKeyHex,
    password,
    OPTS,
    withMnemonic ? mnemonic : undefined,
  );
  return { ...imported, privateKeyHex, mnemonic };
}

/**
 * A record in the ORIGINAL on-disk format: one PBKDF2 key for both secrets, no
 * additional data, no version stamp.
 *
 * Written by hand rather than by an old build, because there is no old build to
 * run — and a migration test whose "legacy" fixture is a current record with a
 * field deleted proves only that the field can be deleted. Records in this shape
 * are on people's devices today; they have to keep opening.
 */
async function legacyRecordFor(
  wallet: Awaited<ReturnType<typeof makeWallet>>,
  password: string,
): Promise<PersistedKeyPasswordWalletRecord> {
  const record = wallet.record;
  const salt = hexToBytes(record.saltHex);
  const kek = await deriveKeyFromPassword(password, salt, record.iterations);
  const seed = await wrapSeed(kek, hexToBytes(wallet.privateKeyHex));
  const phrase = await wrapSeed(kek, Uint8Array.from(wallet.mnemonic, (c) => c.charCodeAt(0)));
  return {
    ...record,
    version: 1,
    wrappedIvHex: seed.ivHex,
    wrappedCiphertextHex: seed.ciphertextHex,
    mnemonicIvHex: phrase.ivHex,
    mnemonicCiphertextHex: phrase.ciphertextHex,
  };
}

describe('keyPasswordWallet', () => {
  it('imports a wallet and unlocks it with the same password (signer round-trips)', async () => {
    const wallet = await makeWallet('correct horse battery staple');

    expect(wallet.privateKeyHex).toHaveLength(64);
    expect(wallet.record.method).toBe('pbkdf2');
    expect(await signsValidly(wallet.signer, wallet.publicKeyHex)).toBe(true);

    const unlocked = await unlockKeyPasswordWallet(wallet.record, 'correct horse battery staple');
    expect(unlocked.publicKeyHex).toBe(wallet.publicKeyHex);
    expect(await signsValidly(unlocked.signer, unlocked.publicKeyHex)).toBe(true);
  });

  it('throws WrongPasswordError on an incorrect password', async () => {
    const wallet = await makeWallet('right-password');
    await expect(unlockKeyPasswordWallet(wallet.record, 'wrong-password')).rejects.toThrow(
      WrongPasswordError,
    );
  });

  it('cross-device: re-import the private key under a NEW password yields the same party', async () => {
    const wallet = await makeWallet('device-a-password');

    // "Another device": user enters their private key + a different password.
    const onDeviceB = await importKeyPasswordWallet(wallet.privateKeyHex, 'device-b-password', OPTS);
    expect(onDeviceB.publicKeyHex).toBe(wallet.publicKeyHex);

    // The device-B record unlocks with the device-B password...
    const unlocked = await unlockKeyPasswordWallet(onDeviceB.record, 'device-b-password');
    expect(unlocked.publicKeyHex).toBe(wallet.publicKeyHex);
    // ...and the salt/wrap are independent from device A (different ciphertext).
    expect(onDeviceB.record.wrappedCiphertextHex).not.toBe(wallet.record.wrappedCiphertextHex);

    // The old (device-A) password does NOT unlock the device-B record.
    await expect(unlockKeyPasswordWallet(onDeviceB.record, 'device-a-password')).rejects.toThrow(
      WrongPasswordError,
    );
  });

  it('rejects a malformed private key on import', async () => {
    await expect(importKeyPasswordWallet('not-hex', 'pw', OPTS)).rejects.toThrow(InvalidPrivateKeyError);
    await expect(importKeyPasswordWallet('abcd', 'pw', OPTS)).rejects.toThrow(InvalidPrivateKeyError);
  });
});

describe('revealWalletSecret', () => {
  it('reveals the original recovery phrase when one was stored', async () => {
    const wallet = await makeWallet('pw', true);

    const revealed = await revealWalletSecret(wallet.record, 'pw');
    expect(revealed.mnemonic).toBe(wallet.mnemonic);
    expect(revealed.privateKeyHex).toBe(wallet.privateKeyHex);
  });

  it('falls back to the private key hex for a seed-only (legacy) record', async () => {
    const wallet = await makeWallet('pw', false);
    expect(wallet.record.mnemonicIvHex).toBeUndefined();

    const revealed = await revealWalletSecret(wallet.record, 'pw');
    expect(revealed.mnemonic).toBeNull();
    expect(revealed.privateKeyHex).toBe(wallet.privateKeyHex);
  });

  it('throws WrongPasswordError on an incorrect password', async () => {
    const wallet = await makeWallet('right');
    await expect(revealWalletSecret(wallet.record, 'wrong')).rejects.toThrow(WrongPasswordError);
  });
});

describe('changeKeyPasswordWalletPassword', () => {
  it('re-wraps under the new password: new unlocks, old no longer does, party is stable', async () => {
    const wallet = await makeWallet('old-password');

    const next = await changeKeyPasswordWalletPassword(wallet.record, 'old-password', 'new-password', OPTS);
    expect(next.publicKeyHex).toBe(wallet.record.publicKeyHex);
    expect(next.createdAt).toBe(wallet.record.createdAt); // creation time preserved
    expect(next.wrappedCiphertextHex).not.toBe(wallet.record.wrappedCiphertextHex); // fresh wrap

    const unlocked = await unlockKeyPasswordWallet(next, 'new-password');
    expect(await signsValidly(unlocked.signer, unlocked.publicKeyHex)).toBe(true);

    await expect(unlockKeyPasswordWallet(next, 'old-password')).rejects.toThrow(WrongPasswordError);
  });

  it('preserves the recovery phrase across a password change', async () => {
    const wallet = await makeWallet('old', true);

    const next = await changeKeyPasswordWalletPassword(wallet.record, 'old', 'new', OPTS);
    const revealed = await revealWalletSecret(next, 'new');
    expect(revealed.mnemonic).toBe(wallet.mnemonic);
    expect(revealed.privateKeyHex).toBe(wallet.privateKeyHex);
  });

  it('throws WrongPasswordError when the current password is wrong', async () => {
    const wallet = await makeWallet('correct');
    await expect(
      changeKeyPasswordWalletPassword(wallet.record, 'incorrect', 'whatever-new', OPTS),
    ).rejects.toThrow(WrongPasswordError);
  });
});

describe('key-binding self-check', () => {
  it('refuses a record whose public key was swapped underneath it', async () => {
    const wallet = await makeWallet('binding-check');
    // Same wrapped seed, someone else's public key: the wallet would register a
    // party it can never sign for, so the unlock must refuse it.
    const foreign = await makeWallet('other');
    const tampered = { ...wallet.record, publicKeyHex: foreign.record.publicKeyHex };

    // On a v2 record the refusal comes from AES-GCM, because the public key is
    // authenticated as additional data (KS-5) — the edit is caught by the
    // primitive that exists for it, before a key is ever built. The binding
    // check below is the backstop for records written before that.
    await expect(unlockKeyPasswordWallet(tampered, 'binding-check')).rejects.toThrow(
      WrongPasswordError,
    );
    // Untouched record still unlocks and signs.
    const ok = await unlockKeyPasswordWallet(wallet.record, 'binding-check');
    expect(await signsValidly(ok.signer, ok.publicKeyHex)).toBe(true);
  });

  it('still checks the binding on a legacy record, where nothing else does', async () => {
    // v1 authenticated no context, so a swapped public key decrypts fine and the
    // only thing standing between the user and a party they cannot sign for is
    // this check.
    const wallet = await makeWallet('legacy-binding');
    const foreign = await makeWallet('legacy-other');
    const legacy = await legacyRecordFor(wallet, 'legacy-binding');

    await expect(
      unlockKeyPasswordWallet({ ...legacy, publicKeyHex: foreign.record.publicKeyHex }, 'legacy-binding'),
    ).rejects.toThrow(KeyBindingError);
  });
});

/**
 * Record format version (CAN-744, A.2). Once this package is published
 * (CAN-778) the on-disk shape is a contract with other people's users: a record
 * they cannot read is a wallet they cannot spend from, and semver on the API
 * says nothing about data written by an older release. Adding the field while
 * the format is still ours is cheap; adding it after is a migration nobody can
 * test against real user data.
 */
describe('record format version', () => {
  it('stamps the current version on a freshly imported wallet', async () => {
    const wallet = await makeWallet('versioned');

    // Literal 2, not the constant: comparing the constant with itself is how a
    // version test passes while nothing writes a version at all.
    expect(wallet.record.version).toBe(2);
    expect(WALLET_RECORD_VERSION).toBe(2);
  });

  it('reads a record written before the field existed as version 1', async () => {
    const wallet = await makeWallet('legacy');
    const legacyRecord = { ...wallet.record };
    delete legacyRecord.version;

    expect(walletRecordVersion(legacyRecord)).toBe(1);
  });

  it('still unlocks a record written before the field existed', async () => {
    const wallet = await makeWallet('legacy-unlock');
    const legacy = await legacyRecordFor(wallet, 'legacy-unlock');
    delete legacy.version;

    const unlocked = await unlockKeyPasswordWallet(legacy, 'legacy-unlock');

    expect(await signsValidly(unlocked.signer, unlocked.publicKeyHex)).toBe(true);
  });

  it('keeps the version when the password changes', async () => {
    const wallet = await makeWallet('old-pass');

    const rewrapped = await changeKeyPasswordWalletPassword(
      wallet.record,
      'old-pass',
      'new-pass',
      OPTS,
    );

    expect(rewrapped.version).toBe(2);
    const unlocked = await unlockKeyPasswordWallet(rewrapped, 'new-pass');
    expect(await signsValidly(unlocked.signer, unlocked.publicKeyHex)).toBe(true);
  });
});

/**
 * Upgrading a record in place (KS-2, KS-4 of the 2026-09-04 key-storage audit).
 *
 * The parameters that protect a wrapped seed are only ever changeable at one
 * moment: while the password is in hand. A build that raises them and does not
 * re-wrap has raised them for new wallets and nobody else — which is what the
 * comment in `passwordKek.ts` claimed was already happening, and was not.
 */
describe('record upgrade on unlock', () => {
  it('re-wraps a legacy record and hands it back to be persisted', async () => {
    const wallet = await makeWallet('legacy-upgrade');
    const legacy = await legacyRecordFor(wallet, 'legacy-upgrade');

    const unlocked = await unlockKeyPasswordWallet(legacy, 'legacy-upgrade', OPTS);

    expect(unlocked.upgraded).toBeDefined();
    expect(unlocked.upgraded!.version).toBe(WALLET_RECORD_VERSION);
    // Same wallet, not a new one: the party must survive the re-wrap, and so
    // must the day the user created it.
    expect(unlocked.upgraded!.publicKeyHex).toBe(legacy.publicKeyHex);
    expect(unlocked.upgraded!.createdAt).toBe(legacy.createdAt);

    // The upgraded record opens with the SAME password and still holds both
    // secrets — an upgrade that loses the recovery phrase is a lost wallet.
    const reopened = await unlockKeyPasswordWallet(unlocked.upgraded!, 'legacy-upgrade', OPTS);
    expect(await signsValidly(reopened.signer, reopened.publicKeyHex)).toBe(true);
    const revealed = await revealWalletSecret(unlocked.upgraded!, 'legacy-upgrade');
    expect(revealed.privateKeyHex).toBe(wallet.privateKeyHex);
    expect(revealed.mnemonic).toBe(wallet.mnemonic);
  });

  it('re-wraps a record whose iteration count is behind', async () => {
    const wallet = await makeWallet('weak-iterations');
    const weak = { ...wallet.record, iterations: 100 };
    // Rebuild the ciphertexts under the weak count so the record is genuinely
    // openable — a record that merely CLAIMS 100 iterations opens with nothing.
    const rebuilt = await changeKeyPasswordWalletPassword(
      wallet.record,
      'weak-iterations',
      'weak-iterations',
      { ...OPTS, iterations: 100 },
    );

    const unlocked = await unlockKeyPasswordWallet(rebuilt, 'weak-iterations', OPTS);

    expect(rebuilt.iterations).toBe(100);
    expect(unlocked.upgraded).toBeDefined();
    expect(unlocked.upgraded!.iterations).toBe(OPTS.iterations);
    expect(weak.iterations).toBe(100);
  });

  it('leaves a current record alone', async () => {
    // Churn has a cost of its own: every re-wrap is a write, and a write that
    // changes nothing is a chance to lose the record for no reason.
    const wallet = await makeWallet('already-current');
    const unlocked = await unlockKeyPasswordWallet(wallet.record, 'already-current', OPTS);

    expect(unlocked.upgraded).toBeUndefined();
  });
});

/**
 * One key per secret (KS-4). The recovery phrase is the more portable of the
 * two — a seed is ours, a phrase types into any BIP39 wallet — and until v2 both
 * were wrapped under the same key, which made the two ciphertexts
 * interchangeable inputs to the same unwrap.
 */
describe('seed and recovery phrase are separately wrapped', () => {
  it('refuses a record whose two ciphertexts were swapped', async () => {
    const wallet = await makeWallet('swap-check');
    const swapped = {
      ...wallet.record,
      wrappedIvHex: wallet.record.mnemonicIvHex!,
      wrappedCiphertextHex: wallet.record.mnemonicCiphertextHex!,
      mnemonicIvHex: wallet.record.wrappedIvHex,
      mnemonicCiphertextHex: wallet.record.wrappedCiphertextHex,
    };

    // Under v1 this decrypted — the same key opened both — and the wrong bytes
    // then travelled as far as the Ed25519 import before anything complained.
    await expect(unlockKeyPasswordWallet(swapped, 'swap-check', OPTS)).rejects.toThrow(
      WrongPasswordError,
    );
  });
});
