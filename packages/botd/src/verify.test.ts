import { selfSendLeg } from '../../client/src/dvp-prepared.fixture';
import { guardSigning, recomputeHash, VerifyError } from './verify';
import type { BotSigner } from './types';

const fakeSigner = (): BotSigner & { signed: string[] } => {
  const signed: string[] = [];
  return { signed, public_key: 'ab', signMessage: async () => 'sig', signPreparedHash: async (h) => (signed.push(h), 'sig'), destroy: () => undefined };
};
const answering = (body: unknown) => async () => new Response(JSON.stringify(body));
const leg = () => selfSendLeg({ party: 'p::1220', kind: 'transfer', receiver: 'o::1220', input: '10', ids: 'a', outputs: [{ owner: 'o::1220', amount: '1' }, { owner: 'p::1220', amount: '9' }] });

describe('guardSigning', () => {
  it('recomputes the hash the SDK library computes', async () => {
    const l = await leg();
    expect(recomputeHash(l.preparedTransaction)).toBe(l.preparedTransactionHash);
  });

  it('signs a hash only after its bytes were seen with it, and only once', async () => {
    const l = await leg();
    const inner = fakeSigner();
    const failed: string[] = [];
    const g = guardSigning(inner, answering({ legs: [{ hash: l.preparedTransactionHash, preparedTransaction: l.preparedTransaction }] }), (r) => failed.push(r));
    await expect(g.signer.signPreparedHash(l.preparedTransactionHash)).rejects.toBeInstanceOf(VerifyError);
    await (await g.fetchImpl('http://x/prepare', {})).json();
    await g.signer.signPreparedHash(l.preparedTransactionHash);
    await expect(g.signer.signPreparedHash(l.preparedTransactionHash)).rejects.toBeInstanceOf(VerifyError);
    expect(inner.signed).toEqual([l.preparedTransactionHash]);
    expect(failed).toHaveLength(2);
  });

  it('reports a hash that is not of its bytes and never signs it', async () => {
    const [l, other] = [await leg(), await selfSendLeg({ party: 'p::1220', kind: 'transfer', receiver: 'thief::1220', input: '10', ids: 'a', outputs: [{ owner: 'thief::1220', amount: '1' }] })];
    const inner = fakeSigner();
    const failed: string[] = [];
    const g = guardSigning(inner, answering({ preparedTransaction: l.preparedTransaction, preparedTransactionHash: other.preparedTransactionHash }), (r) => failed.push(r));
    await g.fetchImpl('http://x/prepare', {});
    expect(failed[0]).toMatch(/is not the hash of its bytes/);
    await expect(g.signer.signPreparedHash(other.preparedTransactionHash)).rejects.toBeInstanceOf(VerifyError);
    expect(inner.signed).toEqual([]);
  });
});
