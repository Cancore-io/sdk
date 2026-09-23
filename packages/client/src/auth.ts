/**
 * `@cancore/client/auth` — ask a person for a scoped grant instead of holding
 * their login.
 *
 * This is the device flow (RFC 8628): your program asks, the API answers with a
 * short code and a page, the person opens that page in a browser where they are
 * signed in, checks the code and approves. Your program then holds a grant
 * token (`cs_…`) of its own — scoped, limited, revocable by the person — and
 * passes it through `request` like any other credential.
 *
 * Nothing is granted before a person says yes, and the token is handed over
 * exactly once. Whether the API mints the trading scopes at all is up to the
 * deployment: where it does not, `requestGrant` rejects with the API's own 400
 * naming the scope.
 */
import { CancoreApiError, createHttp, type ClientOptions } from './http';

/** The budget a trading grant carries. Immutable once issued: a different budget is a different grant. */
export interface GrantLimits {
  /** Ceiling on the USD value of one order or pool trade. */
  maxOrderUsd: number;
  /** Ceiling on the USD the grant may commit inside one rolling window. At least `maxOrderUsd`. */
  windowUsd: number;
  /** Length of that window, in whole seconds. */
  windowSeconds: number;
  /** Trading-pair ids the grant may trade. Omit, or `null`, for any pair. */
  pairIds?: string[] | null;
}

export interface RequestGrantOptions extends ClientOptions {
  /** The name the consent page shows the person. */
  appName: string;
  /** e.g. `['orders:write', 'orders:read']`. */
  scopes: readonly string[];
  /** Required with `orders:write` or `pool:trade`, refused without them. */
  limits?: GrantLimits;
  /**
   * Where the wallet is served, e.g. `https://cancore.io`. The API answers with
   * a path on that host; given this, `verificationUri` is a full URL. Not derived
   * from `baseUrl` — the API and the wallet are not always one host apart.
   */
  appUrl?: string;
}

export interface WaitOptions {
  /** Stop waiting. Rejects with the signal's `reason`; the request stays live until `expiresAt`, so `wait` can be called again. */
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

export interface PendingGrant {
  /** The code the consent page must show. Tell the person to decline if it does not match. */
  userCode: string;
  /** The consent page. A path unless `appUrl` was given. */
  verificationUri: string;
  /** After this nobody can approve the request; `wait` rejects with `GrantExpiredError`. */
  expiresAt: Date;
  /** Poll at the API's pace until the person answers. Resolves to the grant token. */
  wait(options?: WaitOptions): Promise<string>;
}

/** The person declined. */
export class GrantDeniedError extends Error {
  constructor() {
    super('the person declined the grant request');
    this.name = 'GrantDeniedError';
  }
}

/** The request is gone: it expired unanswered, or its grant was already collected. */
export class GrantExpiredError extends Error {
  constructor() {
    super('the grant request expired, or its answer was already collected');
    this.name = 'GrantExpiredError';
  }
}

interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

type PollAnswer =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'granted'; token: string }
  | { status: 'slow_down'; retryAfter?: unknown };

const SPEND_SCOPES = ['orders:write', 'pool:trade'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * The API's hard bounds on a grant's limits, as its document publishes them on
 * `GrantLimitsDto`. Checked here only so a request the API would refuse fails
 * before the round-trip; if they ever move, the API's 400 still says so.
 */
const GRANT_LIMIT_BOUNDS = {
  maxOrderUsd: 100_000,
  windowUsd: 1_000_000,
  minWindowSeconds: 60,
  maxWindowSeconds: 30 * 24 * 60 * 60,
  maxPairIds: 50,
} as const;

/** What the API would refuse with a 400, found before the round-trip; `''` when nothing is. The API stays authoritative. */
function describeInvalidRequest({ appName, scopes, limits }: RequestGrantOptions): string {
  if (!appName?.trim()) return 'appName is required: the consent page has to name who is asking';
  if (!scopes.some((scope) => SPEND_SCOPES.includes(scope))) {
    return limits == null ? '' : 'limits were given without a scope that spends: drop them, or ask for orders:write / pool:trade';
  }
  if (limits == null) return 'a grant that may trade must declare limits: maxOrderUsd, windowUsd and windowSeconds, optionally pairIds';
  const { maxOrderUsd, windowUsd, windowSeconds, pairIds } = limits;
  const b = GRANT_LIMIT_BOUNDS;
  if (!positive(maxOrderUsd) || maxOrderUsd > b.maxOrderUsd) return `limits.maxOrderUsd must be a number above 0 and at most ${b.maxOrderUsd}`;
  if (!positive(windowUsd) || windowUsd > b.windowUsd) return `limits.windowUsd must be a number above 0 and at most ${b.windowUsd}`;
  if (!Number.isInteger(windowSeconds) || windowSeconds < b.minWindowSeconds || windowSeconds > b.maxWindowSeconds) {
    return `limits.windowSeconds must be a whole number of seconds between ${b.minWindowSeconds} and ${b.maxWindowSeconds}`;
  }
  if (windowUsd < maxOrderUsd) return 'limits.windowUsd must be at least limits.maxOrderUsd, or no single order could pass';
  if (pairIds == null) return '';
  if (!Array.isArray(pairIds) || pairIds.length === 0) {
    return 'limits.pairIds must be a non-empty array of trading-pair ids, or omitted to allow any pair';
  }
  if (pairIds.length > b.maxPairIds) return `limits.pairIds may name at most ${b.maxPairIds} pairs`;
  const bad = pairIds.filter((id) => typeof id !== 'string' || !UUID.test(id));
  return bad.length > 0 ? `limits.pairIds must be trading-pair uuids, not: ${bad.join(', ')}` : '';
}

/** Start the device flow. Rejects with a `TypeError` for a request the API would refuse anyway. */
export async function requestGrant(options: RequestGrantOptions): Promise<PendingGrant> {
  const invalid = describeInvalidRequest(options);
  if (invalid) throw new TypeError(invalid);

  const { appName, scopes, limits, appUrl } = options;
  const http = createHttp(options);
  const start = await http.post<DeviceStart>('/auth/device/authorize', { appName, scopes, ...(limits ? { limits } : {}) });
  const initialIntervalMs = (start.interval > 0 ? start.interval : 5) * 1000;

  async function poll(): Promise<PollAnswer> {
    try {
      return await http.post<PollAnswer>('/auth/device/token', { deviceCode: start.deviceCode });
    } catch (err) {
      if (!(err instanceof CancoreApiError)) throw err;
      // Unknown, expired and already collected are one answer on purpose.
      if (err.status === 404) throw new GrantExpiredError();
      // The API sends no RFC 8628 `slow_down` body; a 429 is the only way it asks for one.
      if (err.status === 429) return { status: 'slow_down', retryAfter: (err.body as { retryAfter?: unknown } | undefined)?.retryAfter };
      throw err;
    }
  }

  return {
    userCode: start.userCode,
    verificationUri: appUrl && start.verificationUri.startsWith('/') ? `${appUrl.replace(/\/+$/, '')}${start.verificationUri}` : start.verificationUri,
    expiresAt: new Date(Date.now() + start.expiresIn * 1000),

    async wait({ signal, sleep } = {}) {
      let intervalMs = initialIntervalMs;
      for (;;) {
        // Checked before a poll, never raced against one: a poll that comes back
        // `granted` has already consumed the grant, and dropping it would leave a
        // live credential nobody holds.
        signal?.throwIfAborted();
        const answer = await poll();
        let delayMs = intervalMs;
        switch (answer.status) {
          case 'granted':
            return answer.token;
          case 'denied':
            throw new GrantDeniedError();
          case 'pending':
            break;
          case 'slow_down':
            // RFC 8628 §3.5: five seconds more, for the rest of this wait.
            intervalMs += 5000;
            delayMs = Math.max(intervalMs, positive(answer.retryAfter) ? answer.retryAfter * 1000 : 0);
            break;
          default:
            throw new Error(`POST /auth/device/token answered an unknown status: ${JSON.stringify(answer)}`);
        }
        await pause(delayMs, signal, sleep);
      }
    },
  };
}

/** A sleep that an abort cuts short, clearing its own timer so the process can exit. */
function pause(ms: number, signal?: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    if (sleep) sleep(ms).then(done, reject);
    else timer = setTimeout(done, ms);
  });
}
