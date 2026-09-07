/**
 * Client for the Cancore agent propose-and-approve queue (CAN-237).
 *
 * The asymmetry this module exists to preserve: an agent may ASK for an
 * operation, only the user's key executes it. Nothing here signs, holds a key,
 * or returns a prepared transaction — the API does not offer one. The worst a
 * prompt-injected agent achieves through this client is a queued request the
 * user declines in their wallet.
 *
 * Caps (amount, queue depth) are enforced by the server and deliberately not
 * restated in the tool descriptions an agent reads: those are
 * attacker-reachable, the server is not.
 */

/** The grant is no longer accepted — reconnecting is the fix. */
export class UnauthorizedError extends Error {}

/** The grant is live, it just was not approved for this. Dropping it is not the fix. */
export class ForbiddenError extends Error {}

/** What an agent is allowed to learn: the outcome, never the transaction. */
export interface IntentStatus {
  id: string;
  status: string;
  reason?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** One queued request, as the wallet shows it. */
export interface Intent extends IntentStatus {
  kind: string;
  /**
   * Whatever the kind carries, kept as it arrived. A queue that holds several
   * kinds cannot describe them through one kind's fields.
   */
  params: Record<string, unknown>;
  agentLabel?: string;
}

/** A cross-chain swap offer, in the field names the Cancore API and its own form use. */
export interface OrderProposal {
  sourceNetwork: string;
  sourceTokenAddress: string;
  sourceTokenName?: string;
  sourceAmount: string;
  targetNetwork: string;
  targetTokenAddress: string;
  targetTokenName?: string;
  targetAmount: string;
}

/**
 * A trade against the Cancore pool.
 *
 * The pair is named by TOKEN and there is no rate, and neither is an
 * abbreviation: an agent on a scoped grant cannot read the pair list at all, so
 * a pair id would be a value it could not have obtained honestly — and a rate
 * proposed now is a rate that no longer exists when the user answers. The
 * wallet resolves the pair and quotes it fresh at the press.
 */
export interface AutotradeProposal {
  sourceTokenName: string;
  targetTokenName: string;
  sourceAmount: string;
}

export interface TransferProposal {
  receiverPartyId: string;
  amount: string;
  tokenId?: string;
  description?: string;
}

type Fetch = typeof globalThis.fetch;

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: Fetch;
}

function withLabel(body: Record<string, unknown>, agentLabel?: string): Record<string, unknown> {
  return agentLabel ? { ...body, agentLabel } : body;
}

export class AgentQueueClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: Fetch;

  constructor({ baseUrl, token, fetchImpl = globalThis.fetch }: ClientOptions) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  /**
   * Queue a transfer.
   *
   * Sent flat, unlike the two below: the flat body is what every deployed
   * backend understands, and a stand running one from before the queue carried
   * kinds would reject the envelope.
   */
  proposeTransfer(proposal: TransferProposal, agentLabel?: string): Promise<IntentStatus> {
    const body: Record<string, unknown> = { receiverPartyId: proposal.receiverPartyId, amount: proposal.amount };
    for (const key of ['tokenId', 'description'] as const) {
      if (proposal[key]) body[key] = proposal[key];
    }
    return this.#call<IntentStatus>('POST', '/agent/intents', withLabel(body, agentLabel));
  }

  proposeOrder(proposal: OrderProposal, agentLabel?: string): Promise<IntentStatus> {
    return this.#call<IntentStatus>(
      'POST',
      '/agent/intents',
      withLabel({ kind: 'order', params: proposal }, agentLabel),
    );
  }

  proposeAutotrade(proposal: AutotradeProposal, agentLabel?: string): Promise<IntentStatus> {
    return this.#call<IntentStatus>(
      'POST',
      '/agent/intents',
      withLabel({ kind: 'autotrade', params: proposal }, agentLabel),
    );
  }

  intentStatus(id: string): Promise<IntentStatus> {
    return this.#call<IntentStatus>('GET', `/agent/intents/${encodeURIComponent(id)}`);
  }

  async listPending(): Promise<Intent[]> {
    const out = await this.#call<{ intents?: Intent[] }>('GET', '/agent/intents');
    return out.intents ?? [];
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = (await res.text()).trim();
    if (!res.ok) {
      // The server's own message is the useful part — a cap or a queue limit
      // reads as guidance, not as a transport failure. Pass it through intact
      // so the agent reports the real reason instead of guessing one.
      const message = `${method} ${path}: ${res.status} ${raw.slice(0, 500)}`;
      // The two refusals about the credential itself are typed, not just
      // worded: a caller that has to read a sentence to decide whether to drop
      // a stored grant is a caller that will get it wrong.
      if (res.status === 401) throw new UnauthorizedError(message);
      if (res.status === 403) throw new ForbiddenError(message);
      throw new Error(message);
    }
    return raw ? (JSON.parse(raw) as T) : ({} as T);
  }
}
