import type { Keystore } from './types';

/** Encrypted keystore file at `path` (mode 0600). */
export function createKeystore(path: string): Keystore {
  void path;
  throw new Error('not implemented');
}
