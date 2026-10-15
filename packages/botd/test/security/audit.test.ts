import { readFileSync, rmSync, writeFileSync } from 'fs';
import { start, defaultDeps, createDispatcher, type Deps } from '../../src/daemon';
import { paths } from '../../src/config';
import { agent, make, outcome, owner, req, rig, type Rig } from './rig';

describe('security: audit log tamper detection on restart', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
    await r.unlock();
    for (let i = 0; i < 3; i++) await r.dispatcher.handle(make('10'), agent);
    await r.dispatcher.lock();
  });
  afterEach(() => r.cleanup());

  const restart = async () => {
    await r.deps.audit.close();
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const deps = { ...(await defaultDeps(r.config)), keystore: r.deps.keystore, createEngine: r.deps.createEngine };
    const stop = await start(r.config, deps);
    await stop();
    stderr.mockRestore();
    r.deps = deps;
    return JSON.parse(readFileSync(paths(r.config).state, 'utf8'));
  };
  const lines = () => readFileSync(paths(r.config).audit, 'utf8').trim().split('\n');

  it('an untouched log restarts unpaused', async () => expect(await restart()).toMatchObject({ locked: true, paused: false }));

  it.each<[string, (l: string[]) => string]>([
    ['an edited entry', (l) => l.map((x, i) => (i === 1 ? x.replace('"allow"', '"deny"') : x)).join('\n') + '\n'],
    ['a dropped middle entry', (l) => [...l.slice(0, 1), ...l.slice(2)].join('\n') + '\n'],
    ['the tail cut off', (l) => l.slice(0, 2).join('\n') + '\n'],
    ['swapped entries', (l) => [l[1], l[0], ...l.slice(2)].join('\n') + '\n'],
    ['an emptied file', () => ''],
  ])('%s starts locked and paused', async (_, edit) => {
    writeFileSync(paths(r.config).audit, edit(lines()));
    expect(await restart()).toMatchObject({ locked: true, paused: true, pauseReason: 'audit log truncated or broken' });
  });

  it('a deleted log starts locked and paused', async () => {
    rmSync(paths(r.config).audit);
    expect(await restart()).toMatchObject({ locked: true, paused: true });
  });
});

describe('security: audit write failure fails closed', () => {
  let r: Rig;
  let d: ReturnType<typeof createDispatcher>;
  let calls: string[];
  let broken: boolean;
  beforeEach(async () => {
    broken = false;
    r = await rig();
    calls = [];
    const failing: Deps = {
      ...r.deps,
      audit: { ...r.deps.audit, append: async (e) => (broken ? Promise.reject(new Error('ENOSPC')) : r.deps.audit.append(e)) },
      keystore: { ...r.deps.keystore, unlock: async (p) => (calls.push('unlock'), r.deps.keystore.unlock(p)) },
      limits: { ...r.deps.limits, save: async (l) => (calls.push('limits.save'), r.deps.limits.save(l)) },
      createEngine: (s, h) => {
        const e = r.deps.createEngine(s, h);
        return { ...e, withdraw: async (...a) => (calls.push('withdraw'), e.withdraw(...a)), make: async (p) => (calls.push('make'), e.make(p)) };
      },
    };
    d = createDispatcher(failing);
    await d.handle(req('unlock', { passphrase: 'right' }), owner);
    calls.length = 0;
    broken = true;
  });
  afterEach(() => r.cleanup());

  it('no unlock, limit change, withdraw or trade runs when the audit append fails', async () => {
    expect(await outcome(d.handle(req('unlock', { passphrase: 'right' }), owner))).not.toBe('ok');
    expect(await outcome(d.handle(req('limits.set', { limits: { maxOpenOrders: 1000 } }), owner))).not.toBe('ok');
    expect(await outcome(d.handle(req('withdraw', { to: 'owner::1220aa', instrument: 'CC', amount: '1' }), owner))).not.toBe('ok');
    expect(await outcome(d.handle(make('10'), agent))).not.toBe('ok');
    expect(calls).toEqual([]);
  });
});
