/**
 * The REST fallback (protocol §3.6, D-J) on the same port as `/v1`: bearer
 * login by challenge, the ticket list, intent/receipt/decline by path, the
 * quote list, and the public draw/epoch records and gateway identity. Every
 * error body is the signed `error` frame with the status of its code.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ERROR_HTTP_STATUS } from '@cancore/contracts';
import type { ErrorCode } from '@cancore/contracts';
import { errorBody } from './gateway';
import type { MockGateway } from './gateway';
import { MalformedBodyError, readJson, sendJson } from './http';
import type { Hex } from './keys';
import { fail } from './quotes';
import type { Failure } from './quotes';
import { checkAuth, restChallenge } from './session';
import { HANDLERS } from './wire';
import { validateMessage } from './validate';

const TOKEN_TTL_MS = 3_600_000;
const TICKET_ACTION = /^\/v1\/filler\/tickets\/(0x[0-9a-fA-F]{64})\/(\d+)\/(intent|receipt|decline)$/;
const ACTION_TYPE: Record<string, string> = { intent: 'ticket.intent', receipt: 'ticket.receipt', decline: 'ticket.decline' };

interface Ctx {
  gw: MockGateway;
  res: ServerResponse;
  url: URL;
  fillerId?: string;
}

function error(c: Ctx, f: Failure, re?: unknown, status = ERROR_HTTP_STATUS[f.code as ErrorCode] ?? 400) {
  sendJson(c.res, status, c.gw.emit({ fillerId: c.fillerId, via: 'rest' }, errorBody(f, re)));
}

export async function serveRest(gw: MockGateway, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const c: Ctx = { gw, res, url: new URL(req.url ?? '/', 'http://mock') };
  try {
    await route(c, req.method ?? 'GET', req);
  } catch (e) {
    if (e instanceof MalformedBodyError) return error(c, fail('BAD_REQUEST', `/ ${e.message}`));
    error(c, fail('INTERNAL', (e as Error).message));
  }
}

async function route(c: Ctx, method: string, req: IncomingMessage): Promise<void> {
  const path = c.url.pathname;
  const key = `${method} ${path}`;
  if (key === 'GET /v1/gateway') return sendJson(c.res, 200, c.gw.info());
  if (key === 'GET /v1/filler/auth/challenge') return sendJson(c.res, 200, restChallenge(c.gw));
  if (key === 'POST /v1/filler/auth') return login(c, await readJson(req));
  if (method === 'GET' && path.startsWith('/v1/draws/')) return draws(c, path.slice('/v1/draws/'.length));
  if (!path.startsWith('/v1/filler/')) return error(c, fail('BAD_REQUEST', `no route ${key}`), undefined, 404);
  c.fillerId = bearer(c.gw, req.headers.authorization);
  if (!c.fillerId) return error(c, fail('UNAUTHENTICATED', 'Authorization: Bearer <token from POST /v1/filler/auth> required'));
  if (key === 'GET /v1/filler/tickets') return tickets(c);
  if (key === 'GET /v1/filler/quotes') return quotes(c);
  const action = method === 'POST' ? TICKET_ACTION.exec(path) : null;
  if (action) return ticketAction(c, action, await readJson(req));
  error(c, fail('BAD_REQUEST', `no route ${key}`), undefined, 404);
}

function bearer(gw: MockGateway, header: string | undefined): string | undefined {
  const token = /^Bearer (\S+)$/.exec(header ?? '')?.[1];
  const t = token ? gw.tokens.get(token) : undefined;
  return t && t.expiresAt >= gw.now() ? t.fillerId : undefined;
}

/** The auth.response carries no nonce: it is checked against every live REST challenge. */
function login(c: Ctx, body: Record<string, unknown>): void {
  const gw = c.gw;
  gw.record('F2S', 'rest', undefined, body);
  const invalid = validateMessage({ ...body, type: 'auth.response' });
  if (invalid) return error(c, fail('BAD_REQUEST', invalid), body.id);
  let last: Failure = fail('UNAUTHENTICATED', 'no live challenge: GET /v1/filler/auth/challenge first');
  for (const [nonce, expiresAt] of gw.restChallenges) {
    const r = checkAuth(gw, body, { nonce: nonce as Hex, expiresAt: String(expiresAt) });
    if (!r.ok) {
      last = r;
      continue;
    }
    gw.restChallenges.delete(nonce);
    const token = randomBytes(24).toString('hex');
    const expires = gw.now() + TOKEN_TTL_MS;
    gw.tokens.set(token, { fillerId: r.fillerId, expiresAt: expires });
    return sendJson(c.res, 200, { token, expiresAt: expires });
  }
  error(c, last, body.id);
}

function tickets(c: Ctx): void {
  const status = c.url.searchParams.get('status');
  const statuses: ('OFFERED' | 'ISSUED')[] = status === 'OFFERED' || status === 'ISSUED' ? [status] : ['OFFERED', 'ISSUED'];
  const items = statuses.flatMap((s) =>
    c.gw.tickets.list(c.fillerId!, s).map((t) => (s === 'OFFERED' ? c.gw.offers.get(`${t.offer.orderHash}/${t.offer.attempt}`) : t.issued)),
  );
  sendJson(c.res, 200, { items, nextCursor: null });
}

function quotes(c: Ctx): void {
  const since = Number(c.url.searchParams.get('since') ?? 0);
  const items = c.gw.quotes.list(c.fillerId!, since).map((q) => ({ ...c.gw.quoteEvidence.get(q.quoteHash), status: q.status }));
  sendJson(c.res, 200, { items, nextCursor: null });
}

function ticketAction(c: Ctx, [, orderHash, attempt, action]: RegExpExecArray, body: Record<string, unknown>): void {
  const msg: Record<string, unknown> & { type: string } = { ...body, type: ACTION_TYPE[action!]! };
  c.gw.record('F2S', 'rest', c.fillerId, msg);
  const invalid = validateMessage(msg);
  if (invalid) return error(c, fail('BAD_REQUEST', invalid), body.id);
  if (String(msg.orderHash).toLowerCase() !== orderHash!.toLowerCase() || msg.attempt !== Number(attempt)) return error(c, fail('BAD_REQUEST', 'orderHash/attempt: the body differs from the path'), body.id);
  const outcome = HANDLERS[msg.type]!(c.gw, c.fillerId!, msg);
  if (!outcome.ok) return error(c, outcome, body.id);
  const re = typeof body.id === 'string' ? { re: body.id } : {};
  sendJson(c.res, 200, outcome.reply ? c.gw.emit({ fillerId: c.fillerId, via: 'rest' }, { ...outcome.reply, ...re }) : {});
}

function draws(c: Ctx, rest: string): void {
  const epoch = /^epochs\/([^/]+)$/.exec(rest);
  if (epoch) {
    if (epoch[1] !== c.gw.epoch.epochId) return error(c, fail('BAD_REQUEST', `no epoch ${epoch[1]}`), undefined, 404);
    return sendJson(c.res, 200, c.gw.signRecord({ ...c.gw.epoch }));
  }
  const record = c.gw.draws.get(rest.toLowerCase());
  if (!record) return error(c, fail('BAD_REQUEST', `no draw for ${rest}`), undefined, 404);
  sendJson(c.res, 200, c.gw.signRecord({ ...record }));
}
