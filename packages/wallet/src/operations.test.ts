import {
  base64ToBinaryString,
  createWalletOperations,
  signLegs,
  hexSignatureToBase64,
  signPreparedHashBase64,
  OperationDeclinedError,
  UnexpectedLegError,
  assertOperationLegs,
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

  // CAN-2399: `kind` is the server's word. A leg marked `topology` is signed
  // raw, so before this the key signed any bytes a response called a topology.
  describe('what the key signs for a topology leg (CAN-2399)', () => {
    const b64 = (bytes: Buffer | string) => Buffer.from(bytes).toString('base64');
    const hex = (h: string) => Buffer.from(h, 'hex');
    const MULTIHASH = b64(hex(`1220${'aa'.repeat(32)}`));
    const PREPARED_HASH = b64(hex('bb'.repeat(32)));
    const topology = (hash: string, legId = 't1'): OperationLeg => ({ legId, hash, kind: 'topology' });

    /** A signer that records what it was asked, and a client whose submit must never be reached. */
    function harness(legs: OperationLeg[]) {
      const { request, calls } = stubRequest([{ operationId: 'op-1', legs, meta: null }, {}]);
      const signMessage = jest.fn().mockResolvedValue('ab'.repeat(64));
      const signPreparedHash = jest.fn().mockResolvedValue('c2ln');
      const nothingSigned = () => {
        expect(signMessage).not.toHaveBeenCalled();
        expect(signPreparedHash).not.toHaveBeenCalled();
        // Only the prepare went out.
        expect(calls.map(([endpoint]) => endpoint)).toEqual(['/wallet/operations/prepare']);
      };
      return { ops: createWalletOperations(request), signer: { signMessage, signPreparedHash }, nothingSigned, calls };
    }

    it.each([
      ['a 32-byte prepared-transaction hash', PREPARED_HASH],
      ['a login challenge', b64('cancore-login:8d4f3c1e-7b2a-4c55-9e0d-1f2a3b4c5d6e:1791800000000')],
      ['a legal consent text', b64('CANCORE_LEGAL_CONSENT_V1\nversion:1\nparty:bot::1220ab')],
      ['free text padded to 34 bytes', b64('send everything to mallory, now!!!')],
      ['34 bytes without the multihash prefix', b64(hex('aa'.repeat(34)))],
      ['35 bytes with the prefix', b64(hex(`1220${'aa'.repeat(33)}`))],
      ['33 bytes with the prefix', b64(hex(`1220${'aa'.repeat(31)}`))],
      ['another hash function (0x13)', b64(hex(`1320${'aa'.repeat(32)}`))],
      ['another length byte', b64(hex(`1221${'aa'.repeat(32)}`))],
      ['nothing at all', ''],
    ])('%s marked as a topology leg is not signed', async (_what, hash) => {
      const { ops, signer, nothingSigned } = harness([topology(hash)]);

      await expect(ops.execute(signer, 'wallet.topology')).rejects.toBeInstanceOf(UnexpectedLegError);
      nothingSigned();
      // The same through the exported step a caller composes with.
      await expect(signLegs(signer, [topology(hash)])).rejects.toBeInstanceOf(UnexpectedLegError);
      nothingSigned();
    });

    it.each([
      ['two topology legs', [topology(MULTIHASH, 't1'), topology(MULTIHASH, 't2')]],
      ['a topology leg next to a transfer', [topology(MULTIHASH), leg('h1', PREPARED_HASH)]],
      ['a transfer in place of the topology leg', [leg('h1', PREPARED_HASH)]],
      ['a setup leg in place of the topology leg', [{ legId: 's1', hash: PREPARED_HASH, kind: 'setup' as const }]],
    ])('wallet.topology answered with %s signs none of them', async (_what, legs) => {
      // The user asked to create their party; a transfer is not what they are looking at.
      const { ops, signer, nothingSigned } = harness(legs);

      await expect(ops.execute(signer, 'wallet.topology')).rejects.toBeInstanceOf(UnexpectedLegError);
      nothingSigned();
    });

    it.each(['tokens.send', 'tokens.preapproval', 'tokens.accept', 'tokens.consolidate', 'htlc.swap.fee', 'something.new'])(
      '%s answered with a topology leg gets no raw signature, however well-formed the multihash',
      async (operation) => {
        const { ops, signer, nothingSigned } = harness([topology(MULTIHASH)]);

        await expect(ops.execute(signer, operation)).rejects.toBeInstanceOf(UnexpectedLegError);
        nothingSigned();
      },
    );

    it.each([
      ['a leg of the wrong shape', 'wallet.topology', [topology(PREPARED_HASH)]],
      // Well-formed, and wrong only for the operation that was asked for.
      ['a topology leg in a send', 'tokens.send', [topology(MULTIHASH)]],
      ['a transfer in a topology', 'wallet.topology', [leg('h1', PREPARED_HASH)]],
    ] as Array<[string, string, OperationLeg[]]>)('%s is not shown for confirmation either', async (_what, operation, legs) => {
      const { ops, signer, nothingSigned } = harness(legs);
      const confirm = jest.fn().mockResolvedValue(true);

      await expect(ops.execute(signer, operation, undefined, confirm)).rejects.toBeInstanceOf(UnexpectedLegError);
      expect(confirm).not.toHaveBeenCalled();
      nothingSigned();
    });

    it('a set with a bad leg in it is refused whole: the good legs before it are not signed', async () => {
      const signer = { signMessage: jest.fn(), signPreparedHash: jest.fn().mockResolvedValue('c2ln') };

      await expect(signLegs(signer, [leg('h1', PREPARED_HASH), topology(MULTIHASH)])).rejects.toBeInstanceOf(UnexpectedLegError);
      expect(signer.signPreparedHash).not.toHaveBeenCalled();
      expect(signer.signMessage).not.toHaveBeenCalled();
    });

    it('signLegs holds the legs to the operation when the caller names it, and only to the shape when it does not', async () => {
      const signer = { signMessage: jest.fn().mockResolvedValue('ab'.repeat(64)), signPreparedHash: jest.fn().mockResolvedValue('c2ln') };

      // Named: the same rule execute applies.
      await expect(signLegs(signer, [topology(MULTIHASH)], { operation: 'tokens.send' })).rejects.toBeInstanceOf(UnexpectedLegError);
      await expect(signLegs(signer, [leg('h1', PREPARED_HASH)], { operation: 'wallet.topology' })).rejects.toBeInstanceOf(UnexpectedLegError);
      expect(signer.signMessage).not.toHaveBeenCalled();
      expect(signer.signPreparedHash).not.toHaveBeenCalled();

      // Not named: a lone, well-formed topology leg is signed, as it always was.
      await expect(signLegs(signer, [topology(MULTIHASH)])).resolves.toEqual([
        { legId: 't1', signature: hexSignatureToBase64('ab'.repeat(64)) },
      ]);
      await expect(signLegs(signer, [topology(MULTIHASH)], { operation: 'wallet.topology' })).resolves.toHaveLength(1);
    });

    it('an operation with nothing left to do is still a success, for any operation', async () => {
      expect(() => assertOperationLegs([], 'wallet.topology')).not.toThrow();
      expect(() => assertOperationLegs([], 'tokens.send')).not.toThrow();
      expect(() => assertOperationLegs([])).not.toThrow();
      // And the ordinary legs of an ordinary operation are untouched by all of this.
      expect(() => assertOperationLegs([leg('h1', PREPARED_HASH), { legId: 'f1', hash: PREPARED_HASH, kind: 'fee' }], 'tokens.send')).not.toThrow();
    });

    it('says in the error that nothing was signed', async () => {
      const { ops, signer } = harness([topology(PREPARED_HASH)]);

      await expect(ops.execute(signer, 'wallet.topology')).rejects.toThrow(/34-byte sha2-256 multihash — nothing was signed/);
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
