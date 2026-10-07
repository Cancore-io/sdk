/**
 * The REST fallback of filler-gateway (protocol §3.6), on the host of the
 * WebSocket URL. Bodies are the WebSocket messages; every filler-gateway →
 * filler message in a response — a list item, an ack, an error body — is
 * verified exactly like a WebSocket frame before it is returned.
 *
 * Login: `GET /v1/filler/auth/challenge` (a signed `auth.challenge`), then
 * `POST /v1/filler/auth` with the `auth.response` → `{token, expiresAt}`. The
 * bearer token is reused until shortly before `expiresAt`, and renewed once
 * when filler-gateway answers 401.
 */
import {
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
import { frameBytes, gatewayErrorOf, utf8, verifyGatewayObject, type FrameExpectations, type VerifiedFrame } from './frames';

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

/** Renew the token this long before filler-gateway's `expiresAt`. */
const TOKEN_MARGIN_MS = 30_000;
const PAGE_LIMIT = 100;
/** A guard against a server that never ends a cursor chain. */
const MAX_PAGES = 1_000;

/** The HTTP origin of a `ws(s)://host/v1` URL. */
export function restOrigin(gatewayUrl: string): string {
  const url = new URL(gatewayUrl);
  const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  return `${protocol}//${url.host}`;
}

export class GatewayRest {
  private readonly origin: string;
  private readonly expect: FrameExpectations;
  private token: AuthToken | undefined;
  private pendingLogin: Promise<AuthToken> | undefined;

  constructor(private readonly options: RestOptions) {
    this.origin = restOrigin(options.gatewayUrl);
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
    const { text } = await this.authed('POST', path, JSON.stringify(request.message));
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

  /** Forgets the token; the next call logs in again. */
  reset(): void {
    this.token = undefined;
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
      const { text } = await this.authed('GET', `${path}?${params.toString()}`);
      const body = parseJson(text, path);
      if (!isObject(body) || !Array.isArray(body.items)) throw new GatewayError('BAD_RESPONSE', false, `${path}: expected {items, nextCursor}`);
      body.items.forEach(each);
      cursor = typeof body.nextCursor === 'string' && body.nextCursor.length > 0 ? body.nextCursor : null;
      if (!cursor) return;
    }
    throw new GatewayError('BAD_RESPONSE', false, `${path}: more than ${MAX_PAGES} pages`);
  }

  /** A bearer call; on 401 the token is renewed once and the call repeated. */
  private async authed(method: 'GET' | 'POST', path: string, body?: string): Promise<{ status: number; text: string }> {
    for (let round = 0; ; round++) {
      const token = await this.bearer();
      const response = await this.call(method, path, body, token.token);
      if (response.status === 401 && round === 0) {
        if (this.token === token) this.token = undefined;
        continue;
      }
      return this.ok(response, path);
    }
  }

  private async bearer(): Promise<AuthToken> {
    const now = this.options.clock.now();
    if (this.token && this.token.expiresAt - TOKEN_MARGIN_MS > now) return this.token;
    // One login at a time; concurrent callers share it.
    this.pendingLogin ??= this.login().finally(() => (this.pendingLogin = undefined));
    return this.pendingLogin;
  }

  private async login(): Promise<AuthToken> {
    const challengePath = '/v1/filler/auth/challenge';
    const { text } = this.ok(await this.call('GET', challengePath), challengePath);
    const check = verifyGatewayObject(parseJson(text, challengePath), utf8(text), this.expect);
    if (!check.ok || check.verified.frame.type !== 'auth.challenge') {
      throw new GatewayError('UNVERIFIED_RESPONSE', false, `${challengePath}: the challenge failed verification (${check.ok ? check.verified.frame.type : check.reason})`);
    }
    const { nonce, expiresAt } = check.verified.frame;
    if (typeof nonce !== 'string' || typeof expiresAt !== 'string') throw new GatewayError('BAD_RESPONSE', false, `${challengePath}: malformed auth.challenge`);
    const sig = await signTypedDataChecked(this.options.quoteSigner, {
      domain: FILLER_PROTOCOL_DOMAIN,
      types: FILLER_AUTH_TYPES,
      primaryType: 'FillerAuth',
      message: { fillerId: this.options.fillerId, nonce, expiresAt },
    });
    // `nonce` names the challenge being answered, so filler-gateway finds it
    // without trying every live one (optional field, @cancore/contracts 0.2.0-rc.6).
    const response = await this.options.seal<AuthResponse>({
      type: 'auth.response',
      id: this.options.nextId(),
      keyAddress: this.options.quoteSigner.address.toLowerCase() as Hex,
      protocolVersion: PROTOCOL_VERSION,
      nonce: nonce.toLowerCase() as Hex,
      sig,
    });
    const authPath = '/v1/filler/auth';
    const reply = this.ok(await this.call('POST', authPath, JSON.stringify(response)), authPath);
    const token = parseJson(reply.text, authPath);
    if (!isObject(token) || typeof token.token !== 'string' || typeof token.expiresAt !== 'number') {
      throw new GatewayError('BAD_RESPONSE', false, `${authPath}: expected {token, expiresAt}`);
    }
    this.token = { token: token.token, expiresAt: token.expiresAt };
    return this.token;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: string, token?: string): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const response = await this.options.fetch(`${this.origin}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    return { status: response.status, text: await response.text() };
  }

  /** A 2xx passes; anything else becomes the typed error of its body (verified), or a generic one. */
  private ok(response: { status: number; text: string }, path: string): { status: number; text: string } {
    if (response.status >= 200 && response.status < 300) return response;
    let body: unknown;
    try {
      body = JSON.parse(response.text);
    } catch {
      body = undefined;
    }
    const check = body === undefined ? undefined : verifyGatewayObject(body, utf8(response.text), this.expect);
    if (check?.ok && check.verified.frame.type === 'error') throw gatewayErrorOf(check.verified.frame, response.status);
    throw new GatewayError('UNVERIFIED_RESPONSE', false, `${path}: HTTP ${response.status} without a verified error body`, undefined, response.status);
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
