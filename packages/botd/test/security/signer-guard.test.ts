import { chmodSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { selfSendLeg } from '../../../client/src/dvp-prepared.fixture';
import { guardSigning, VerifyError } from '../../src/verify';
import type { BotSigner } from '../../src/types';

const inner = (): BotSigner & { signed: string[] } => {
  const signed: string[] = [];
  return { signed, public_key: 'ab', signMessage: async (m) => (signed.push(`msg:${m}`), 's'), signPreparedHash: async (h) => (signed.push(h), 's'), destroy: () => undefined };
};
const answering = (body: unknown) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body));
const leg = (receiver = 'o::1220') => selfSendLeg({ party: 'p::1220', kind: 'transfer', receiver, input: '10', ids: 'a', outputs: [{ owner: receiver, amount: '1' }, { owner: 'p::1220', amount: '9' }] });

describe('security: verifying signer', () => {
  it('refuses a hash never seen with its bytes in an API answer', async () => {
    const l = await leg();
    const s = inner();
    const failed: string[] = [];
    const g = guardSigning(s, answering({ ok: true }), (r) => failed.push(r));
    await g.fetchImpl('http://x', {});
    await expect(g.signer.signPreparedHash(l.preparedTransactionHash)).rejects.toBeInstanceOf(VerifyError);
    expect(s.signed).toEqual([]);
    expect(failed).toHaveLength(1);
  });

  it('a hash is signable once: no replay, and variants of it are not the same hash', async () => {
    const l = await leg();
    const s = inner();
    const g = guardSigning(s, answering({ preparedTransaction: l.preparedTransaction, preparedTransactionHash: l.preparedTransactionHash }), () => undefined);
    await g.fetchImpl('http://x', {});
    for (const v of [` ${l.preparedTransactionHash}`, l.preparedTransactionHash.replace(/=+$/, ''), l.preparedTransactionHash.toLowerCase()]) {
      if (v !== l.preparedTransactionHash) await expect(g.signer.signPreparedHash(v)).rejects.toBeInstanceOf(VerifyError);
    }
    await g.signer.signPreparedHash(l.preparedTransactionHash);
    await expect(g.signer.signPreparedHash(l.preparedTransactionHash)).rejects.toBeInstanceOf(VerifyError);
    expect(s.signed).toEqual([l.preparedTransactionHash]);
  });

  it('bytes whose recomputed hash differs from the claimed one are never signable, nested anywhere', async () => {
    const [honest, thief] = [await leg(), await leg('thief::1220')];
    const s = inner();
    const failed: string[] = [];
    const g = guardSigning(s, answering({ a: [{ b: { preparedTransaction: honest.preparedTransaction, hash: thief.preparedTransactionHash } }] }), (r) => failed.push(r));
    await g.fetchImpl('http://x', {});
    await expect(g.signer.signPreparedHash(thief.preparedTransactionHash)).rejects.toBeInstanceOf(VerifyError);
    await expect(g.signer.signPreparedHash(honest.preparedTransactionHash)).rejects.toBeInstanceOf(VerifyError);
    expect(failed[0]).toMatch(/not the hash of its bytes/);
    expect(s.signed).toEqual([]);
  });

  it('undecodable bytes and non-JSON answers verify nothing', async () => {
    const l = await leg();
    for (const body of [{ preparedTransaction: 'AAAA', preparedTransactionHash: l.preparedTransactionHash }, 'not json', '']) {
      const g = guardSigning(inner(), answering(body), () => undefined);
      await g.fetchImpl('http://x', {});
      await expect(g.signer.signPreparedHash(l.preparedTransactionHash)).rejects.toBeInstanceOf(VerifyError);
    }
  });

  it('a lock forgets every verified hash', async () => {
    const l = await leg();
    const g = guardSigning(inner(), answering({ preparedTransaction: l.preparedTransaction, preparedTransactionHash: l.preparedTransactionHash }), () => undefined);
    await g.fetchImpl('http://x', {});
    g.signer.destroy();
    await expect(g.signer.signPreparedHash(l.preparedTransactionHash)).rejects.toBeInstanceOf(VerifyError);
  });

  it('signMessage cannot be used to sign a prepared-transaction hash as raw bytes', async () => {
    const l = await leg();
    const s = inner();
    const g = guardSigning(s, answering({}), () => undefined);
    const rawHash = Buffer.from(l.preparedTransactionHash, 'base64').toString('latin1');
    await expect(g.signer.signMessage(rawHash)).rejects.toBeInstanceOf(VerifyError);
    await expect(g.signer.signMessage('CANCORE_FAUCET_TERMS_OF_SERVICE_V1:p::1220:1')).resolves.toBe('s');
    expect(s.signed).toEqual(['msg:CANCORE_FAUCET_TERMS_OF_SERVICE_V1:p::1220:1']);
  });
});

describe('security: pinned trust boundary', () => {
  // Without `venuePartyId` in the config the SDK would take a trade's venue from the API's /htlc/fee-config;
  // the engine pins DEFAULT_VENUES[network] instead, and refuses a stand it has no venue for.
  const engineWith = async (options: { baseUrl: string; venuePartyId?: string }) => {
    jest.resetModules();
    const seen: Record<string, unknown>[] = [];
    jest.doMock('@cancore/client/selfcustody', () => ({
      ...jest.requireActual('@cancore/client/selfcustody'),
      createSelfCustody: (o: Record<string, unknown>) => (seen.push(o), {}),
    }));
    const { createEngine } = await import('../../src/engine/index');
    createEngine({ signer: inner(), ...options, hooks: { onSettled: () => undefined, onEnded: () => undefined, onVerifyFailed: () => undefined } });
    return seen[0];
  };

  it('a DvP trade venue is pinned even when the config omits venuePartyId', async () => {
    const { DEFAULT_VENUES } = jest.requireActual('@cancore/client/selfcustody');
    expect((await engineWith({ baseUrl: 'https://api.cancore.io' }))?.venuePartyId).toBe(DEFAULT_VENUES.mainnet);
    expect((await engineWith({ baseUrl: 'https://api.cancore.io', venuePartyId: 'v::1' }))?.venuePartyId).toBe('v::1');
  });

  it('a stand with no pinned venue is refused, by the engine and by the daemon at start', async () => {
    await expect(engineWith({ baseUrl: 'https://api.example.com' })).rejects.toThrow(/no venue is pinned/);
    const { defaultDeps } = await import('../../src/daemon');
    const { DEFAULTS } = await import('../../src/config');
    const dir = mkdtempSync(join(tmpdir(), 'botd-venue-'));
    chmodSync(dir, 0o700);
    try {
      await expect(defaultDeps({ ...DEFAULTS, stateDir: dir, baseUrl: 'https://api.example.com' })).rejects.toThrow(/no venue is pinned/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
