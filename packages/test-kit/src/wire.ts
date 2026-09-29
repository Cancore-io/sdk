/**
 * One WebSocket frame from a taker: parse, gate on authentication (nothing
 * but `auth.response` before `auth.ok` — B8), validate against the protocol
 * schema, dispatch, answer with `re`.
 */
import { errorBody } from './gateway';
import type { Conn, MockGateway } from './gateway';
import { onQuote } from './quoting';
import { fail } from './quotes';
import type { Failure } from './quotes';
import { onAuthResponse, onPong } from './session';
import { onDecline, onFill, onIntent, onReceipt } from './ticketing';
import type { Outcome } from './ticketing';
import { directionOf, validateMessage } from './validate';

type Handler = (gw: MockGateway, fillerId: string, msg: Record<string, unknown>) => Outcome;

export const HANDLERS: Readonly<Record<string, Handler>> = {
  quote: onQuote,
  'ticket.intent': onIntent,
  'ticket.receipt': onReceipt,
  'ticket.decline': onDecline,
  'fill.reported': onFill,
  'quote.reconfirm.reply': () => fail('UNKNOWN_REQUEST', 'this mock sends no quote.reconfirm'),
};

function parse(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { type?: unknown }).type === 'string' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function answer(gw: MockGateway, conn: Conn, f: Failure, re?: unknown) {
  gw.emit({ conn, fillerId: conn.fillerId }, errorBody(f, re));
}

export function onFrame(gw: MockGateway, conn: Conn, text: string): void {
  const msg = parse(text);
  gw.record('F2S', 'ws', conn.fillerId, msg ?? { raw: text });
  if (!msg) return answer(gw, conn, fail('BAD_REQUEST', '/ one JSON object with a string "type" per frame'));
  if (conn.fillerId) return authenticated(gw, conn, conn.fillerId, msg);
  if (msg.type !== 'auth.response') {
    answer(gw, conn, fail('UNAUTHENTICATED', 'authenticate first: nothing but auth.response before auth.ok'), msg.id);
    return conn.close(1008, 'UNAUTHENTICATED');
  }
  const invalid = validateMessage(msg);
  if (!invalid) return onAuthResponse(gw, conn, msg);
  answer(gw, conn, fail('BAD_REQUEST', invalid), msg.id);
  conn.close(1008, 'BAD_REQUEST');
}

function authenticated(gw: MockGateway, conn: Conn, fillerId: string, msg: Record<string, unknown>): void {
  const type = String(msg.type);
  if (type === 'pong') return onPong(conn, msg);
  const direction = directionOf(type);
  if (!direction || direction === 'S2F') return answer(gw, conn, fail('UNSUPPORTED_TYPE', `no F→S frame "${type}" in protocol v1`), msg.id);
  const invalid = validateMessage(msg);
  if (invalid) return answer(gw, conn, fail('BAD_REQUEST', invalid), msg.id);
  if (type === 'ping') return void gw.emit({ conn, fillerId }, { type: 'pong', re: msg.id });
  const handler = HANDLERS[type];
  if (!handler) return answer(gw, conn, fail('BAD_REQUEST', `type: ${type} is not accepted after auth.ok`), msg.id);
  const outcome = handler(gw, fillerId, msg);
  if (!outcome.ok) return answer(gw, conn, outcome, msg.id);
  if (outcome.reply) gw.emit({ conn, fillerId }, { ...outcome.reply, ...(typeof msg.id === 'string' ? { re: msg.id } : {}) });
}
