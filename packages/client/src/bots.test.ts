import { ed25519 } from '@noble/curves/ed25519';
import { deriveWalletKey, providerFromMnemonic } from '@cancore/wallet';
import { CancoreApiError, type FetchLike } from './http';
import { BOT_ACCOUNTS_MAX, createSelfCustody, nextBotAccount, type BotAccount } from './selfcustody';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const baseUrl = 'https://api.example';
const CHALLENGE = 'Welcome to Cancore 2026-10-27 sig:0123456789abcdef';
const jwt = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.s`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const botRow = (over: Partial<BotAccount> = {}): BotAccount => ({
  id: '7d4e3c1a-0000-4000-8000-000000000001', name: 'grid-bot-1', publicKey: null, partyId: null, status: 'ACTIVE',
  onboardingState: 'key-generated', stoppedAt: null, createdAt: '2026-10-27T10:00:00.000Z', ...over,
});

interface Sent { method: string; path: string; body: unknown; bearer: string | undefined }

/** The gateway's auth routes, as far as an owner managing bots sees them. */
function gateway(answer: (sent: Sent) => Response | undefined = () => undefined) {
  const sent: Sent[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const s: Sent = {
      method: init.method ?? 'GET',
      path: new URL(url).pathname,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      bearer: headers.authorization,
    };
    sent.push(s);
    const custom = answer(s);
    if (custom) return custom;
    if (s.path === '/auth/challenge' || s.path === '/auth/register-challenge') return json({ challenge: CHALLENGE });
    if (s.path === '/auth/login-signature') return json({ token: jwt('owner'), user: { id: 'owner' } });
    if (s.path === '/auth/bots' && s.method === 'POST') {
      const { publicKey, name } = s.body as { publicKey: string; name: string };
      return json(botRow({ publicKey, name }), 201);
    }
    if (s.path === '/auth/bots') return json([botRow()]);
    return json(botRow({ stoppedAt: s.path.endsWith('/stop') ? '2026-10-27T11:00:00.000Z' : null }));
  };
  return { sent, fetchImpl };
}

async function owner(answer?: (sent: Sent) => Response | undefined) {
  const g = gateway(answer);
  const signer = await providerFromMnemonic(PHRASE, { account: 0 });
  return { ...g, signer, acct: createSelfCustody({ baseUrl, signer, fetchImpl: g.fetchImpl }) };
}

describe('bots.create — a bot account made from the owner\'s own session', () => {
  test('asks a challenge for the BOT key, signs it with the bot key, and posts the proof on the owner\'s session', async () => {
    const { acct, sent, signer } = await owner();
    const botSigner = await providerFromMnemonic(PHRASE, { account: 1 });

    const bot = await acct.bots.create({ name: 'grid-bot-1', botSigner });

    const challengeCall = sent.find((s) => s.path === '/auth/register-challenge')!;
    expect(challengeCall.body).toEqual({ publicKey: botSigner.public_key });
    expect(challengeCall.bearer).toBeUndefined();
    const create = sent.find((s) => s.path === '/auth/bots' && s.method === 'POST')!;
    const body = create.body as { publicKey: string; challenge: string; signature: string; name: string };
    expect(Object.keys(body).sort()).toEqual(['challenge', 'name', 'publicKey', 'signature']);
    expect(body).toMatchObject({ publicKey: botSigner.public_key, challenge: CHALLENGE, name: 'grid-bot-1' });
    expect(create.bearer).toBe(`Bearer ${jwt('owner')}`);
    const message = new TextEncoder().encode(CHALLENGE);
    expect(ed25519.verify(Buffer.from(body.signature, 'hex'), message, Buffer.from(botSigner.public_key, 'hex'))).toBe(true);
    expect(ed25519.verify(Buffer.from(body.signature, 'hex'), message, Buffer.from(signer.public_key, 'hex'))).toBe(false);
    expect(bot).toMatchObject({ name: 'grid-bot-1', publicKey: botSigner.public_key });
  });

  test('a bot signer with only signMessage is held to the login-challenge shape, as at sign-in', async () => {
    const { acct, sent } = await owner((s) => (s.path === '/auth/register-challenge' ? json({ challenge: 'x'.repeat(32) }) : undefined));
    const signMessage = jest.fn(async () => '00'.repeat(64));

    await expect(acct.bots.create({ name: 'b', botSigner: { public_key: 'ab'.repeat(32), signMessage } })).rejects.toThrow(/not a Cancore login challenge/);
    expect(signMessage).not.toHaveBeenCalled();
    expect(sent.some((s) => s.path === '/auth/bots')).toBe(false);
  });

  test('a signer without a public key is refused before anything is sent', async () => {
    const { acct, sent } = await owner();

    await expect(acct.bots.create({ name: 'b', botSigner: { publicKeyHex: 'ab' } as never })).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });

  test('the cap and the owner checks come back as the API said them', async () => {
    const { acct } = await owner((s) =>
      s.path === '/auth/bots' && s.method === 'POST'
        ? json({ statusCode: 409, message: 'You have already made 5 bot accounts, the maximum is 5' }, 409)
        : undefined,
    );
    const botSigner = await providerFromMnemonic(PHRASE, { account: 1 });

    const err = await acct.bots.create({ name: 'b', botSigner }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancoreApiError);
    expect(err).toMatchObject({ status: 409, path: '/auth/bots', message: expect.stringMatching(/maximum is 5/) });
  });
});

describe('bots.list / stop / resume', () => {
  test('are the owner routes, signed in as the owner, with the id encoded into the path', async () => {
    const { acct, sent } = await owner();

    expect(await acct.bots.list()).toEqual([botRow()]);
    expect((await acct.bots.stop('id/../x')).stoppedAt).not.toBeNull();
    expect((await acct.bots.resume('b1')).stoppedAt).toBeNull();

    const routes = sent.filter((s) => s.path.startsWith('/auth/bots')).map((s) => `${s.method} ${s.path}`);
    expect(routes).toEqual(['GET /auth/bots', 'POST /auth/bots/id%2F..%2Fx/stop', 'POST /auth/bots/b1/resume']);
    expect(sent.filter((s) => s.path.startsWith('/auth/bots')).every((s) => s.bearer === `Bearer ${jwt('owner')}`)).toBe(true);
  });
});

describe('nextBotAccount — the wallet\'s rule for which key the next bot gets', () => {
  const keyOf = (account: number) => deriveWalletKey(PHRASE, 'standard', account).publicKeyHex;

  test('the key at index N is the one the web wallet derives for its bot N (test vector, m/44\'/6767\'/N\'/0\'/0\')', async () => {
    expect((await providerFromMnemonic(PHRASE, { account: 1 })).public_key).toBe('554c86a3beb8a346d165c91342313ec56901b6ecf8037a6ed07a4dd81ecb2f5d');
    expect((await providerFromMnemonic(PHRASE, { account: 5 })).public_key).toBe('e5cf53aa92b968df650003862ae72034472d44c8f4160c5ce94409791decafc4');
    for (let n = 1; n <= BOT_ACCOUNTS_MAX; n++) expect((await providerFromMnemonic(PHRASE, { account: n })).public_key).toBe(keyOf(n));
  });

  test('is the lowest index from 1 whose key is not registered, never 0', async () => {
    expect(await nextBotAccount([], keyOf)).toBe(1);
    expect(await nextBotAccount([{ publicKey: keyOf(0) }], keyOf)).toBe(1);
    expect(await nextBotAccount([{ publicKey: keyOf(1) }, { publicKey: keyOf(3) }], keyOf)).toBe(2);
  });

  test('a freed index is handed out again, whatever the order of the list', async () => {
    expect(await nextBotAccount([{ publicKey: keyOf(3) }, { publicKey: keyOf(2) }, { publicKey: null }], keyOf)).toBe(1);
  });

  test('compares keys whatever their case or 0x prefix', async () => {
    expect(await nextBotAccount([{ publicKey: `0x${keyOf(1).toUpperCase()}` }], keyOf)).toBe(2);
  });

  test('is null when all five are registered', async () => {
    const all = [1, 2, 3, 4, 5].map((n) => ({ publicKey: keyOf(n) }));
    expect(await nextBotAccount(all, keyOf)).toBeNull();
  });

  test('takes an async key source, such as providerFromMnemonic', async () => {
    const publicKeyOf = async (account: number) => (await providerFromMnemonic(PHRASE, { account })).public_key;
    expect(await nextBotAccount([{ publicKey: keyOf(1) }], publicKeyOf)).toBe(2);
  });
});
