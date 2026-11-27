import { linkSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultGrantPath, forgetGrant, loadGrant, saveGrant } from './grant';

jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
  return { ...actual, openSync: jest.fn(actual.openSync), renameSync: jest.fn(actual.renameSync) };
});
jest.mock('node:os', () => {
  const actual = jest.requireActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: jest.fn(actual.homedir) };
});

const DEV = 'https://api-dev.cancore.app';
const MAINNET = 'https://api.cancore.io';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cancore-mcp-')), 'grants.json');
}

test('a grant is readable back for the stand it was approved for', () => {
  const path = tempPath();
  saveGrant(path, DEV, { token: 'tok', scopes: ['agent:propose'], appName: 'Claude' });

  expect(loadGrant(path, DEV)?.token).toBe('tok');
  expect(loadGrant(path, DEV)?.obtainedAt).toBeGreaterThan(0);
});

// The whole reason the file is a map: a dev token silently carried to mainnet
// is only noticed by what it does there.
test('one stand does not overwrite another', () => {
  const path = tempPath();
  saveGrant(path, DEV, { token: 'dev', scopes: [], appName: 'Claude' });
  saveGrant(path, MAINNET, { token: 'main', scopes: [], appName: 'Claude' });

  expect(loadGrant(path, DEV)?.token).toBe('dev');
  expect(loadGrant(path, MAINNET)?.token).toBe('main');

  forgetGrant(path, DEV);
  expect(loadGrant(path, DEV)).toBeUndefined();
  expect(loadGrant(path, MAINNET)?.token).toBe('main');
});

test('BUG-1635 replaces the file without writing new tokens into the old inode', () => {
  const path = tempPath();
  writeFileSync(path, '{}', { mode: 0o644 });
  linkSync(path, path + '.old');
  saveGrant(path, DEV, { token: 'tok', scopes: [], appName: 'Claude' });
  expect(readFileSync(path + '.old', 'utf8')).toBe('{}');
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('BUG-1635 refuses the default path when there is no home directory', () => {
  jest.mocked(homedir).mockReturnValueOnce('');
  expect(() => defaultGrantPath()).toThrow(/No home directory/);
});

test('BUG-1635 forgets a grant by replacing the file with mode 0600', () => {
  const path = tempPath();
  saveGrant(path, DEV, { token: 'dev', scopes: [], appName: 'test' });
  saveGrant(path, MAINNET, { token: 'main', scopes: [], appName: 'test' });
  const before = readFileSync(path);
  linkSync(path, path + '.old');

  forgetGrant(path, DEV);

  expect(readFileSync(path + '.old')).toEqual(before);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(loadGrant(path, DEV)).toBeUndefined();
  expect(loadGrant(path, MAINNET)?.token).toBe('main');
});

test('BUG-1635 creates a private exclusive temporary file and removes it when rename fails', () => {
  const path = tempPath();
  const renameError = new Error('rename failed');
  jest.mocked(renameSync).mockImplementationOnce(() => { throw renameError; });

  expect(() => saveGrant(path, DEV, { token: 'test', scopes: [], appName: 'test' })).toThrow(renameError);
  expect(openSync).toHaveBeenLastCalledWith(expect.stringMatching(/grants\.json\..+\.tmp$/), 'wx', 0o600);
  expect(readdirSync(dirname(path))).toEqual([]);
});

test('the file is 0600 even when it already existed with looser permissions', () => {
  const path = tempPath();
  writeFileSync(path, '{}', { mode: 0o644 });

  saveGrant(path, DEV, { token: 'tok', scopes: [], appName: 'Claude' });

  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('a missing or unreadable file is no grant, not a crash', () => {
  const path = tempPath();
  expect(loadGrant(path, DEV)).toBeUndefined();
  writeFileSync(path, 'not json');
  expect(loadGrant(path, DEV)).toBeUndefined();
});

// CAN-2087: the backend says when a grant ends. A grant past that moment is
// refused by the server anyway; carrying it only turns every call into a 401.
test('an expired grant is no grant', () => {
  const path = tempPath();
  saveGrant(path, DEV, { token: 'old', scopes: [], appName: 'Claude', expiresAt: 1_000 });

  expect(loadGrant(path, DEV, 1_000)).toBeUndefined();
  expect(loadGrant(path, DEV, 999)?.token).toBe('old');
});

test('expiry and session id survive a round trip, and a grant without them still loads', () => {
  const path = tempPath();
  saveGrant(path, DEV, { token: 'tok', scopes: [], appName: 'Claude', expiresAt: 4_102_444_800, sessionId: 'ses_1' });
  saveGrant(path, MAINNET, { token: 'legacy', scopes: [], appName: 'Claude' });

  expect(loadGrant(path, DEV)).toMatchObject({ expiresAt: 4_102_444_800, sessionId: 'ses_1' });
  expect(loadGrant(path, MAINNET)?.token).toBe('legacy');
});
