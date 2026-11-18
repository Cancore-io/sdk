import {
  createWalletOperations,
  OperationNotCommittedError,
  OperationOutcomeUnknownError,
  type WalletRequest,
} from './operations';

const PENDING = { operationId: 'op-1', status: 'pending' };
const SIGNED = [{ legId: 'leg-1', signature: 'sig' }];

/** A backend whose submit and status answers are scripted in turn, recording every call. */
function backend(submits: Array<unknown | Error>, statuses: string[]) {
  const calls: string[] = [];
  const request = (async (endpoint: string) => {
    calls.push(endpoint);
    const next = endpoint === '/wallet/operations/submit' ? submits.shift() : { operationId: 'op-1', status: statuses.shift() };
    if (next instanceof Error) throw next;
    return next;
  }) as WalletRequest;
  const ops = createWalletOperations(request, { sleep: async () => {}, intervalMs: 1, timeoutMs: 1_000 });
  return { ops, calls };
}

describe('submit answered 202 pending (CAN-3679)', () => {
  it('is never a success: polls the status, then returns the replayed result once committed', async () => {
    const { ops, calls } = backend([PENDING, { updateId: 'upd-1' }], ['submitted', 'committed']);

    await expect(ops.submit('op-1', SIGNED)).resolves.toEqual({ updateId: 'upd-1' });
    expect(calls).toEqual(['/wallet/operations/submit', '/wallet/operations/op-1', '/wallet/operations/op-1', '/wallet/operations/submit']);
  });

  it('surfaces the coded refusal the backend replays once rejected', async () => {
    const refusal = Object.assign(new Error('holdings are invalid'), { errorCode: 'WALLET_TOO_FRAGMENTED' });
    const { ops } = backend([PENDING, refusal], ['rejected']);

    await expect(ops.submit('op-1', SIGNED)).rejects.toBe(refusal);
  });

  it('never resubmits while the operation is still submitted', async () => {
    const { ops, calls } = backend([PENDING, { updateId: 'upd-1' }], ['submitted', 'submitted', 'submitted', 'committed']);

    await ops.submit('op-1', SIGNED);
    expect(calls.filter((c) => c === '/wallet/operations/submit')).toHaveLength(2);
  });

  it('reports an expired, never committed operation as not committed', async () => {
    const { ops } = backend([PENDING], ['expired_not_committed']);

    await expect(ops.submit('op-1', SIGNED)).rejects.toBeInstanceOf(OperationNotCommittedError);
  });

  it('gives up as outcome-unknown, not as a failure, when the status never settles', async () => {
    let clock = 0;
    const request = (async (endpoint: string) =>
      endpoint === '/wallet/operations/submit' ? PENDING : { operationId: 'op-1', status: 'submitted' }) as WalletRequest;
    const ops = createWalletOperations(request, { sleep: async (ms) => void (clock += ms), now: () => clock, intervalMs: 100, timeoutMs: 1_000 });

    await expect(ops.submit('op-1', SIGNED)).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
  });

  it('passes a direct answer through untouched, as before', async () => {
    const { ops, calls } = backend([{ updateId: 'upd-0' }], []);

    await expect(ops.submit('op-1', SIGNED)).resolves.toEqual({ updateId: 'upd-0' });
    expect(calls).toEqual(['/wallet/operations/submit']);
  });
});
