import type { Http } from './http';
import { signerPublicKey, signLoginChallenge, type KeySigner } from './session';

/** How many bot accounts one owner may ever make: the API's cap, and the bot indexes 1..5 of a phrase. */
export const BOT_ACCOUNTS_MAX = 5;

/** `BotAccountResponseDto` */
export interface BotAccount {
  id: string;
  /** Also its party name. */
  name: string;
  /** Hex Ed25519 public key the bot signs in with. */
  publicKey: string | null;
  /** Null until the bot runs its `onboard()`. */
  partyId: string | null;
  status: string;
  /** `key-generated`: no party yet; `party-hosted`: the party exists; `preapproved` or `done`: it can receive CC. */
  onboardingState: 'not-started' | 'key-generated' | 'party-hosted' | 'preapproved' | 'done' | null;
  /** When the owner stopped it; null while it runs. A stopped bot makes and takes no orders (403 `ACCOUNT_STOPPED`). */
  stoppedAt: string | null;
  createdAt: string;
}

export interface CreateBotInput {
  /** The bot's name and party name. */
  name: string;
  /** The bot's own key, e.g. `providerFromMnemonic(phrase, { account: nextBotAccount(...) })`. Never the owner's. */
  botSigner: KeySigner;
}

/**
 * The owner's bot accounts. Every route here needs the owner's own sign-in: an app-session grant
 * is refused, and so is a bot. The owner must be an active self-custody account.
 */
export interface Bots {
  /**
   * `POST /auth/register-challenge` for the bot's key, the challenge signed by that key, then
   * `POST /auth/bots`. A 409 is the cap of five reached, or a key already registered; a 403 is an
   * owner that is a bot or not a self-custody account.
   */
  create(input: CreateBotInput): Promise<BotAccount>;
  /** `GET /auth/bots`, oldest first. */
  list(): Promise<BotAccount[]>;
  /** `POST /auth/bots/{botId}/stop`: its open orders are cancelled, trades under way run to their end. Idempotent. */
  stop(botId: string): Promise<BotAccount>;
  /** `POST /auth/bots/{botId}/resume`: orders the stop cancelled are not restored. Idempotent. */
  resume(botId: string): Promise<BotAccount>;
}

export function createBots(http: Http, anonymous: Http): Bots {
  const botPath = (botId: string, action: 'stop' | 'resume') => `/auth/bots/${encodeURIComponent(botId)}/${action}`;
  return {
    async create({ name, botSigner }) {
      const publicKey = signerPublicKey(botSigner, 'botSigner');
      const { challenge } = await anonymous.post<{ challenge: string }>('/auth/register-challenge', { publicKey });
      const signature = await signLoginChallenge(botSigner, challenge);
      return http.post<BotAccount>('/auth/bots', { publicKey, challenge, signature, name });
    },
    list: () => http.get<BotAccount[]>('/auth/bots'),
    stop: (botId) => http.post<BotAccount>(botPath(botId, 'stop')),
    resume: (botId) => http.post<BotAccount>(botPath(botId, 'resume')),
  };
}

const normalised = (key: string) => key.trim().toLowerCase().replace(/^0x/, '');

/**
 * The account index of the owner's recovery phrase the next bot's key comes from — the web
 * wallet's own rule, so its **Show key** shows the same key: the lowest index from 1 whose public
 * key is not registered yet (`bots.list()`), or null when all five are. The index is found by key,
 * not by any slot number the API keeps, so a phrase restored elsewhere arrives at the same answer.
 * A bot an admin removed frees its index, and the next bot gets that very key again.
 *
 * `publicKeyOf(account)` is the hex public key at `m/44'/6767'/{account}'/0'/0'`:
 * `(await providerFromMnemonic(phrase, { account })).public_key`.
 */
export async function nextBotAccount(
  registered: ReadonlyArray<Pick<BotAccount, 'publicKey'>>,
  publicKeyOf: (account: number) => string | Promise<string>,
): Promise<number | null> {
  const taken = new Set(registered.flatMap(({ publicKey }) => (publicKey ? [normalised(publicKey)] : [])));
  for (let account = 1; account <= BOT_ACCOUNTS_MAX; account++) {
    if (!taken.has(normalised(await publicKeyOf(account)))) return account;
  }
  return null;
}
