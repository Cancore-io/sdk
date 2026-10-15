import { promises as fs } from 'fs';
import { z } from 'zod';
import { dec } from './decimal';
import type { Limits } from './types';

// Positive, at most 10 decimals, below 1e15: a cap the owner could mean.
const cap = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,10})?$/, 'decimal string, at most 15 integer and 10 fraction digits')
  .refine((s) => dec(s) > 0n, 'must be positive');
const caps = z.record(z.string().min(1), cap).default({});

const schema = z
  .object({
    allowedPairs: z
      .array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'BASE/QUOTE'))
      .max(100)
      .default([]),
    maxOrderAmount: caps,
    maxOrderNotional: caps,
    maxDailyVolume: caps,
    maxPosition: caps,
    maxOpenOrders: z.number().int().min(0).max(1000).default(0),
    maxPriceDeviationBps: z.number().int().min(0).max(10_000).default(0),
    maxCommandsPerMinute: z.number().int().min(0).max(600).default(0),
  })
  .strict();

/** Parses owner-supplied limits; throws on anything malformed. Omitted fields allow nothing. */
export function parseLimits(raw: unknown): Limits {
  return schema.parse(raw);
}

/** Nothing allowed. The starting point before the owner sets limits. */
export function emptyLimits(): Limits {
  return schema.parse({});
}

/**
 * Reads the owner's limits file. Refused unless owned by root or the daemon's
 * user and writable by nobody else: an agent able to edit it could raise its own caps.
 * The daemon only reads this file.
 */
export async function loadLimits(path: string): Promise<Limits> {
  const st = await fs.stat(path);
  if (!st.isFile()) throw new Error(`${path}: not a regular file`);
  const uid = process.getuid?.();
  if (st.uid !== 0 && st.uid !== uid) throw new Error(`${path}: owned by uid ${st.uid}, expected root or ${uid}`);
  if (st.mode & 0o022) throw new Error(`${path}: writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
  return parseLimits(JSON.parse(await fs.readFile(path, 'utf8')));
}
