/**
 * CAN-2793, `routes.set` and `routes.state` against the real filler-gateway of the intent stand: the routes the
 * filler serves are exactly the ones it set, a route Cancore has not approved is refused and changes nothing, and
 * an answer signed by any key but the pinned filler-gateway's is refused with a typed error. The stand filler's
 * active routes are put back as they were after every change: the other stand specs quote on them.
 *
 *   INTENT_STAND_ENV=<stand env> npx jest --selectProjects int --runInBand packages/trader/test/CAN-2793-routes.stand.int.test.ts
 */
import type { Hex } from '@cancore/contracts';
import { GatewayError } from '../src/filler/errors';
import { createFillerRoutes } from '../src/filler/routes';
import { createTestTypedDataSigner } from '../src/filler/testing';
import { env } from './stand/canton-ledger';
import { GATEWAY_KEYS, standChain, standSuite } from './stand/filler-gateway';

standSuite('CAN-2793: routes against the real filler-gateway', GATEWAY_KEYS, () => {
  const routesWith = (gatewaySigner: Hex = env('FILLER_GATEWAY_SIGNER') as Hex) =>
    createFillerRoutes({ gatewayUrl: env('FILLER_GATEWAY_WS_URL'), fillerId: env('STAND_FILLER_ID'), gatewaySigner, messageSigner: createTestTypedDataSigner(env('STAND_FILLER_MESSAGE_KEY') as Hex) });
  const key = (r: { src: string; dst: string }) => `${r.src}>${r.dst}`;
  const activeOf = (state: { routes: Array<{ src: string; dst: string; active: boolean }> }) => state.routes.filter((r) => r.active).map(({ src, dst }) => ({ src, dst }));

  test('TC-SDK-2793-INT-01: routes.set [A→B] — routes.state, signed by filler-gateway, serves exactly A→B; routes.set [] serves none', async () => {
    const routes = routesWith();
    const before = await routes.state();
    expect(before.routes.length).toBeGreaterThan(0);
    const only = before.routes[0]!;
    try {
      const one = await routes.set([{ src: only.src, dst: only.dst }]);
      expect(activeOf(one).map(key)).toEqual([key(only)]);
      expect(activeOf(await routes.state()).map(key)).toEqual([key(only)]);
      const none = await routes.set([]);
      expect(activeOf(none)).toEqual([]);
      expect(none.routes.map(key).sort()).toEqual(before.routes.map(key).sort());
      expect(activeOf(await routes.state())).toEqual([]);
    } finally {
      await routes.set(activeOf(before));
    }
    expect(activeOf(await routes.state()).map(key).sort()).toEqual(activeOf(before).map(key).sort());
  }, 120_000);

  test('TC-SDK-2793-INT-02: a route Cancore has not approved — refused ROUTE_NOT_APPROVED, routes.state unchanged', async () => {
    const routes = routesWith();
    const before = await routes.state();
    const unapproved = { src: standChain(), dst: 'eip155:1' };
    expect(before.routes.map(key)).not.toContain(key(unapproved));
    const refusal = await routes.set([...activeOf(before), unapproved]).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(GatewayError);
    expect(refusal).toMatchObject({ code: 'ROUTE_NOT_APPROVED' });
    expect(await routes.state()).toEqual(before);
  }, 120_000);

  test('TC-SDK-2793-INT-03: answers signed by filler-gateway while another key is pinned — refused UNVERIFIED_RESPONSE, nothing taken from them', async () => {
    const elsewhere = routesWith(createTestTypedDataSigner(`0x${'5e'.repeat(32)}`).address);
    const refusal = await elsewhere.state().catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(GatewayError);
    expect(refusal).toMatchObject({ code: 'UNVERIFIED_RESPONSE' });
  }, 120_000);
});
