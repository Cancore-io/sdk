/**
 * CAN-2352 on the full intent stand: the filler's Canton operations client against the real bridge filler-gateway →
 * trading → participant. The SDK prepares, checks every leg, signs with the party key and submits; nothing is played
 * but what each case names.
 *
 * INT-02 and INT-03 put a relay between the SDK and filler-gateway — the SDK's own injectable `fetch`. The relay
 * holds every answer to the real filler-gateway key, changes what the case says, and signs the result with a relay
 * key the SDK pins in place of the stand's: what reaches the SDK is exactly what a filler-gateway that lies would
 * send. Requests it changes it seals again with the stand filler's message key, as a compromised path would have to.
 *
 * Skipped without INTENT_STAND_ENV; with it, a missing key fails naming every missing key.
 */
import type { Hex } from '@cancore/contracts';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { CantonTransferFactory } from '../src/filler/canton/factories';
import { CantonRefusal } from '../src/filler/canton/legs';
import { createCantonOperations, type CantonOperations } from '../src/filler/canton/operations';
import { GatewayError } from '../src/filler/errors';
import { createSealer } from '../src/filler/protocol/envelope';
import { verifyGatewayObject } from '../src/filler/protocol/frames';
import { systemClock, type HttpFetch, type HttpResponse } from '../src/filler/runtime';
import { createTestGatewaySigner, createTestTypedDataSigner } from '../src/filler/testing';
import { activeContracts, cantonToken, env, ledger } from './stand/canton-ledger';
import { standSuite } from './stand/filler-gateway';

const REQUIRED = [
  'FILLER_GATEWAY_WS_URL', 'FILLER_GATEWAY_SIGNER', 'CANTON_PARTICIPANT_UID', 'CNRX_ADMIN_PARTY', 'CANTON_TRANSFER_FACTORIES_JSON',
  'STAND_FILLER_ID', 'STAND_FILLER_MESSAGE_KEY', 'STAND_FILLER_CANTON_PARTY', 'STAND_FILLER_CANTON_PARTY_KEY',
  'STAND_FILLER2_ID', 'STAND_FILLER2_MESSAGE_KEY', 'STAND_FILLER2_CANTON_PARTY', 'STAND_FILLER2_CANTON_PARTY_KEY',
  'CANTON_JSON_API_URL', 'CANTON_TOKEN_URL', 'CANTON_CLIENT_ID', 'CANTON_CLIENT_SECRET', 'STAND_CANTON_RECIPIENT_PARTY',
] as const;

/** The relay's own signing key: a test key the SDK pins as filler-gateway's in INT-02/03, never the stand's. */
const RELAY_KEY: Hex = `0x${'52'.repeat(32)}`;
const RELAY = createTestGatewaySigner(RELAY_KEY);
const HOLDING_V1 = '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding';

type Frame = { type: string } & Record<string, unknown>;
type Body = { status: number; frame: Frame };

/** What a case changes on the way: the sealed request out, the verified answer back, or the answer instead of filler-gateway. */
interface Relay {
  request?: (path: string, message: Frame) => Frame | undefined;
  answer?: (path: string, frame: Frame) => Frame | Body;
  /** An answer of the relay's own, filler-gateway never asked: undefined forwards. */
  instead?: (path: string, message: Frame) => Body | undefined;
}

interface Party {
  prefix: 'STAND_FILLER' | 'STAND_FILLER2';
  signed: () => number;
}

const isBody = (x: Frame | Body): x is Body => typeof x.status === 'number' && typeof x.frame === 'object';

const respond = (status: number, frame: Frame): HttpResponse => {
  const text = JSON.stringify(frame);
  return { status, headers: { get: () => null }, text: async () => text };
};

/** The SDK's fetch through the relay: each answer verified as the stand's, changed, signed by the relay key. */
function relayFetch(prefix: Party['prefix'], relay: Relay, seen: string[]): HttpFetch {
  const reseal = createSealer({ fillerId: env(`${prefix}_ID`), messageSigner: createTestTypedDataSigner(env(`${prefix}_MESSAGE_KEY`) as Hex), clock: systemClock });
  return async (url, request) => {
    const path = new URL(url).pathname;
    seen.push(path);
    let body = request.body;
    if (body !== undefined && relay.request) {
      const { fillerId: _f, sentAt: _s, msgSig: _m, ...unsealed } = JSON.parse(body) as Frame;
      const changed = relay.request(path, unsealed);
      if (changed) body = JSON.stringify(await reseal(changed as never));
    }
    const own = body !== undefined && relay.instead ? relay.instead(path, JSON.parse(body) as Frame) : undefined;
    if (own) return respond(own.status, RELAY.sign(own.frame));
    const response = await fetch(url, { method: request.method, headers: { ...request.headers }, ...(body !== undefined ? { body } : {}) });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: response.status, headers: response.headers, text: async () => text };
    }
    const check = verifyGatewayObject(parsed, new TextEncoder().encode(text), { gatewaySigner: env('FILLER_GATEWAY_SIGNER') as Hex, fillerId: env(`${prefix}_ID`) });
    if (!check.ok) {
      if (Array.isArray(parsed) || typeof (parsed as Frame).sig !== 'string') return { status: response.status, headers: response.headers, text: async () => text };
      throw new Error(`relay: ${path} answered a frame the stand did not sign (${check.reason})`);
    }
    const changed = relay.answer ? relay.answer(path, parsed as Frame) : (parsed as Frame);
    const answer: Body = isBody(changed) ? changed : { status: response.status, frame: changed };
    return respond(answer.status, RELAY.sign(answer.frame));
  };
}

/** The Canton operations of one stand filler: straight to filler-gateway, or through `relay`. */
function operations(prefix: Party['prefix'], relay?: Relay, seen: string[] = []): { ops: CantonOperations } & Party {
  const seed = hexToBytes(env(`${prefix}_CANTON_PARTY_KEY`).replace(/^0x/, ''));
  let signatures = 0;
  const ops = createCantonOperations({
    gatewayUrl: env('FILLER_GATEWAY_WS_URL'),
    fillerId: env(`${prefix}_ID`),
    gatewaySigner: relay ? RELAY.address : (env('FILLER_GATEWAY_SIGNER') as Hex),
    messageSigner: createTestTypedDataSigner(env(`${prefix}_MESSAGE_KEY`) as Hex),
    partySigner: {
      publicKey: `0x${bytesToHex(ed25519.getPublicKey(seed))}` as Hex,
      signHash: async (hash) => (signatures++, `0x${bytesToHex(ed25519.sign(hash, seed))}` as Hex),
    },
    participantUid: env('CANTON_PARTICIPANT_UID'),
    registries: JSON.parse(env('CANTON_TRANSFER_FACTORIES_JSON')) as Record<string, CantonTransferFactory[]>,
    ...(relay ? { fetch: relayFetch(prefix, relay, seen) } : {}),
  });
  return { ops, prefix, signed: () => signatures };
}

/**
 * The CNRX holdings of `party` on the participant, read through the token standard, not through Cancore. Locked
 * ones count too: a received CNRX its guardian has not marked yet may carry a lock, and is still the delivery.
 */
async function cnrxOnLedger(party: string): Promise<Map<string, string>> {
  type View = { owner?: string; instrumentId?: { admin?: string; id?: string }; amount?: string; lock?: unknown };
  const events = await activeContracts(party, { InterfaceFilter: { value: { interfaceId: HOLDING_V1, includeInterfaceView: true, includeCreatedEventBlob: false } } }, await cantonToken());
  const held = new Map<string, string>();
  for (const event of events) {
    const view = event.interfaceViews?.[0]?.viewValue as View | undefined;
    if (view?.owner === party && view.instrumentId?.admin === env('CNRX_ADMIN_PARTY') && view.instrumentId?.id === 'CNRX') held.set(event.contractId, String(view.amount));
  }
  return held;
}

const created = (before: Map<string, string>, after: Map<string, string>): string[] => [...after.entries()].filter(([cid]) => !before.has(cid)).map(([, amount]) => Number(amount).toString());

const failure = async (run: Promise<unknown>): Promise<unknown> => run.then(() => undefined, (e: unknown) => e);

const cnrx = () => ({ admin: env('CNRX_ADMIN_PARTY'), id: 'CNRX' });

standSuite('CAN-2352: the Canton operations client against the real filler-gateway → trading bridge', REQUIRED, () => {
  test('TC-SDK-2352-INT-01: party.allocate of a filler that has its party is refused by Cancore before anything is signed; holdings.transfer — prepared by Cancore, checked and signed by the SDK, submitted; the receiver’s holding is on the participant', async () => {
    const filler = operations('STAND_FILLER');
    const { ops } = filler;
    const party = env('STAND_FILLER_CANTON_PARTY');
    const receiver = env('STAND_CANTON_RECIPIENT_PARTY');

    // Every stand filler is onboarded with its party; a second allocation is Cancore staff's, never the node's.
    const allocated = await failure(ops.allocateParty());
    expect(allocated).toBeInstanceOf(GatewayError);
    expect((allocated as GatewayError).code).toBe('NOT_ELIGIBLE');
    expect(filler.signed()).toBe(0);
    const token = await cantonToken();
    const details = await ledger<{ partyDetails?: Array<{ party: string; isLocal?: boolean }> }>(`/v2/parties/${encodeURIComponent(party)}`, token);
    expect(details.partyDetails?.map((d) => d.party)).toContain(party);

    const before = await cnrxOnLedger(receiver);
    const sent = await ops.transfer({ asset: cnrx(), amount: '0.2352', toParty: receiver });
    expect(sent).toMatchObject({ op: 'holdings.transfer', result: { outcome: 'COMPLETED' } });
    expect(created(before, await cnrxOnLedger(receiver))).toEqual(['0.2352']);
    expect(filler.signed()).toBeGreaterThan(0);
  }, 240_000);

  const tampers: Array<{ name: string; relay: Relay; refusal: RegExp }> = [
    {
      name: 'another operation than asked',
      relay: { answer: (path, frame) => (path.endsWith('/canton/prepare') ? { ...frame, op: 'registry.accept' } : frame) },
      refusal: /the backend prepared registry\.accept/,
    },
    {
      name: 'the receiver replaced, the summary still naming the asked one',
      relay: {
        request: (path, m) => (path.endsWith('/canton/prepare') ? { ...m, params: { ...(m.params as Frame), toParty: env('STAND_CANTON_RECIPIENT_PARTY') } } : undefined),
        answer: (path, frame) => (path.endsWith('/canton/prepare') ? { ...frame, summary: { ...(frame.summary as Frame), receiver: env('STAND_FILLER2_CANTON_PARTY') } } : frame),
      },
      refusal: /the transfer is to another receiver/,
    },
    {
      name: 'the amount replaced, the summary still stating the asked one',
      relay: {
        request: (path, m) => (path.endsWith('/canton/prepare') ? { ...m, params: { ...(m.params as Frame), amount: '0.4704' } } : undefined),
        answer: (path, frame) => (path.endsWith('/canton/prepare') ? { ...frame, summary: { ...(frame.summary as Frame), amount: '0.2352' } } : frame),
      },
      refusal: /the transfer moves another amount/,
    },
  ];

  test.each(tampers)('TC-SDK-2352-INT-02: a tampered prepare is never signed — $name', async ({ relay, refusal }) => {
    const seen: string[] = [];
    const filler = operations('STAND_FILLER', relay, seen);
    const before = await cnrxOnLedger(env('STAND_FILLER_CANTON_PARTY'));

    const error = await failure(filler.ops.transfer({ asset: cnrx(), amount: '0.2352', toParty: env('STAND_FILLER2_CANTON_PARTY') }));
    expect(error).toBeInstanceOf(CantonRefusal);
    expect(String((error as Error).message)).toMatch(refusal);
    expect(filler.signed()).toBe(0);
    expect(seen.filter((p) => p.endsWith('/canton/submit'))).toEqual([]);
    expect(await cnrxOnLedger(env('STAND_FILLER_CANTON_PARTY'))).toEqual(before);
  }, 180_000);

  test('TC-SDK-2352-INT-03: a lost submit answer is retried under the same operationId — one transaction; a final refusal is not retried', async () => {
    const receiver = env('STAND_CANTON_RECIPIENT_PARTY');
    const submits: string[] = [];
    let lost = false;
    const once = operations('STAND_FILLER', {
      instead: (path, m) => {
        if (!path.endsWith('/canton/submit')) return undefined;
        submits.push(String(m.operationId));
        return undefined;
      },
      answer: (path, frame) => {
        if (!path.endsWith('/canton/submit') || lost) return frame;
        lost = true;
        // The first submit reached Cancore and committed; its answer is replaced by a retryable refusal.
        return { status: 503, frame: { type: 'error', fillerId: env('STAND_FILLER_ID'), sentAt: Date.now(), re: frame.re, code: 'CANTON_UNAVAILABLE', message: 'relay: the answer was lost' } };
      },
    });
    const before = await cnrxOnLedger(receiver);
    const sent = await once.ops.transfer({ asset: cnrx(), amount: '0.2353', toParty: receiver });
    expect(sent.result.outcome).toBe('COMPLETED');
    expect(submits).toHaveLength(2);
    expect(new Set(submits)).toEqual(new Set([sent.operationId]));
    expect(created(before, await cnrxOnLedger(receiver))).toEqual(['0.2353']);

    const finalSubmits: string[] = [];
    const refused = operations('STAND_FILLER', {
      instead: (path, m) => {
        if (!path.endsWith('/canton/submit')) return undefined;
        finalSubmits.push(String(m.operationId));
        return { status: 400, frame: { type: 'error', fillerId: env('STAND_FILLER_ID'), sentAt: Date.now(), re: m.id, code: 'CANTON_REFUSED', message: 'relay: refused for good' } };
      },
    });
    // The relay answers the submit itself, never forwarding it: what this half shows is that a final refusal is not retried.
    const error = await failure(refused.ops.transfer({ asset: cnrx(), amount: '0.2354', toParty: receiver }));
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe('CANTON_REFUSED');
    expect(finalSubmits).toHaveLength(1);
  }, 300_000);
});
