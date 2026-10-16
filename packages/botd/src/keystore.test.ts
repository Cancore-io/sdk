import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveWalletKey, isValidMnemonic, providerFromMnemonic } from '@cancore/wallet';
import { createKeystore, generateMnemonic, keyFromEnv, KeystoreFileError, WrongPassphraseError } from './keystore';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const HASH = Buffer.alloc(32, 1).toString('base64');
const dir = mkdtempSync(join(tmpdir(), 'botd-keystore-'));
let n = 0;
const fresh = () => join(dir, `k${n++}.json`);

async function initialised(): Promise<string> {
  const path = fresh();
  await createKeystore(path).init(PHRASE, 'correct horse');
  return path;
}

jest.setTimeout(30_000);

describe('createKeystore', () => {
  it('roundtrips init/unlock to the SDK key, file is 0600 with scrypt >= 2^17', async () => {
    const path = await initialised();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(file.kdf).toMatchObject({ name: 'scrypt', N: 2 ** 17, r: 8, p: 1 });
    expect(file.cipher.name).toBe('aes-256-gcm');
    expect(readFileSync(path, 'utf8')).not.toContain(deriveWalletKey(PHRASE).seedHex);

    const ks = createKeystore(path);
    expect(ks.isLocked()).toBe(true);
    expect(await ks.publicKey()).toBe(deriveWalletKey(PHRASE).publicKeyHex);
    const signer = await ks.unlock('correct horse');
    expect(ks.isLocked()).toBe(false);
    expect(await signer.signPreparedHash(HASH)).toBe(await (await providerFromMnemonic(PHRASE)).signPreparedHash!(HASH));
    ks.lock();
    expect(ks.isLocked()).toBe(true);
    await expect(signer.signPreparedHash(HASH)).rejects.toThrow(/destroyed/);
  });

  it('refuses to overwrite an existing keystore', async () => {
    const path = await initialised();
    await expect(createKeystore(path).init(PHRASE, 'other')).rejects.toThrow(/already exists/);
  });

  it('works with a generated phrase', async () => {
    const phrase = generateMnemonic();
    expect(isValidMnemonic(phrase)).toBe(true);
    const path = fresh();
    await createKeystore(path).init(phrase, 'pw');
    expect((await createKeystore(path).unlock('pw')).public_key).toBe(deriveWalletKey(phrase).publicKeyHex);
  });

  it('wrong passphrase → WrongPassphraseError', async () => {
    const path = await initialised();
    await expect(createKeystore(path).unlock('nope')).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it.each([
    ['tag', (f: any) => (f.cipher.tag = Buffer.alloc(16).toString('base64'))],
    ['ciphertext', (f: any) => (f.cipher.ciphertext = Buffer.alloc(32, 9).toString('base64'))],
    ['publicKey', (f: any) => (f.publicKey = '00'.repeat(32))],
  ])('tampered %s → WrongPassphraseError', async (_, tamper) => {
    const path = await initialised();
    const file = JSON.parse(readFileSync(path, 'utf8'));
    tamper(file);
    writeFileSync(path, JSON.stringify(file));
    await expect(createKeystore(path).unlock('correct horse')).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('refuses garbage and a downgraded KDF', async () => {
    const path = await initialised();
    const file = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...file, kdf: { ...file.kdf, N: 2 ** 10 } }));
    await expect(createKeystore(path).unlock('correct horse')).rejects.toThrow(/minimum/);
    writeFileSync(path, '{not json');
    await expect(createKeystore(path).unlock('correct horse')).rejects.toBeInstanceOf(KeystoreFileError);
  });

  it.each([0o640, 0o604, 0o644])('refuses mode %o', async (mode) => {
    const path = await initialised();
    chmodSync(path, mode);
    await expect(createKeystore(path).unlock('correct horse')).rejects.toThrow(/group\/others/);
    await expect(createKeystore(path).publicKey()).rejects.toThrow(/group\/others/);
  });
  it('refuses a file whose scrypt cost is above the maximum, before running scrypt', async () => {
    const path = await initialised();
    const file = JSON.parse(readFileSync(path, 'utf8'));
    file.kdf.N = 2 ** 19;
    writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
    await expect(createKeystore(path).unlock('correct horse')).rejects.toBeInstanceOf(KeystoreFileError);
    await expect(createKeystore(path).unlock('correct horse')).rejects.toThrow(/above the maximum/);
  });
});

describe('keyFromEnv', () => {
  const env = { CANCORE_BOT_KEY: deriveWalletKey(PHRASE).seedHex };
  it('refuses without the explicit opt-in', () => {
    expect(() => keyFromEnv({ network: 'testnet', env })).toThrow(/insecureEnvKey/);
  });
  it('refuses on mainnet even with the opt-in', () => {
    expect(() => keyFromEnv({ insecureEnvKey: true, network: 'mainnet', env })).toThrow(/devnet and testnet only/);
    expect(() => keyFromEnv({ insecureEnvKey: true, network: undefined, env })).toThrow(/devnet and testnet only/);
    expect(() => keyFromEnv({ insecureEnvKey: true, network: 'Mainnet', env })).toThrow(/devnet and testnet only/);
  });
  it('reads the key off mainnet with the opt-in', () => {
    expect(keyFromEnv({ insecureEnvKey: true, network: 'testnet', env }).public_key).toBe(deriveWalletKey(PHRASE).publicKeyHex);
  });
});
