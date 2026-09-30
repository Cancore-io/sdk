import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { providerFromMnemonic } from '@cancore/wallet';
import type { FetchLike } from './http';
import {
  CeremonyError,
  createSelfCustody,
  grossAmount,
  legalConsentMessage,
  SettleError,
  sha256Hex,
  type IncomingTransfer,
  type SelfCustodyOptions,
} from './selfcustody';
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

interface VenueOptions {
  /** The first accept-deposit submit finds its prepared stash already gone. */
  staleDepositOnce?: boolean;
  /**
   * The swap prepare is refused as too fragmented: `once` until the maker merges its 40 small
   * holdings; `always`, with holdings that never compact; `unmergeable`, with nothing to merge.
   */
  fragmented?: 'once' | 'always' | 'unmergeable';
  /**
   * The swap submit answers 500 although the swap row exists; the command then `commits` a few
   * polls later, stays `stuck` in init_request_created, or lands `cancelled`.
   */
  flowBSubmitFails?: 'commits' | 'stuck' | 'cancelled';
  /** The proposal is rejected on the ledger right after it is created. */
  rejectAfterCreate?: boolean;
  /** The counter leg is accepted by an earlier attempt: the next accept says so. */
  counterAcceptedElsewhere?: boolean;
}

function venue({
  staleDepositOnce = false,
  fragmented,
  flowBSubmitFails,
  rejectAfterCreate = false,
  counterAcceptedElsewhere = false,
}: VenueOptions = {}) {
  const accounts = new Map<string, Account>(); // by bearer token
  const byKey = new Map<string, Account>();
  const pending = new Map<string, Pending>();
  const log: Array<{ type: string; params: Record<string, unknown> }> = [];
  const prepared: string[] = [];
  /** Every prepare asked for, refused or not. */
  const asked: string[] = [];
  /** What the preimage route answered the sender, each time it asked: null while the gate withholds it. */
  const preimageReads: Array<string | null> = [];
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
  let mergeable = fragmented === 'once' || fragmented === 'always' ? 40 : 0;
  let fragmentedRefusals = 0;
  let commitPollsLeft = 0;
  let storedPreimage: string | null = null;
  let counterLocked = false;
  const claims: string[] = [];
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
    asked.push(type);
    switch (type) {
      case 'wallet.topology': legs = [leg('topology', 34), leg('topology', 34)]; break;
      case 'tokens.preapproval': legs = owner.roles.includes('has-preapproval') ? [] : [leg('setup')]; meta = { alreadyExists: legs.length === 0 }; break;
      case 'htlc.flow-b-create':
        if (fragmented && (fragmented !== 'once' || fragmentedRefusals === 0)) {
          // A heal loop that never ends would spin here forever: the fifth refusal is one the SDK does not heal.
          if (++fragmentedRefusals > 4) return refuse(400, 'the fake venue ends a heal loop that does not end');
          return refuse(409, 'Wallet too fragmented: the deposit leg needs more holdings than Canton allows in one command.');
        }
        legs = [leg('escrow'), leg('transfer')];
        meta = { swapId: 's1' };
        break;
      case 'tokens.consolidate':
        legs = mergeable > 0 ? [leg('transfer')] : [];
        meta = mergeable > 0 ? { mergedCount: mergeable } : {};
        break;
      case 'htlc.accept-deposit-counter': legs = [leg('transfer'), leg('escrow'), leg('transfer')]; break;
      case 'htlc.accept-counter':
        if (counterAcceptedElsewhere) {
          swap!.status = 'counter_accepted';
          return refuse(400, 'Counter proposal already accepted');
        }
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
        storedPreimage = String(op.params.encryptedPreimage);
        if (rejectAfterCreate) swap.status = 'proposal_rejected';
        if (flowBSubmitFails) {
          // The row exists and the command is still in flight: it lands a few polls later, or never.
          swap.status = 'init_request_created';
          commitPollsLeft = flowBSubmitFails === 'stuck' ? 0 : 3;
          return refuse(500, 'Canton did not answer in time');
        }
        break;
      case 'tokens.consolidate': if (fragmented !== 'always') mergeable = 0; break;
      case 'htlc.accept-deposit-counter': swap!.status = 'htlc_active'; counterLocked = true; counterPollsLeft = 2; break;
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
      if (commitPollsLeft > 0 && --commitPollsLeft === 0) swap!.status = flowBSubmitFails === 'cancelled' ? 'proposal_cancelled' : 'proposal_created';
      return json(swap);
    }
    if (route === 'GET /htlc/s1/preimage') {
      // Decrypted for the sender only, and — the API's BUG-137 atomicity gate — before a claim only
      // once the counter leg is locked: earlier, it would let the main leg be claimed with nothing in return.
      if (caller.partyId !== swap?.sender) return refuse(403, 'not the sender');
      const gated = (swap.status === 'proposal_created' || swap.status === 'htlc_active') && !counterLocked;
      const senderPreimage = gated ? null : storedPreimage;
      preimageReads.push(senderPreimage);
      return json({ revealed: false, senderPreimage });
    }
    if (route === 'POST /htlc/s1/claim') {
      claims.push(body.preimage);
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

  /** A swap the maker opened before its process died: the row, the order link, the stored preimage (unless none was stored). */
  async function openedEarlier(makerParty: string, takerParty: string, preimage: string, { status = 'proposal_created', stored = true } = {}) {
    swap = { id: 's1', status, sender: makerParty, receiver: takerParty, hashLock: await sha256Hex(preimage) };
    order.swapId = 's1';
    storedPreimage = stored ? preimage : null;
  }

  return { fetchImpl, log, prepared, asked, preimageReads, routes, order, incoming, byKey, claims, openedEarlier };
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

/** Two accounts of one phrase, signed up and onboarded against `api`; `makerOptions` override the maker's clock and sleep. */
async function tradingPair(api: ReturnType<typeof venue>, accounts: [number, number], makerOptions: Partial<SelfCustodyOptions> = {}) {
  const [makerKey, takerKey] = await Promise.all(accounts.map((account) => providerFromMnemonic(PHRASE, { account })));
  const maker = createSelfCustody({ baseUrl, signer: makerKey!, fetchImpl: api.fetchImpl, ...fast, ...makerOptions });
  const taker = createSelfCustody({ baseUrl, signer: takerKey!, fetchImpl: api.fetchImpl, ...fast });
  await maker.session.register({ partyName: 'maker' });
  await taker.session.register({ partyName: 'taker' });
  await Promise.all([maker.onboard(), taker.onboard()]);
  return { maker, taker };
}

const swapsOpened = (api: ReturnType<typeof venue>) => api.prepared.filter((t) => t === 'htlc.flow-b-create').length;
const askedFor = (api: ReturnType<typeof venue>, type: string) => api.asked.filter((t) => t === type).length;

/** A clock that moves only while the SDK sleeps: a wait minutes long ends in a few dozen polls. */
function sleepingClock(stepMs = 10_000) {
  let clock = 0;
  return {
    now: () => clock,
    sleep: () => {
      clock += stepMs;
      return fast.sleep();
    },
  };
}

describe('the paths where a mistake costs money', () => {
  test('a wallet too fragmented for one command is merged by its own key, then the swap is prepared once more', async () => {
    const api = venue({ fragmented: 'once' });
    const { maker, taker } = await tradingPair(api, [4, 5]);
    const [made] = await Promise.all([maker.make('o1'), taker.take('o1')]);
    expect(made.swap.status).toBe('both_claimed');
    // The refused prepare opened nothing; the merge ran on the maker's key; then exactly one swap.
    const order = api.log.map((e) => e.type);
    expect(order.indexOf('tokens.consolidate')).toBeLessThan(order.indexOf('htlc.flow-b-create'));
    expect(api.log.find((e) => e.type === 'tokens.consolidate')!.params).toEqual({ tokenId: 'CBTC' });
    expect(swapsOpened(api)).toBe(1);
  });

  test('a wallet that stays too fragmented is healed once — the swap is retried once, then the refusal surfaces', async () => {
    const api = venue({ fragmented: 'always' });
    const { maker, taker } = await tradingPair(api, [14, 15]);
    await taker.swap.accept('o1');
    const error = await maker.make('o1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CeremonyError);
    expect(error).toMatchObject({ operation: 'htlc.flow-b-create', stage: 'prepare', cause: { status: 409 } });
    // One heal of three merge passes (each merged something), one retry — never a second round of paid merges.
    expect(api.log.filter((e) => e.type === 'tokens.consolidate')).toHaveLength(3);
    expect(askedFor(api, 'htlc.flow-b-create')).toBe(2);
    expect(swapsOpened(api)).toBe(0);
  });

  test('a wallet refused as too fragmented with nothing to merge is not retried', async () => {
    const api = venue({ fragmented: 'unmergeable' });
    const { maker, taker } = await tradingPair(api, [16, 17]);
    await taker.swap.accept('o1');
    const error = await maker.make('o1').catch((e: unknown) => e);
    expect(error).toMatchObject({ operation: 'htlc.flow-b-create', stage: 'prepare', cause: { status: 409 } });
    // The first merge pass found nothing: no more passes, and no retry of a swap that would be refused again.
    expect(askedFor(api, 'tokens.consolidate')).toBe(1);
    expect(askedFor(api, 'htlc.flow-b-create')).toBe(1);
  });

  test('a swap submit that fails but commits later is followed — a second swap is never opened', async () => {
    const api = venue({ flowBSubmitFails: 'commits' });
    const { maker, taker } = await tradingPair(api, [6, 7]);
    const [made, taken] = await Promise.all([maker.make('o1'), taker.take('o1')]);
    expect(swapsOpened(api)).toBe(1);
    expect(made.swap.status).toBe('both_claimed');
    expect(taken.delivery).toBe('accepted');
  });

  test.each([
    ['never leaves init_request_created within the recovery window', 'stuck', [22, 23]],
    ['lands cancelled', 'cancelled', [24, 25]],
  ] as const)('a swap submit that fails and then %s surfaces the failure — a second swap is never prepared', async (_, outcome, accounts) => {
    const api = venue({ flowBSubmitFails: outcome });
    const { maker, taker } = await tradingPair(api, [...accounts], sleepingClock());
    await taker.swap.accept('o1');
    const error = await maker.make('o1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CeremonyError);
    expect(error).toMatchObject({ operation: 'htlc.flow-b-create', stage: 'submit', meta: { swapId: 's1' } });
    expect(askedFor(api, 'htlc.flow-b-create')).toBe(1);
  });

  test('a maker restarted before the taker deposits resumes the swap, reads the preimage back for the claim, and opens nothing new', async () => {
    const api = venue();
    let waitingOnTaker!: () => void;
    const waiting = new Promise<void>((resolve) => (waitingOnTaker = resolve));
    const { maker, taker } = await tradingPair(api, [8, 9], {
      sleep: () => {
        waitingOnTaker();
        return fast.sleep();
      },
    });
    await taker.swap.accept('o1');
    const preimage = 'ab'.repeat(32);
    await api.openedEarlier((await maker.me()).partyId!, (await taker.me()).partyId!, preimage);

    // Back while the swap is proposal_created and the counter leg is not locked: the API would answer
    // the preimage with null, so the maker waits on the taker without asking for it.
    const making = maker.make('o1');
    await Promise.race([waiting, making]);
    expect(api.preimageReads).toEqual([]);

    const [made] = await Promise.all([making, taker.take('o1')]);
    expect(made.swap.status).toBe('both_claimed');
    expect(swapsOpened(api)).toBe(0);
    expect(api.preimageReads).toEqual([preimage]);
    expect(api.claims).toEqual([preimage]);
  });

  test('the venue, like the API, withholds the maker’s preimage until the counter leg is locked', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [18, 19]);
    await taker.swap.accept('o1');
    const preimage = 'cd'.repeat(32);
    await api.openedEarlier((await maker.me()).partyId!, (await taker.me()).partyId!, preimage);
    const read = async () =>
      ((await (await maker.session.request(`${baseUrl}/htlc/s1/preimage`, { method: 'GET', headers: {} })).json()) as { senderPreimage: string | null })
        .senderPreimage;

    expect(await read()).toBeNull();
    await taker.execute('htlc.accept-deposit-counter', { swapId: 's1', counterTokenId: 'CC', counterAmount: grossAmount('5000', '0.005') });
    expect(await read()).toBe(preimage);
  });

  test('a resumed swap whose preimage the API never releases ends in a SettleError at the deadline, and nothing is claimed', async () => {
    const api = venue();
    const { maker, taker } = await tradingPair(api, [20, 21], sleepingClock());
    await taker.swap.accept('o1');
    // The maker died after accepting the counter leg, and the API kept no preimage for it.
    await api.openedEarlier((await maker.me()).partyId!, (await taker.me()).partyId!, 'ef'.repeat(32), {
      status: 'counter_accepted',
      stored: false,
    });
    const error = await maker.make('o1', { deadlineMs: 10 * 60_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettleError);
    expect(error).toMatchObject({ swapId: 's1', message: expect.stringMatching(/preimage is not recoverable/) });
    // A null is waited on until the deadline, not taken as final on the first read.
    expect(api.preimageReads.length).toBeGreaterThan(1);
    expect(api.claims).toEqual([]);
  });

  test('a proposal rejected on the ledger ends both sides with a SettleError naming the swap — nothing funded, nothing claimed', async () => {
    const api = venue({ rejectAfterCreate: true });
    const { maker, taker } = await tradingPair(api, [10, 11]);
    const [made, taken] = await Promise.allSettled([maker.make('o1'), taker.take('o1')]);
    for (const outcome of [made, taken]) {
      expect(outcome.status).toBe('rejected');
      const reason = (outcome as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(SettleError);
      expect(reason).toMatchObject({ swapId: 's1', message: expect.stringMatching(/proposal_rejected/) });
    }
    expect(api.prepared).not.toContain('htlc.accept-deposit-counter');
    expect(api.claims).toEqual([]);
  });

  test('a counter leg an earlier attempt already accepted counts as accepted, and the swap settles', async () => {
    const api = venue({ counterAcceptedElsewhere: true });
    const { maker, taker } = await tradingPair(api, [12, 13]);
    const [made] = await Promise.all([maker.make('o1'), taker.take('o1')]);
    expect(made.swap.status).toBe('both_claimed');
    // Asked once, answered "already accepted", and taken at its word: the claim followed, once.
    expect(askedFor(api, 'htlc.accept-counter')).toBe(1);
    expect(api.claims).toHaveLength(1);
  });
});

/** A signed-in API that answers only the routes a test names, and records every route asked for. */
function stub(handlers: Record<string, (body: Record<string, unknown>) => unknown>) {
  const hits: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const route = `${init.method} ${new URL(url).pathname}`;
    hits.push(route);
    if (route === 'POST /auth/challenge') return json({ challenge: 'Welcome to Cancore 2026-09-28 sig:1' });
    if (route === 'POST /auth/login-signature') return json({ token: jwt('a'), user: {} });
    const handler = handlers[route];
    if (!handler) return refuse(404, `no route ${route}`);
    const out = handler(init.body ? JSON.parse(String(init.body)) : {});
    return out instanceof Response ? out : json(out);
  };
  return { fetchImpl, hits, signed: () => hits.filter((r) => r.startsWith('POST /wallet/operations')) };
}

const takenOrder = (over: Record<string, unknown> = {}) => ({
  id: 'o1', status: 'accepted', sourceNetwork: 'canton', sourceTokenAddress: 'CBTC', sourceAmount: '0.01',
  targetNetwork: 'canton', targetTokenAddress: 'CC', targetAmount: '5000', initiatorUserId: 'maker',
  opponentUserId: 'me', opponent: { partyId: 'party-taker' }, swapId: null, ...over,
});

describe('refusals that come before anything is signed', () => {
  test.each([{ sourceNetwork: 'sepolia' }, { targetNetwork: 'sepolia' }])('an order that is not Canton on both sides: %o', async (side) => {
    const api = stub({ 'GET /orders/o1': () => takenOrder(side) });
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast });
    await expect(acct.make('o1')).rejects.toThrow(/only Canton↔Canton/);
    await expect(acct.take('o1')).rejects.toThrow(/only Canton↔Canton/);
    expect(api.signed()).toEqual([]);
  });

  test('an order another account took', async () => {
    const api = stub({
      'GET /orders/o1': () => takenOrder({ opponentUserId: 'someone-else' }),
      'GET /auth/me': () => ({ id: 'me', partyId: 'party-me' }),
    });
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast });
    await expect(acct.take('o1')).rejects.toThrow(/taken by another account/);
    expect(api.signed()).toEqual([]);
  });

  test('a timeout the stand does not offer for the order', async () => {
    const api = stub({
      'GET /orders/o1': () => takenOrder(),
      'GET /htlc/timeout-options': () => ({ timeoutHours: [1, 2] }),
    });
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast });
    await expect(acct.make('o1', { timeoutHours: 3 })).rejects.toThrow(/timeoutHours 3 is not offered.*1, 2/);
    expect(api.signed()).toEqual([]);
  });

  test('an order nobody takes: the wait ends at the deadline with the last state it saw', async () => {
    const api = stub({ 'GET /orders/o1': () => takenOrder({ status: 'open', opponentUserId: null, opponent: null }) });
    let clock = 0;
    const acct = createSelfCustody({
      baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast, now: () => (clock += 60_000),
    });
    const error = await acct.make('o1', { deadlineMs: 10 * 60_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettleError);
    expect(error).toMatchObject({ message: expect.stringMatching(/order o1 to be taken/), last: { status: 'open' } });
    expect(api.signed()).toEqual([]);
  });

  test('a prepare the API refuses surfaces as a CeremonyError naming the operation and the stage', async () => {
    const api = stub({ 'POST /wallet/operations/prepare': () => refuse(400, 'amount must be a number string') });
    const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast });
    const error = await acct.send({ receiverPartyId: 'p', amount: 'lots' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CeremonyError);
    expect(error).toMatchObject({ operation: 'tokens.send', stage: 'prepare', meta: null });
    expect(api.hits).not.toContain('POST /wallet/operations/submit');
  });
});

test('acceptIncoming skips what expired and what the filter drops, and one refusal does not stop the rest', async () => {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const ti = (contractId: string, executeBefore: string, instrumentId = 'USDCx') =>
    ({ contractId, templateId: 't', instrumentAdmin: 'admin', instrumentId, executeBefore });
  const prepared: string[] = [];
  const api = stub({
    'GET /tokens/transfer-requests/incoming': () => [
      ti('expired', at(-60_000)), ti('refused', at(60_000)), ti('fine', at(60_000)), ti('dust', at(60_000), 'SPAM'),
    ],
    'POST /wallet/operations/prepare': (body) => {
      const cid = String((body.params as Record<string, unknown>).instructionCid);
      prepared.push(cid);
      return cid === 'refused'
        ? refuse(400, 'registry context unavailable')
        : { operationId: `op-${cid}`, legs: [{ legId: 'l', hash: b64(new Uint8Array(32)), kind: 'transfer' }], meta: null };
    },
    'POST /wallet/operations/submit': () => ({ outcome: 'committed' }),
  });
  const acct = createSelfCustody({ baseUrl, signer: await providerFromMnemonic(PHRASE), fetchImpl: api.fetchImpl, ...fast });
  const { accepted, failed } = await acct.acceptIncoming((t) => t.instrumentId !== 'SPAM');
  expect(accepted.map((t) => t.contractId)).toEqual(['fine']);
  expect(failed.map((f) => f.transfer.contractId)).toEqual(['refused']);
  expect(failed[0]!.error).toBeInstanceOf(CeremonyError);
  expect(prepared).toEqual(['refused', 'fine']);
});
