import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inspect } from 'util';
import { createKeystore, keyFromEnv } from '../../src/keystore';
import { createDispatcher, defaultDeps } from '../../src/daemon';
import { DEFAULTS, paths, type BotConfig } from '../../src/config';
import { owner, agent, req, outcome, LIMITS } from './rig';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PASS = 'correct-horse-Passphrase-77';
const KEY_HEX = '7f'.repeat(32);

describe('security: keystore and state files', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'botd-files-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const ks = () => join(dir, 'keystore.json');

  it('refuses a keystore readable by group or others', async () => {
    await createKeystore(ks()).init(PHRASE, PASS);
    for (const mode of [0o640, 0o604, 0o660]) {
      chmodSync(ks(), mode);
      await expect(createKeystore(ks()).unlock(PASS)).rejects.toThrow(/readable by group/);
    }
  });

  it('refuses a keystore path that is a symlink, even to a good file', async () => {
    const real = join(dir, 'real.json');
    await createKeystore(real).init(PHRASE, PASS);
    symlinkSync(real, ks());
    await expect(createKeystore(ks()).unlock(PASS)).rejects.toThrow(/ELOOP/);
    await expect(createKeystore(ks()).publicKey()).rejects.toThrow(/ELOOP/);
  });

  it('init never overwrites, also not through a symlink', async () => {
    symlinkSync(join(dir, 'elsewhere.json'), ks());
    await expect(createKeystore(ks()).init(PHRASE, PASS)).rejects.toThrow(/already exists/);
  });

  it('refuses a weakened KDF or a swapped public key', async () => {
    await createKeystore(ks()).init(PHRASE, PASS);
    const file = JSON.parse(readFileSync(ks(), 'utf8'));
    writeFileSync(ks(), JSON.stringify({ ...file, kdf: { ...file.kdf, N: 1024 } }), { mode: 0o600 });
    await expect(createKeystore(ks()).unlock(PASS)).rejects.toThrow(/below the minimum/);
    writeFileSync(ks(), JSON.stringify({ ...file, publicKey: 'ff'.repeat(32) }), { mode: 0o600 });
    await expect(createKeystore(ks()).unlock(PASS)).rejects.toThrow(/wrong passphrase/);
  });

  it('a plaintext env key is refused on mainnet and without the explicit opt-in', () => {
    const env = { CANCORE_BOT_KEY: KEY_HEX };
    expect(() => keyFromEnv({ insecureEnvKey: true, network: 'mainnet', env })).toThrow(/mainnet/);
    expect(() => keyFromEnv({ insecureEnvKey: 'true' as never, network: 'testnet', env })).toThrow(/insecureEnvKey/);
    expect(() => keyFromEnv({ network: 'testnet', env })).toThrow(/insecureEnvKey/);
  });

  it('error messages never carry the key or the passphrase', async () => {
    const msgs: string[] = [];
    try {
      keyFromEnv({ insecureEnvKey: true, network: 'testnet', env: { CANCORE_BOT_KEY: `${KEY_HEX}zz` } });
    } catch (e) {
      msgs.push(String(e), inspect(e));
    }
    await createKeystore(ks()).init(PHRASE, PASS);
    await createKeystore(ks()).unlock(`${PASS}-wrong`).catch((e) => msgs.push(String(e), inspect(e)));
    await createKeystore(ks()).init(PHRASE, PASS).catch((e) => msgs.push(String(e), inspect(e)));
    await createKeystore(ks()).init('not a phrase', PASS).catch((e) => msgs.push(String(e), inspect(e)));
    expect(msgs.length).toBeGreaterThanOrEqual(8);
    for (const m of msgs) {
      expect(m).not.toContain(KEY_HEX);
      expect(m).not.toContain(PASS);
      expect(m).not.toContain('legal winner');
    }
  });

  it('the daemon refuses a state directory others can enter or write', async () => {
    const config: BotConfig = { ...DEFAULTS, stateDir: join(dir, 'state') };
    mkdirSync(config.stateDir, { mode: 0o700 });
    for (const mode of [0o750, 0o770, 0o755, 0o777, 0o701]) {
      chmodSync(config.stateDir, mode);
      await expect(defaultDeps(config)).rejects.toThrow(/mode 0700/);
    }
    // A symlinked state dir resolves to its target, which is then held to the same rule.
    chmodSync(config.stateDir, 0o777);
    symlinkSync(config.stateDir, join(dir, 'link'));
    await expect(defaultDeps({ ...config, stateDir: join(dir, 'link') })).rejects.toThrow(/mode 0700/);
  });

  it('the daemon refuses a limits file writable by group or others', async () => {
    const config: BotConfig = { ...DEFAULTS, stateDir: join(dir, 'state') };
    mkdirSync(config.stateDir, { mode: 0o700 });
    writeFileSync(paths(config).limits, JSON.stringify({ ...LIMITS, maxOpenOrders: 1000 }), { mode: 0o666 });
    chmodSync(paths(config).limits, 0o666);
    const deps = await defaultDeps(config);
    await expect(deps.limits.load()).rejects.toThrow(/writable by group or others/);
    await deps.audit.close();
  });

  it('the passphrase and key reach no file, log line, error or inspectable object', async () => {
    const config: BotConfig = { ...DEFAULTS, stateDir: join(dir, 'state'), ownerParty: 'owner::1220aa' };
    mkdirSync(config.stateDir, { mode: 0o700 });
    await createKeystore(paths(config).keystore).init(PHRASE, PASS);
    writeFileSync(paths(config).limits, JSON.stringify(LIMITS), { mode: 0o600 });
    const out: string[] = [];
    const spies = [jest.spyOn(process.stderr, 'write'), jest.spyOn(process.stdout, 'write')].map((s) => s.mockImplementation((c) => (out.push(String(c)), true)));
    const deps = await defaultDeps(config, { fetchImpl: async () => new Response('{}', { status: 503 }) });
    const d = createDispatcher(deps);
    try {
      out.push(String(await outcome(d.handle(req('unlock', { passphrase: `${PASS}x` }), owner))));
      out.push(String(await outcome(d.handle(req('unlock', { passphrase: PASS }), agent))));
      out.push(String(await outcome(d.handle(req('unlock', { passphrase: PASS }), owner))));
      out.push(String(await outcome(d.handle(req('order.make', { base: 'CC', quote: 'USDCx', side: 'buy', amount: '1', price: '0.15' }), agent))));
      // Everything reachable from Deps and the live keystore, as a debugger or a crash dump would print it.
      out.push(inspect(deps, { depth: 20, showHidden: true }), inspect(d, { depth: 20, showHidden: true }), JSON.stringify(Object.keys(deps)));
      const signer = await deps.keystore.unlock(PASS);
      out.push(inspect(signer, { depth: 20, showHidden: true }), JSON.stringify(signer));
    } finally {
      await d.lock();
      await deps.audit.close();
      for (const s of spies) s.mockRestore();
    }
    const seedHex = Buffer.from(require('@cancore/wallet').deriveWalletKey(PHRASE).seed).toString('hex');
    const files = readdirSync(config.stateDir).filter((f) => f !== 'keystore.json').map((f) => readFileSync(join(config.stateDir, f), 'utf8'));
    for (const text of [...files, ...out]) {
      expect(text).not.toContain(PASS);
      expect(text).not.toContain(seedHex);
      expect(text).not.toContain(Buffer.from(seedHex, 'hex').toString('base64'));
      expect(text).not.toContain('legal winner');
    }
    for (const f of readdirSync(config.stateDir)) expect(statSync(join(config.stateDir, f)).mode & 0o077).toBe(0);
  });
});
