import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bytesToHex, ed25519PublicKeyFromSeed } from '@cancore/wallet';
import { confirmBackup, main, readKeyFile } from './cli';
import { createKeystore, generateMnemonic } from './keystore';

// Each prompt answers 'a': the CLI asks for the passphrase twice, then the keystore applies the policy.
jest.mock('readline', () => ({
  createInterface: () => {
    const rl = { question: (_q: string, cb: (a: string) => void) => cb('a'), close: () => undefined, once: () => rl };
    return rl;
  },
}));

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
    await keystore.initSeed(readKeyFile(file), 'bot-pass-2026');
    const expected = bytesToHex(ed25519PublicKeyFromSeed(Buffer.from(KEY, 'hex')));
    expect(await keystore.publicKey()).toBe(expected);
    expect((await keystore.unlock('bot-pass-2026')).public_key).toBe(expected);
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
    await expect(keystore.initSeed(new Uint8Array(31), 'bot-pass-2026')).rejects.toThrow(/32-byte/);
    await keystore.initSeed(Buffer.from(KEY, 'hex'), 'bot-pass-2026');
    await expect(keystore.initSeed(Buffer.from(KEY, 'hex'), 'bot-pass-2026')).rejects.toThrow(/refusing to overwrite/);
  });
});

describe('cancore-bot init with a weak passphrase', () => {
  it('prints the policy message, not a stack, writes nothing and exits 1', async () => {
    const file = join(dir, 'bot.key');
    writeFileSync(file, KEY, { mode: 0o600 });
    const cfg = join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify({ stateDir: dir }), { mode: 0o600 });
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const err: string[] = [];
    const write = jest.spyOn(process.stderr, 'write').mockImplementation((s) => (err.push(String(s)), true));
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await main(['init', '--import-key', file, '--config', cfg])).toBe(1);
    } finally {
      write.mockRestore();
      out.mockRestore();
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    }
    expect(err.join('')).toMatch(/^cancore-bot: keystore: passphrase rejected \(too-short\): use at least 12 characters/m);
    expect(err.join('')).not.toMatch(/\n\s+at /);
    expect(() => readFileSync(join(dir, 'keystore.json'))).toThrow();
  });
});
