import { bridge, LoopReportError, type LoopSubmitter } from './bridge';
import { CancoreApiError } from './http';

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
  await client.registerDeposit({ amount: '25', evmTxHash: '0xdead', sourceChainId: '1' });
  await client.depositAttestation({ amount: '25' });
  await client.buildLoopCommand({ operationType: 'bridgeMint', params: { agreementCid: '00ag', attestationCid: '00at' } });
  await client.reportLoopResult({ operationType: 'bridgeMint', success: true });

  expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.example', '')}`)).toEqual([
    'GET /canton-wallet/bridge/limits',
    'GET /canton-wallet/bridge/history?page=1&pageSize=20',
    'POST /canton-wallet/bridge/check-onboarding',
    'POST /canton-wallet/bridge/estimate-cost',
    'POST /canton-wallet/bridge/mint',
    'POST /canton-wallet/bridge/burn',
    'POST /canton-wallet/bridge/prepare-interactive',
    'POST /canton-wallet/bridge/submit-interactive',
    'POST /canton-wallet/bridge/history/pending-deposit',
    'POST /canton-wallet/bridge/deposit-attestation',
    'POST /canton-wallet/bridge/loop-command',
    'POST /canton-wallet/bridge/loop-result',
  ]);
  expect(calls[3]?.body).toEqual({ operation: 'burn', amount: '10' });
});

test('registerDeposit sends the hash lowercase, as the chain recorder stores it', async () => {
  const { calls, client } = fakeApi({ id: 'row-1' });

  await client.registerDeposit({ amount: '25', evmTxHash: `0x${'AB'.repeat(32)}`, sourceChainId: '1' });

  expect(calls[0]?.body).toEqual({ amount: '25', evmTxHash: `0x${'ab'.repeat(32)}`, sourceChainId: '1' });
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

const COMMAND = { commands: [{ ExerciseCommand: {} }], actAs: ['loop-party'], readAs: [], disclosedContracts: [] };
const DEPOSIT_HASH = `0x${'d'.repeat(64)}`;
const MINT = {
  operationType: 'bridgeMint' as const,
  params: { agreementCid: '00ag', attestationCid: '00at', amount: '25', evmTxHash: DEPOSIT_HASH, sourceChainId: '1' },
};
const MINT_REPORT = { operationType: 'bridgeMint', amount: '25', evmTxHash: DEPOSIT_HASH, sourceChainId: '1' };

/** The two Loop routes, in the order they are called; the report answers with `reportStatus`. */
function loopApi(reportStatus = 200) {
  const events: string[] = [];
  const bodies: Record<string, unknown> = {};
  const request = async (url: string, init: RequestInit) => {
    const route = new URL(url).pathname.replace('/canton-wallet/bridge/', '');
    events.push(route);
    bodies[route] = JSON.parse(String(init.body));
    if (route === 'loop-result') return new Response(reportStatus === 200 ? '' : '{"message":"refused"}', { status: reportStatus });
    return new Response(JSON.stringify(COMMAND));
  };
  return { events, bodies, client: bridge({ baseUrl: 'https://api.example', request }) };
}

// For a Loop party the report is the only writer of its bridge row: the order is
// the contract, and the report must name the deposit so the right row closes.
test('executeLoop builds the command, has the Loop wallet submit it, then reports what the wallet answered', async () => {
  const { events, bodies, client } = loopApi();

  const result = await client.executeLoop(MINT, async (command) => {
    events.push('submit');
    expect(command).toEqual(COMMAND);
    return { update_id: '1220abcd', status: 'succeeded' };
  });

  expect(events).toEqual(['loop-command', 'submit', 'loop-result']);
  expect(bodies['loop-command']).toEqual(MINT);
  expect(bodies['loop-result']).toEqual({ ...MINT_REPORT, success: true, transactionId: '1220abcd' });
  expect(result).toEqual(bodies['loop-result']);
});

test('a burn report carries the recipient and amount, never the holdings it burned', async () => {
  const { bodies, client } = loopApi();
  const burn = {
    operationType: 'bridgeBurn' as const,
    params: { agreementCid: '00ag', holdingCids: ['00h1', '00h2'], amount: '10', ethRecipient: '0xabc', destinationChainId: '1' },
  };

  await client.executeLoop(burn, async () => ({ update_id: '1220abcd' }));

  expect(bodies['loop-result']).toEqual({
    operationType: 'bridgeBurn', success: true, transactionId: '1220abcd', amount: '10', ethRecipient: '0xabc', destinationChainId: '1',
  });
});

const rejects: LoopSubmitter = async () => {
  throw new Error('ledger said no');
};
const answersFailed: LoopSubmitter = async () => ({ status: 'failed', error: { error_message: 'ledger said no' } });

test.each([
  ['rejects', rejects],
  ["resolves with Loop's status: 'failed'", answersFailed],
])('a submit that %s is reported as a failure, then thrown', async (_, submit) => {
  const { events, bodies, client } = loopApi();

  const err = await client.executeLoop(MINT, submit).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(LoopReportError);
  expect((err as Error).message).toBe('ledger said no');
  expect(events).toEqual(['loop-command', 'loop-result']);
  expect(bodies['loop-result']).toEqual({ ...MINT_REPORT, success: false, error: 'ledger said no' });
});

test.each([
  ['an error longer than the DTO takes is cut to 2000 characters', async () => Promise.reject(new Error('x'.repeat(2500))), 'x'.repeat(2000)],
  ["a 'failed' answer without a message", async () => ({ status: 'failed' }), 'The Loop wallet reported the transaction failed'],
  ['a rejection that is not an Error', async () => Promise.reject('popup blocked'), 'popup blocked'],
] as Array<[string, LoopSubmitter, string]>)('the reported error: %s', async (_, submit, error) => {
  const { bodies, client } = loopApi();

  await client.executeLoop(MINT, submit).catch(() => undefined);

  expect(bodies['loop-result']).toEqual({ ...MINT_REPORT, success: false, error });
});

// Loop can reject a transaction that committed. Reported as a failure, a mint's
// row would stay PENDING for good and a burn would get a FAILED row it does not deserve.
test.each([
  ['rejects', rejects],
  ["resolves with Loop's status: 'failed'", answersFailed],
])('a submit that %s is reported and resolved as a success when the caller\'s check says it landed', async (_, submit) => {
  const { events, bodies, client } = loopApi();
  const asked: unknown[] = [];

  const result = await client.executeLoop(MINT, submit, {
    landed: async (input) => {
      asked.push(input);
      return true;
    },
  });

  expect(asked).toEqual([MINT]);
  expect(events).toEqual(['loop-command', 'loop-result']);
  expect(bodies['loop-result']).toEqual({ ...MINT_REPORT, success: true });
  expect(result).toEqual(bodies['loop-result']);
});

test('a submit that did not land is reported as a failure, then thrown', async () => {
  const { bodies, client } = loopApi();

  const err = await client.executeLoop(MINT, rejects, { landed: async () => false, isCancelled: () => false }).catch((e: unknown) => e);

  expect((err as Error).message).toBe('ledger said no');
  expect(bodies['loop-result']).toEqual({ ...MINT_REPORT, success: false, error: 'ledger said no' });
});

// A cancelled burn reported as a failure is one more FAILED withdrawal in the user's history.
test('a cancellation in the wallet is thrown as it is and never reported', async () => {
  const cancelled = new Error('Request rejected by the wallet');
  const { events, client } = loopApi();
  const landed = jest.fn(async () => true);

  const err = await client
    .executeLoop(MINT, async () => Promise.reject(cancelled), { isCancelled: (e) => e === cancelled, landed })
    .catch((e: unknown) => e);

  expect(err).toBe(cancelled);
  expect(events).toEqual(['loop-command']);
  expect(landed).not.toHaveBeenCalled();
});

test('a failed submit is thrown as the submitter threw it', async () => {
  const refused = new Error('ledger said no');
  const { client } = loopApi();

  await expect(client.executeLoop(MINT, async () => Promise.reject(refused))).rejects.toBe(refused);
});

test.each([
  ['went through', async () => ({ update_id: '1220abcd' }), true],
  ['failed', rejects, false],
])('a report the backend refuses is thrown, not swallowed, when the submit %s', async (_, submit, success) => {
  const { client } = loopApi(400);

  const err = await client.executeLoop(MINT, submit).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(LoopReportError);
  const { result, cause } = err as LoopReportError;
  expect(result.success).toBe(success);
  expect(result.transactionId).toBe(success ? '1220abcd' : undefined);
  expect(cause).toBeInstanceOf(CancoreApiError);
});
