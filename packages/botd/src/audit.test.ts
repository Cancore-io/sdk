import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hashEntry, openAuditLog } from './audit';
import type { AuditEntry, AuditLog } from './types';

type Input = Parameters<AuditLog['append']>[0];
const entry = (i: number, params: unknown = { i }): Input =>
  ({ method: 'order.make', riskClass: 'trade', decision: 'allow', params }) as unknown as Input;

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botd-audit-'));
  file = path.join(dir, 'audit.jsonl');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function seed(n: number): Promise<void> {
  const log = await openAuditLog(file);
  for (let i = 0; i < n; i++) await log.append(entry(i));
}
const lines = (): string[] => fs.readFileSync(file, 'utf8').trimEnd().split('\n');
const writeLines = (ls: string[]): void => fs.writeFileSync(file, `${ls.join('\n')}\n`);

describe('audit log', () => {
  test('creates the file 0600 and chains from genesis', async () => {
    const log = await openAuditLog(file);
    const a = await log.append(entry(0));
    const b = await log.append(entry(1));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(a.seq).toBe(0);
    expect(a.prev).toBe('0'.repeat(64));
    expect(b.prev).toBe(a.hash);
    expect(a.hash).toBe(hashEntry(a));
    expect(await log.verify()).toEqual({ ok: true, entries: 2 });
  });

  test('reopening resumes seq and prev from the last line', async () => {
    await seed(3);
    const log = await openAuditLog(file);
    expect(log.tornTail).toBeNull();
    const e = await log.append(entry(3));
    expect(e.seq).toBe(3);
    expect(await log.verify()).toEqual({ ok: true, entries: 4 });
  });

  test('concurrent appends are serialized', async () => {
    const log = await openAuditLog(file);
    const out = await Promise.all(Array.from({ length: 50 }, (_, i) => log.append(entry(i))));
    expect(out.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(await log.verify()).toEqual({ ok: true, entries: 50 });
  });

  test.each(['seq', 'at', 'method', 'riskClass', 'decision', 'reason', 'params', 'prev', 'hash'])(
    'tampering with %s breaks the chain at that entry',
    async (field) => {
      await seed(4);
      const ls = lines();
      const e = JSON.parse(ls[2]!) as Record<string, unknown>;
      e[field] = field === 'seq' ? 7 : field === 'params' ? { i: 99 } : 'x';
      ls[2] = JSON.stringify(e);
      writeLines(ls);
      expect(await (await openAuditLog(file)).verify()).toEqual({ ok: false, brokenAt: 2 });
    },
  );

  test('a re-hashed edit still breaks the next link', async () => {
    await seed(4);
    const ls = lines();
    const e = JSON.parse(ls[1]!) as AuditEntry;
    e.params = { i: 42 };
    e.hash = hashEntry(e);
    ls[1] = JSON.stringify(e);
    writeLines(ls);
    expect(await (await openAuditLog(file)).verify()).toEqual({ ok: false, brokenAt: 2 });
  });

  test('deleting a middle line is detected', async () => {
    await seed(5);
    const ls = lines();
    ls.splice(2, 1);
    writeLines(ls);
    expect(await (await openAuditLog(file)).verify()).toEqual({ ok: false, brokenAt: 2 });
  });

  test('reordering is detected', async () => {
    await seed(5);
    const ls = lines();
    [ls[1], ls[3]] = [ls[3]!, ls[1]!];
    writeLines(ls);
    expect(await (await openAuditLog(file)).verify()).toEqual({ ok: false, brokenAt: 1 });
  });

  test('a torn final line is reported, preserved, and the chain continues', async () => {
    await seed(3);
    const before = fs.readFileSync(file, 'utf8');
    const fragment = '{"seq":3,"at":"2026-';
    fs.appendFileSync(file, fragment);
    const log = await openAuditLog(file);
    expect(log.tornTail).toEqual({ bytes: fragment.length, savedTo: expect.stringContaining('audit.jsonl.torn-') });
    expect(fs.readFileSync(log.tornTail!.savedTo, 'utf8')).toBe(fragment);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect((await log.append(entry(3))).seq).toBe(3);
    expect(await log.verify()).toEqual({ ok: true, entries: 4 });
  });

  test('verify reports a torn tail left in place', async () => {
    await seed(2);
    const log = await openAuditLog(file);
    fs.appendFileSync(file, '{"seq":2');
    expect(await log.verify()).toEqual({ ok: false, brokenAt: 2 });
  });

  test('secrets are never written, at any depth', async () => {
    const log = await openAuditLog(file);
    const e = await log.append(
      entry(0, { pair: 'CC/USDCx', passphrase: 'p1', nested: [{ mnemonic: 'm1', privateKey: 'k1', private_key: 'k2' }] }),
    );
    const text = fs.readFileSync(file, 'utf8');
    for (const s of ['p1', 'm1', 'k1', 'k2']) expect(text).not.toContain(s);
    expect(e.params).toEqual({ pair: 'CC/USDCx', passphrase: '[redacted]', nested: [{ mnemonic: '[redacted]', privateKey: '[redacted]', private_key: '[redacted]' }] });
    expect(await log.verify()).toEqual({ ok: true, entries: 1 });
  });

  test('tail returns the last n entries in order', async () => {
    await seed(5);
    const log = await openAuditLog(file);
    expect((await log.tail(3)).map((e) => e.seq)).toEqual([2, 3, 4]);
    expect((await log.tail(10)).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(await log.tail(0)).toEqual([]);
  });

  test('10k entries: verify and tail stay fast', async () => {
    const big = Array.from({ length: 10_000 }, (_, i) => ({ i, pad: 'x'.repeat(100) }));
    // Build the file directly: 10k fsyncs would measure the disk, not the code.
    let prev = '0'.repeat(64);
    const ls = big.map((params, seq) => {
      const body = { method: 'order.make', riskClass: 'trade', decision: 'allow', params, seq, at: new Date(0).toISOString(), prev } as unknown as Omit<AuditEntry, 'hash'>;
      const e = { ...body, hash: hashEntry(body) };
      prev = e.hash;
      return JSON.stringify(e);
    });
    writeLines(ls);
    const t0 = Date.now();
    const log = await openAuditLog(file);
    expect(await log.verify()).toEqual({ ok: true, entries: 10_000 });
    const t = await log.tail(5);
    expect(t.map((e) => e.seq)).toEqual([9995, 9996, 9997, 9998, 9999]);
    expect((await log.append(entry(0))).seq).toBe(10_000);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
