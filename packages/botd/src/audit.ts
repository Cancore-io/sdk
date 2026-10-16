import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { chmod, open, stat, truncate, writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import type { AuditEntry, AuditLog } from './types';

const GENESIS = '0'.repeat(64);
const SECRET_KEY = /passphrase|mnemonic|private_?key|secret|seed/i;
const CHUNK = 64 * 1024;

/** An opened log; `tornTail` holds the bytes of a final line cut off by a crash, moved aside on open. */
export interface OpenedAuditLog extends AuditLog {
  tornTail: { bytes: number; savedTo: string } | null;
}

/** Sorted-key JSON, so the hash does not depend on property order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function hashEntry(entry: Omit<AuditEntry, 'hash'> & { hash?: string }): string {
  const { hash: _omit, ...rest } = entry;
  return createHash('sha256').update(canonical(rest)).digest('hex');
}

/** Drops any key that could carry key material, at any depth. Defensive: callers should never pass it. */
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(x);
    return out;
  }
  return v;
}

/** The last `n` complete lines, reading backwards in chunks; `torn` is a trailing fragment with no newline. */
async function readTail(path: string, n: number): Promise<{ lines: string[]; torn: string; tornAt: number }> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    let pos = size;
    let buf = Buffer.alloc(0);
    let newlines = 0;
    while (pos > 0 && newlines <= n) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      await fh.read(chunk, 0, len, pos);
      for (const b of chunk) if (b === 10) newlines += 1;
      buf = Buffer.concat([chunk, buf]);
    }
    const parts = buf.toString('utf8').split('\n');
    const torn = parts.pop()!;
    if (pos > 0) parts.shift(); // the first part may be a partial line
    return { lines: parts.slice(-n).filter((l) => l !== ''), torn, tornAt: size - Buffer.byteLength(torn) };
  } finally {
    await fh.close();
  }
}

/** Opens (or creates) the JSONL log at `path`, appending only. */
export async function openAuditLog(path: string): Promise<OpenedAuditLog> {
  await writeFile(path, '', { flag: 'a', mode: 0o600 });
  await chmod(path, 0o600);

  let tornTail: OpenedAuditLog['tornTail'] = null;
  const tail = await readTail(path, 1);
  if (tail.torn !== '') {
    // A crash mid-append; keep the fragment as evidence, then cut it so new entries chain cleanly.
    const savedTo = `${path}.torn-${Date.now()}`;
    await writeFile(savedTo, tail.torn, { mode: 0o600 });
    await truncate(path, tail.tornAt);
    tornTail = { bytes: Buffer.byteLength(tail.torn), savedTo };
  }
  let seq = 0;
  let prev = GENESIS;
  const last = tail.lines[0];
  if (last !== undefined) {
    const e = JSON.parse(last) as AuditEntry; // a complete but unparsable last line is corruption: refuse
    seq = e.seq + 1;
    prev = e.hash;
  }

  const fh = await open(path, 'a', 0o600);
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn);
    queue = p.catch(() => undefined);
    return p;
  };

  return {
    tornTail,
    append: (input) =>
      serial(async () => {
        // JSON round-trip so the hash covers exactly what is written and read back.
        const body = JSON.parse(
          JSON.stringify({ ...input, params: redact(input.params), seq, at: new Date().toISOString(), prev }),
        ) as Omit<AuditEntry, 'hash'>;
        const entry: AuditEntry = { ...body, hash: hashEntry(body) };
        await fh.write(`${JSON.stringify(entry)}\n`);
        await fh.sync();
        seq += 1;
        prev = entry.hash;
        return entry;
      }),
    verify: () =>
      serial(async () => {
        if ((await stat(path)).size === 0) return { ok: true as const, entries: 0 };
        let expectSeq = 0;
        let expectPrev = GENESIS;
        const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
        for await (const line of rl) {
          let e: AuditEntry;
          try {
            e = JSON.parse(line) as AuditEntry;
          } catch {
            rl.close();
            return { ok: false as const, brokenAt: expectSeq };
          }
          if (e.seq !== expectSeq || e.prev !== expectPrev || e.hash !== hashEntry(e)) {
            rl.close();
            return { ok: false as const, brokenAt: expectSeq };
          }
          expectSeq += 1;
          expectPrev = e.hash;
        }
        return { ok: true as const, entries: expectSeq };
      }),
    tail: (n) =>
      serial(async () => (n <= 0 ? [] : (await readTail(path, n)).lines.map((l) => JSON.parse(l) as AuditEntry))),
    close: () => serial(() => fh.close()),
  };
}
