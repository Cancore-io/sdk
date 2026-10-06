/**
 * `FakeChain` — an EVM chain in memory behind `EvmRpc`: blocks with hashes,
 * one or more `CancoreRouter`s answering their views from scripted state,
 * ERC-20 balances and allowances, native balances, router logs, and reorgs.
 * Calls are decoded and answered through the same ABI of `@cancore/contracts`
 * the SDK encodes with, so a test exercises the real encoding both ways.
 *
 * `endpoint()` gives further `EvmRpc`s over the same chain, each with its own
 * label, head lag, outage switch or a wrong chain id — the material of
 * failover tests. Test use only.
 */
import { CANCORE_ROUTER_ABI, IBURN_MINT_ERC20_ABI, type FillProof, type FillTicket, type Hex, type Order } from '@cancore/contracts';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { decodeParams, encodeEventLog, encodeFunctionResult, selectorOf, topicOf, type AbiEntry } from '../chain/abi';
import { hashFillProof, hashOrder, hashTicket } from '../chain/hashes';
import type { AttestorSetRecord, IntentRecord } from '../chain/router';
import type { EvmRpc, EvmRpcRequest } from '../rpc';

const ROUTER_ABI = CANCORE_ROUTER_ABI as unknown as readonly AbiEntry[];
const ERC20_ABI = IBURN_MINT_ERC20_ABI as unknown as readonly AbiEntry[];
const ROUTER_FUNCTIONS = new Map(ROUTER_ABI.filter((e) => e.type === 'function').map((e) => [selectorOf(e), e]));
const ERC20_FUNCTIONS = new Map(ERC20_ABI.filter((e) => e.type === 'function' && (e.name === 'balanceOf' || e.name === 'allowance')).map((e) => [selectorOf(e), e]));

const lower = (address: string): string => address.toLowerCase();
const hex = (n: bigint): string => `0x${n.toString(16)}`;

/** A router escrow record, present from `atBlock` on (default: always). */
export interface FakeIntent extends IntentRecord {
  atBlock?: bigint;
}

/** The scripted state of one router; every map is keyed by lowercase hex. */
export class FakeRouter {
  readonly intents = new Map<string, FakeIntent>();
  /** `orderHash` → the block it was filled at. */
  readonly filled = new Map<string, bigint>();
  readonly ticketSigners = new Set<string>();
  readonly minInput = new Map<string, bigint>();
  readonly proofWindow = new Map<string, bigint>();
  readonly attestationSetFor = new Map<string, number>();
  readonly attestorSets = new Map<number, AttestorSetRecord>();
  readonly revokedAttestors = new Set<string>();
  currentSetId = 1;
  /** Source routers by origin chain id, for `sourceOrderHash`; this router itself for its own chain. */
  readonly sourceRouters = new Map<bigint, Hex>();

  constructor(
    readonly address: Hex,
    private readonly chain: FakeChain,
  ) {}

  openIntent(orderHash: Hex, record: Omit<FakeIntent, 'status'> & { status?: number }): this {
    this.intents.set(lower(orderHash), { status: 1, ...record });
    return this;
  }

  answer(entry: AbiEntry, args: unknown[], block: bigint): unknown[] {
    const key = (i: number) => lower(String(args[i]));
    switch (entry.name) {
      case 'intents': {
        const record = this.intents.get(key(0));
        if (!record || (record.atBlock !== undefined && block < record.atBlock)) return [0n, 0n, 0n];
        return [BigInt(record.status), record.refundAfter, record.openedAt];
      }
      case 'filled': {
        const at = this.filled.get(key(0));
        return [at !== undefined && at <= block];
      }
      case 'ticketSigners':
        return [this.ticketSigners.has(key(0))];
      case 'minInput':
        return [this.minInput.get(key(0)) ?? 0n];
      case 'proofWindow':
        return [this.proofWindow.get(key(0)) ?? 0n];
      case 'attestationSetFor':
        return [BigInt(this.attestationSetFor.get(key(0)) ?? 0)];
      case 'getAttestorSet': {
        const set = this.attestorSets.get(Number(args[0]));
        return set ? [set.members, BigInt(set.threshold), set.activeFrom, set.retiredAt] : [[], 0n, 0n, 0n];
      }
      case 'revokedAttestors':
        return [this.revokedAttestors.has(key(0))];
      case 'currentSetId':
        return [BigInt(this.currentSetId)];
      case 'isMember':
        return [this.attestorSets.get(Number(args[0]))?.members.some((m) => lower(m) === key(1)) ?? false];
      case 'hashOrder':
        return [hashOrder(args[0] as Order, { chainId: this.chain.chainId, router: this.address })];
      case 'sourceOrderHash': {
        const order = args[0] as Order;
        const origin = BigInt(order.originChainId);
        const router = this.sourceRouters.get(origin) ?? (origin === this.chain.chainId ? this.address : undefined);
        if (!router) throw Object.assign(new Error('execution reverted: SourceRouterUnknown'), { code: 3 });
        return [hashOrder(order, { chainId: origin, router })];
      }
      case 'hashTicket':
        return [hashTicket(args[0] as FillTicket)];
      case 'hashFillProof':
        return [hashFillProof(args[0] as FillProof, { chainId: this.chain.chainId, router: this.address })];
      default:
        throw Object.assign(new Error(`execution reverted: FakeRouter has no ${entry.name}`), { code: 3 });
    }
  }
}

/** ERC-20 state of one token. */
export class FakeToken {
  readonly balances = new Map<string, bigint>();
  /** `${owner}:${spender}` → allowance. */
  readonly allowances = new Map<string, bigint>();

  setBalance(owner: Hex, amount: bigint): this {
    this.balances.set(lower(owner), amount);
    return this;
  }

  approve(owner: Hex, spender: Hex, amount: bigint): this {
    this.allowances.set(`${lower(owner)}:${lower(spender)}`, amount);
    return this;
  }
}

interface FakeLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

export interface FakeEndpointOptions {
  label?: string;
  /** This endpoint's head trails the chain's by this many blocks. */
  headLag?: bigint;
  /** What `eth_chainId` answers instead of the chain's id. */
  chainId?: bigint;
}

/** One `EvmRpc` over a `FakeChain`. `down` makes every request reject. */
export class FakeEndpoint implements EvmRpc {
  readonly calls: EvmRpcRequest[] = [];
  down = false;
  readonly label: string;

  constructor(
    private readonly chain: FakeChain,
    private readonly options: FakeEndpointOptions = {},
  ) {
    this.label = options.label ?? 'fake-chain';
  }

  async request<T = unknown>(request: EvmRpcRequest): Promise<T> {
    this.calls.push({ method: request.method, params: [...(request.params ?? [])] });
    if (this.down) throw new Error(`${this.label}: connection refused`);
    const head = this.chain.head - (this.options.headLag ?? 0n);
    return this.chain.handle(request, head, this.options.chainId ?? this.chain.chainId) as T;
  }
}

export class FakeChain implements EvmRpc {
  /** The chain's head; move it with `mine`. */
  head = 100n;
  /** `safe` / `finalized` blocks; default the head. */
  safe: bigint | undefined;
  finalized: bigint | undefined;
  readonly routers = new Map<string, FakeRouter>();
  readonly tokens = new Map<string, FakeToken>();
  readonly nativeBalances = new Map<string, bigint>();
  private readonly logs: FakeLog[] = [];
  private readonly forks = new Map<bigint, number>();
  private forkCounter = 0;
  private txCounter = 0;
  private readonly primary: FakeEndpoint;

  constructor(
    readonly chainId: bigint,
    readonly label = 'fake-chain',
  ) {
    this.primary = new FakeEndpoint(this, { label });
  }

  get calls(): EvmRpcRequest[] {
    return this.primary.calls;
  }

  /** Whether the chain's own endpoint rejects every request. */
  get down(): boolean {
    return this.primary.down;
  }

  set down(value: boolean) {
    this.primary.down = value;
  }

  request<T = unknown>(request: EvmRpcRequest): Promise<T> {
    return this.primary.request<T>(request);
  }

  /** Another endpoint over this chain. */
  endpoint(options: FakeEndpointOptions = {}): FakeEndpoint {
    return new FakeEndpoint(this, options);
  }

  router(address: Hex): FakeRouter {
    let router = this.routers.get(lower(address));
    if (!router) {
      router = new FakeRouter(address, this);
      this.routers.set(lower(address), router);
    }
    return router;
  }

  token(address: Hex): FakeToken {
    let token = this.tokens.get(lower(address));
    if (!token) {
      token = new FakeToken();
      this.tokens.set(lower(address), token);
    }
    return token;
  }

  mine(blocks = 1n): this {
    this.head += blocks;
    return this;
  }

  /** The hash of block `n` on the current fork. */
  blockHash(n: bigint): Hex {
    return `0x${bytesToHex(keccak_256(utf8ToBytes(`${this.label}:${n}:${this.forks.get(n) ?? 0}`)))}`;
  }

  /** A router event in block `blockNumber` (default: the head). */
  emit(router: Hex, name: string, args: Readonly<Record<string, unknown>>, blockNumber = this.head): Hex {
    const entry = ROUTER_ABI.find((e) => e.type === 'event' && e.name === name);
    if (!entry) throw new Error(`no router event ${name}`);
    const { topics, data } = encodeEventLog(entry, args);
    const transactionHash: Hex = `0x${bytesToHex(keccak_256(utf8ToBytes(`${this.label}:tx:${this.txCounter++}`)))}`;
    const logIndex = this.logs.filter((l) => l.blockNumber === blockNumber).length;
    this.logs.push({ address: lower(router), topics: [...topics], data, blockNumber, logIndex, transactionHash });
    return transactionHash;
  }

  /** Replaces every block from `fromBlock` up: new hashes, and the logs in them are gone. */
  reorg(fromBlock: bigint): this {
    this.forkCounter++;
    for (let n = fromBlock; n <= this.head; n++) this.forks.set(n, this.forkCounter);
    for (let i = this.logs.length - 1; i >= 0; i--) if (this.logs[i]!.blockNumber >= fromBlock) this.logs.splice(i, 1);
    return this;
  }

  /** @internal Answers one request as an endpoint whose head is `head`. */
  handle(request: EvmRpcRequest, head: bigint, chainId: bigint): unknown {
    const params = request.params ?? [];
    switch (request.method) {
      case 'eth_chainId':
        return hex(chainId);
      case 'eth_blockNumber':
        return hex(head);
      case 'eth_getBlockByNumber': {
        const n = this.blockOf(params[0], head);
        if (n === undefined || n > head) return null;
        return { number: hex(n), hash: this.blockHash(n), parentHash: n === 0n ? `0x${'00'.repeat(32)}` : this.blockHash(n - 1n) };
      }
      case 'eth_getBalance': {
        this.requireBlock(params[1], head);
        return hex(this.nativeBalances.get(lower(String(params[0]))) ?? 0n);
      }
      case 'eth_call': {
        const block = this.requireBlock(params[1], head);
        const { to, data } = params[0] as { to: string; data: Hex };
        return this.call(lower(to), data, block);
      }
      case 'eth_getLogs': {
        const filter = params[0] as { address: string; fromBlock: string; toBlock: string; topics?: Hex[][] };
        const from = BigInt(filter.fromBlock);
        const to = BigInt(filter.toBlock);
        const topic0 = filter.topics?.[0]?.map((t) => t.toLowerCase());
        return this.logs
          .filter((l) => l.address === lower(filter.address) && l.blockNumber >= from && l.blockNumber <= to && l.blockNumber <= head && (!topic0 || topic0.includes(l.topics[0]!)))
          .map((l) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            blockNumber: hex(l.blockNumber),
            blockHash: this.blockHash(l.blockNumber),
            transactionHash: l.transactionHash,
            logIndex: hex(BigInt(l.logIndex)),
            removed: false,
          }));
      }
      default:
        throw new Error(`FakeChain: ${request.method} is not scripted`);
    }
  }

  private call(to: string, data: Hex, block: bigint): Hex {
    const selector = data.slice(0, 10).toLowerCase() as Hex;
    const router = this.routers.get(to);
    if (router) {
      const entry = ROUTER_FUNCTIONS.get(selector);
      if (!entry) throw Object.assign(new Error('execution reverted'), { code: 3 });
      const args = decodeParams(entry.inputs ?? [], `0x${data.slice(10)}`);
      return encodeFunctionResult(entry, router.answer(entry, args, block));
    }
    const token = this.tokens.get(to);
    const entry = ERC20_FUNCTIONS.get(selector);
    if (token && entry) {
      const args = decodeParams(entry.inputs ?? [], `0x${data.slice(10)}`).map((a) => lower(String(a)));
      const value = entry.name === 'balanceOf' ? token.balances.get(args[0]!) ?? 0n : token.allowances.get(`${args[0]}:${args[1]}`) ?? 0n;
      return encodeFunctionResult(entry, [value]);
    }
    // A call to an address without code returns empty data.
    return '0x';
  }

  private blockOf(tag: unknown, head: bigint): bigint | undefined {
    if (tag === 'latest' || tag === 'pending') return head;
    if (tag === 'safe') return this.safe ?? head;
    if (tag === 'finalized') return this.finalized ?? head;
    if (tag === 'earliest') return 0n;
    if (typeof tag === 'string' && /^0x[0-9a-fA-F]+$/.test(tag)) return BigInt(tag);
    return undefined;
  }

  private requireBlock(tag: unknown, head: bigint): bigint {
    const n = this.blockOf(tag, head);
    if (n === undefined) throw new Error(`invalid block tag ${String(tag)}`);
    if (n > head) throw Object.assign(new Error('header not found'), { code: -32000 });
    return n;
  }
}

/** `topics[0]` of a router event, for tests that filter logs by hand. */
export const routerEventTopic = (name: string): Hex => {
  const entry = ROUTER_ABI.find((e) => e.type === 'event' && e.name === name);
  if (!entry) throw new Error(`no router event ${name}`);
  return topicOf(entry);
};
