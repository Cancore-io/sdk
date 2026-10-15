import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bytesToHex, ed25519PublicKeyFromSeed } from '@cancore/wallet';
import { confirmBackup, readKeyFile } from './cli';
import { createKeystore, generateMnemonic } from './keystore';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botd-init-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const KEY = '11'.repeat(32);

describe('init from a new phrase', () => {
  it('generates 24 words', () => {
    expect(generateMnemonic().split(' ')).toHaveLength(24);
  });

  it('asks three distinct random words back and refuses a wrong one', async () => {
    const phrase = generateMnemonic();
    const words = phrase.split(' ');
    const asked: string[] = [];
    const picks = [5, 5, 0, 23];
    const pick = () => picks.shift()!;
    await confirmBackup(phrase, async (q) => (asked.push(q), words[Number(/#(\d+)/.exec(q)![1]) - 1]!), pick);
    expect(asked).toEqual(['word #1: ', 'word #6: ', 'word #24: ']);
    await expect(confirmBackup(phrase, async () => 'wrong')).rejects.toThrow(/does not match/);
  });
});

describe('init --import-key', () => {
  it('reads a 0600 file of 64 hex into a keystore with that key', async () => {
    const file = join(dir, 'bot.key');
    writeFileSync(file, `${KEY}\n`, { mode: 0o600 });
    const keystore = createKeystore(join(dir, 'keystore.json'));
    await keystore.initSeed(readKeyFile(file), 'pass');
    const expected = bytesToHex(ed25519PublicKeyFromSeed(Buffer.from(KEY, 'hex')));
    expect(await keystore.publicKey()).toBe(expected);
    expect((await keystore.unlock('pass')).public_key).toBe(expected);
  });

  it('refuses a file others can read, and anything but 64 hex', () => {
    const file = join(dir, 'bot.key');
    writeFileSync(file, KEY, { mode: 0o600 });
    chmodSync(file, 0o644);
    expect(() => readKeyFile(file)).toThrow(/readable by group\/others/);
    chmodSync(file, 0o600);
    writeFileSync(file, 'abandon abandon');
    expect(() => readKeyFile(file)).toThrow(/64 hex/);
  });

  it('refuses a key of the wrong length and never overwrites a keystore', async () => {
    const keystore = createKeystore(join(dir, 'keystore.json'));
    await expect(keystore.initSeed(new Uint8Array(31), 'pass')).rejects.toThrow(/32-byte/);
    await keystore.initSeed(Buffer.from(KEY, 'hex'), 'pass');
    await expect(keystore.initSeed(Buffer.from(KEY, 'hex'), 'pass')).rejects.toThrow(/refusing to overwrite/);
  });
});
