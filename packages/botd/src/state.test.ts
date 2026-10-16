import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openAuditLog } from './audit';
import { auditIntact, createStateStore, initialState } from './state';

const dir = mkdtempSync(join(tmpdir(), 'botd-state-'));
let n = 0;
const fresh = () => join(dir, `f${n++}`);

async function logWith(entries: number) {
  const log = await openAuditLog(fresh());
  const appended = [];
  for (let i = 0; i < entries; i++) appended.push(await log.append({ at: i, method: 'status', riskClass: 'read', decision: 'allow' } as never));
  return { log, appended };
}

describe('auditIntact', () => {
  it('is true when the log still holds the recorded entry, and when it is longer', async () => {
    const { log, appended } = await logWith(3);
    const at = appended[1]!;
    expect(await auditIntact({ ...initialState(), lastAuditSeq: at.seq, lastAuditHash: at.hash }, log)).toBe(true);
  });

  it('is false when the log was cut back past the recorded entry', async () => {
    const { log } = await logWith(2);
    expect(await auditIntact({ ...initialState(), lastAuditSeq: 5, lastAuditHash: 'x' }, log)).toBe(false);
  });

  it('is false when the recorded hash does not match', async () => {
    const { log, appended } = await logWith(2);
    expect(await auditIntact({ ...initialState(), lastAuditSeq: appended[1]!.seq, lastAuditHash: 'forged' }, log)).toBe(false);
  });
});

describe('createStateStore', () => {
  it('a stale save after recordAudit does not move the audit pointer back', async () => {
    const store = createStateStore(fresh());
    await store.recordAudit({ seq: 7, hash: 'h7' });
    await store.save({ ...initialState(), lastAuditSeq: 3, lastAuditHash: 'h3' });
    expect(await store.load()).toMatchObject({ lastAuditSeq: 7, lastAuditHash: 'h7' });
  });
});
