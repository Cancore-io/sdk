import { agent, LIMITS, make, outcome, req, rig, type Rig } from './rig';

// CC at 0.15 USD (the rig's engine). 100 CC = 15 USD.
describe('security: USD caps through the dispatcher', () => {
  let r: Rig;
  afterEach(() => r.cleanup());

  it('a single make over perOrderUsd is refused before the engine', async () => {
    r = await rig({ ...LIMITS, perOrderUsd: '10', perDayUsd: '1000' });
    await r.unlock();
    expect(await outcome(r.dispatcher.handle(make('100'), agent))).toBe('usd_order_exceeded');
    expect(r.engine.made).toHaveLength(0);
  });

  it('a USD price the API does not give (sourcePriceUsd null) refuses the make', async () => {
    r = await rig({ ...LIMITS, perOrderUsd: '1000', perDayUsd: '1000' });
    r.engine.usdPrices = async () => ({});
    await r.unlock();
    expect(await outcome(r.dispatcher.handle(make('10'), agent))).toBe('usd_price_missing');
    expect(r.engine.made).toHaveLength(0);
  });

  it('a strategy whose orders would pass perDayUsd is refused at start', async () => {
    r = await rig({ ...LIMITS, perOrderUsd: '1000', perDayUsd: '5' });
    await r.unlock();
    const grid = { kind: 'grid', base: 'CC', quote: 'USDCx', config: { side: 'buy', levels: 3, amountPerLevel: '20', lowerPrice: '0.149', upperPrice: '0.151' } };
    expect(await outcome(r.dispatcher.handle(req('strategy.start', grid), agent))).toBe('usd_daily_exceeded');
    expect(r.state().strategies ?? []).toEqual([]);
  });

  it('missing caps refuse every trade unless the owner opted out', async () => {
    const { perOrderUsd: _a, perDayUsd: _b, ...noCaps } = { ...LIMITS, perOrderUsd: '', perDayUsd: '' };
    r = await rig(noCaps);
    await r.unlock();
    expect(await outcome(r.dispatcher.handle(make('1'), agent))).toBe('usd_cap_missing');
    await r.cleanup();
    r = await rig({ ...noCaps, usdCapsOptOut: true });
    await r.unlock();
    expect(await outcome(r.dispatcher.handle(make('1'), agent))).toBe('ok');
  });
  it('a settled fill keeps its fill-time USD value: a later price drop does not free the daily budget', async () => {
    // 100 CC at $0.15 = $15, the whole day. Then CC drops to $0.075: repriced, the fill would look like $7.5.
    r = await rig({ ...LIMITS, perOrderUsd: '1000', perDayUsd: '15' });
    await r.unlock();
    expect(await outcome(r.dispatcher.handle(make('100'), agent))).toBe('ok');
    const orderId = r.state().openOrders[0]!.orderId;
    r.hooks().onSettled(orderId);
    // Settlement runs in the background: wait on its effect, not on a timer.
    while (!r.state().fills?.length) await new Promise((res) => setImmediate(res));
    expect(r.state().fills).toEqual([expect.objectContaining({ instrument: 'CC', amount: '100', usdValue: '15' })]);
    r.engine.usdPrices = async () => ({ CC: '0.075', USDCx: '1' });
    expect(await outcome(r.dispatcher.handle(make('100'), agent))).toBe('usd_daily_exceeded');
  });
  it('a settle for an order the book never knew pauses the bot; a repeated settle of a booked fill does not', async () => {
    r = await rig({ ...LIMITS, perOrderUsd: '1000', perDayUsd: '1000' });
    await r.unlock();
    expect(await outcome(r.dispatcher.handle(make('10'), agent))).toBe('ok');
    const orderId = r.state().openOrders[0]!.orderId;
    r.hooks().onSettled(orderId);
    while (!r.state().fills?.length) await new Promise((res) => setImmediate(res));
    // The same settle again (serve and reconcile both saw it): booked once, nothing paused.
    r.hooks().onSettled(orderId);
    // Unknown: limits never saw this trade, so the owner must look before anything else trades.
    r.hooks().onSettled('ghost');
    // Settle work runs in order: once the ghost's entry is written, the repeated settle has been handled too.
    while (!r.audit().some((e) => e.reason === 'unbooked_fill')) await new Promise((res) => setImmediate(res));
    expect(r.audit().filter((e) => (e.params as { event?: string; orderId?: string })?.event === 'settled' && (e.params as { orderId?: string }).orderId === orderId)).toHaveLength(1);
    expect(r.state().openOrders).toEqual([]);
    // Only the ghost paused: the repeated settle of a booked fill did not.
    expect(r.audit().filter((e) => e.reason === 'unbooked_fill').map((e) => (e.params as { orderId?: string }).orderId)).toEqual(['ghost']);
    expect(r.state()).toMatchObject({ paused: true, pauseReason: 'unbooked_fill' });
    expect(r.state().fills).toHaveLength(1);
    expect(r.audit()).toContainEqual(expect.objectContaining({ method: 'settle', decision: 'deny', reason: 'unbooked_fill' }));
  });
});
