import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cantonFingerprint, providerFromMnemonic } from '@cancore/wallet';
import { acceptTransferLeg, DEV, selfSendLeg } from './dvp-prepared.fixture';
import { refusalBody, wireLeg } from './wire.fixture';
import { CeremonyError, createSelfCustody, SettleError, UnverifiedTransactionError } from './selfcustody';

/**
 * The self-custody client over real HTTP, in the int lane CI runs (CAN-2934 keeps `npm test` out of CI): a gateway on
 * 127.0.0.1 answers the routes below, and the client talks to it with its own fetch — real requests, status codes,
 * headers and JSON bodies on the wire, the sign-in included. Every prepared leg comes from the same fixtures as the
 * unit tests, so what the key is asked to sign is a real Canton transaction tree.
 *
 * Not a live stand: QA asked for runs against the dev gateway and ledger (CAN-2400, CAN-2421, CAN-2423), which wait on
 * dev database access for the existing rig. This is the in-process half.
 */
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const FAR = Math.floor(Date.now() / 1000) + 3600;
const jwt = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub, exp: FAR })).toString('base64url')}.s`;

type Answer = { status: number; body: unknown };
const answer = (status: number, body: unknown): Answer => ({ status, body });
const refuse = (status: number, message: string, errorCode?: string) => answer(status, refusalBody(status, message, errorCode));
type Handler = (body: Record<string, unknown>) => unknown;

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8').on('data', (chunk: string) => (text += chunk)).on('end', () => resolve(text)).on('error', reject);
  });

/** A gateway on a free port of 127.0.0.1; a route nobody handles answers 404. */
async function gateway(handlers: Record<string, Handler>) {
  const hits: string[] = [];
  const server = createServer(async (req, res) => {
    const route = `${req.method} ${new URL(req.url ?? '/', 'http://x').pathname}`;
    hits.push(route);
    const text = await read(req);
    let out: unknown;
    if (route === 'POST /auth/challenge') out = { challenge: 'Welcome to Cancore 2026-10-28 sig:1' };
    else if (route === 'POST /auth/login-signature') out = { token: jwt('me'), user: {} };
    else out = handlers[route] ? await handlers[route](text ? JSON.parse(text) : {}) : refuse(404, `no route ${route}`);
    const { status, body } = (out as Answer)?.status !== undefined && 'body' in (out as object) ? (out as Answer) : answer(200, out);
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    submitted: () => hits.filter((r) => r === 'POST /wallet/operations/submit').length,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const servers: Array<{ close: () => Promise<void> }> = [];
afterAll(() => Promise.all(servers.map((s) => s.close())));

/** An account of the phrase at `n` on the gateway of `handlers`; devnet pins the instrument admins (localhost names no network). */
async function account(n: number, handlers: (me: string) => Record<string, Handler>, over: Record<string, unknown> = {}) {
  const signer = await providerFromMnemonic(PHRASE, { account: n });
  const me = `party-me::${cantonFingerprint(signer.public_key)}`;
  const api = await gateway({ 'GET /auth/me': () => ({ id: 'me', partyId: me }), ...handlers(me) });
  servers.push(api);
  const acct = createSelfCustody({
    baseUrl: api.baseUrl, signer, network: 'devnet', pollMs: 1,
    sleep: () => new Promise<void>((resolve) => setImmediate(resolve)), ...over,
  });
  return { api, acct, me };
}

describe('CAN-2400: only the DvP refusal is called a DvP refusal, over HTTP', () => {
  const OPEN = {
    id: 'o1', status: 'open', sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceAmount: '0.01', targetNetwork: 'canton',
    targetTokenAddress: 'CC', targetAmount: '5000', initiatorUserId: 'maker', opponentUserId: null, opponent: null, swapId: null, dvp: true,
  };
  const offer = {
    sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceTokenName: 'CBTC', sourceAmount: '0.01',
    targetNetwork: 'canton', targetTokenAddress: 'CC', targetTokenName: 'CC', targetAmount: '5000',
  };
  /** A gateway that refuses taking o1, placing an order and placing a pair order with the same 403. */
  const refusing = (n: number, message: string, errorCode?: string) =>
    account(n, () => ({
      'GET /orders/o1': () => OPEN,
      'GET /htlc/dvp/instruments': () => [{ id: 'CBTC', admin: DEV.cbtcRegistrar }, { id: 'CC', admin: DEV.dso }],
      'POST /orders/o1/accept': () => refuse(403, message, errorCode),
      'POST /orders': () => refuse(403, message, errorCode),
      'GET /trading-pairs/p1': () => ({ id: 'p1', baseToken: { network: 'canton' }, quoteToken: { network: 'canton' } }),
      'POST /orders/pair': () => refuse(403, message, errorCode),
    }));
  const asTheApiSaidIt = (error: unknown, message: string) => {
    expect(error).toMatchObject({ name: 'CancoreApiError', status: 403 });
    expect(error).not.toBeInstanceOf(SettleError);
    expect((error as Error).message).toContain(message);
    expect((error as Error).message).not.toMatch(/allocation-DvP/i);
  };

  test('@happy G0-CAN-2400.1: the DvP refusal by its code DVP_NOT_ALLOWED is said as a DvP refusal at take and at placing an order', async () => {
    const { api, acct } = await refusing(701, 'refused', 'DVP_NOT_ALLOWED');
    const taken = await acct.take('o1').catch((e: unknown) => e);
    expect(taken).toBeInstanceOf(SettleError);
    expect((taken as Error).message).toMatch(/taking order o1: allocation-DvP is not open to this account/);
    await expect(acct.swap.create(offer)).rejects.toThrow(/placing the order: allocation-DvP is not open to this account/);
    expect(api.hits).toEqual(expect.arrayContaining(['POST /orders/o1/accept', 'POST /orders']));
    expect(api.submitted()).toBe(0);
  });

  test('@edge G0-CAN-2400.2: a gateway that sends no code is still read as the DvP refusal by its words', async () => {
    const words = 'Allocation-DvP is not open to this account on this stand. A DvP trade needs a self-custody, staff/bot or allowlisted party on at least one side.';
    const { acct } = await refusing(702, words);
    await expect(acct.take('o1')).rejects.toBeInstanceOf(SettleError);
    await expect(acct.swap.create(offer)).rejects.toThrow(/placing the order: allocation-DvP is not open to this account/);
  });

  test.each([
    ['@negative G0-CAN-2400.3: self-trade inside one owner\'s family', 'Self-trade is not allowed: the order initiator and acceptor belong to the same person.', undefined],
    ['@negative G0-CAN-2400.4: documents not accepted', 'The platform documents must be accepted before trading.', undefined],
    ['@edge G0-CAN-2400.5: a code this client does not know (a stopped bot)', 'This bot account was stopped by its owner: it cannot make or take orders until the owner resumes it', 'ACCOUNT_STOPPED'],
    ['@edge G0-CAN-2400.5: a 403 that says nothing', 'Forbidden', undefined],
  ])('%s reaches the caller as the CancoreApiError it is, at take, placing an order and placing a pair order', async (_what, message, errorCode) => {
    const { api, acct } = await refusing(703 + message.length % 50, message, errorCode);
    asTheApiSaidIt(await acct.take('o1').catch((e: unknown) => e), message);
    asTheApiSaidIt(await acct.swap.create(offer).catch((e: unknown) => e), message);
    asTheApiSaidIt(await acct.swap.createForPair({ tradingPairId: 'p1', sourceAmount: '1', targetAmount: '2' }).catch((e: unknown) => e), message);
    expect(api.submitted()).toBe(0);
  });
});

describe('CAN-2421: a fee split sends only through the DSO\'s own preapproval, over HTTP', () => {
  const FEE = '24.8756218905';
  type Over = Partial<Parameters<typeof selfSendLeg>[0]>;
  /** A gateway quoting a 0.125 CC network fee, no fee debt, 10 000 CC held, and preparing the split with `over` applied to its transfer leg. */
  const splitting = (n: number, over: Over = {}) =>
    account(n, (me) => ({
      [`GET /tokens/balance/${encodeURIComponent(me)}/CC`]: () => ({ balance: '10000', holdingsCount: 1 }),
      'GET /tokens/transfer/estimate-fee': () => ({ networkFee: 0.125 }),
      'GET /tokens/fee-debt': () => ({ outstandingCc: '0' }),
      'POST /wallet/operations/prepare': async () => ({
        operationId: 'split',
        meta: {},
        legs: [
          wireLeg(await selfSendLeg({ party: me, kind: 'transfer', receiver: me, input: '10000', ids: 'a', outputs: [{ owner: me, amount: FEE }, { owner: me, amount: '9975.1243781095' }], ...over }), 'l1'),
          wireLeg(await selfSendLeg({ party: me, kind: 'fee', receiver: DEV.venue, input: '10', ids: 'b', outputs: [{ owner: DEV.venue, amount: '0.125' }, { owner: me, amount: '9.875' }] }), 'l2'),
        ],
      }),
      'POST /wallet/operations/submit': () => ({ updateId: 'u1', outcome: 'committed' }),
    }));
  const MALLORY = 'mallory::1220ff';

  test('@happy G0-CAN-2421.1: a split through the preapproval the DSO signed is read, signed and submitted', async () => {
    const { api, acct } = await splitting(711);
    await expect(acct.splitForFee('CC', FEE)).resolves.toEqual({ verified: true });
    expect(api.submitted()).toBe(1);
  });

  test('@negative G0-CAN-2421.2: a preapproval somebody else signed (the 0.8.0 hole) is refused before the key signs', async () => {
    const { api, acct } = await splitting(712, { preapproval: (c) => ({ ...c, signatories: [MALLORY], stakeholders: [MALLORY, c.stakeholders[1] ?? MALLORY] }) });
    await expect(acct.splitForFee('CC', FEE)).rejects.toThrow(/preapproval the instrument admin did not sign/);
    expect(api.submitted()).toBe(0);
  });

  test('@edge G0-CAN-2421.3: a command that claims the DSO for a contract that does not carry its signature is refused too', async () => {
    const { api, acct } = await splitting(713, { preapproval: (c) => ({ ...c, signatories: [c.stakeholders[1] ?? MALLORY, DEV.venue] }), commandSignatories: [DEV.dso, DEV.venue] });
    await expect(acct.splitForFee('CC', FEE)).rejects.toThrow(/preapproval the instrument admin did not sign/);
    expect(api.submitted()).toBe(0);
  });
});

describe('CAN-2423: the bot pays its own network fee, so no debt is left behind, over HTTP', () => {
  const OWNER = 'party-owner::1220bb';
  const feeLeg = async (me: string, amount: string, id: string) =>
    wireLeg(await selfSendLeg({ party: me, kind: 'fee', receiver: DEV.venue, input: '100', ids: 'b', outputs: [{ owner: DEV.venue, amount }, { owner: me, amount: (100 - Number(amount)).toFixed(10) }] }), id);
  /** A gateway whose `tokens.send` defers its network fee of `deferred` CC to a `tokens.send-fee` ceremony of its own. */
  const sending = (n: number, deferred: string) => {
    const prepared: string[] = [];
    return account(n, (me) => ({
      'POST /wallet/operations/prepare': async (body) => {
        prepared.push(String(body.type));
        return body.type === 'tokens.send'
          ? { operationId: 'send', meta: { feeDeferred: { amount: Number(deferred) } }, legs: [wireLeg(await selfSendLeg({ party: me, kind: 'transfer', receiver: OWNER, input: '10000', ids: 'a', outputs: [{ owner: OWNER, amount: '100' }, { owner: me, amount: '9900' }] }), 't')] }
          : { operationId: 'fee', meta: {}, legs: [await feeLeg(me, deferred, 'f')] };
      },
      'POST /wallet/operations/submit': () => ({ updateId: 'u1', outcome: 'committed' }),
    }), { maxFee: '10' }).then((a) => ({ ...a, prepared }));
  };

  test('@happy G0-CAN-2423.1: a send whose fee the API deferred pays it at once through tokens.send-fee: nothing is owed', async () => {
    const { api, acct, prepared } = await sending(721, '9.4');
    await expect(acct.send({ receiverPartyId: OWNER, amount: '100' })).resolves.toMatchObject({ outcome: 'committed', deferredFee: 'paid' });
    expect(prepared).toEqual(['tokens.send', 'tokens.send-fee']);
    expect(api.submitted()).toBe(2);
  });

  test('@negative G0-CAN-2423.2: a deferred fee above the account\'s ceiling is not signed: the send stands and the fee is reported owed', async () => {
    const { api, acct } = await sending(722, '12');
    const out = await acct.send({ receiverPartyId: OWNER, amount: '100' });
    expect(out).toMatchObject({ outcome: 'committed', deferredFee: 'owed' });
    expect((out as { feeError?: CeremonyError }).feeError?.cause).toBeInstanceOf(UnverifiedTransactionError);
    expect(api.submitted()).toBe(1);
  });

  test('@edge G0-CAN-2423.3: an incoming transfer accepted with a fee budget asks for the fee leg and pays it in the same transaction', async () => {
    const asked: Array<Record<string, unknown>> = [];
    let signatures = 0;
    const { acct } = await account(723, (me) => ({
      'GET /tokens/transfer-requests/incoming': () => [
        { contractId: 'ti-1', templateId: 't', instrumentAdmin: DEV.cbtcRegistrar, instrumentId: 'CBTC', executeBefore: new Date(Date.now() + 60_000).toISOString() },
      ],
      'POST /wallet/operations/prepare': async (body) => {
        const params = body.params as { instructionCid: string; withFeeLeg?: boolean };
        asked.push(params);
        const accept = await acceptTransferLeg({ party: me, sender: DEV.venue, instrument: { id: 'CBTC', admin: DEV.cbtcRegistrar }, amount: '1', offerCid: params.instructionCid });
        return { operationId: 'accept', meta: null, legs: [wireLeg(accept, 'a'), ...(params.withFeeLeg ? [await feeLeg(me, '2', 'f')] : [])] };
      },
      'POST /wallet/operations/submit': (body) => ((signatures += (body.signatures as unknown[]).length), { outcome: 'committed' }),
    }));
    const { accepted, failed } = await acct.acceptIncoming(undefined, { maxFee: '2' });
    expect([accepted.length, failed.length]).toEqual([1, 0]);
    expect(asked[0]).toMatchObject({ instructionCid: 'ti-1', withFeeLeg: true });
    // The accept and its fee leg, both signed in one submit: the bot's fee is paid, not left as debt.
    expect(signatures).toBe(2);
  });
});
