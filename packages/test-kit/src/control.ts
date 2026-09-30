/**
 * The test's handle on the mock, on its own port: `/__mock/*`. Never part of
 * the protocol; the programmatic API (index.ts) calls the same functions.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MockGateway } from './gateway';
import { MalformedBodyError, readJson, sendJson } from './http';
import { TEST_KEYS } from './keys';
import { rfq } from './quoting';
import type { RfqOptions } from './quoting';
import { MODES, parseMode, UnknownModeError } from './scenario';
import { offerFixture } from './ticketing';

type Route = (gw: MockGateway, body: Record<string, unknown>) => [number, unknown];

export const health = (gw: MockGateway) => {
  const { acceptByMs, issueDelayMs, heartbeatMs, heartbeatMisses, minTicketTtlS, ticketTtlS, windowMs, quoteTtlMs, deltaDrand, finalityMs, clock } = gw.cfg;
  return { ok: true, now: gw.now(), mode: gw.mode, config: { acceptByMs, issueDelayMs, heartbeatMs, heartbeatMisses, minTicketTtlS, ticketTtlS, windowMs, quoteTtlMs, deltaDrand, finalityMs, clock } };
};

/** Close the live sockets of one taker (or all): the DROP_CONNECTION of a test's choosing. */
export function drop(gw: MockGateway, fillerId?: string): number {
  const conns = [...gw.conns].filter((c) => !fillerId || c.fillerId === fillerId);
  for (const c of conns) c.close(1001, 'mock: drop');
  return conns.length;
}

export const keys = () => ({
  testOnly: true,
  gateway: TEST_KEYS.gateway.address,
  ticketSigners: [TEST_KEYS.ticketSigner.address],
  foreignSigner: TEST_KEYS.foreignSigner.address,
  takers: {
    'acme-markets': { quoteKey: TEST_KEYS.acmeQuote, filler: TEST_KEYS.acmeFiller },
    'zeta-liquidity': { quoteKey: TEST_KEYS.zetaQuote, filler: TEST_KEYS.zetaFiller },
  },
});

function setScenario(gw: MockGateway, body: Record<string, unknown>): [number, unknown] {
  try {
    gw.mode = parseMode(body.mode);
    return [200, { mode: gw.mode }];
  } catch (e) {
    if (!(e instanceof UnknownModeError)) throw e;
    return [400, { error: e.message, allowed: e.allowed }];
  }
}

/** Only a JSON number (Number("15s") is NaN, Number(true) is 1); the clock refuses a non-integer or a negative one → 400. */
const msOf = (v: unknown) => (typeof v === 'number' ? v : NaN);

const ROUTES: Record<string, Route> = {
  'GET /__mock/health': (gw) => [200, health(gw)],
  'GET /__mock/scenario': (gw) => [200, { mode: gw.mode, allowed: [...MODES] }],
  'POST /__mock/scenario': setScenario,
  'POST /__mock/reset': (gw) => (gw.reset(), [200, { ok: true, now: gw.now() }]),
  'GET /__mock/clock': (gw) => [200, { now: gw.now() }],
  'POST /__mock/clock': (gw, b) => (gw.clock.advance(msOf(b.advanceMs ?? 0)), [200, { now: gw.now() }]),
  'GET /__mock/fillers': (gw) => [200, { fillers: [...gw.fillers.values()] }],
  'POST /__mock/rfq': (gw, b) => [200, rfq(gw, b as RfqOptions)],
  'POST /__mock/offer': (gw, b) => [200, offerFixture(gw, String(b.fillerId ?? 'acme-markets'))],
  'POST /__mock/drop': (gw, b) => [200, { dropped: drop(gw, typeof b.fillerId === 'string' ? b.fillerId : undefined) }],
  'GET /__mock/log': (gw) => [200, { log: gw.entries }],
  'GET /__mock/keys': () => [200, keys()],
};

export async function serveControl(gw: MockGateway, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const route = ROUTES[`${req.method} ${new URL(req.url ?? '/', 'http://mock').pathname}`];
  try {
    const body = req.method === 'POST' ? await readJson(req) : {};
    if (!route) return sendJson(res, 404, { error: `no control route ${req.method} ${req.url}`, routes: Object.keys(ROUTES) });
    const [status, out] = route(gw, body);
    sendJson(res, status, out);
  } catch (e) {
    sendJson(res, e instanceof MalformedBodyError ? e.status : e instanceof RangeError ? 400 : 500, { error: (e as Error).message });
  }
}
