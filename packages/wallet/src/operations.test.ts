import {
  base64ToBinaryString,
  createWalletOperations,
  signLegs,
  hexSignatureToBase64,
  signPreparedHashBase64,
  OperationDeclinedError,
  type OperationLeg,
  type WalletRequest,
} from './operations';

const leg = (legId: string, hash: string): OperationLeg => ({ legId, hash, kind: 'transfer' });

/** A request function that answers each call in turn, recording what it was asked. */
function stubRequest(answers: unknown[]): { request: WalletRequest; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  let index = 0;
  const request = (async (endpoint: string, init?: { body?: string }) => {
    calls.push([endpoint, init?.body ? JSON.parse(init.body) : undefined]);
    return answers[index++];
  }) as WalletRequest;
  return { request, calls };
}

describe('@cancore/wallet/operations', () => {
  it('asks for an operation by name, with its own params nested', async () => {
    const { request, calls } = stubRequest([{ operationId: 'op-1', legs: [], meta: null }]);

    await createWalletOperations(request).prepare('tokens.send', { receiverPartyId: 'bob::1220', amount: '5' });

    expect(calls[0]).toEqual([
      '/wallet/operations/prepare',
      { type: 'tokens.send', params: { receiverPartyId: 'bob::1220', amount: '5' } },
    ]);
  });

  it('omits params entirely for an operation that takes none', async () => {
    // An empty object and an absent one are not the same request: the backend
    // validates `params` against the operation's DTO, and an operation with no
    // arguments should not be sent an empty shape to validate.
    const { request, calls } = stubRequest([{ operationId: 'op-1', legs: [], meta: null }]);

    await createWalletOperations(request).prepare('tokens.preapproval');

    expect(calls[0][1]).toEqual({ type: 'tokens.preapproval' });
  });

  it('signs every leg on the one key and submits each signature under its own leg id', async () => {
    // Two legs is the case worth pinning: a CC send is a transfer and its
    // network fee. A positional submit would one day post the fee's signature
    // for the transfer, and both would be real signatures over real transactions.
    const { request, calls } = stubRequest([
      { operationId: 'op-1', legs: [leg('sk-main', 'aGk='), leg('sk-fee', 'Ymxh')], meta: null },
      { updateId: 'u-1' },
    ]);
    const signPreparedHash = jest.fn(async (hash: string) => `sig(${hash})`);

    const result = await createWalletOperations(request).execute(
      { signMessage: jest.fn(), signPreparedHash },
      'tokens.accept',
      { instructionCid: 'ti-1' },
    );

    expect(calls[1]).toEqual([
      '/wallet/operations/submit',
      {
        operationId: 'op-1',
        signatures: [
          { legId: 'sk-main', signature: 'sig(aGk=)' },
          { legId: 'sk-fee', signature: 'sig(Ymxh)' },
        ],
      },
    ]);
    expect(result).toEqual({ updateId: 'u-1' });
  });

  it('signs the legs in order, one prompt for the whole ceremony', async () => {
    const { request } = stubRequest([
      { operationId: 'op-1', legs: [leg('a', 'aGk='), leg('b', 'Ymxh')], meta: null },
      {},
    ]);
    const seen: string[] = [];
    const signPreparedHash = jest.fn(async (hash: string) => {
      seen.push(hash);
      return 'sig';
    });

    await createWalletOperations(request).execute({ signMessage: jest.fn(), signPreparedHash }, 'x');

    expect(seen).toEqual(['aGk=', 'Ymxh']);
  });

  it('submits nothing to sign as an empty signature list rather than skipping the submit', async () => {
    // An operation may legitimately prepare no legs; what that MEANS belongs to
    // the operation, not to the client guessing.
    const { request, calls } = stubRequest([{ operationId: 'op-1', legs: [], meta: null }, {}]);

    await createWalletOperations(request).execute({ signMessage: jest.fn() }, 'tokens.preapproval');

    expect(calls[1][1]).toEqual({ operationId: 'op-1', signatures: [] });
  });

  it('prefers the shape-checked signPreparedHash when the provider has one', async () => {
    // The base64 hash goes through untouched on this path: the modern provider
    // signs it as-is and answers in the encoding the submit expects. Moved here
    // from the app when its copy of this encoder was deleted (CAN-1040).
    const signPreparedHash = jest.fn().mockResolvedValue('already-base64');
    const signMessage = jest.fn();

    expect(await signPreparedHashBase64({ signMessage, signPreparedHash }, 'aGk=')).toBe('already-base64');
    expect(signPreparedHash).toHaveBeenCalledWith('aGk=');
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('falls back to signMessage for a provider without the shape-checked path', async () => {
    // The older provider signs a binary string and answers in hex; the encoding
    // between that and what Canton accepts has no second chance — a wrong one is
    // a rejected transaction, not a retry.
    const signMessage = jest.fn().mockResolvedValue(`0x${'ab'.repeat(64)}`);

    const signature = await signPreparedHashBase64({ signMessage }, 'aGk=');

    expect(signMessage).toHaveBeenCalledWith('hi');
    expect(signature).toBe(hexSignatureToBase64('ab'.repeat(64)));
  });

  it('signs a topology leg through the raw path, never the shape-checked one', async () => {
    // A topology hash is a 34-byte multihash, and `signPreparedHash` refuses
    // anything but 32 bytes. Choosing by KIND is what keeps a real prepared
    // transaction from ever taking this path by accident.
    const multihash = Buffer.from(`1220${'aa'.repeat(32)}`, 'hex').toString('base64');
    const { request, calls } = stubRequest([
      { operationId: 'op-1', legs: [{ legId: 'h1', hash: multihash, kind: 'topology' }], meta: null },
      {},
    ]);
    const signPreparedHash = jest.fn();
    const signMessage = jest.fn().mockResolvedValue('ab'.repeat(64));

    await createWalletOperations(request).execute({ signMessage, signPreparedHash }, 'wallet.topology');

    expect(signPreparedHash).not.toHaveBeenCalled();
    expect(signMessage).toHaveBeenCalledWith(base64ToBinaryString(multihash));
    expect(calls[1][1]).toEqual({
      operationId: 'op-1',
      signatures: [{ legId: 'h1', signature: hexSignatureToBase64('ab'.repeat(64)) }],
    });
  });

  it('paces the legs when a caller asks, and not otherwise', async () => {
    // A signer that opens a UI per signature can drop a prompt fired in the same
    // tick as the last one. Opt-in, so nobody else pays the latency.
    const { request } = stubRequest([
      {
        operationId: 'op-1',
        legs: [leg('a', 'aGk='), leg('b', 'Ymxh')],
        meta: null,
      },
      {},
    ]);
    const signer = { signMessage: jest.fn(), signPreparedHash: jest.fn().mockResolvedValue('sig') };
    const prepared = await createWalletOperations(request).prepare('x');
    jest.useFakeTimers();

    const started = signLegs(signer, prepared.legs, { pauseMsBetweenLegs: 2000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(signer.signPreparedHash).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2000);
    await started;
    expect(signer.signPreparedHash).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  describe('execute() confirm seam (CAN-1113)', () => {
    // Accept-counter's whole reason for existing: `execute` used to go
    // prepare -> sign -> submit in one call, with nowhere between "we know the
    // legs" and "we sign" to show the user anything. `confirm` is that gap.

    it('signs and submits nothing when confirm refuses', async () => {
      const { request, calls } = stubRequest([{ operationId: 'op-1', legs: [leg('a', 'aGk=')], meta: null }]);
      const signPreparedHash = jest.fn();
      const confirm = jest.fn().mockResolvedValue(false);

      await expect(
        createWalletOperations(request).execute({ signMessage: jest.fn(), signPreparedHash }, 'htlc.accept-counter', undefined, confirm),
      ).rejects.toBeInstanceOf(OperationDeclinedError);

      expect(signPreparedHash).not.toHaveBeenCalled();
      // Only the prepare call happened — no submit was ever posted.
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('/wallet/operations/prepare');
    });

    it('hands confirm exactly the legs and meta prepare answered, before any signature', async () => {
      const meta = { swapId: 'swap-1' };
      const { request } = stubRequest([
        { operationId: 'op-1', legs: [leg('a', 'aGk='), leg('b', 'Ymxh')], meta },
        {},
      ]);
      const confirm = jest.fn().mockResolvedValue(true);

      await createWalletOperations(request).execute(
        { signMessage: jest.fn(), signPreparedHash: jest.fn().mockResolvedValue('sig') },
        'htlc.accept-counter',
        undefined,
        confirm,
      );

      expect(confirm).toHaveBeenCalledWith(
        [leg('a', 'aGk='), leg('b', 'Ymxh')],
        meta,
      );
    });

    it('signs and submits once confirm agrees', async () => {
      const { request, calls } = stubRequest([
        { operationId: 'op-1', legs: [leg('a', 'aGk=')], meta: null },
        { updateId: 'u-1' },
      ]);
      const signPreparedHash = jest.fn().mockResolvedValue('sig(aGk=)');
      const confirm = jest.fn().mockResolvedValue(true);

      const result = await createWalletOperations(request).execute(
        { signMessage: jest.fn(), signPreparedHash },
        'htlc.accept-counter',
        undefined,
        confirm,
      );

      expect(signPreparedHash).toHaveBeenCalledWith('aGk=');
      expect(calls[1]).toEqual([
        '/wallet/operations/submit',
        { operationId: 'op-1', signatures: [{ legId: 'a', signature: 'sig(aGk=)' }] },
      ]);
      expect(result).toEqual({ updateId: 'u-1' });
    });

    it('behaves exactly as before when no caller passes a confirm', async () => {
      // Optional, so every existing caller keeps working unchanged.
      const { request, calls } = stubRequest([{ operationId: 'op-1', legs: [leg('a', 'aGk=')], meta: null }, {}]);
      const signPreparedHash = jest.fn().mockResolvedValue('sig');

      await createWalletOperations(request).execute({ signMessage: jest.fn(), signPreparedHash }, 'tokens.accept');

      expect(signPreparedHash).toHaveBeenCalledWith('aGk=');
      expect(calls[1][0]).toBe('/wallet/operations/submit');
    });
  });

  it('reads the catalogue, which is what replaced fifty documented routes', async () => {
    const { request, calls } = stubRequest([[{ type: 'tokens.send', params: 'Dto', flags: [] }]]);

    const catalogue = await createWalletOperations(request).list();

    expect(calls[0][0]).toBe('/wallet/operations');
    expect(catalogue).toEqual([{ type: 'tokens.send', params: 'Dto', flags: [] }]);
  });
});
