import {
  AgentQueueClient,
  ForbiddenError,
  UnauthorizedError,
  type AutotradeProposal,
  type OrderProposal,
  type TransferProposal,
} from './client';
import { AGENT_SCOPES, awaitGrant, startAuthorization, type DeviceStart } from './device';
import { defaultGrantPath, forgetGrant, loadGrant, saveGrant } from './grant';

export interface SessionConfig {
  /** Gateway root, e.g. https://api-dev.cancore.app */
  apiBaseUrl: string;
  /** Where the wallet is served, e.g. https://app-dev.cancore.app — the consent page lives there. */
  appBaseUrl: string;
  /** The name the owner sees on the consent page. */
  appName: string;
  grantPath?: string;
}

export interface SessionDeps {
  fetchImpl?: typeof globalThis.fetch;
  /** Best effort by design: this server also runs headless, where there is no browser to ask. */
  openBrowser?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Every tool answers with plain JSON — this is the whole vocabulary. */
export type ToolResult = Record<string, unknown>;

const DEFAULT_WAIT_SECONDS = 45;
const MIN_WAIT_SECONDS = 5;
const MAX_WAIT_SECONDS = 300;

/**
 * One MCP session: the grant it may hold, the authorization request it may be
 * waiting on, and the six things an agent can do with them.
 *
 * The token never leaves this object. Tools refer to access by what it can do,
 * never by the string — a model that cannot see a credential cannot leak it
 * into a transcript, and nothing here needs it to.
 */
export class CancoreSession {
  readonly #config: SessionConfig;
  readonly #deps: Required<Pick<SessionDeps, 'fetchImpl'>> & SessionDeps;
  readonly #grantPath: string;
  #pending: { start: DeviceStart; expiresAt: number } | undefined;

  constructor(config: SessionConfig, deps: SessionDeps = {}) {
    this.#config = config;
    this.#deps = { fetchImpl: deps.fetchImpl ?? globalThis.fetch, ...deps };
    this.#grantPath = config.grantPath ?? defaultGrantPath();
  }

  /**
   * Ask the owner to authorize this server, and wait a bounded while.
   *
   * The wait is short by default: an MCP client has its own request timeout, and
   * a tool that outlives it reports a failure for a flow that actually
   * succeeded. A pending answer is not a failure — the request stays live and
   * the next call resumes it, so the code already on the owner's screen keeps
   * working. Minting a second one would teach them that a mismatched code is
   * normal, which is the one thing the consent page relies on them noticing.
   */
  async connectWallet(args: { waitSeconds?: number; appName?: string; force?: boolean } = {}): Promise<ToolResult> {
    if (!this.#config.apiBaseUrl) {
      return { error: 'CANCORE_API_URL is not set — point it at the Cancore gateway (e.g. https://api-dev.cancore.app)' };
    }
    if (!args.force && loadGrant(this.#grantPath, this.#config.apiBaseUrl)) {
      // Divergence from the Go server, deliberate: re-running the whole consent
      // dance for an owner who already approved is a worse answer than saying so.
      return { status: 'granted', scopes: [...AGENT_SCOPES], note: 'already authorized for this stand; pass force to ask again' };
    }

    const appName = args.appName || this.#config.appName;
    const now = this.#deps.now ?? Date.now;
    let resumed = false;
    if (this.#pending && now() < this.#pending.expiresAt) {
      resumed = true;
    } else {
      const start = await startAuthorization(this.#deps.fetchImpl, this.#config.apiBaseUrl, appName);
      this.#pending = { start, expiresAt: now() + start.expiresIn * 1000 };
    }
    const start = this.#pending.start;

    const page = this.#config.appBaseUrl ? `${this.#config.appBaseUrl}${start.verificationUri}` : start.verificationUri;
    const opened = this.#config.appBaseUrl && this.#deps.openBrowser ? await this.#deps.openBrowser(page) : false;

    const budgetMs = clampWait(args.waitSeconds) * 1000;
    const outcome = await awaitGrant(this.#deps.fetchImpl, this.#config.apiBaseUrl, start, {
      budgetMs,
      ...(this.#deps.sleep ? { sleep: this.#deps.sleep } : {}),
      ...(this.#deps.now ? { now: this.#deps.now } : {}),
    });

    if (outcome.status === 'granted' && outcome.token) {
      this.#pending = undefined;
      saveGrant(this.#grantPath, this.#config.apiBaseUrl, {
        token: outcome.token,
        scopes: [...AGENT_SCOPES],
        appName,
      });
      return {
        status: 'granted',
        scopes: [...AGENT_SCOPES],
        note: 'access is stored for this stand; the owner can revoke it in the wallet at any time',
      };
    }
    if (outcome.status === 'denied') {
      this.#pending = undefined;
      return { status: 'denied', note: 'the owner declined. Do not ask again unless they bring it up' };
    }
    return {
      status: 'pending',
      userCode: start.userCode,
      page,
      opened,
      resumed,
      next: 'ask the owner to open the page and approve it, then call cancore_connect_wallet again to keep waiting',
      expectCode: 'the page must show this same code — if it does not, the request is not ours',
    };
  }

  proposeAutotrade(proposal: AutotradeProposal, agentLabel?: string): Promise<ToolResult> {
    return this.#queue(
      (client) => client.proposeAutotrade(proposal, agentLabel),
      'the user sees the live quote in their Cancore wallet and approves it there; poll cancore_intent_status for the outcome',
    );
  }

  proposeOrder(proposal: OrderProposal, agentLabel?: string): Promise<ToolResult> {
    return this.#queue(
      (client) => client.proposeOrder(proposal, agentLabel),
      'the user reviews this in their Cancore create-order form; poll cancore_intent_status for the outcome',
    );
  }

  proposeTransfer(proposal: TransferProposal, agentLabel?: string): Promise<ToolResult> {
    return this.#queue(
      (client) => client.proposeTransfer(proposal, agentLabel),
      'the user reviews and signs this in their Cancore wallet; poll cancore_intent_status for the outcome',
    );
  }

  intentStatus(id: string): Promise<ToolResult> {
    return this.#call(async (client) => ({ ...(await client.intentStatus(id)) }));
  }

  listIntents(): Promise<ToolResult> {
    return this.#call(async (client) => ({ intents: await client.listPending() }));
  }

  async #queue(
    send: (client: AgentQueueClient) => Promise<{ id: string; status: string }>,
    next: string,
  ): Promise<ToolResult> {
    return this.#call(async (client) => {
      const queued = await send(client);
      return { intentId: queued.id, status: queued.status, next };
    });
  }

  async #call(run: (client: AgentQueueClient) => Promise<ToolResult>): Promise<ToolResult> {
    const grant = loadGrant(this.#grantPath, this.#config.apiBaseUrl);
    if (!grant) {
      return {
        error:
          'this server has no access to the wallet yet — run cancore_connect_wallet and the owner approves it in their browser',
      };
    }
    const client = new AgentQueueClient({
      baseUrl: this.#config.apiBaseUrl,
      token: grant.token,
      fetchImpl: this.#deps.fetchImpl,
    });
    try {
      return await run(client);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        // The grant itself is refused: keeping it only produces the same failure
        // on every later call.
        forgetGrant(this.#grantPath, this.#config.apiBaseUrl);
        return { error: `${err.message} — run cancore_connect_wallet to ask the owner for a new one` };
      }
      if (err instanceof ForbiddenError) {
        // Live grant, wrong scope. Dropping it would make the owner re-approve
        // for no reason.
        return { error: `${err.message} — this grant was not approved for that` };
      }
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function clampWait(seconds: number | undefined): number {
  if (!seconds) return DEFAULT_WAIT_SECONDS;
  return Math.min(Math.max(Math.trunc(seconds), MIN_WAIT_SECONDS), MAX_WAIT_SECONDS);
}
