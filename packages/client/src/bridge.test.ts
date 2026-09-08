import { bridge } from './bridge';

function fakeApi(reply: unknown) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const request = async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  return { calls, client: bridge({ baseUrl: 'https://api.example', request }) };
}

test('each method hits the bridge route it documents', async () => {
  const { calls, client } = fakeApi({ submissionKey: 'sk', preparedTransactionHash: 'aGFzaA==' });

  await client.limits();
  await client.history({ page: 1, pageSize: 20 });
  await client.checkOnboarding();
  await client.estimateCost({ operation: 'burn', amount: '10' });
  await client.mint({ evmTxHash: '0xdead', sourceChainId: '11155111' });
  await client.burn({ amount: '10', ethRecipient: '0xabc' });
  await client.prepareInteractive({ operation: 'burn', amount: '10', ethRecipient: '0xabc' });
  await client.submitInteractive({ submissionKey: 'sk', signature: 'c2ln' });

  expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.example', '')}`)).toEqual([
    'GET /canton-wallet/bridge/limits',
    'GET /canton-wallet/bridge/history?page=1&pageSize=20',
    'POST /canton-wallet/bridge/check-onboarding',
    'POST /canton-wallet/bridge/estimate-cost',
    'POST /canton-wallet/bridge/mint',
    'POST /canton-wallet/bridge/burn',
    'POST /canton-wallet/bridge/prepare-interactive',
    'POST /canton-wallet/bridge/submit-interactive',
  ]);
  expect(calls[3]?.body).toEqual({ operation: 'burn', amount: '10' });
});

// The self-custody path is the reason the client exists next to the direct
// routes: the hash goes OUT to a signer the client never sees, and only the
// signature comes back in. The signer here proves that is the only exchange.
test('executeInteractive hands the prepared hash to the signer and submits what it returns', async () => {
  const { calls, client } = fakeApi({ submissionKey: 'sk-1', preparedTransactionHash: 'aGFzaA==' });
  const signed: string[] = [];

  await client.executeInteractive({ operation: 'burn', amount: '10', ethRecipient: '0xabc' }, async (hash) => {
    signed.push(hash);
    return `sig(${hash})`;
  });

  expect(signed).toEqual(['aGFzaA==']);
  expect(calls[1]?.body).toEqual({ submissionKey: 'sk-1', signature: 'sig(aGFzaA==)' });
});
