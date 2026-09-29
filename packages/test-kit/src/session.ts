/**
 * Login and liveness (protocol §3.5 Session): `auth.challenge` first, then
 * `FillerAuth{fillerId, nonce, expiresAt}` by a registered quote key, then
 * `auth.ok` and `epoch.weights`; heartbeat pings from the gateway, the socket
 * closed after `heartbeatMisses` unanswered ones.
 */
import { randomBytes } from 'node:crypto';
import { errorBody } from './gateway';
import type { Conn, MockGateway, Signed } from './gateway';
import { BadSignatureError, recover } from './keys';
import type { Hex } from './keys';
import { fillerAuthDigest } from './protocol';
import { fail } from './quotes';
import type { Failure } from './quotes';

const newChallenge = (gw: MockGateway) => ({ nonce: `0x${randomBytes(32).toString('hex')}` as Hex, expiresAt: String(gw.nowS() + gw.cfg.challengeTtlS) });

export function openSession(gw: MockGateway, conn: Conn): void {
  conn.challenge = newChallenge(gw);
  gw.emit({ conn }, { type: 'auth.challenge', ...conn.challenge });
}

/** `GET /v1/filler/auth/challenge`: the same challenge, remembered until it expires. */
export function restChallenge(gw: MockGateway): Signed {
  const c = newChallenge(gw);
  gw.restChallenges.set(c.nonce, Number(c.expiresAt));
  return gw.emit({ via: 'rest' }, { type: 'auth.challenge', ...c });
}

/** The fillerId the response authenticates, or why not. */
export function checkAuth(gw: MockGateway, msg: Record<string, unknown>, challenge: { nonce: Hex; expiresAt: string } | undefined): Failure | { ok: true; fillerId: string } {
  if (gw.mode === 'UNSUPPORTED_VERSION' || msg.protocolVersion !== '1') return fail('UNSUPPORTED_VERSION', `protocolVersion ${JSON.stringify(msg.protocolVersion)} is not served; this gateway speaks "1"`);
  if (!challenge || gw.now() > Number(challenge.expiresAt) * 1000) return fail('UNAUTHENTICATED', 'no live challenge: it expired or was never issued');
  const filler = gw.fillers.get(String(msg.fillerId));
  if (!filler || filler.quoteKey !== msg.keyAddress) return fail('UNAUTHENTICATED', `no quote key ${String(msg.keyAddress)} registered for ${String(msg.fillerId)}`);
  const digest = fillerAuthDigest({ fillerId: filler.fillerId, nonce: challenge.nonce, expiresAt: challenge.expiresAt });
  if (signer(digest, msg.sig) !== filler.quoteKey) return fail('BAD_SIGNATURE', 'FillerAuth does not recover to keyAddress');
  return { ok: true, fillerId: filler.fillerId };
}

/** Who signed `digest`, or null for a malformed / high-s / bad-v signature. */
export function signer(digest: Hex, sig: unknown): Hex | null {
  try {
    return recover(digest, sig as Hex);
  } catch (e) {
    if (e instanceof BadSignatureError) return null;
    throw e;
  }
}

export function onAuthResponse(gw: MockGateway, conn: Conn, msg: Record<string, unknown>): void {
  const result = checkAuth(gw, msg, conn.challenge);
  if (!result.ok) {
    gw.emit({ conn }, errorBody(result, msg.id));
    return conn.close(1008, result.code);
  }
  conn.fillerId = result.fillerId;
  conn.challenge = undefined;
  gw.live.set(result.fillerId, conn);
  const to = { conn, fillerId: result.fillerId };
  gw.emit(to, { type: 'auth.ok', heartbeatIntervalMs: gw.cfg.heartbeatMs, ...(typeof msg.id === 'string' ? { re: msg.id } : {}) });
  const { epochId, startsAt, endsAt, weightsRoot } = gw.epoch;
  gw.emit(to, { type: 'epoch.weights', epochId, startsAt, endsAt, weightsRoot });
  conn.heartbeat = { missed: 0 };
  gw.clock.schedule(gw.now() + gw.cfg.heartbeatMs, () => beat(gw, conn));
}

/**
 * A ping counts as missed only if the taker had a chance to answer it: one
 * `advance` of the virtual clock is instantaneous for the taker, so pings sent
 * inside the same jump are not held against it.
 */
function beat(gw: MockGateway, conn: Conn): void {
  const hb = conn.heartbeat;
  if (conn.closed || !hb) return;
  if (hb.outstanding && hb.sentIn !== gw.clock.generation) hb.missed++;
  if (hb.missed >= gw.cfg.heartbeatMisses) return conn.close(4000, `${hb.missed} heartbeats missed`);
  hb.outstanding = gw.nextId('ping');
  hb.sentIn = gw.clock.generation;
  gw.emit({ conn, fillerId: conn.fillerId }, { type: 'ping', id: hb.outstanding });
  gw.clock.schedule(gw.now() + gw.cfg.heartbeatMs, () => beat(gw, conn));
}

/** Any pong to one of our pings proves the taker alive, a late one included. */
export function onPong(conn: Conn, msg: Record<string, unknown>): void {
  if (conn.heartbeat && typeof msg.re === 'string' && msg.re.startsWith('ping-')) conn.heartbeat = { missed: 0 };
}
