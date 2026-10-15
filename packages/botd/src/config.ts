import { readFileSync } from 'fs';
import { join } from 'path';

/** Daemon and CLI configuration; a JSON file, every field optional. */
export interface BotConfig {
  /** The OS user the daemon must run as. */
  daemonUser: string;
  /** Group allowed to talk to the agent socket. */
  clientsGroup: string;
  /** Keystore, state, limits and audit live here. */
  stateDir: string;
  /** Agent socket: read/reduce/trade only. */
  agentSocket: string;
  /** Owner socket: everything, including owner methods. */
  ownerSocket: string;
  /** Gateway root for the engine. */
  baseUrl: string;
  /** The only party `withdraw` may send to. */
  ownerParty?: string;
  /** Pinned trust boundary for the engine: the API's fee-config cannot move these. */
  venuePartyId?: string;
  maxFeeRate?: string;
  feeRecipientPartyId?: string | string[];
  /** Which pinned instrument admins and fee pools apply; derived from baseUrl for Cancore's hosts. */
  network?: 'devnet' | 'testnet' | 'mainnet';
  /** Ceiling of one withdraw's network fee, in CC; unset refuses every withdraw. */
  maxFee?: string;
}

export const DEFAULT_CONFIG_PATH = '/etc/cancore-bot/config.json';

export const DEFAULTS: BotConfig = {
  daemonUser: 'cancore-bot',
  clientsGroup: 'cancore-bot-clients',
  stateDir: '/var/lib/cancore-bot',
  agentSocket: '/run/cancore-bot/bot.sock',
  ownerSocket: '/run/cancore-bot/owner.sock',
  baseUrl: 'https://api.cancore.io',
};

/** A missing file at the default path means defaults; a missing explicit path is an error. */
export function loadConfig(path?: string): BotConfig {
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(path ?? DEFAULT_CONFIG_PATH, 'utf8')) as Partial<BotConfig>) };
  } catch (err) {
    if (!path && (err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS };
    throw err;
  }
}

export const paths = (config: BotConfig) => ({
  keystore: join(config.stateDir, 'keystore.json'),
  state: join(config.stateDir, 'state.json'),
  limits: join(config.stateDir, 'limits.json'),
  audit: join(config.stateDir, 'audit.jsonl'),
});

/** Value of `--name <v>` in argv. */
export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
