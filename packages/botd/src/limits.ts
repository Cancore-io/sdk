import type { Limits } from './types';

/** Parses owner-supplied limits; throws on anything malformed. */
export function parseLimits(raw: unknown): Limits {
  void raw;
  throw new Error('not implemented');
}

/** Nothing allowed. The starting point before the owner sets limits. */
export function emptyLimits(): Limits {
  throw new Error('not implemented');
}
