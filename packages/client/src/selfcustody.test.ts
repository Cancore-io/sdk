import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { providerFromMnemonic } from '@cancore/wallet';
import type { FetchLike } from './http';
import { createSelfCustody, grossAmount, legalConsentMessage, sha256Hex, type IncomingTransfer } from './selfcustody';
import { createSession, expiresWithin } from './session';

/**
 * A fake venue that settles one Canton↔Canton swap the way the API does: every
 * leg it prepares must come back signed by the key of the account that asked,
 * and each submit moves the swap on. Two accounts from one phrase trade against
 * it concurrently, so the maker's and the taker's loops meet in the middle
 * exactly as they would against a stand.
 */
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const FAR = Math.floor(Date.now() / 1000) + 3600;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));
const hex = (text: string) => new Uint8Array(Buffer.from(text, 'hex'));
const jwt = (sub: string, exp = FAR) =>
  `h.${Buffer.from(JSON.stringify({ sub, exp })).toString('base64url')}.s`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refuse = (status: number, message: string) => json({ statusCode: status, message }, status);

interface Account { publicKey: string; id: string; partyId: string | null; roles: string[] }
interface Leg { legId: string; hash: string; kind: string }
interface Pending { type: string; params: Record<string, unknown>; legs: Leg[]; owner: Account }

function venue({ staleDepositOnce = false } = {}) {
  const accounts = new Map<string, Account>(); // by bearer token
  const byKey = new Map<string, Account>();
  const pending = new Map<string, Pending>();
  const log: Array<{ type: string; params: Record<string, unknown> }> = [];
  const prepared: string[] = [];
  const routes = new Set<string>();
  let staleDeposit = staleDepositOnce;
  const challenges = new Set<string>();
  const order = {
    id: 'o1', status: 'open', sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceAmount: '0.01',
    targetNetwork: 'canton', targetTokenAddress: 'CC', targetAmount: '5000',
    initiatorUserId: 'maker', opponentUserId: null as string | null, opponent: null as { partyId: string } | null,
    swapId: null as string | null,
  };
  let swap: Record<string, unknown> | null = null;
  let counterPollsLeft = 0;
  const incoming: IncomingTransfer[] = [];
  let seq = 0;

  const verify = (owner: Account, leg: Leg, signature: string) => {
    const ok = ed25519.verify(unb64(signature), unb64(leg.hash), hex(owner.publicKey));
    if (!ok) throw new Error(`leg ${leg.legId} (${leg.kind}) is not signed by ${owner.id}`);
  };
  const leg = (kind: string, bytes = 32): Leg => {
    const raw = new Uint8Array(bytes).map(() => Math.floor(Math.random() * 256));
    if (kind === 'topology') raw.set([0x12, 0x20]);
    return { legId: `leg-${++seq}`, hash: b64(raw), kind };
  };

  function prepare(owner: Account, type: string, params: Record<string, unknown>): Response {
    let legs: Leg[];
    let meta: Record<string, unknown> = {};
    switch (type) {
      case 'wallet.topology': legs = [leg('topology', 34), leg('topology', 34)]; break;
      case 'tokens.preapproval': legs = owner.roles.includes('has-preapproval') ? [] : [leg('setup')]; meta = { alreadyExists: legs.length === 0 }; break;
      case 'htlc.flow-b-create': legs = [leg('escrow'), leg('transfer')]; meta = { swapId: 's1' }; break;
      case 'htlc.accept-deposit-counter': legs = [leg('transfer'), leg('escrow'), leg('transfer')]; break;
      case 'htlc.accept-counter':
        if (counterPollsLeft > 0) return refuse(400, 'Counter proposal not found on swap');
        legs = [leg('transfer')];
        break;
      case 'tokens.accept': legs = [leg('transfer')]; break;
      default: return refuse(400, `unknown operation ${type}`);
    }
    const operationId = `op-${++seq}`;
    prepared.push(type);
    pending.set(operationId, { type, params, legs, owner });
    return json({ operationId, legs, meta });
  }

  function submit(caller: Account, operationId: string, signatures: Array<{ legId: string; signature: string }>): Response {
    const op = pending.get(operationId);
    if (!op || op.owner !== caller) return refuse(404, 'unknown operation');
    for (const l of op.legs) verify(caller, l, signatures.find((s) => s.legId === l.legId)?.signature ?? '');
    pending.delete(operationId);
    if (op.type === 'htlc.accept-deposit-counter' && staleDeposit) {
      staleDeposit = false;
      return refuse(400, 'No pending accept-deposit submission found for this key');
    }
    log.push({ type: op.type, params: op.params });
    switch (op.type) {
      case 'wallet.topology': caller.partyId = `party-${caller.id}`; break;
      case 'tokens.preapproval': caller.roles.push('has-preapproval'); break;
      case 'htlc.flow-b-create':
        swap = { id: 's1', status: 'proposal_created', sender: caller.partyId, receiver: op.params.receiver, hashLock: op.params.hashLock };
        order.swapId = 's1';
        break;
      case 'htlc.accept-deposit-counter': swap!.status = 'htlc_active'; counterPollsLeft = 2; break;
      case 'htlc.accept-counter': swap!.status = 'counter_accepted'; break;
      case 'tokens.accept': incoming.splice(incoming.findIndex((t) => t.contractId === op.params.instructionCid), 1); break;
    }
    return json({ ok: true });
  }

  const fetchImpl: FetchLike = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const bearer = (init.headers as Record<string, string>).authorization?.replace('Bearer ', '');
    const caller = bearer ? accounts.get(bearer) : undefined;
    const route = `${init.method} ${pathname}`;
    routes.add(`${String(init.method).toLowerCase()} ${pathname.replace(/\/(o1|s1)(?=\/|$)/, '/{id}')}`);

    if (route === 'POST /auth/challenge' || route === 'POST /auth/register-challenge') {
      const challenge = `Welcome to Cancore 2026-09-28 sig:${++seq}`;
      challenges.add(challenge);
      return json({ challenge, expiresAt: Date.now() + 300_000 });
    }
    if (route === 'POST /auth/login-signature' || route === 'POST /auth/register') {
      if (!challenges.delete(body.challenge)) return refuse(401, 'unknown challenge');
      if (!ed25519.verify(hex(body.signature), new TextEncoder().encode(body.challenge), hex(body.publicKey))) return refuse(401, 'bad signature');
      let account = byKey.get(body.publicKey);
      if (route === 'POST /auth/register') {
        if (account || body.signingMethod !== 'passkey' || !body.partyName) return refuse(400, 'bad registration');
        account = { publicKey: body.publicKey, id: body.partyName, partyId: null, roles: ['user'] };
        byKey.set(body.publicKey, account);
      }
      if (!account) return refuse(404, 'ACCOUNT_NOT_FOUND');
      const token = jwt(account.id);
      accounts.set(token, account);
      return json({ token, refreshToken: `r-${token}`, user: account });
    }
    if (!caller) return refuse(401, 'Unauthorized');
    if (route === 'POST /auth/redeem-invite') {
      if (body.code !== 'ABCD-EFGH-JKMN') return refuse(404, 'unknown code');
      caller.roles.push('partner-bot');
      return json({ success: true, role: 'partner-bot' });
    }
    if (route === 'GET /auth/me') return json(caller);
    if (route === 'POST /wallet/operations/prepare') return prepare(caller, body.type, body.params ?? {});
    if (route === 'POST /wallet/operations/submit') return submit(caller, body.operationId, body.signatures);
    if (route === 'GET /orders/o1') return json(order);
    if (route === 'POST /orders/o1/accept') {
      order.status = 'accepted';
      order.opponentUserId = caller.id;
      order.opponent = { partyId: caller.partyId! };
      return json(order);
    }
    if (route === 'GET /htlc/fee-config') return json({ feeRate: '0.0050000000' });
    if (route === 'GET /htlc/timeout-options') {
      return searchParams.get('orderId') === 'o1' ? json({ timeoutHours: [4, 1, 2] }) : refuse(400, 'no order');
    }
    if (route === 'GET /htlc/s1') {
      if (counterPollsLeft > 0) counterPollsLeft--;
      return json(swap);
    }
    if (route === 'POST /htlc/s1/claim') {
      if (swap!.status !== 'counter_accepted') return refuse(400, `swap is ${swap!.status}`);
      if ((await sha256Hex(body.preimage)) !== swap!.hashLock) return refuse(400, 'wrong preimage');
      swap!.status = 'both_claimed';
      // CBTC to the taker is a registry transfer the taker must accept; CC to the maker is direct.
      incoming.push({
        contractId: 'ti-delivery', templateId: 'Splice.Api.Token.TransferInstruction', transferId: 't1',
        sender: 'escrow', receiver: String(swap!.receiver), amount: '0.01', instrumentId: 'CBTC',
        instrumentAdmin: 'cbtc-admin', memo: '', requestedAt: new Date().toISOString(),
        executeBefore: new Date(Date.now() + 3_600_000).toISOString(),
        swapContext: { swapId: 's1', orderId: 'o1', swapStatus: 'both_claimed', leg: 'main' },
      });
      return json(swap);
    }
    if (route === 'GET /tokens/transfer-requests/incoming') return json(incoming.filter((t) => t.receiver === caller.partyId));
    return refuse(404, `no route ${route}`);
  };

  return { fetchImpl, log, prepared, routes, order, incoming, byKey };
}

const baseUrl = 'https://api.example';
// Yield a macrotask per wait: an instantly-resolving sleep would starve jest's own timers.
const fast = { pollMs: 1, sleep: () => new Promise<void>((resolve) => setImmediate(resolve)) };

test('two self-custody accounts from one phrase register, onboard and settle a Canton↔Canton order end to end', async () => {
  const api = venue();
  const [makerKey, takerKey] = await Promise.all([
    providerFromMnemonic(PHRASE, { account: 0 }),
    providerFromMnemonic(PHRASE, { account: 1 }),
  ]);
  const maker = createSelfCustody({ baseUrl, signer: makerKey, fetchImpl: api.fetchImpl, ...fast });
  const taker = createSelfCustody({ baseUrl, signer: takerKey, fetchImpl: api.fetchImpl, ...fast });

  const registered = await maker.session.register({ partyName: 'maker', inviteCode: 'ABCD-EFGH-JKMN' });
  expect(registered.roles).toContain('partner-bot');
  await taker.session.register({ partyName: 'taker' });
  await Promise.all([maker.onboard(), taker.onboard()]);
  // Onboarding again changes nothing: the party exists and the preapproval too.
  await maker.onboard();
  expect(api.log.filter((e) => e.type === 'wallet.topology')).toHaveLength(2);
  expect(api.log.filter((e) => e.type === 'tokens.preapproval')).toHaveLength(2);

  const [made, taken] = await Promise.all([maker.make('o1'), taker.take('o1')]);

  const create = api.log.find((e) => e.type === 'htlc.flow-b-create')!.params;
  expect(create).toMatchObject({
    tokenId: 'CBTC',
    amount: grossAmount('0.01', '0.005'),
    timeoutHours: 1, // the shortest the stand offers for this order
    receiver: 'party-taker',
    orderId: 'o1',
  });
  expect(await sha256Hex(String(create.encryptedPreimage))).toBe(create.hashLock);
  expect(api.log.find((e) => e.type === 'htlc.accept-deposit-counter')!.params).toEqual({
    swapId: 's1', counterTokenId: 'CC', counterAmount: grossAmount('5000', '0.005'),
  });
  expect(made).toMatchObject({ swap: { status: 'both_claimed' }, delivery: 'direct' });
  expect(taken).toMatchObject({ swap: { status: 'both_claimed' }, delivery: 'accepted' });
  expect(api.log.find((e) => e.type === 'tokens.accept')!.params).toMatchObject({
    instructionCid: 'ti-delivery', templateId: 'Splice.Api.Token.TransferInstruction', adminPartyId: 'cbtc-admin',
  });
  expect(api.incoming).toHaveLength(0);

  // Every route the whole flow touched is one the gateway documents, with that method.
  const spec = JSON.parse(readFileSync(join(__dirname, '..', 'spec', 'openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const undocumented = [...api.routes].filter((r) => {
    const [method, path] = r.split(' ') as [string, string];
    return spec.paths[path]?.[method] === undefined;
  });
  // Registration signs the account in, so the flow never needs login-signature.
  expect([...api.routes].sort()).toEqual([
    'get /auth/me',
    'get /htlc/fee-config',
    'get /htlc/timeout-options',
    'get /htlc/{id}',
    'get /orders/{id}',
    'get /tokens/transfer-requests/incoming',
    'post /auth/redeem-invite',
    'post /auth/register',
    'post /auth/register-challenge',
    'post /htlc/{id}/claim',
    'post /orders/{id}/accept',
    'post /wallet/operations/prepare',
    'post /wallet/operations/submit',
  ]);
  expect(undocumented).toEqual([]);
});

test('a deposit whose prepared stash expired before the submit is prepared and signed again, once', async () => {
  const api = venue({ staleDepositOnce: true });
  const [makerKey, takerKey] = await Promise.all([
    providerFromMnemonic(PHRASE, { account: 2 }),
    providerFromMnemonic(PHRASE, { account: 3 }),
  ]);
  const maker = createSelfCustody({ baseUrl, signer: makerKey, fetchImpl: api.fetchImpl, ...fast });
  const taker = createSelfCustody({ baseUrl, signer: takerKey, fetchImpl: api.fetchImpl, ...fast });
  await maker.session.register({ partyName: 'maker' });
  await taker.session.register({ partyName: 'taker' });
  await Promise.all([maker.onboard(), taker.onboard()]);

  const [, taken] = await Promise.all([maker.make('o1'), taker.take('o1')]);
  expect(api.prepared.filter((t) => t === 'htlc.accept-deposit-counter')).toHaveLength(2);
  expect(taken.swap.status).toBe('both_claimed');
});

test('the session renews an expiring token and signs in again after a 401', async () => {
  const signer = await providerFromMnemonic(PHRASE);
  const seen: string[] = [];
  let expiring = true;
  let revoked = false;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const auth = (init.headers as Record<string, string>).authorization ?? '';
    seen.push(path);
    if (path === '/auth/challenge') return json({ challenge: 'Welcome to Cancore 2026-09-28 sig:1' });
    if (path === '/auth/login-signature') {
      const token = jwt('a', expiring ? Math.floor(Date.now() / 1000) + 30 : FAR);
      expiring = false;
      return json({ token, refreshToken: 'r1', user: {} });
    }
    if (path === '/auth/refresh') return json({ token: jwt('a'), refreshToken: 'r2' });
    if (revoked) {
      revoked = false;
      return refuse(401, 'Unauthorized');
    }
    return json({ ok: auth.startsWith('Bearer h.') });
  };
  const session = createSession({ baseUrl, signer, fetchImpl });
  await session.login();
  // The token dies in 30 s — inside the renewal margin, so it is refreshed first.
  expect(await (await session.request(`${baseUrl}/x`, { method: 'GET', headers: {} })).json()).toEqual({ ok: true });
  expect(seen).toEqual(['/auth/challenge', '/auth/login-signature', '/auth/refresh', '/x']);

  revoked = true;
  seen.length = 0;
  await session.request(`${baseUrl}/y`, { method: 'GET', headers: {} });
  expect(seen).toEqual(['/y', '/auth/challenge', '/auth/login-signature', '/y']);
});

test('a submit that timed out is resubmitted with the same signatures; a plain execute never re-prepares', async () => {
  const signer = await providerFromMnemonic(PHRASE);
  const submits: string[] = [];
  let prepares = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/auth/challenge') return json({ challenge: 'Welcome to Cancore 2026-09-28 sig:1' });
    if (path === '/auth/login-signature') return json({ token: jwt('a'), user: {} });
    const body = JSON.parse(String(init.body));
    if (path === '/wallet/operations/prepare') {
      prepares++;
      return json({ operationId: `op${prepares}`, legs: [{ legId: 'l', hash: b64(new Uint8Array(32)), kind: 'transfer' }], meta: null });
    }
    submits.push(`${body.operationId}:${body.signatures[0].signature.slice(0, 8)}`);
    if (submits.length === 1) return refuse(400, 'submission timed out — safe to retry with the same signature');
    if (submits.length === 2) return refuse(400, 'No pending submission found for this key');
    return json({ ok: true });
  };
  const acct = createSelfCustody({ baseUrl, signer, fetchImpl, ...fast });
  // `execute` does not re-run a stale prepare — only the accept ceremonies may.
  await expect(acct.execute('htlc.accept-counter', { swapId: 's' })).rejects.toThrow(/No pending/);
  expect(submits[0]).toBe(submits[1]);
  expect(prepares).toBe(1);
});

test('collect accepts exactly the claim’s own payouts, and nothing else in the inbox', async () => {
  const signer = await providerFromMnemonic(PHRASE);
  const accepted: string[] = [];
  const ti = (contractId: string) => ({ contractId, templateId: 't', instrumentAdmin: 'a', executeBefore: new Date(Date.now() + 60_000).toISOString() });
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/auth/challenge') return json({ challenge: 'Welcome to Cancore 2026-09-28 sig:1' });
    if (path === '/auth/login-signature') return json({ token: jwt('a'), user: {} });
    if (path === '/partner/cashback/claim') return json({ id: 'c1', status: 'settling' });
    if (path === '/partner/cashback/claims') {
      return json([{ id: 'c1', status: 'settling', payouts: [
        { id: 'p1', tokenId: 'CC', settlementStatus: 'accepted', transferInstructionCid: null },
        { id: 'p2', tokenId: 'USDCx', settlementStatus: 'pending', transferInstructionCid: 'ti-cashback' },
      ] }]);
    }
    if (path === '/tokens/transfer-requests/incoming') return json([ti('ti-cashback'), ti('ti-unrelated')]);
    const body = JSON.parse(String(init.body));
    if (path === '/wallet/operations/prepare') {
      accepted.push(body.params.instructionCid);
      return json({ operationId: 'op', legs: [{ legId: 'l', hash: b64(new Uint8Array(32)), kind: 'transfer' }], meta: null });
    }
    return json({ ok: true });
  };
  const acct = createSelfCustody({ baseUrl, signer, fetchImpl, ...fast });
  const { pending } = await acct.cashback.collect();
  expect(accepted).toEqual(['ti-cashback']);
  expect(pending).toBe(0);
});

test('acceptTerms signs the exact text the API verifies', async () => {
  const signer = await providerFromMnemonic(PHRASE);
  let posted: Record<string, string> | undefined;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/auth/challenge') return json({ challenge: 'Welcome to Cancore 2026-09-28 sig:1' });
    if (path === '/auth/login-signature') return json({ token: jwt('a'), user: {} });
    if (path === '/auth/me') return json({ id: 'u1', partyId: 'p::1220' });
    posted = JSON.parse(String(init.body));
    return json({});
  };
  const acct = createSelfCustody({ baseUrl, signer, fetchImpl, now: () => Date.parse('2026-09-28T10:00:00.000Z') });
  const documents = [{ key: 'terms-of-use', version: '2026-08-01', url: '/legal/terms-of-use' }, { key: 'privacy', version: '2026-08-01', url: '/legal/privacy' }];
  await acct.acceptTerms('2026-08-01', documents);
  const message = legalConsentMessage({ version: '2026-08-01', partyId: 'p::1220', issuedAt: '2026-09-28T10:00:00.000Z', documents });
  expect(message).toBe(
    'CANCORE_LEGAL_CONSENT_V1\nversion:2026-08-01\nparty:p::1220\nissuedAt:2026-09-28T10:00:00.000Z\ndocuments:privacy@2026-08-01,terms-of-use@2026-08-01',
  );
  expect(ed25519.verify(hex(posted!.signature!), new TextEncoder().encode(message), hex(signer.public_key))).toBe(true);
});

test('grossAmount covers the net after the fee, in exact 1e-10 units rounded up', () => {
  expect(grossAmount('100', '0.005')).toBe(100.5);
  expect(grossAmount('5000', '0.0050000000')).toBe(5025);
  expect(grossAmount('0.0000000001', '0.01')).toBe(0.0000000002);
  expect(grossAmount('0.3', '0')).toBe(0.3);
  // The API's own check: gross ≥ net × (1 + rate) − 1e-8.
  for (const [net, rate] of [['123.4567891234', '0.0075'], ['0.00012345', '0.01'], ['99999.9999999999', '0.005']] as const) {
    expect(grossAmount(net, rate)).toBeGreaterThanOrEqual(parseFloat(net) * (1 + parseFloat(rate)) - 1e-8);
  }
});

test('expiresWithin reads exp from a JWT and leaves an unreadable one to the 401 path', () => {
  expect(expiresWithin(jwt('a', 1000), 60_000, 1000 * 1000 - 30_000)).toBe(true);
  expect(expiresWithin(jwt('a', 1000), 60_000, 1000 * 1000 - 120_000)).toBe(false);
  expect(expiresWithin('not-a-jwt', 60_000, 0)).toBe(false);
});
