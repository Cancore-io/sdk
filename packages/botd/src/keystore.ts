import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type BinaryLike, type ScryptOptions } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { deriveWalletKey, hexToBytes, isValidMnemonic, newMnemonic } from '@cancore/wallet';
import { createSigner } from './signer';
import type { BotSigner, Keystore } from './types';

const VERSION = 1;
const MIN_N = 2 ** 17;
const KDF = { N: MIN_N, r: 8, p: 1 };
// scrypt needs 128 * N * r bytes; node's default maxmem (32 MiB) is below that for N = 2^17.
const MAXMEM = 512 * 1024 * 1024;

interface KeystoreFile {
  version: number;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string };
  publicKey: string;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('keystore: wrong passphrase or corrupted file');
    this.name = 'WrongPassphraseError';
  }
}

export class KeystoreFileError extends Error {
  constructor(message: string) {
    super(`keystore: ${message}`);
    this.name = 'KeystoreFileError';
  }
}

/** A fresh 24-word BIP39 phrase from the wallet's generator, for `init`. */
export function generateMnemonic(): string {
  return newMnemonic(256);
}

function scrypt(passphrase: BinaryLike, salt: Buffer, kdf: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: MAXMEM };
  return new Promise((resolve, reject) => scryptCb(passphrase, salt, 32, options, (err, key) => (err ? reject(err) : resolve(key))));
}

// The header is authenticated as AAD, so swapping the public key or weakening the KDF breaks the tag.
function aad(file: Pick<KeystoreFile, 'version' | 'kdf' | 'publicKey'>): Buffer {
  return Buffer.from(JSON.stringify([file.version, file.kdf, file.publicKey]));
}

function readChecked(path: string): KeystoreFile {
  // Stat the opened descriptor, not the path, so the checked file is the one read.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (st.mode & 0o077) throw new KeystoreFileError(`${path} is readable by group/others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new KeystoreFileError(`${path} is not owned by the current user`);
    const file = JSON.parse(readFileSync(fd, 'utf8')) as KeystoreFile;
    if (file.version !== VERSION || file.kdf?.name !== 'scrypt' || file.cipher?.name !== 'aes-256-gcm') throw new KeystoreFileError('unsupported file format');
    if (!(file.kdf.N >= MIN_N && file.kdf.r >= 8 && file.kdf.p >= 1)) throw new KeystoreFileError('scrypt parameters below the minimum');
    return file;
  } catch (err) {
    if (err instanceof KeystoreFileError) throw err;
    throw new KeystoreFileError(`cannot read ${path}: ${(err as Error).message}`);
  } finally {
    closeSync(fd);
  }
}

/** Encrypted keystore file at `path` (mode 0600). */
export function createKeystore(path: string): Keystore {
  let signer: BotSigner | undefined;
  return {
    async init(mnemonic, passphrase) {
      if (!isValidMnemonic(mnemonic)) throw new Error('keystore: not a valid BIP39 recovery phrase');
      if (!passphrase) throw new Error('keystore: empty passphrase');
      const derived = deriveWalletKey(mnemonic);
      const seed = Buffer.from(derived.seed);
      derived.seed.fill(0);
      const salt = randomBytes(32);
      const iv = randomBytes(12);
      const kdf = { name: 'scrypt' as const, ...KDF, salt: salt.toString('base64') };
      const header = { version: VERSION, kdf, publicKey: derived.publicKeyHex };
      const kek = await scrypt(passphrase, salt, KDF);
      try {
        const cipher = createCipheriv('aes-256-gcm', kek, iv);
        cipher.setAAD(aad(header));
        const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
        const file: KeystoreFile = {
          ...header,
          cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') },
        };
        const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600, flag: 'wx' });
        // link(2) is atomic and fails with EEXIST, so an existing keystore is never overwritten.
        try {
          linkSync(tmp, path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new KeystoreFileError(`${path} already exists; refusing to overwrite`);
          throw err;
        } finally {
          unlinkSync(tmp);
        }
      } finally {
        kek.fill(0);
        seed.fill(0);
      }
    },
    async unlock(passphrase) {
      const file = readChecked(path);
      const kek = await scrypt(passphrase, Buffer.from(file.kdf.salt, 'base64'), file.kdf);
      let seed: Buffer;
      try {
        const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(file.cipher.iv, 'base64'));
        decipher.setAAD(aad(file));
        decipher.setAuthTag(Buffer.from(file.cipher.tag, 'base64'));
        seed = Buffer.concat([decipher.update(Buffer.from(file.cipher.ciphertext, 'base64')), decipher.final()]);
      } catch {
        throw new WrongPassphraseError();
      } finally {
        kek.fill(0);
      }
      const next = createSigner(seed);
      if (next.public_key !== file.publicKey) {
        next.destroy();
        throw new KeystoreFileError('decrypted key does not match the stored public key');
      }
      signer?.destroy();
      signer = next;
      return next;
    },
    lock() {
      signer?.destroy();
      signer = undefined;
    },
    isLocked() {
      return signer === undefined;
    },
    async publicKey() {
      return readChecked(path).publicKey;
    },
  };
}

export interface EnvKeyOptions {
  /** Must be literally true: a plaintext key in the environment is for throwaway test bots only. */
  insecureEnvKey?: boolean;
  network: string;
  env?: NodeJS.ProcessEnv;
  /** Env var holding the 64-hex wallet key; default CANCORE_BOT_KEY. */
  variable?: string;
}

/** A signer from a hex key in the environment; refused unless opted in, and always on mainnet. */
export function keyFromEnv({ insecureEnvKey, network, env = process.env, variable = 'CANCORE_BOT_KEY' }: EnvKeyOptions): BotSigner {
  if (insecureEnvKey !== true) throw new Error('keyFromEnv: refused; pass insecureEnvKey: true to read a plaintext key from the environment');
  if (network === 'mainnet') throw new Error('keyFromEnv: refused on mainnet; use an encrypted keystore');
  const hex = env[variable]?.trim();
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`keyFromEnv: ${variable} must be a 32-byte key as 64 hex characters`);
  return createSigner(hexToBytes(hex.toLowerCase()));
}
