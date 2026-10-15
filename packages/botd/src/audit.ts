import type { AuditLog } from './types';

/** Opens (or creates) the JSONL log at `path`, appending only. */
export function openAuditLog(path: string): Promise<AuditLog> {
  void path;
  throw new Error('not implemented');
}
