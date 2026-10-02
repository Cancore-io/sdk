import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// sync.mjs stamps CONTRACTS_RELEASE.commit with `git rev-parse HEAD` of the
// evm-contracts checkout it reads. It must refuse any source that commit would
// not describe, and refuse before it writes anything into this package.

const script = join(__dirname, '..', 'scripts', 'sync.mjs');
const sync = (dir: string) =>
  spawnSync(process.execPath, [script], { env: { ...process.env, EVM_CONTRACTS_DIR: dir }, encoding: 'utf8' });

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'contracts-sync-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

test('a directory that is not a git checkout is refused', () => {
  const run = sync(scratch);
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain('is not the root of a git checkout');
});

test('a subdirectory of some other checkout is refused: its HEAD is not the source', () => {
  expect(spawnSync('git', ['init', '-q', scratch]).status).toBe(0);
  const inner = join(scratch, 'evm-contracts');
  mkdirSync(inner);
  const run = sync(inner);
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain('is not the root of a git checkout');
});

test('a checkout with uncommitted changes is refused', () => {
  expect(spawnSync('git', ['init', '-q', scratch]).status).toBe(0);
  writeFileSync(join(scratch, 'version.json'), '{}');
  const run = sync(scratch);
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain('has uncommitted changes');
});
