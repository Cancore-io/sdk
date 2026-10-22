import { z } from 'zod';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'fs';
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
  /**
   * More instrument admins a DvP allocation may run under, by instrument id (`Amulet` for CC). Added to the SDK's
   * pins for the network, never replacing them: testnet has no pinned CC admin, so CC trades there need it.
   */
  instrumentAdmins?: Record<string, string[]>;
  /** More parties a network-fee leg (of a withdraw, say) may pay; added to the SDK's pins. Testnet has none pinned. */
  networkFeeRecipients?: string[];
  /** Ceiling of one withdraw's network fee, in CC; unset refuses every withdraw. */
  maxFee?: string;
  /**
   * New orders an hour, agent and strategies together; default 5. The daemon's own budget: the platform may have a
   * per-person limit of its own on top, and a 429 from it is a `rate_limited` refusal.
   */
  ordersPerHour?: number;
}

export const DEFAULT_CONFIG_PATH = '/etc/cancore-bot/config.json';

export const DEFAULTS: BotConfig = {
  daemonUser: 'cancore-bot',
  clientsGroup: 'cancore-bot-clients',
  stateDir: '/var/lib/cancore-bot',
  agentSocket: '/run/cancore-bot/bot.sock',
  ownerSocket: '/run/cancore-bot/owner.sock',
  // Devnet unless the config names another host: a config without baseUrl must never spend real funds.
  baseUrl: 'https://api-dev.cancore.app',
};

const str = z.string().min(1);
/** Strict: a misspelt key or a wrong type is an error at start, not a silently ignored pin. */
const configSchema = z
  .object({
    daemonUser: str, clientsGroup: str, stateDir: str, agentSocket: str, ownerSocket: str, baseUrl: z.string().url(),
    ownerParty: str, venuePartyId: str, maxFeeRate: str, feeRecipientPartyId: z.union([str, z.array(str)]),
    network: z.enum(['devnet', 'testnet', 'mainnet']), maxFee: str, ordersPerHour: z.number().int().positive(),
    instrumentAdmins: z.record(str, z.array(str).min(1)), networkFeeRecipients: z.array(str).min(1),
  })
  .partial()
  .strict();

/** The config pins ownerParty (the only withdraw target): refused if anyone but root or this user could rewrite it. */
function readTrusted(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path}: not a regular file`);
    const uid = process.getuid?.();
    if (st.uid !== 0 && st.uid !== uid) throw new Error(`${path}: owned by uid ${st.uid}, expected root or ${uid}`);
    if (st.mode & 0o022) throw new Error(`${path}: writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/** A missing file at the default path means defaults; a missing explicit path is an error. */
export function loadConfig(path?: string): BotConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readTrusted(path ?? DEFAULT_CONFIG_PATH));
  } catch (err) {
    if (!path && (err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS };
    throw err;
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`config: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return { ...DEFAULTS, ...parsed.data };
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
