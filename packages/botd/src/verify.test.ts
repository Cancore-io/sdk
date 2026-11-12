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

  it('refuses to sign a non-text message and never reaches the inner signer', async () => {
    const calls: string[] = [];
    const inner = { ...fakeSigner(), signMessage: async (m: string) => (calls.push(m), 'sig') };
    const failed: string[] = [];
    const g = guardSigning(inner, answering({}), (r) => failed.push(r));
    await expect(g.signer.signMessage('\x00\xff\x10binary')).rejects.toBeInstanceOf(VerifyError);
    expect(failed[0]).toMatch(/non-text/);
    expect(calls).toEqual([]);
    expect(await g.signer.signMessage('I agree')).toBe('sig');
  });

  describe('a topology multihash (CAN-2922)', () => {
    // 0x12 (sha2-256), 0x20 (32 bytes), then a digest: the binary string the wallet signs a topology leg with.
    const MULTIHASH = `\x12\x20${String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 0xe0 + i))}`;
    const recording = (onTopologySigned?: (hex: string) => Promise<unknown>) => {
      const calls: string[] = [];
      const failed: string[] = [];
      const g = guardSigning({ ...fakeSigner(), signMessage: async (m: string) => (calls.push(m), 'sig') }, answering({}), (r) => failed.push(r), onTopologySigned);
      return { g, calls, failed };
    };

    it('is signed once per onboarding, and not outside one', async () => {
      const { g, calls, failed } = recording();
      await expect(g.signer.signMessage(MULTIHASH)).rejects.toBeInstanceOf(VerifyError);
      const signedInOnboarding = await g.onboarding(async () => {
        await Promise.resolve();
        const sig = await g.signer.signMessage(MULTIHASH);
        await expect(g.signer.signMessage(MULTIHASH)).rejects.toBeInstanceOf(VerifyError);
        return sig;
      });
      expect(signedInOnboarding).toBe('sig');
      expect(await g.onboarding(() => g.signer.signMessage(MULTIHASH))).toBe('sig');
      expect(calls).toEqual([MULTIHASH, MULTIHASH]);
      expect(failed).toHaveLength(2);
      expect(failed[0]).toMatch(/non-text/);
    });

    it('is refused to whatever an onboarding left scheduled once it has ended', async () => {
      const { g, calls } = recording();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let leftover!: Promise<string>;
      await g.onboarding(async () => {
        leftover = gate.then(() => g.signer.signMessage(MULTIHASH));
      });
      release();
      await expect(leftover).rejects.toBeInstanceOf(VerifyError);
      expect(calls).toEqual([]);
    });

    it('is put on the record, in hex, before the key signs it; a record that fails stops the signature (review F-1)', async () => {
      // Each record with the number of signatures the key had made when it was written.
      const recorded: { hex: string; signedBefore: number }[] = [];
      let recordFails = false;
      const { g, calls } = recording(async (hex) => {
        if (recordFails) throw new Error('audit write failed');
        recorded.push({ hex, signedBefore: calls.length });
      });
      await expect(g.signer.signMessage(MULTIHASH)).rejects.toBeInstanceOf(VerifyError);
      await g.onboarding(() => g.signer.signMessage(MULTIHASH));
      expect(recorded).toEqual([{ hex: Buffer.from(MULTIHASH, 'latin1').toString('hex'), signedBefore: 0 }]);
      expect(recorded[0]!.hex).toMatch(/^1220[0-9a-f]{64}$/);
      recordFails = true;
      await expect(g.onboarding(() => g.signer.signMessage(MULTIHASH))).rejects.toThrow('audit write failed');
      expect(calls).toEqual([MULTIHASH]);
    });

    it('still refuses every other binary inside an onboarding, without using up its one multihash', async () => {
      const { g, calls } = recording();
      const digest = MULTIHASH.slice(2);
      const others = [
        digest, // a 32-byte prepared-transaction hash
        `\x12\x21${digest}`, // another digest length
        `\x13\x20${digest}`, // another hash function
        `\x12\x20${digest.slice(1)}`, // 33 bytes
        `\x12\x20${digest}\x00`, // 35 bytes
        `\x12\x20\u0100${digest.slice(1)}`, // 34 chars, one of them past a byte
      ];
      await g.onboarding(async () => {
        for (const other of others) await expect(g.signer.signMessage(other)).rejects.toBeInstanceOf(VerifyError);
        expect(await g.signer.signMessage(MULTIHASH)).toBe('sig');
      });
      expect(calls).toEqual([MULTIHASH]);
    });
  });

  it('keeps only the newest 256 verified hashes: an abandoned prepare does not stay signable forever', async () => {
    const l = await leg();
    const inner = fakeSigner();
    let body: unknown = { legs: [{ hash: l.preparedTransactionHash, preparedTransaction: l.preparedTransaction }] };
    const g = guardSigning(inner, async () => new Response(JSON.stringify(body)), () => undefined);
    await g.fetchImpl('http://x/prepare', {});
    const others = await Promise.all(Array.from({ length: 256 }, (_, i) => selfSendLeg({ party: 'p::1220', kind: 'transfer', receiver: 'o::1220', input: '10', ids: `b${i}`, outputs: [{ owner: 'o::1220', amount: '1' }] })));
    body = { legs: others.map((o) => ({ hash: o.preparedTransactionHash, preparedTransaction: o.preparedTransaction })) };
    await g.fetchImpl('http://x/prepare', {});
    await expect(g.signer.signPreparedHash(l.preparedTransactionHash)).rejects.toBeInstanceOf(VerifyError);
    await g.signer.signPreparedHash(others[255]!.preparedTransactionHash);
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
