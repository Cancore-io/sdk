import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { openAuditLog } from './audit';
import type * as SQLite from 'node:sqlite';

const lockedByThisProcess = new Set<string>();
const inodeKey = ({ dev, ino }: { dev: number; ino: number }) => `${dev}:${ino}`;

/** SQLite's OS lock dies with its process. Keep the lock file across restarts. */
function lockStateDirectory(dir: string): () => void {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof SQLite;
  const path = join(dir, 'daemon.lock.sqlite');
  // Closing any descriptor of the lock file drops every POSIX lock this process holds on it,
  // so a second attempt from this process must be refused before it opens the file.
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing && lockedByThisProcess.has(inodeKey(existing))) {
    throw new Error(`Cannot lock bot daemon state directory ${dir}`, { cause: new Error('already locked by this process') });
  }
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let key: string;
  try {
    fchmodSync(fd, 0o600);
    key = inodeKey(fstatSync(fd));
  } finally {
    closeSync(fd);
  }
  const database = new DatabaseSync(path);
  try {
    database.exec('BEGIN EXCLUSIVE');
  } catch (cause) {
    database.close();
    throw new Error(`Cannot lock bot daemon state directory ${dir}`, { cause });
  }
  lockedByThisProcess.add(key);
  return () => {
    lockedByThisProcess.delete(key);
    database.close();
  };
}

export async function openLockedAudit(dir: string, path: string) {
  const release = lockStateDirectory(dir);
  try {
    const audit = await openAuditLog(path);
    return { ...audit, close: async () => {
      try { await audit.close(); } finally { release(); }
    } };
  } catch (error) {
    release();
    throw error;
  }
}
