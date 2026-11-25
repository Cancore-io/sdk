import { join } from 'node:path';
import { openAuditLog } from './audit';
import type * as SQLite from 'node:sqlite';

/** SQLite's OS lock dies with its process. Keep the lock file across restarts. */
function lockStateDirectory(dir: string): () => void {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof SQLite;
  const database = new DatabaseSync(join(dir, 'daemon.lock.sqlite'));
  try {
    database.exec('BEGIN EXCLUSIVE');
  } catch (cause) {
    database.close();
    throw new Error(`Cannot lock bot daemon state directory ${dir}`, { cause });
  }
  return () => database.close();
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
