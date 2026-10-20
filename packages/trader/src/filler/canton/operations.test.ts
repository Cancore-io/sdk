import type { Hex } from '@cancore/contracts';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { GatewayError } from '../errors';
import {
  createFakeFetch,
  createFakeGatewayLogin,
  createRecordingLogger,
  createTestGatewaySigner,
  createTestTypedDataSigner,
  FakeClock,
  type FakeRoute,
  type TestGatewaySigner,
} from '../testing';
import { allocation, NODE_KEY, NODE_PRIVATE_KEY, OTHER_KEY, PARTICIPANT, party, topologyLeg, transactionLeg } from './fixtures';
import { CantonRefusal } from './legs';
import { type CantonPartySigner, createCantonOperations, signatureHex } from './operations';

const GATEWAY_KEY: Hex = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';
const MESSAGE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FILLER = 'cancore-dev-1';

/** The party key as the node holds it; `signed` records every hash it signed. */
function partySigner(): CantonPartySigner & { signed: string[] } {
  const signed: string[] = [];
  return {
    publicKey: `0x${NODE_KEY}` as Hex,
    signed,
    async signHash(hash) {
      signed.push(bytesToHex(hash));
      return signatureHex(ed25519.sign(hash, NODE_PRIVATE_KEY));
    },
  };
}

type Body = Record<string, unknown>;

/** A refusal as filler-gateway sends it: a signed `error` (only a 429 may come unsigned). */
const gatewayError = (gateway: TestGatewaySigner, code: string, message: string) =>
  gateway.frame({ type: 'error', id: `g-${code}`, fillerId: FILLER, code, message } as never);

/** A filler-gateway with the Canton routes; `prepared(body)` and `submitted(body)` shape the answers. */
function harness(answer: { prepared: (request: Body) => Body | Promise<Body>; submit?: (gateway: TestGatewaySigner) => FakeRoute }) {
  const clock = new FakeClock();
  const gateway = createTestGatewaySigner(GATEWAY_KEY, clock);
  const login = createFakeGatewayLogin(gateway, { fillerId: FILLER, clock });
  const submits: Body[] = [];
  const http = createFakeFetch({
    ...login.routes,
    'POST /v1/filler/canton/prepare': async (request) => {
      const body = JSON.parse(String(request.body)) as Body;
      return { status: 200, body: gateway.frame({ type: 'canton.prepared', id: 'g-prepared', fillerId: FILLER, re: body.id, ...(await answer.prepared(body)) } as never) };
    },
    'POST /v1/filler/canton/submit':
      answer.submit?.(gateway) ??
      ((request) => {
        const body = JSON.parse(String(request.body)) as Body;
        submits.push(body);
        return { status: 200, body: gateway.frame({ type: 'canton.submitted', id: 'g-submitted', fillerId: FILLER, re: body.id, operationId: body.operationId, op: 'party.allocate', updateId: 'u-1', result: { partyId: party() } } as never) };
      }),
  });
  const signer = partySigner();
  const logger = createRecordingLogger();
  const ops = createCantonOperations({
    gatewayUrl: 'wss://filler-gateway.example/v1',
    fillerId: FILLER,
    gatewaySigner: gateway.address,
    messageSigner: createTestTypedDataSigner(MESSAGE_KEY),
    partySigner: signer,
    participantUid: PARTICIPANT,
    fetch: http.fetch,
    clock,
    logger,
    instanceId: 'replica-1',
  });
  return { clock, ops, signer, submits, http, logger };
}

const allocated = (clock: FakeClock, over: Body = {}, txs = allocation()) => ({
  operationId: 'op-1',
  op: 'party.allocate',
  legs: [topologyLeg(txs)],
  summary: { partyId: party(), publicKey: `0x${NODE_KEY}`, hosting: { participantUid: PARTICIPANT, permission: 'CONFIRMATION', threshold: 1 } },
  expiresAt: clock.now() + 60_000,
  ...over,
});

describe('party.allocate', () => {
  test('an honest allocation is checked, signed once per leg with the party key, and submitted', async () => {
    const h = harness({ prepared: () => allocated(h.clock) });
    const submitted = await h.ops.allocateParty();
    expect(submitted).toMatchObject({ type: 'canton.submitted', operationId: 'op-1', op: 'party.allocate', result: { partyId: party() } });
    const prepare = JSON.parse(String(h.http.requests.find((r) => r.url.endsWith('/canton/prepare'))!.body));
    expect(prepare).toMatchObject({ type: 'canton.prepare', op: 'party.allocate', params: { publicKey: `0x${NODE_KEY}` }, fillerId: FILLER });
    expect(prepare.msgSig).toMatch(/^0x[0-9a-f]{130}$/);
    const leg = allocated(h.clock).legs[0]!;
    expect(h.signer.signed).toEqual([leg.hash.slice(2)]);
    const [signature] = h.submits[0]!.signatures as Array<{ legId: string; signature: Hex }>;
    expect(signature!.legId).toBe(leg.legId);
    expect(ed25519.verify(hexToBytes(signature!.signature.slice(2)), hexToBytes(leg.hash.slice(2)), hexToBytes(NODE_KEY))).toBe(true);
  });

  test.each([
    ['another key in the summary', (c: FakeClock) => allocated(c, { summary: { ...allocated(c).summary, publicKey: `0x${OTHER_KEY}` } }), /another key/],
    ['hosting stated on another participant', (c: FakeClock) => allocated(c, { summary: { ...allocated(c).summary, hosting: { participantUid: 'PAR::evil::1220bb', permission: 'CONFIRMATION', threshold: 1 } } }), /stated hosting/],
    ['a topology that hosts elsewhere, whatever the summary says', (c: FakeClock) => allocated(c, {}, allocation({ hosting: { participants: [{ uid: 'PAR::evil::1220bb', permission: 2 }] } })), /hosted elsewhere/],
    ['a transaction leg in an allocation', async (c: FakeClock) => allocated(c, { legs: [await transactionLeg()] }), /topology legs only/],
    ['a leg of an unknown kind', (c: FakeClock) => allocated(c, { legs: [{ legId: 'x', kind: 'raw-hash', hash: `0x${'00'.repeat(32)}` }] }), /unknown leg kind/],
    ['no legs', (c: FakeClock) => allocated(c, { legs: [] }), /nothing to sign/],
    ['an expired operation', (c: FakeClock) => allocated(c, { expiresAt: c.now() }), /expired/],
    ['another op', (c: FakeClock) => allocated(c, { op: 'registry.accept' }), /prepared registry.accept/],
  ])('%s: refused, nothing signed or submitted', async (_name, answer, detail) => {
    const h = harness({ prepared: () => answer(h.clock) });
    const run = h.ops.allocateParty();
    await expect(run).rejects.toBeInstanceOf(CantonRefusal);
    await expect(run).rejects.toThrow(detail);
    expect(h.signer.signed).toEqual([]);
    expect(h.submits).toEqual([]);
  });

  test('an answer to another prepare is refused', async () => {
    const h = harness({ prepared: () => ({ ...allocated(h.clock), re: 'someone-else' }) });
    await expect(h.ops.allocateParty()).rejects.toThrow(/another prepare/);
    expect(h.signer.signed).toEqual([]);
  });
});

describe('other operations', () => {
  const settle = async (clock: FakeClock) => ({
    operationId: 'op-2',
    op: 'intent.settle',
    legs: [await transactionLeg()],
    summary: {},
    expiresAt: clock.now() + 60_000,
  });

  test("the op's own check sees the decoded transactions, and its refusal stops the signature", async () => {
    const h = harness({ prepared: () => settle(h.clock) });
    const seen: string[] = [];
    const run = h.ops.run('intent.settle', { orderHash: `0x${'11'.repeat(32)}` }, (_prepared, txs) => {
      seen.push(...txs.map((t) => t.commandId));
      throw new CantonRefusal('tx-0', 'the payee is not the filler');
    });
    await expect(run).rejects.toThrow(/payee is not the filler/);
    expect(seen).toEqual(['legs-test']);
    expect(h.signer.signed).toEqual([]);
  });

  test('a topology leg outside party.allocate is refused', async () => {
    const h = harness({ prepared: async () => ({ ...(await settle(h.clock)), legs: [topologyLeg(allocation())] }) });
    await expect(h.ops.run('intent.settle', { orderHash: `0x${'11'.repeat(32)}` }, () => undefined)).rejects.toThrow(/transaction legs only/);
  });
});

describe('preapproval.create (CAN-2904)', () => {
  const ADMIN = 'cancore::12204f383aca6af056f6d83c9b5758fbc53c27a743e2f9d591e61bc657202172524b';
  const preapproval = async (clock: FakeClock, legs: unknown[]) => ({
    operationId: 'op-pa',
    op: 'preapproval.create',
    legs,
    summary: {
      party: party(), admin: ADMIN, instrumentAllowances: ['CNRX'],
      requestedAt: String(Math.floor(clock.now() / 1000)), executeBefore: String(Math.floor(clock.now() / 1000) + 365 * 86_400),
    },
    expiresAt: clock.now() + 60_000,
  });

  test('createPreapproval asks for the admin and holds the prepared legs to the preapproval check: a second leg is refused, nothing signed', async () => {
    const asked: Body[] = [];
    const h = harness({
      prepared: async (body) => {
        asked.push(body);
        return preapproval(h.clock, [await transactionLeg(), await transactionLeg({ legId: 'tx-1' })]);
      },
    });
    await expect(h.ops.createPreapproval(ADMIN)).rejects.toThrow(/expected one transaction, got 2/);
    expect(asked).toEqual([expect.objectContaining({ op: 'preapproval.create', params: { admin: ADMIN } })]);
    expect(h.signer.signed).toEqual([]);
    expect(h.submits).toEqual([]);
  });

  test('one leg that is not the create is refused by the same check, nothing signed', async () => {
    const h = harness({ prepared: async () => preapproval(h.clock, [await transactionLeg()]) });
    await expect(h.ops.createPreapproval(ADMIN)).rejects.toThrow(/does more than one create/);
    expect(h.signer.signed).toEqual([]);
  });
});

describe('submit', () => {
  test('a retryable refusal is submitted again with the same operationId; the third failure is thrown', async () => {
    const operationIds: unknown[] = [];
    let calls = 0;
    const h = harness({
      prepared: () => allocated(h.clock),
      submit: (gateway) => (request) => {
        calls++;
        operationIds.push((JSON.parse(String(request.body)) as Body).operationId);
        return { status: 503, body: gatewayError(gateway, 'CANTON_UNAVAILABLE', 'participant down') };
      },
    });
    await expect(h.ops.allocateParty()).rejects.toBeInstanceOf(GatewayError);
    expect(calls).toBe(3);
    expect(new Set(operationIds)).toEqual(new Set(['op-1']));
  });

  test('a final refusal is not retried, and a spent prepare budget holds back new prepares only', async () => {
    let submits = 0;
    const h = harness({
      prepared: () => allocated(h.clock),
      submit: (gateway) => () => {
        submits++;
        return { status: 410, body: gatewayError(gateway, 'OPERATION_EXPIRED', 'expired') };
      },
    });
    await expect(h.ops.allocateParty()).rejects.toBeInstanceOf(GatewayError);
    expect(submits).toBe(1);

    const limited = harness({ prepared: () => allocated(limited.clock) });
    limited.http.routes['POST /v1/filler/canton/prepare'] = () => ({ status: 429, body: { type: 'error', code: 'RATE_LIMITED', message: 'budget', retryAfterMs: 60_000 } });
    await expect(limited.ops.allocateParty()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const prepares = () => limited.http.requests.filter((r) => r.url.endsWith('/canton/prepare')).length;
    await expect(limited.ops.allocateParty()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(prepares()).toBe(1);
  });
});

describe('configuration', () => {
  test('a party key that is not 32 bytes, or no participant uid, is refused up front', () => {
    const base = {
      gatewayUrl: 'wss://x.example/v1',
      fillerId: FILLER,
      gatewaySigner: createTestGatewaySigner(GATEWAY_KEY).address,
      messageSigner: createTestTypedDataSigner(MESSAGE_KEY),
      fetch: createFakeFetch().fetch,
    };
    expect(() => createCantonOperations({ ...base, partySigner: { publicKey: '0x00', signHash: async () => '0x' }, participantUid: PARTICIPANT })).toThrow(/partySigner/);
    expect(() => createCantonOperations({ ...base, partySigner: partySigner(), participantUid: 'cancore' })).toThrow(/participantUid/);
  });
});
