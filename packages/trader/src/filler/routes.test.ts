import { FILLER_MESSAGE_TYPES, FILLER_PROTOCOL_DOMAIN, fillerMessageBodyHash, type Hex } from '@cancore/contracts';
import { FillerConfigError, GatewayError } from './errors';
import { recoverTypedDataSigner } from './signer';
import { createFakeFetch, createFakeGatewayLogin, createTestGatewaySigner, createTestTypedDataSigner, FakeClock, type TestGatewaySigner } from './testing';
import { createFillerRoutes } from './routes';

const GATEWAY_KEY: Hex = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';
const MESSAGE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const MESSAGE_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const FILLER = 'cancore-dev-1';

type Body = Record<string, unknown>;
const APPROVED = [
  { src: 'eip155:56', dst: 'eip155:1' },
  { src: 'eip155:1', dst: 'canton:devnet' },
];

/** filler-gateway with the routes of §3.20: approved routes, the ones the filler serves, and the sealed requests it got. */
function harness(options: { refuse?: (gateway: TestGatewaySigner) => Body } = {}) {
  const clock = new FakeClock();
  const gateway = createTestGatewaySigner(GATEWAY_KEY, clock);
  const login = createFakeGatewayLogin(gateway, { fillerId: FILLER, clock });
  const active = new Set(APPROVED.map((r) => `${r.src}>${r.dst}`));
  const posted: Body[] = [];
  const state = (re?: unknown) =>
    gateway.frame({ type: 'routes.state', id: 'g-routes', fillerId: FILLER, ...(re ? { re } : {}), routes: APPROVED.map((r) => ({ ...r, active: active.has(`${r.src}>${r.dst}`) })) } as never);
  const http = createFakeFetch({
    ...login.routes,
    'GET /v1/filler/routes': () => ({ status: 200, body: state() }),
    'POST /v1/filler/routes': (request) => {
      const body = JSON.parse(String(request.body)) as Body;
      posted.push(body);
      if (options.refuse) return { status: 403, body: options.refuse(gateway) };
      active.clear();
      for (const r of body.routes as { src: string; dst: string }[]) active.add(`${r.src}>${r.dst}`);
      return { status: 200, body: state(body.id) };
    },
  });
  const routes = createFillerRoutes({
    gatewayUrl: 'wss://filler-gateway.example/v1',
    fillerId: FILLER,
    gatewaySigner: gateway.address,
    messageSigner: createTestTypedDataSigner(MESSAGE_KEY),
    fetch: http.fetch,
    clock,
    instanceId: 'replica-1',
  });
  return { routes, posted, gateway };
}

describe('CAN-2793 the filler sets its own routes within those Cancore approved', () => {
  test('state(): every approved route and whether the filler serves it', async () => {
    const h = harness();
    expect((await h.routes.state()).routes).toEqual(APPROVED.map((r) => ({ ...r, active: true })));
  });

  test('set(): a routes.set sealed by the message key, the full list, duplicates dropped; the verified new state back', async () => {
    const h = harness();
    const state = await h.routes.set([APPROVED[0]!, APPROVED[0]!]);
    expect(state.routes).toEqual([
      { ...APPROVED[0], active: true },
      { ...APPROVED[1], active: false },
    ]);
    const [sent] = h.posted;
    expect(sent).toMatchObject({ type: 'routes.set', fillerId: FILLER, routes: [APPROVED[0]] });
    const { msgSig, ...body } = sent as Body & { msgSig: Hex };
    const digestInput = { domain: FILLER_PROTOCOL_DOMAIN, types: FILLER_MESSAGE_TYPES, primaryType: 'FillerMessage' as const, message: { bodyHash: fillerMessageBodyHash(body) } };
    expect(recoverTypedDataSigner(digestInput, msgSig)).toBe(MESSAGE_ADDRESS);
  });

  test('set([]): every route off', async () => {
    const h = harness();
    expect((await h.routes.set([])).routes.every((r) => !r.active)).toBe(true);
  });

  test('a route outside the approved ones: ROUTE_NOT_APPROVED from filler-gateway is thrown', async () => {
    const h = harness({ refuse: (gateway) => gateway.frame({ type: 'error', id: 'g-err', fillerId: FILLER, code: 'ROUTE_NOT_APPROVED', message: 'not approved for cancore-dev-1: eip155:1>eip155:56' } as never) });
    await expect(h.routes.set([{ src: 'eip155:1', dst: 'eip155:56' }])).rejects.toMatchObject({ code: 'ROUTE_NOT_APPROVED' });
    await expect(h.routes.set([{ src: 'eip155:1', dst: 'eip155:56' }])).rejects.toBeInstanceOf(GatewayError);
  });

  test('a malformed route is refused before anything is signed or sent', async () => {
    const h = harness();
    await expect(h.routes.set([{ src: 'solana:mainnet', dst: 'eip155:1' }])).rejects.toBeInstanceOf(FillerConfigError);
    expect(h.posted).toHaveLength(0);
  });

  test('an answer not signed by the pinned filler-gateway is refused', async () => {
    const clock = new FakeClock();
    const impostor = createTestGatewaySigner(`0x${'11'.repeat(32)}`, clock);
    const gateway = createTestGatewaySigner(GATEWAY_KEY, clock);
    const login = createFakeGatewayLogin(gateway, { fillerId: FILLER, clock });
    const http = createFakeFetch({
      ...login.routes,
      'GET /v1/filler/routes': () => ({ status: 200, body: impostor.frame({ type: 'routes.state', id: 'g-x', fillerId: FILLER, routes: [] } as never) }),
    });
    const routes = createFillerRoutes({ gatewayUrl: 'wss://filler-gateway.example/v1', fillerId: FILLER, gatewaySigner: gateway.address, messageSigner: createTestTypedDataSigner(MESSAGE_KEY), fetch: http.fetch, clock });
    await expect(routes.state()).rejects.toMatchObject({ code: 'UNVERIFIED_RESPONSE' });
  });
});
