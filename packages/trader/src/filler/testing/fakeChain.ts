/**
 * `FakeChain` — an EVM chain in memory behind `EvmRpc`: blocks with hashes,
 * one or more `CancoreRouter`s answering their views from scripted state,
 * ERC-20 balances and allowances, native balances, router logs, and reorgs —
 * and transactions: a mempool, `eth_sendRawTransaction` with replace-by-fee
 * rules, blocks that include and execute them (`fill`, `approve`, plain
 * transfers), receipts, and reorgs that undo them.
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
import { decodeSignedTransaction, type DecodedTransaction } from './transactions';
import { hashFillProof, hashOrder, hashTicket } from '../chain/hashes';
import type { AttestorSetRecord, IntentRecord } from '../chain/router';
import type { EvmRpc, EvmRpcRequest } from '../rpc';

const ROUTER_ABI = CANCORE_ROUTER_ABI as unknown as readonly AbiEntry[];
const ERC20_ABI = IBURN_MINT_ERC20_ABI as unknown as readonly AbiEntry[];
const ROUTER_FUNCTIONS = new Map(ROUTER_ABI.filter((e) => e.type === 'function').map((e) => [selectorOf(e), e]));
const ERC20_FUNCTIONS = new Map(ERC20_ABI.filter((e) => e.type === 'function' && (e.name === 'balanceOf' || e.name === 'allowance')).map((e) => [selectorOf(e), e]));
const ERC20_APPROVE = ERC20_ABI.find((e) => e.type === 'function' && e.name === 'approve')!;
const ROUTER_FILL = ROUTER_ABI.find((e) => e.type === 'function' && e.name === 'fill')!;

/** The revert data of a custom error without arguments: its selector. */
export const errorSelector = (name: string): Hex => `0x${bytesToHex(keccak_256(utf8ToBytes(`${name}()`))).slice(0, 8)}`;

const revert = (name: string): Error => Object.assign(new Error(`execution reverted: ${name}`), { code: 3, data: errorSelector(name) });

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
  /** Fee the token takes on every transfer, basis points: the recipient gets less than was sent. */
  transferFeeBps = 0n;
  /** Refuses to change a non-zero allowance to another non-zero one (USDT). */
  zeroFirst = false;
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

/** A transaction in the mempool. */
export interface FakePendingTransaction extends DecodedTransaction {
  raw: Hex;
}

/** A transaction in a block. */
export interface FakeMinedTransaction extends FakePendingTransaction {
  blockNumber: bigint;
  status: 0 | 1;
  gasUsed: bigint;
  /** The custom error it reverted with. */
  error?: string;
  logs: FakeLog[];
  /** Restores the state it changed (a reorg). */
  undo: () => void;
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
  /** This endpoint follows another fork: its block hashes differ from the chain's at every height. */
  fork?: string;
  /** Methods this endpoint rejects. */
  failing?: readonly string[];
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
    if (this.options.failing?.includes(request.method)) throw new Error(`${this.label}: ${request.method} failed`);
    const head = this.chain.head - (this.options.headLag ?? 0n);
    return this.chain.handle(request, head, this.options.chainId ?? this.chain.chainId, this.options.fork) as T;
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
  /** Base fee of every block. */
  baseFeePerGas = 1_000_000_000n;
  /** What `eth_maxPriorityFeePerGas` answers. */
  priorityFee = 1_000_000_000n;
  /** A transaction whose tip is below this stays in the mempool (a stuck transaction). */
  minTip = 0n;
  /** A reorg drops the transactions it undoes instead of returning them to the mempool. */
  dropOnReorg = false;
  /** `eth_getTransactionReceipt` answers null for every transaction: an endpoint whose receipts lag its state. */
  hideReceipts = false;
  /** `timestamp` of block 0; later blocks are `blockTime` apart unless set with `setTimestamp`. */
  genesisTime = 1_789_998_800n;
  blockTime = 12n;
  private readonly timestamps = new Map<bigint, bigint>();
  /** By `from:nonce`. */
  readonly mempool = new Map<string, FakePendingTransaction>();
  /** By hash, in inclusion order. */
  readonly minedTransactions = new Map<string, FakeMinedTransaction>();
  /** Next nonce per sender, by mined transactions. */
  readonly accountNonces = new Map<string, bigint>();
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

  /** Adds `blocks` blocks; each includes and executes what the mempool holds that pays the base fee and `minTip`. */
  mine(blocks = 1n): this {
    for (let i = 0n; i < blocks; i++) {
      this.head += 1n;
      this.include(this.head);
    }
    return this;
  }

  /** `timestamp` of block `n`: the last one set at or below `n`, plus `blockTime` per block since. */
  timestampOf(n: bigint): bigint {
    let anchor: [bigint, bigint] = [0n, this.genesisTime];
    for (const [block, at] of this.timestamps) if (block <= n && block >= anchor[0]) anchor = [block, at];
    return anchor[1] + (n - anchor[0]) * this.blockTime;
  }

  /** Sets the `timestamp` of block `n`; the blocks after it follow `blockTime` apart. */
  setTimestamp(n: bigint, timestamp: bigint): this {
    this.timestamps.set(n, timestamp);
    return this;
  }

  /** A pending transaction by hash. */
  pendingByHash(hash: string): FakePendingTransaction | undefined {
    return [...this.mempool.values()].find((t) => t.hash === hash.toLowerCase());
  }

  private nonceOf(address: string): bigint {
    return this.accountNonces.get(lower(address)) ?? 0n;
  }

  private include(block: bigint): void {
    for (;;) {
      const next = [...this.mempool.values()]
        .filter((t) => t.nonce === this.nonceOf(t.from) && t.maxFeePerGas >= this.baseFeePerGas && t.maxPriorityFeePerGas >= this.minTip)
        .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))[0];
      if (!next) return;
      this.mempool.delete(`${next.from}:${next.nonce}`);
      this.accountNonces.set(next.from, next.nonce + 1n);
      this.minedTransactions.set(next.hash, this.execute(next, block));
    }
  }

  /** Runs `tx` in `block`: its effects, logs and an undo. */
  private execute(tx: FakePendingTransaction, block: bigint): FakeMinedTransaction {
    const undo: Array<() => void> = [];
    const logs: FakeLog[] = [];
    const mined = (status: 0 | 1, gasUsed: bigint, error?: string): FakeMinedTransaction => ({
      ...tx,
      blockNumber: block,
      status,
      gasUsed,
      ...(error ? { error } : {}),
      logs,
      undo: () => undo.reverse().forEach((u) => u()),
    });
    try {
      const effect = this.effect(tx, this.timestampOf(block), block);
      if (!effect) return mined(1, 21_000n);
      undo.push(...effect.undo);
      for (const log of effect.logs) {
        const entry = ROUTER_ABI.find((e) => e.type === 'event' && e.name === log.name)!;
        const { topics, data } = encodeEventLog(entry, log.args);
        const stored: FakeLog = { address: lower(log.address), topics: [...topics], data, blockNumber: block, logIndex: this.logs.filter((l) => l.blockNumber === block).length, transactionHash: tx.hash };
        this.logs.push(stored);
        logs.push(stored);
      }
      return mined(1, effect.gasUsed);
    } catch (error) {
      return mined(0, 30_000n, (error as Error).message.replace('execution reverted: ', ''));
    }
  }

  /**
   * What a call does at `timestamp`: router `fill` (the checks of
   * `CancoreRouter.fill` a filler can trip, T-25…T-28) and ERC-20 `approve`;
   * throws a revert. Undefined for a plain transfer. Changes nothing until
   * `apply` — `eth_estimateGas` runs it and drops the result.
   */
  private effect(tx: { from: string; to: string; data: Hex }, timestamp: bigint, block: bigint): { gasUsed: bigint; logs: Array<{ address: string; name: string; args: Record<string, unknown> }>; undo: Array<() => void> } | undefined {
    const selector = tx.data.slice(0, 10).toLowerCase();
    const to = lower(tx.to);
    const router = this.routers.get(to);
    if (router && selector === selectorOf(ROUTER_FILL)) {
      const [order, amount, ticket] = decodeParams(ROUTER_FILL.inputs ?? [], `0x${tx.data.slice(10)}`) as [Order, bigint, Record<string, unknown>, Hex];
      const orderHash = lower(String(ticket.orderHash));
      if (router.filled.has(orderHash)) throw revert('AlreadyFilled');
      if (timestamp < BigInt(String(ticket.validFrom))) throw revert('TicketNotYetValid');
      if (timestamp > BigInt(String(ticket.validUntil))) throw revert('TicketExpired');
      if (lower(String(ticket.deliveryKey)) !== lower(tx.from)) throw revert('WrongDeliveryKey');
      const token = this.tokens.get(lower(`0x${String(order.outputAsset).slice(26)}`));
      const allowanceKey = `${lower(tx.from)}:${to}`;
      const allowance = token?.allowances.get(allowanceKey) ?? 0n;
      const balance = token?.balances.get(lower(tx.from)) ?? 0n;
      if (!token || allowance < amount || balance < amount) throw revert('TransferFailed');
      const received = amount - (amount * token.transferFeeBps) / 10_000n;
      if (received < BigInt(String(order.minReceived))) throw revert('BelowMinReceived');
      const recipient = lower(`0x${String(order.recipient).slice(26)}`);
      const before = token.balances.get(recipient) ?? 0n;
      token.balances.set(lower(tx.from), balance - amount);
      token.balances.set(recipient, before + received);
      token.allowances.set(allowanceKey, allowance - amount);
      router.filled.set(orderHash, block);
      return {
        gasUsed: 95_000n,
        logs: [{ address: to, name: 'Filled', args: { orderHash, fillerId: ticket.fillerId, deliveryKey: lower(tx.from), repayTo: ticket.repayTo, received, recipient: order.recipient, filledAt: timestamp, attempt: ticket.attempt } }],
        undo: [
          () => token.balances.set(lower(tx.from), balance),
          () => token.balances.set(recipient, before),
          () => token.allowances.set(allowanceKey, allowance),
          () => router.filled.delete(orderHash),
        ],
      };
    }
    const token = this.tokens.get(to);
    if (token && selector === selectorOf(ERC20_APPROVE)) {
      const [spender, value] = decodeParams(ERC20_APPROVE.inputs ?? [], `0x${tx.data.slice(10)}`) as [Hex, bigint];
      const k = `${lower(tx.from)}:${lower(spender)}`;
      const before = token.allowances.get(k) ?? 0n;
      if (token.zeroFirst && before !== 0n && value !== 0n) throw revert('ApproveFromNonZero');
      token.allowances.set(k, value);
      return { gasUsed: 46_000n, logs: [], undo: [() => token.allowances.set(k, before)] };
    }
    return undefined;
  }

  /** `eth_estimateGas`: runs the call in the next block and undoes it at once; a revert is thrown. */
  private estimate(call: { from: string; to: string; data?: Hex }, head: bigint): bigint {
    const effect = this.effect({ from: call.from, to: call.to, data: call.data ?? '0x' }, this.timestampOf(head + 1n), head + 1n);
    if (!effect) return 21_000n;
    effect.undo.reverse().forEach((u) => u());
    return effect.gasUsed;
  }

  private sendRaw(raw: Hex, chainId: bigint): Hex {
    const tx = { ...decodeSignedTransaction(raw), raw: raw.toLowerCase() as Hex };
    if (tx.chainId !== chainId) throw Object.assign(new Error('invalid chain id'), { code: -32000 });
    if (this.minedTransactions.has(tx.hash) || this.pendingByHash(tx.hash)) throw Object.assign(new Error('already known'), { code: -32000 });
    if (tx.nonce < this.nonceOf(tx.from)) throw Object.assign(new Error('nonce too low'), { code: -32000 });
    const k = `${tx.from}:${tx.nonce}`;
    const replaced = this.mempool.get(k);
    if (replaced && (tx.maxFeePerGas * 10n < replaced.maxFeePerGas * 11n || tx.maxPriorityFeePerGas * 10n < replaced.maxPriorityFeePerGas * 11n)) {
      throw Object.assign(new Error('replacement transaction underpriced'), { code: -32000 });
    }
    this.mempool.set(k, tx);
    return tx.hash;
  }

  /** The hash of block `n` on the current fork (or on the named fork of an endpoint). */
  blockHash(n: bigint, fork?: string): Hex {
    return `0x${bytesToHex(keccak_256(utf8ToBytes(`${this.label}:${fork ?? ''}:${n}:${this.forks.get(n) ?? 0}`)))}`;
  }

  /** The height of the block with `hash` on the current fork (or the named one), at or below `head`. */
  numberOfHash(hash: string, head = this.head, fork?: string): bigint | undefined {
    for (let n = head; n >= 0n; n--) if (this.blockHash(n, fork) === hash.toLowerCase()) return n;
    return undefined;
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
    const undone = [...this.minedTransactions.values()].filter((t) => t.blockNumber >= fromBlock).reverse();
    for (const tx of undone) {
      tx.undo();
      this.minedTransactions.delete(tx.hash);
      if (this.nonceOf(tx.from) > tx.nonce) this.accountNonces.set(tx.from, tx.nonce);
      if (!this.dropOnReorg) {
        const { blockNumber: _b, status: _s, gasUsed: _g, error: _e, logs: _l, undo: _u, ...pending } = tx;
        this.mempool.set(`${tx.from}:${tx.nonce}`, pending);
      }
    }
    this.forkCounter++;
    for (let n = fromBlock; n <= this.head; n++) this.forks.set(n, this.forkCounter);
    for (let i = this.logs.length - 1; i >= 0; i--) if (this.logs[i]!.blockNumber >= fromBlock) this.logs.splice(i, 1);
    return this;
  }

  /** @internal Answers one request as an endpoint whose head is `head`. */
  handle(request: EvmRpcRequest, head: bigint, chainId: bigint, fork?: string): unknown {
    const params = request.params ?? [];
    switch (request.method) {
      case 'eth_chainId':
        return hex(chainId);
      case 'eth_blockNumber':
        return hex(head);
      case 'eth_getBlockByNumber': {
        const n = this.blockOf(params[0], head);
        if (n === undefined || n > head) return null;
        return this.blockObject(n, fork);
      }
      case 'eth_getBlockByHash': {
        const n = this.numberOfHash(String(params[0]), head, fork);
        if (n === undefined) return null;
        return this.blockObject(n, fork);
      }
      case 'eth_maxPriorityFeePerGas':
        return hex(this.priorityFee);
      case 'eth_getTransactionCount': {
        const address = lower(String(params[0]));
        const mined = this.nonceOf(address);
        if (params[1] !== 'pending') return hex(mined);
        let next = mined;
        while (this.mempool.has(`${address}:${next}`)) next++;
        return hex(next);
      }
      case 'eth_estimateGas':
        return hex(this.estimate(params[0] as { from: string; to: string; data?: Hex }, head));
      case 'eth_sendRawTransaction':
        return this.sendRaw(String(params[0]) as Hex, chainId);
      case 'eth_getTransactionByHash': {
        const hash = lower(String(params[0]));
        const mined = this.minedTransactions.get(hash);
        if (mined && mined.blockNumber <= head) return { hash, blockNumber: hex(mined.blockNumber), nonce: hex(mined.nonce) };
        const pending = this.pendingByHash(hash);
        return pending ? { hash, blockNumber: null, nonce: hex(pending.nonce) } : null;
      }
      case 'eth_getTransactionReceipt': {
        const mined = this.minedTransactions.get(lower(String(params[0])));
        if (!mined || mined.blockNumber > head || this.hideReceipts) return null;
        return {
          transactionHash: mined.hash,
          status: hex(BigInt(mined.status)),
          blockNumber: hex(mined.blockNumber),
          blockHash: this.blockHash(mined.blockNumber, fork),
          gasUsed: hex(mined.gasUsed),
          effectiveGasPrice: hex(this.baseFeePerGas + (mined.maxPriorityFeePerGas < mined.maxFeePerGas - this.baseFeePerGas ? mined.maxPriorityFeePerGas : mined.maxFeePerGas - this.baseFeePerGas)),
          logs: mined.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
        };
      }
      case 'eth_getBalance': {
        this.requireBlock(params[1], head, fork);
        return hex(this.nativeBalances.get(lower(String(params[0]))) ?? 0n);
      }
      case 'eth_call': {
        const block = this.requireBlock(params[1], head, fork);
        const { to, data } = params[0] as { to: string; data: Hex };
        return this.call(lower(to), data, block);
      }
      case 'eth_getLogs': {
        const filter = params[0] as { address: string; fromBlock: string; toBlock: string; topics?: Array<Hex | Hex[] | null> };
        const from = BigInt(filter.fromBlock);
        const to = filter.toBlock === 'latest' ? head : BigInt(filter.toBlock);
        // A topic position is one value or a list of alternatives (JSON-RPC); positions after the first narrow by equality.
        const position = (i: number) => {
          const value = filter.topics?.[i];
          return value === undefined || value === null ? undefined : (Array.isArray(value) ? value : [value]).map((t) => t.toLowerCase());
        };
        const topic0 = position(0);
        const topic1 = position(1);
        return this.logs
          .filter((l) => l.address === lower(filter.address) && l.blockNumber >= from && l.blockNumber <= to && l.blockNumber <= head && (!topic0 || topic0.includes(l.topics[0]!)) && (!topic1 || topic1.includes(l.topics[1]!)))
          .map((l) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            blockNumber: hex(l.blockNumber),
            blockHash: this.blockHash(l.blockNumber, fork),
            transactionHash: l.transactionHash,
            logIndex: hex(BigInt(l.logIndex)),
            removed: false,
          }));
      }
      default:
        throw new Error(`FakeChain: ${request.method} is not scripted`);
    }
  }

  private blockObject(n: bigint, fork?: string): Record<string, unknown> {
    return {
      number: hex(n),
      hash: this.blockHash(n, fork),
      parentHash: n === 0n ? `0x${'00'.repeat(32)}` : this.blockHash(n - 1n, fork),
      timestamp: hex(this.timestampOf(n)),
      baseFeePerGas: hex(this.baseFeePerGas),
      transactions: [],
    };
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

  private requireBlock(tag: unknown, head: bigint, fork?: string): bigint {
    if (typeof tag === 'object' && tag !== null && 'blockHash' in tag) {
      // EIP-1898: a block this endpoint does not hold on its own chain is not served.
      const n = this.numberOfHash(String((tag as { blockHash: unknown }).blockHash), head, fork);
      if (n === undefined) throw Object.assign(new Error('header not found'), { code: -32000 });
      return n;
    }
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
