import type { BotSigner, Engine } from '../types';

export interface SelfCustodyOptions {
  signer: BotSigner;
  /** Gateway root, e.g. https://api.cancore.io */
  baseUrl: string;
}

export function createSelfCustody(options: SelfCustodyOptions): Engine {
  void options;
  throw new Error('not implemented');
}
