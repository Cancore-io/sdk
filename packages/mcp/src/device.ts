/**
 * Device-flow authorization (RFC 8628) against the Cancore gateway.
 *
 * The shape mirrors the Go server in `Cancore-io/mcp-server` byte for byte,
 * because both write the same grant file: a person who switches runtimes must
 * not have to re-approve.
 */

/** A started authorization request: the code the agent keeps, the one the person reads. */
export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type PollStatus = 'pending' | 'granted' | 'denied';

export interface PollOutcome {
  status: PollStatus;
  /** Present only when status is 'granted'. */
  token?: string;
}

/** Scopes this server asks for: queue a request, read the queue. Never sign. */
export const AGENT_SCOPES = ['agent:propose', 'agent:read'] as const;

type Fetch = typeof globalThis.fetch;

async function postJson<T>(fetchImpl: Fetch, url: string, body: unknown): Promise<T> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${url} answered ${res.status}: ${text.slice(0, 200)}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

/**
 * Ask the backend for a pair of codes. Nothing is granted here — until a person
 * approves, the request holds a name and a scope list.
 */
export async function startAuthorization(
  fetchImpl: Fetch,
  baseUrl: string,
  appName: string,
  scopes: readonly string[] = AGENT_SCOPES,
): Promise<DeviceStart> {
  const out = await postJson<Partial<DeviceStart>>(fetchImpl, `${baseUrl}/auth/device/authorize`, {
    appName,
    scopes,
  });
  if (!out.deviceCode || !out.userCode) {
    throw new Error(`the backend started no request (is ${baseUrl} a Cancore gateway?)`);
  }
  return {
    deviceCode: out.deviceCode,
    userCode: out.userCode,
    verificationUri: out.verificationUri ?? '',
    expiresIn: out.expiresIn ?? 0,
    interval: out.interval && out.interval > 0 ? out.interval : 5,
  };
}

/**
 * Ask once whether the request has been answered.
 *
 * Expired, already collected and never existed all answer the same way on
 * purpose, so a guesser learns nothing from the difference.
 */
export async function pollGrant(
  fetchImpl: Fetch,
  baseUrl: string,
  deviceCode: string,
): Promise<PollOutcome> {
  return postJson<PollOutcome>(fetchImpl, `${baseUrl}/auth/device/token`, { deviceCode });
}

export interface AwaitOptions {
  /** How long to keep polling before handing control back. */
  budgetMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the request is answered or the budget runs out.
 *
 * A budget that runs out is NOT an error: the same request stays live and the
 * caller may resume it, which is what keeps the code already on the person's
 * screen valid instead of minting them a second one.
 */
export async function awaitGrant(
  fetchImpl: Fetch,
  baseUrl: string,
  start: DeviceStart,
  { budgetMs, sleep = defaultSleep, now = Date.now }: AwaitOptions,
): Promise<PollOutcome> {
  const deadline = now() + budgetMs;
  const intervalMs = start.interval * 1000;
  for (;;) {
    const outcome = await pollGrant(fetchImpl, baseUrl, start.deviceCode);
    if (outcome.status !== 'pending') return outcome;
    if (now() + intervalMs > deadline) return { status: 'pending' };
    await sleep(intervalMs);
  }
}
