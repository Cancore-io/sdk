import { CancoreApiError } from './http';
import { TrackTimeoutError, swap } from './swap';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeApi(replies: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const request = async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    const reply = replies[Math.min(i, replies.length - 1)] ?? { body: {} };
    i += 1;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  return { calls, client: swap({ baseUrl: 'https://api.example/', request }) };
}

const order = (status: string) => ({ id: 'o1', status, sourceAmount: '5', targetAmount: '1' });

test('each method hits the API route it documents, with the API field names', async () => {
  const { calls, client } = fakeApi([{ body: order('open') }]);

  await client.listOpen({ page: 2, pageSize: 10, sourceNetwork: 'canton' });
  await client.listMine();
  await client.get('o 1');
  await client.create({
    sourceNetwork: 'canton',
    sourceTokenAddress: 'CC',
    sourceTokenName: 'CC',
    sourceAmount: '5',
    targetNetwork: 'sepolia',
    targetTokenAddress: '0xabc',
    targetTokenName: 'USDC',
    targetAmount: '12.5',
  });
  await client.createForPair({ tradingPairId: 'p1', sourceAmount: '5', targetAmount: '1', side: 'buy' });
  await client.accept('o1');
  await client.cancel('o1');
  await client.quote({ pairConfigId: 'pc1', sourceAmount: '5' });
  await client.execute('qt_1');

  expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.example', '')}`)).toEqual([
    'GET /orders?page=2&pageSize=10&sourceNetwork=canton',
    'GET /orders/my',
    'GET /orders/o%201',
    'POST /orders',
    'POST /orders/pair',
    'POST /orders/o1/accept',
    'POST /orders/o1/cancel',
    'POST /auto-trader/quote',
    'POST /auto-trader/execute',
  ]);
  // The pool quote takes a number, as the service does; the client converts.
  expect(calls[7]?.body).toEqual({ pairConfigId: 'pc1', sourceAmount: 5 });
  expect(calls[8]?.body).toEqual({ quoteToken: 'qt_1' });
  // Accept sends an (empty) JSON body — AcceptOrderDto is `{}`, not absent.
  expect(calls[5]?.body).toEqual({});
});

test('a non-2xx answer becomes one typed error that keeps the server message', async () => {
  const { client } = fakeApi([{ status: 400, body: { message: ['sourceAmount must be positive'] } }]);
  const err = await client.get('o1').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CancoreApiError);
  expect((err as CancoreApiError).status).toBe(400);
  expect((err as CancoreApiError).message).toMatch(/GET \/orders\/o1 → 400: sourceAmount must be positive/);
});

test('track polls until a terminal status and reports every step', async () => {
  const { calls, client } = fakeApi([
    { body: order('accepted') },
    { body: order('swap_created') },
    { body: order('completed') },
  ]);
  const seen: string[] = [];

  const final = await client.track('o1', { intervalMs: 1, sleep: async () => {}, onUpdate: (o) => seen.push(o.status) });

  expect(final.status).toBe('completed');
  expect(seen).toEqual(['accepted', 'swap_created', 'completed']);
  expect(calls).toHaveLength(3);
});

test('track gives up with the last order in hand, not a bare timeout', async () => {
  const { client } = fakeApi([{ body: order('accepted') }]);
  // A clock the sleeps move — a frozen clock against a deadline loop never ends.
  let clock = 0;
  const err = await client
    .track('o1', {
      intervalMs: 1000,
      timeoutMs: 2500,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    })
    .catch((e: unknown) => e);

  expect(err).toBeInstanceOf(TrackTimeoutError);
  expect((err as TrackTimeoutError).last.status).toBe('accepted');
});
