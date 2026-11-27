import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, promises as fsp, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type * as SQLite from 'node:sqlite';
import { openLockedAudit } from './state-lock';

let dir: string;
const lockPath = () => join(dir, 'daemon.lock.sqlite');
const auditPath = () => join(dir, 'audit.jsonl');
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'botd-lock-'))));
afterEach(() => {
  jest.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** Exit status of another process that tries to take the same SQLite lock. */
const lockFromAnotherProcess = () => spawnSync(process.execPath, [
  '-e', "new (require('node:sqlite').DatabaseSync)(process.argv[1]).exec('BEGIN EXCLUSIVE')", lockPath(),
]).status;

describe('openLockedAudit', () => {
  it('BUG-1623 narrows an existing lock file to 0600', async () => {
    writeFileSync(lockPath(), '');
    chmodSync(lockPath(), 0o644);
    const audit = await openLockedAudit(dir, auditPath());
    try {
      expect(statSync(lockPath()).mode & 0o777).toBe(0o600);
    } finally {
      await audit.close();
    }
  });

  it('BUG-1623 refuses a symlinked lock file and leaves its target alone', async () => {
    const target = join(dir, 'target');
    writeFileSync(target, '');
    chmodSync(target, 0o644);
    symlinkSync(target, lockPath());
    await expect(openLockedAudit(dir, auditPath())).rejects.toThrow(/ELOOP/);
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  it('BUG-1623 closes the SQLite handle when the lock cannot be taken', async () => {
    writeFileSync(lockPath(), 'not a database '.repeat(16), { mode: 0o600 });
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof SQLite;
    const close = jest.spyOn(DatabaseSync.prototype, 'close');
    await expect(openLockedAudit(dir, auditPath())).rejects.toThrow(/Cannot lock/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('BUG-1623 releases the lock when closing the audit log fails', async () => {
    const promises = jest.requireActual<typeof fsp>('fs/promises');
    const realOpen = promises.open;
    const open = jest.spyOn(promises, 'open').mockImplementation(async (...args: Parameters<typeof realOpen>) => {
      const handle = await realOpen(...args);
      if (args[1] !== 'a') return handle;
      const realClose = handle.close;
      return Object.assign(handle, { close: async () => {
        await realClose();
        throw new Error('disk gone');
      } });
    });
    const audit = await openLockedAudit(dir, auditPath());
    await expect(audit.close()).rejects.toThrow('disk gone');
    open.mockRestore();
    const reopened = await openLockedAudit(dir, auditPath());
    await reopened.close();
  });

  it('BUG-1623 keeps the OS lock when this process asks for it again', async () => {
    const audit = await openLockedAudit(dir, auditPath());
    try {
      await expect(openLockedAudit(dir, join(dir, 'other.jsonl'))).rejects.toThrow(/Cannot lock/);
      expect(lockFromAnotherProcess()).not.toBe(0);
    } finally {
      await audit.close();
    }
    expect(lockFromAnotherProcess()).toBe(0);
  });
});
