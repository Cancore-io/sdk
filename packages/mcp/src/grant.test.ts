import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetGrant, loadGrant, saveGrant } from './grant';

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
