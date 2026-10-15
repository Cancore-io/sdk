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
  // Without `venuePartyId` in the daemon config, the SDK takes a trade's venue from the API's
  // /htlc/fee-config (selfcustody.ts dvpTerms), even on a network with a pinned default venue.
  // Fixing it belongs in @cancore/client (prefer DEFAULT_VENUES[network]) or in the daemon (refuse to start unpinned).
  test.failing('a DvP trade venue is pinned even when the config omits venuePartyId', async () => {
    jest.resetModules();
    const seen: Record<string, unknown>[] = [];
    jest.doMock('@cancore/client/selfcustody', () => ({ createSelfCustody: (o: Record<string, unknown>) => (seen.push(o), {}) }));
    const { createEngine } = await import('../../src/engine/index');
    createEngine({ signer: inner(), baseUrl: 'https://api.cancore.io', hooks: { onSettled: () => undefined, onEnded: () => undefined, onVerifyFailed: () => undefined } });
    expect(seen[0]?.venuePartyId).toEqual(expect.any(String));
  });
});
