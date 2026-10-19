/**
 * CAN-2776 against a real node: anvil, no contracts. Behind a load balancer
 * the node that answers may not have the block a depth read points at yet: dev
 * declined a ticket `V-E4: unverifiable: malformed: … no block 0xb64ed5`. A
 * lagging endpoint here is anvil itself, except that the newest blocks are not
 * there yet: `eth_getBlockByNumber` / `eth_getBlockByHash` answer `null` and a
 * call pinned to such a block fails `header not found`, as geth answers. Every
 * value read comes from anvil.
 *
 *   anvil &
 *   ANVIL_RPC_URL=http://127.0.0.1:8545 npm run test:int -- missing-block
 *
 * Skipped without ANVIL_RPC_URL. In this repository's CI the `anvil` job runs it.
 */
import type { Hex } from '@cancore/contracts';
import { ChainClient, ChainReadError } from '../src/filler/chain/client';
import type { EvmChainId } from '../src/filler/chains';
import type { EvmRpc } from '../src/filler/rpc';
import { createRecordingLogger } from '../src/filler/testing';

const RPC_URL = process.env.ANVIL_RPC_URL;
const live = RPC_URL ? describe : describe.skip;

// anvil's fourth default account: a public test address with a balance.
const HOLDER: Hex = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';

const httpRpc = (url: string): EvmRpc => {
  let id = 0;
  return {
    label: 'anvil',
    async request<T>({ method, params = [] }: { method: string; params?: readonly unknown[] }): Promise<T> {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      const body = (await response.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
      if (body.error) throw body.error;
      return body.result as T;
    },
  };
};

/**
 * anvil as a node `behind` blocks behind for its first `misses` answers about
 * a block: it reports the true head (another node of the balancer answered
 * that), but blocks newer than `head − behind` are not there.
 */
function lagging(inner: EvmRpc, o: { label: string; behind: bigint; misses: number; callsOnly?: boolean }) {
  let missed = 0;
  const state = { get missed() { return missed; } };
  const rpc: EvmRpc = {
    label: o.label,
    async request<T>(req: { method: string; params?: readonly unknown[] }): Promise<T> {
      const lacking = async (number: bigint) => {
        if (missed >= o.misses) return false;
        const head = BigInt(await inner.request<string>({ method: 'eth_blockNumber', params: [] }));
        if (number <= head - o.behind) return false;
        missed += 1;
        return true;
      };
      if (!o.callsOnly && req.method === 'eth_getBlockByNumber' && typeof req.params?.[0] === 'string' && req.params[0].startsWith('0x')) {
        if (await lacking(BigInt(req.params[0]))) return null as T;
      }
      if ((!o.callsOnly && req.method === 'eth_getBlockByHash') || req.method === 'eth_call' || req.method === 'eth_getBalance') {
        const ref = req.method === 'eth_getBlockByHash' ? req.params?.[0] : (req.params?.[1] as { blockHash?: string } | undefined)?.blockHash;
        if (typeof ref === 'string') {
          const block = await inner.request<{ number: string } | null>({ method: 'eth_getBlockByHash', params: [ref, false] });
          if (block && (await lacking(BigInt(block.number)))) {
            if (req.method === 'eth_getBlockByHash') return null as T;
            throw { code: -32000, message: 'header not found' };
          }
        }
      }
      return inner.request<T>(req);
    },
  };
  return { rpc, state };
}

live('CAN-2776: a block the answering node does not have yet, on anvil', () => {
  const anvil = httpRpc(RPC_URL ?? 'http://127.0.0.1:0');
  const logger = createRecordingLogger();
  let chain: EvmChainId;
  const sleeps: number[] = [];
  const client = (endpoints: EvmRpc[]) =>
    new ChainClient({ chain, endpoints, maxHeadLagBlocks: 5, logger, missingBlockRetry: { attempts: 4, delayMs: 50 }, sleep: async (ms) => void sleeps.push(ms) });

  beforeAll(async () => {
    chain = `eip155:${BigInt(await anvil.request<string>({ method: 'eth_chainId', params: [] }))}` as EvmChainId;
    // A few blocks, so that a depth read has history below the head.
    for (let i = 0; i < 4; i++) await anvil.request({ method: 'evm_mine', params: [] });
  });
  beforeEach(() => void sleeps.splice(0));

  test('TC-SDK-2776-01: the head block missing on the only node for two answers: the depth read waits and reads anvil’s value', async () => {
    const { rpc, state } = lagging(anvil, { label: 'lb', behind: 1n, misses: 2 });
    const expected = BigInt(await anvil.request<string>({ method: 'eth_getBalance', params: [HOLDER, 'latest'] }));
    await expect(client([rpc]).balance(HOLDER, { confirmations: 1 })).resolves.toBe(expected);
    expect(state.missed).toBe(2);
    expect(sleeps).toEqual([50, 100]);
  });

  test('TC-SDK-2776-02: one node lacks the block, the next has it: answered at once, nothing waited', async () => {
    const { rpc } = lagging(anvil, { label: 'behind', behind: 1n, misses: 100 });
    const head = BigInt(await anvil.request<string>({ method: 'eth_blockNumber', params: [] }));
    await expect(client([rpc, anvil]).block(head)).resolves.toMatchObject({ number: head });
    expect(sleeps).toEqual([]);
  });

  test('TC-SDK-2776-03: a call pinned to a block hash the node does not know (`header not found`) re-pins and calls again', async () => {
    const { rpc, state } = lagging(anvil, { label: 'lb', behind: 1n, misses: 1, callsOnly: true });
    const c = client([rpc]);
    // The header is served (another node of the balancer had it); the call lands on one that does not.
    const pinned = await c.pin({ confirmations: 1 });
    const value = await c.balance(HOLDER, pinned);
    expect(value).toBe(BigInt(await anvil.request<string>({ method: 'eth_getBalance', params: [HOLDER, 'latest'] })));
    expect(state.missed).toBe(1);
    expect(sleeps).toEqual([50]);
  });

  test('TC-SDK-2776-04: a block that never shows up fails unavailable with blockMissing — never malformed', async () => {
    const { rpc } = lagging(anvil, { label: 'lb', behind: 1n, misses: 1_000 });
    const error = await client([rpc]).balance(HOLDER, { confirmations: 1 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ChainReadError);
    expect(error).toMatchObject({ reason: 'unavailable', blockMissing: true });
    expect(sleeps).toEqual([50, 100, 200]);
  });

  test('TC-SDK-2776-05: an endpoint that is down is not a missing block: unavailable without blockMissing, no waiting', async () => {
    const down = httpRpc('http://127.0.0.1:9');
    const error = await client([down]).balance(HOLDER, { confirmations: 1 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ reason: 'unavailable', blockMissing: false });
    expect(sleeps).toEqual([]);
  });
});
