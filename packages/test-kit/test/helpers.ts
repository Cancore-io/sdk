import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { startMockGateway } from '../src/index';
import { TEST_KEYS, sign } from '../src/keys';
import type { Hex } from '../src/keys';
import { fillerAuthDigest, fillerQuoteDigest, fillTicketDigest, gatewaySigner, sigHash, ticketIntentDigest, ticketReceiptDigest } from '../src/protocol';

export type Frame = Record<string, unknown> & { type: string };
export type Kind = 'cli' | 'in-process';
export const KINDS: [Kind][] = [['cli'], ['in-process']];

export interface MockHandle {
  url: string;
  http: string;
  control: string;
  readyMs: number;
  close(): Promise<void>;
}

export const BIN = resolve(__dirname, '..', 'dist', 'bin.js');

/** The CLI as a stranger runs it: a child process, ephemeral ports, one JSON ready line on stdout. */
export async function spawnMock(extra: string[] = []): Promise<MockHandle> {
  const started = Date.now();
  const child = spawn(process.execPath, [BIN, 'mock-gateway', '--port', '0', '--control', '0', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const line = await new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`mock not ready in 5 s; stderr: ${stderr}`)), 5_000);
    createInterface({ input: child.stdout }).once('line', (l) => {
      clearTimeout(timer);
      ok(l);
    });
    child.once('exit', (code) => fail(new Error(`mock exited ${code}; stderr: ${stderr}`)));
  });
  const ready = JSON.parse(line) as { event: string; url: string; http: string; control: string };
  if (ready.event !== 'ready') throw new Error(`unexpected first line: ${line}`);
  return {
    ...ready,
    readyMs: Date.now() - started,
    close: () =>
      new Promise<void>((ok) => {
        child.once('exit', () => ok());
        child.kill('SIGTERM');
      }),
  };
}

export async function inProcessMock(): Promise<MockHandle> {
  const started = Date.now();
  const gw = await startMockGateway({ port: 0, controlPort: 0 });
  return { url: gw.url, http: gw.httpUrl, control: gw.controlUrl, readyMs: Date.now() - started, close: () => gw.close() };
}

export const startMock = (kind: Kind) => (kind === 'cli' ? spawnMock() : inProcessMock());

export interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T>(url: string, method: string, body?: unknown, token?: string): Promise<Reply<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

export const ctl = <T = Record<string, unknown>>(m: MockHandle, path: string, body?: unknown) => call<T>(`${m.control}${path}`, body === undefined ? 'GET' : 'POST', body);
export const rest = <T = Record<string, unknown>>(m: MockHandle, method: string, path: string, body?: unknown, token?: string) => call<T>(`${m.http}${path}`, method, body, token);

export const advance = (m: MockHandle, advanceMs: number) => ctl<{ now: number }>(m, '/__mock/clock', { advanceMs });
export const now = async (m: MockHandle) => (await ctl<{ now: number }>(m, '/__mock/clock')).body.now;
/** Move the mock's clock to `at` (ms). */
export const advanceTo = async (m: MockHandle, at: number) => advance(m, at - (await now(m)));

export const FILLERS = {
  'acme-markets': { quote: TEST_KEYS.acmeQuote, filler: TEST_KEYS.acmeFiller },
  'zeta-liquidity': { quote: TEST_KEYS.zetaQuote, filler: TEST_KEYS.zetaFiller },
} as const;
export type FillerId = keyof typeof FILLERS;

let ids = 0;
export const nextId = () => `c-${++ids}`;

/**
 * A WebSocket client that records every frame and hands them out by type, in
 * arrival order. It answers the gateway's heartbeat pings like any live taker
 * (`autoPong = false` to play a dead one).
 */
export class Taker {
  readonly frames: Frame[] = [];
  autoPong = true;
  private readonly taken = new Set<number>();
  private waiters: (() => void)[] = [];
  readonly closed: Promise<number>;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Frame;
      this.frames.push(frame);
      if (frame.type === 'ping' && this.autoPong) this.send({ type: 'pong', re: frame.id });
      for (const w of this.waiters.splice(0)) w();
    });
    this.closed = new Promise((ok) => ws.once('close', (code: number) => ok(code)));
  }

  static open(url: string): Promise<Taker> {
    const ws = new WebSocket(url);
    const t = new Taker(ws);
    return new Promise((ok, fail) => {
      ws.once('open', () => ok(t));
      ws.once('error', fail);
    });
  }

  /** The next frame of `type` (matching `pred`) not handed out yet. */
  next(type: string, pred: (f: Frame) => boolean = () => true, timeoutMs = 3_000): Promise<Frame> {
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`no ${type} within ${timeoutMs} ms; got: ${this.frames.map((f) => f.type).join(', ')}`)), timeoutMs);
      const look = () => {
        const i = this.frames.findIndex((f, n) => !this.taken.has(n) && f.type === type && pred(f));
        if (i < 0) return void this.waiters.push(look);
        this.taken.add(i);
        clearTimeout(timer);
        ok(this.frames[i]!);
      };
      look();
    });
  }

  send(msg: Record<string, unknown>): Record<string, unknown> {
    const framed = { id: nextId(), ...msg };
    this.ws.send(JSON.stringify(framed));
    return framed;
  }

  close() {
    this.ws.close();
    return this.closed;
  }
}

export function authResponse(challenge: Frame, fillerId: FillerId, overrides: Record<string, unknown> = {}) {
  const key = FILLERS[fillerId].quote;
  const digest = fillerAuthDigest({ fillerId, nonce: challenge.nonce as Hex, expiresAt: String(challenge.expiresAt) });
  return { type: 'auth.response', fillerId, keyAddress: key.address, protocolVersion: '1', sig: sign(digest, key.privateKey), ...overrides };
}

/** Open, answer the challenge, wait for auth.ok and epoch.weights. */
export async function login(m: MockHandle, fillerId: FillerId = 'acme-markets') {
  const taker = await Taker.open(`${m.url}`);
  const challenge = await taker.next('auth.challenge');
  taker.send(authResponse(challenge, fillerId));
  const ok = await taker.next('auth.ok');
  const epoch = await taker.next('epoch.weights');
  return { taker, challenge, ok, epoch };
}

/** REST login: challenge → FillerAuth → bearer token. */
export async function restLogin(m: MockHandle, fillerId: FillerId = 'acme-markets') {
  const challenge = (await rest<Frame>(m, 'GET', '/v1/filler/auth/challenge')).body;
  const res = await rest<{ token: string; expiresAt: number }>(m, 'POST', '/v1/filler/auth', { id: nextId(), ...authResponse(challenge, fillerId) });
  if (res.status !== 200) throw new Error(`REST login failed: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

export function quoteFor(request: Frame, fillerId: FillerId, q: { nonce: string; amountOut: string; validUntil: string }) {
  const keys = FILLERS[fillerId];
  const body = { requestId: String(request.requestId), filler: keys.filler.address, amountOut: q.amountOut, validUntil: q.validUntil, nonce: q.nonce };
  return { type: 'quote', ...body, sig: sign(fillerQuoteDigest(body), keys.quote.privateKey) };
}

export function intentFor(offer: Frame, fillerId: FillerId = 'acme-markets') {
  const body = { orderHash: offer.orderHash as Hex, attempt: offer.attempt as number, validFrom: String(offer.validFrom), validUntil: String(offer.validUntil) };
  return { type: 'ticket.intent', ...body, sig: sign(ticketIntentDigest(body), FILLERS[fillerId].filler.privateKey) };
}

export function receiptFor(issued: Frame, fillerId: FillerId = 'acme-markets') {
  const ticket = issued.ticket as Parameters<typeof fillTicketDigest>[0];
  const body = { ticketHash: fillTicketDigest(ticket), ticketSigHash: sigHash(issued.ticketSig as Hex) };
  return { type: 'ticket.receipt', orderHash: issued.orderHash, attempt: issued.attempt, ...body, sig: sign(ticketReceiptDigest(body), FILLERS[fillerId].filler.privateKey) };
}

export const signedByGateway = (f: Frame) => {
  try {
    return gatewaySigner(f) === TEST_KEYS.gateway.address;
  } catch {
    return false;
  }
};
