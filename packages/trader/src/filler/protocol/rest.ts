/**
 * The REST side of filler-gateway (protocol §3.6), on the host of the
 * WebSocket URL: the login, and the fallback while the session is down.
 * Bodies are the WebSocket messages; every filler-gateway → filler message in
 * a response — the challenge, a list item, an ack, an error body — is
 * verified exactly like a WebSocket frame before it is returned.
 *
 * Login: `GET /v1/filler/auth/challenge?fillerId=` → a signed `auth.challenge`
 * addressed to this filler (any other `fillerId` is refused), then
 * `POST /v1/filler/auth` with the `auth.response` → `{token, expiresAt}`. One
 * token serves REST (`Authorization: Bearer`) and the WebSocket upgrade
 * (`bearer.<token>`); it is reused until shortly before `expiresAt`, one login
 * runs at a time for every caller, and it is renewed once when filler-gateway
 * answers 401. The token is never logged.
 *
 * Unsigned refusals: the login routes refuse unsigned as long as they have
 * checked no signature (400, 404, 401 "no live challenge", 429), and every 429
 * on every route is unsigned. Such a body is a hint only — its code and
 * `retryAfterMs` steer the retry, nothing else; every other refusal must be
 * the signed `error`. A 401 of `POST /v1/filler/auth` fails the login, and the
 * next attempt (after the backoff) starts over from a fresh challenge.
 *
 * Rate limits: a 429 pauses its rate class (`limits.ts`) for the `retryAfterMs`
 * of its body, else `Retry-After`; until then a call of that class is refused
 * locally with `RATE_LIMITED` and its `retryAfterMs`, without a request.
 */
import {
  ERROR_CODES,
  FILLER_AUTH_TYPES,
  FILLER_PROTOCOL_DOMAIN,
  PROTOCOL_VERSION,
  type AuthResponse,
  type AuthToken,
  type Hex,
  type QuoteAck,
  type QuoteFinalStatus,
  type QuoteMessage,
  type TicketDecline,
  type TicketIntentMessage,
  type TicketReceiptMessage,
} from '@cancore/contracts';
import { GatewayError } from '../errors';
import type { Clock, HttpFetch, Logger } from '../runtime';
import { signTypedDataChecked, type QuoteSigner } from '../signer';
import type { Sealer } from './envelope';
import { frameBytes, gatewayErrorOf, retryAfterOf, utf8, verifyGatewayObject, type FrameExpectations, type VerifiedFrame } from './frames';
import { DEFAULT_RETRY_AFTER_MS, parseRetryAfter, RateLimits, type RateClass } from './limits';

export interface RestOptions {
  /** `wss://host/v1` → `https://host`; `ws://` → `http://` (local stand). */
  gatewayUrl: string;
  fillerId: string;
  gatewaySigner: Hex;
  quoteSigner: QuoteSigner;
  /** Seals the `auth.response` body; ticket bodies arrive sealed. */
  seal: Sealer;
  fetch: HttpFetch;
  clock: Clock;
  logger: Logger;
  nextId: () => string;
}

/** A ticket action and the frame it posts. */
export type TicketAction =
  | { action: 'intent'; message: TicketIntentMessage }
  | { action: 'receipt'; message: TicketReceiptMessage }
  | { action: 'decline'; message: TicketDecline };

/** One item of `GET /v1/filler/quotes`: the quote as sent, its verified ack, its final status. */
export interface QuoteListItem {
  quote: QuoteMessage;
  ack: VerifiedFrame & { readonly frame: VerifiedFrame['frame'] & QuoteAck };
  /** Open enum (V-2): an unknown status is kept as received. */
  status: QuoteFinalStatus | (string & {});
}

/** Renew the token this long before filler-gateway's `expiresAt`, so a reconnect never offers an expired one. */
export const TOKEN_MARGIN_MS = 30_000;
const PAGE_LIMIT = 100;
/** A guard against a server that never ends a cursor chain. */
const MAX_PAGES = 1_000;

/** The HTTP origin of a `ws(s)://host/v1` URL. */
export function restOrigin(gatewayUrl: string): string {
  const url = new URL(gatewayUrl);
  const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  return `${protocol}//${url.host}`;
}

interface Reply {
  status: number;
  text: string;
  /** The `Retry-After` header, when the response had one. */
  retryAfter: string | null;
}

const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

export class GatewayRest {
  /** The rate-limit pauses of this filler, shared with the WebSocket side (`FillerProtocolClient`). */
  readonly limits: RateLimits;
  private readonly origin: string;
  private readonly expect: FrameExpectations;
  private token: AuthToken | undefined;
  private pendingLogin: Promise<AuthToken> | undefined;

  constructor(private readonly options: RestOptions) {
    this.origin = restOrigin(options.gatewayUrl);
    this.limits = new RateLimits(options.clock);
    this.expect = { gatewaySigner: options.gatewaySigner, fillerId: options.fillerId };
  }

  /** `GET /v1/filler/tickets?status=` — every page; items that fail verification are dropped and logged. */
  async listTickets(status?: 'OFFERED' | 'ISSUED'): Promise<VerifiedFrame[]> {
    const out: VerifiedFrame[] = [];
    await this.pages('/v1/filler/tickets', status ? { status } : {}, (item) => {
      const verified = this.verifyItem(item, 'ticket');
      if (verified) out.push(verified);
    });
    return out;
  }

  /**
   * `POST /v1/filler/tickets/{orderHash}/{attempt}/{action}`. An intent
   * returns the verified `ticket.intent.ack`; a receipt or decline returns
   * nothing (`{}`).
   */
  async postTicket(request: TicketAction): Promise<VerifiedFrame | undefined> {
    const { orderHash, attempt } = request.message;
    const path = `/v1/filler/tickets/${encodeURIComponent(orderHash)}/${attempt}/${request.action}`;
    const { text } = await this.authed('POST', path, 'ticket', JSON.stringify(request.message));
    if (request.action !== 'intent') return undefined;
    const check = verifyGatewayObject(parseJson(text, path), utf8(text), this.expect);
    if (!check.ok || check.verified.frame.type !== 'ticket.intent.ack') {
      throw new GatewayError('UNVERIFIED_RESPONSE', false, `${path}: the ack failed verification (${check.ok ? check.verified.frame.type : check.reason})`);
    }
    return check.verified;
  }

  /** `GET /v1/filler/quotes?since=` — every page; an item whose ack fails verification is dropped and logged. */
  async listQuotes(sinceMs: number): Promise<QuoteListItem[]> {
    const out: QuoteListItem[] = [];
    await this.pages('/v1/filler/quotes', { since: String(Math.max(0, Math.floor(sinceMs))) }, (item) => {
      if (!isObject(item) || !isObject(item.quote)) return;
      const ack = this.verifyItem(item.ack, 'quote ack');
      if (!ack || ack.frame.type !== 'quote.ack') return;
      out.push({ quote: item.quote as unknown as QuoteMessage, ack: ack as QuoteListItem['ack'], status: String(item.status) });
    });
    return out;
  }

  /**
   * A token valid for at least `TOKEN_MARGIN_MS` more: the held one, or a
   * fresh login. Concurrent callers — the session and every REST call — share
   * one login. Rejects with the login's `GatewayError` (`RATE_LIMITED` with
   * `retryAfterMs` while the login class is paused).
   */
  validToken(): Promise<AuthToken> {
    const now = this.options.clock.now();
    if (this.token && this.token.expiresAt - TOKEN_MARGIN_MS > now) return Promise.resolve(this.token);
    if (!this.pendingLogin) {
      const pending: Promise<AuthToken> = this.login().finally(() => {
        if (this.pendingLogin === pending) this.pendingLogin = undefined;
      });
      this.pendingLogin = pending;
    }
    return this.pendingLogin;
  }

  /** Stops sharing a login that is taking too long: the next `validToken()` starts a new one. */
  abandonLogin(): void {
    this.pendingLogin = undefined;
  }

  /** Forgets `token` when it is the one held (every token when omitted); the next call logs in again. */
  dropToken(token?: string): void {
    if (token === undefined || this.token?.token === token) this.token = undefined;
  }

  // -------------------------------------------------------------------------

  private verifyItem(item: unknown, what: string): VerifiedFrame | undefined {
    const check = verifyGatewayObject(item, frameBytes(item), this.expect);
    if (check.ok) return check.verified;
    this.options.logger.warn(`filler-gateway REST: ${what} dropped`, { reason: check.reason, type: check.type });
    return undefined;
  }

  private async pages(path: string, query: Record<string, string>, each: (item: unknown) => void): Promise<void> {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ ...query, limit: String(PAGE_LIMIT), ...(cursor ? { cursor } : {}) });
      const { text } = await this.authed('GET', `${path}?${params.toString()}`, 'read');
      const body = parseJson(text, path);
      if (!isObject(body) || !Array.isArray(body.items)) throw new GatewayError('BAD_RESPONSE', false, `${path}: expected {items, nextCursor}`);
      body.items.forEach(each);
      cursor = typeof body.nextCursor === 'string' && body.nextCursor.length > 0 ? body.nextCursor : null;
      if (!cursor) return;
    }
    throw new GatewayError('BAD_RESPONSE', false, `${path}: more than ${MAX_PAGES} pages`);
  }

  /**
   * A bearer call of `rateClass`; refused locally while that class is paused.
   * On 401 the token is renewed once and the call repeated.
   */
  private async authed(method: 'GET' | 'POST', path: string, rateClass: RateClass, body?: string): Promise<Reply> {
    for (let round = 0; ; round++) {
      this.limits.check(rateClass, `${method} ${path}`);
      const token = await this.validToken();
      const response = await this.call(method, path, body, token.token);
      if (response.status === 401 && round === 0) {
        this.dropToken(token.token);
        continue;
      }
      return this.ok(response, path, rateClass);
    }
  }

  private async login(): Promise<AuthToken> {
    const challengePath = '/v1/filler/auth/challenge';
    this.limits.check('login', `GET ${challengePath}`);
    const query = new URLSearchParams({ fillerId: this.options.fillerId }).toString();
    const { text } = this.ok(await this.call('GET', `${challengePath}?${query}`), challengePath, 'login', true);
    // The signature, and the fillerId: a challenge addressed to anyone else (or to no one) is refused.
    const check = verifyGatewayObject(parseJson(text, challengePath), utf8(text), this.expect);
    if (!check.ok || check.verified.frame.type !== 'auth.challenge') {
      throw new GatewayError('UNVERIFIED_RESPONSE', false, `${challengePath}: the challenge failed verification (${check.ok ? check.verified.frame.type : check.reason})`);
    }
    const { nonce, expiresAt } = check.verified.frame;
    if (typeof nonce !== 'string' || typeof expiresAt !== 'string' || !/^(0|[1-9][0-9]*)$/.test(expiresAt)) {
      throw new GatewayError('BAD_RESPONSE', false, `${challengePath}: malformed auth.challenge`);
    }
    if (Number(expiresAt) * 1000 <= this.options.clock.now()) throw new GatewayError('BAD_RESPONSE', false, `${challengePath}: the challenge has already expired`);
    const sig = await signTypedDataChecked(this.options.quoteSigner, {
      domain: FILLER_PROTOCOL_DOMAIN,
      types: FILLER_AUTH_TYPES,
      primaryType: 'FillerAuth',
      message: { fillerId: this.options.fillerId, nonce, expiresAt },
    });
    // `nonce` names the challenge being answered, so filler-gateway finds it without trying every live one.
    const response = await this.options.seal<AuthResponse>({
      type: 'auth.response',
      id: this.options.nextId(),
      keyAddress: this.options.quoteSigner.address.toLowerCase() as Hex,
      protocolVersion: PROTOCOL_VERSION,
      nonce: nonce.toLowerCase() as Hex,
      sig,
    });
    const authPath = '/v1/filler/auth';
    const reply = this.ok(await this.call('POST', authPath, JSON.stringify(response)), authPath, 'login', true);
    const token = parseJson(reply.text, authPath);
    if (!isObject(token) || typeof token.token !== 'string' || token.token.length === 0 || typeof token.expiresAt !== 'number' || !Number.isSafeInteger(token.expiresAt)) {
      throw new GatewayError('BAD_RESPONSE', false, `${authPath}: expected {token, expiresAt}`);
    }
    this.token = { token: token.token, expiresAt: token.expiresAt };
    return this.token;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: string, token?: string): Promise<Reply> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const response = await this.options.fetch(`${this.origin}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    return { status: response.status, text: await response.text(), retryAfter: response.headers?.get('retry-after') ?? null };
  }

  /**
   * A 2xx passes; anything else becomes the typed error of its body (verified),
   * or a generic one. An unsigned refusal body is taken — as a hint, never
   * verified — on a 429 (always unsigned) and, with `unsigned`, on the login
   * routes. A 429 is `RATE_LIMITED` whatever its body, and pauses `rateClass`
   * for its `retryAfterMs` (the body's, else `Retry-After`, else
   * `DEFAULT_RETRY_AFTER_MS`).
   */
  private ok(response: Reply, path: string, rateClass: RateClass, unsigned = false): Reply {
    if (response.status >= 200 && response.status < 300) return response;
    let body: unknown;
    try {
      body = JSON.parse(response.text);
    } catch {
      body = undefined;
    }
    const limited = response.status === 429;
    const fallbackMs = parseRetryAfter(response.retryAfter, this.options.clock.now()) ?? (limited ? DEFAULT_RETRY_AFTER_MS : undefined);
    const check = body === undefined ? undefined : verifyGatewayObject(body, utf8(response.text), this.expect);
    let error: GatewayError;
    if (check?.ok && check.verified.frame.type === 'error') {
      error = gatewayErrorOf(check.verified.frame, response.status, fallbackMs);
    } else if ((unsigned || limited) && isObject(body) && body.type === 'error' && typeof body.code === 'string' && body.code.length > 0) {
      const message = typeof body.message === 'string' ? body.message : '';
      const code = limited ? 'RATE_LIMITED' : body.code;
      error = new GatewayError(code, KNOWN_CODES.has(code), `${path}: HTTP ${response.status}, unsigned: ${message}`, undefined, response.status, retryAfterOf(body.retryAfterMs) ?? fallbackMs);
    } else if (limited) {
      error = new GatewayError('RATE_LIMITED', true, `${path}: HTTP 429`, undefined, response.status, fallbackMs);
    } else {
      error = new GatewayError('UNVERIFIED_RESPONSE', false, `${path}: HTTP ${response.status} without a verified error body`, undefined, response.status);
    }
    if ((limited || error.code === 'RATE_LIMITED') && error.retryAfterMs !== undefined) {
      this.limits.pause(rateClass, error.retryAfterMs);
      this.options.logger.warn('filler-gateway REST: rate limited, holding the class back', { path, rateClass, retryAfterMs: error.retryAfterMs });
    }
    throw error;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError('BAD_RESPONSE', false, `${path}: the body is not JSON`);
  }
}
