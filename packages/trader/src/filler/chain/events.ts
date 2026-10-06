/**
 * Router events (`IntentOpened`, `Filled`, `Settled`, `Refunded`) that survive
 * reorganisations. The watcher polls `eth_getLogs` — `EvmRpc` is a plain
 * request interface, so no node subscription is assumed — and reports a log
 * only once it is `confirmations` blocks deep, so a shallow reorg never
 * produces an event at all.
 *
 * A deeper reorg is caught by re-reading block hashes: the last scanned block
 * and every block that held a reported log. A log whose block was replaced is
 * reported `removed`, the scan rewinds, and whatever the new chain holds is
 * reported `added` again. Every router event happens at most once per order,
 * so an event's identity is `(name, orderHash)`: between two `added` reports of
 * one identity there is always a `removed` — never a duplicate.
 *
 * The watcher keeps its cursor in memory; a caller that must resume after a
 * restart persists `cursor` and passes it back as `fromBlock` (a rescan
 * reports the logs of the rescanned range again).
 */
import { CANCORE_ROUTER_ABI, type Hex } from '@cancore/contracts';
import type { Logger } from '../runtime';
import { AbiDecodeError, decodeEventLog, entryOf, topicOf, type AbiEntry } from './abi';
import { ChainReadError, quantity, toQuantity, type ChainClient } from './client';

export const ROUTER_EVENTS = ['IntentOpened', 'Filled', 'Settled', 'Refunded'] as const;
export type RouterEventName = (typeof ROUTER_EVENTS)[number];

export interface RouterLog {
  name: RouterEventName;
  orderHash: Hex;
  /** Decoded arguments by name (the order tuple of `IntentOpened` as an object). */
  args: Readonly<Record<string, unknown>>;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
}

export type RouterEventUpdate = { kind: 'added'; log: RouterLog } | { kind: 'removed'; log: RouterLog };

export interface RouterEventWatcherOptions {
  client: ChainClient;
  /** The pinned router, from config. */
  router: Hex;
  /** A log is reported once its block is this many blocks below the head. */
  confirmations: number;
  /** First block to scan. */
  fromBlock: bigint;
  /** Called in chain order; awaited before the next update. */
  onUpdate: (update: RouterEventUpdate) => void | Promise<void>;
  logger: Logger;
  /** Blocks per `eth_getLogs` request. Default 2 000. */
  maxRange?: bigint;
  /** How far back reported logs are remembered for reorg checks. Default 1 024 blocks. */
  retentionBlocks?: bigint;
}

const ROUTER_ABI = CANCORE_ROUTER_ABI as unknown as readonly AbiEntry[];
const ENTRIES = new Map<Hex, AbiEntry>(ROUTER_EVENTS.map((name) => {
  const entry = entryOf(ROUTER_ABI, 'event', name);
  return [topicOf(entry), entry];
}));

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

const identity = (log: RouterLog): string => `${log.name}:${log.orderHash}`;

export class RouterEventWatcher {
  private next: bigint;
  private lastScanned: { number: bigint; hash: Hex } | undefined;
  /** Reported and not removed, by identity. */
  private readonly reported = new Map<string, RouterLog>();
  private polling: Promise<void> | undefined;

  constructor(private readonly options: RouterEventWatcherOptions) {
    if (!Number.isSafeInteger(options.confirmations) || options.confirmations < 0) throw new TypeError('confirmations must be a non-negative integer');
    this.next = options.fromBlock;
  }

  /** The next block the watcher will scan. */
  get cursor(): bigint {
    return this.next;
  }

  /** One round: check for a reorg, then report the logs of the newly confirmed blocks. One round at a time. */
  poll(): Promise<void> {
    this.polling ??= this.round().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async round(): Promise<void> {
    const { client } = this.options;
    await this.detectReorg();
    const head = await client.head();
    const confirmed = head - BigInt(this.options.confirmations);
    const maxRange = this.options.maxRange ?? 2_000n;
    while (this.next <= confirmed) {
      const to = this.next + maxRange - 1n < confirmed ? this.next + maxRange - 1n : confirmed;
      const logs = await this.fetch(this.next, to);
      for (const log of logs) await this.add(log);
      const header = await client.block(to);
      this.lastScanned = { number: header.number, hash: header.hash };
      this.next = to + 1n;
    }
    this.prune();
  }

  /**
   * The last scanned block and every block that holds a reported log, re-read:
   * a replaced block removes its logs and rewinds the scan to it.
   */
  private async detectReorg(): Promise<void> {
    const { client } = this.options;
    if (!this.lastScanned) return;
    if ((await client.block(this.lastScanned.number)).hash === this.lastScanned.hash) return;

    let rewindTo = this.lastScanned.number - (this.options.retentionBlocks ?? 1_024n);
    const byBlock = [...this.reported.values()].sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : a.blockNumber > b.blockNumber ? -1 : b.logIndex - a.logIndex));
    const checked = new Map<bigint, Hex>();
    for (const log of byBlock) {
      let hash = checked.get(log.blockNumber);
      if (hash === undefined) {
        hash = (await client.block(log.blockNumber)).hash;
        checked.set(log.blockNumber, hash);
      }
      if (hash === log.blockHash) {
        // The newest block that is still canonical: everything above it is rescanned.
        rewindTo = log.blockNumber + 1n;
        break;
      }
      this.reported.delete(identity(log));
      this.options.logger.warn('chain: router log removed by a reorg', { chain: client.chain, event: log.name, orderHash: log.orderHash, block: log.blockNumber.toString() });
      await this.options.onUpdate({ kind: 'removed', log });
    }
    if (rewindTo < this.options.fromBlock) rewindTo = this.options.fromBlock;
    this.next = rewindTo;
    this.lastScanned = undefined;
  }

  private async add(log: RouterLog): Promise<void> {
    const key = identity(log);
    const known = this.reported.get(key);
    if (known && known.blockHash === log.blockHash && known.logIndex === log.logIndex) return; // rescanned, still canonical
    if (known) {
      // The same event in another block without a reorg we saw: report the move, never two live copies.
      this.reported.delete(key);
      await this.options.onUpdate({ kind: 'removed', log: known });
    }
    this.reported.set(key, log);
    await this.options.onUpdate({ kind: 'added', log });
  }

  private async fetch(from: bigint, to: bigint): Promise<RouterLog[]> {
    const { client, router } = this.options;
    const raw = await client.request<unknown>('eth_getLogs', [{ address: router, fromBlock: toQuantity(from), toBlock: toQuantity(to), topics: [[...ENTRIES.keys()]] }]);
    if (!Array.isArray(raw)) throw new ChainReadError(client.chain, 'malformed', 'eth_getLogs did not return an array');
    const logs: RouterLog[] = [];
    for (const item of raw as Array<Record<string, unknown>>) {
      if (item.removed === true) continue;
      if (typeof item.address !== 'string' || item.address.toLowerCase() !== router.toLowerCase()) continue;
      logs.push(this.parse(item));
    }
    return logs.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex));
  }

  private parse(item: Record<string, unknown>): RouterLog {
    const { client } = this.options;
    try {
      const topics = item.topics as Hex[];
      if (!Array.isArray(topics) || typeof topics[0] !== 'string') throw new AbiDecodeError('no topics');
      const entry = ENTRIES.get(topics[0].toLowerCase() as Hex);
      if (!entry) throw new AbiDecodeError(`unknown topic ${topics[0]}`);
      const args = decodeEventLog(entry, { topics, data: item.data as Hex });
      if (typeof item.blockHash !== 'string' || !HEX32.test(item.blockHash) || typeof item.transactionHash !== 'string' || !HEX32.test(item.transactionHash)) {
        throw new AbiDecodeError('log without a block hash or transaction hash');
      }
      return {
        name: entry.name as RouterEventName,
        orderHash: args.orderHash as Hex,
        args,
        blockNumber: quantity(item.blockNumber, 'log.blockNumber'),
        blockHash: item.blockHash.toLowerCase() as Hex,
        transactionHash: item.transactionHash.toLowerCase() as Hex,
        logIndex: Number(quantity(item.logIndex, 'log.logIndex')),
      };
    } catch (error) {
      throw new ChainReadError(client.chain, 'malformed', `router log: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  private prune(): void {
    const floor = this.next - (this.options.retentionBlocks ?? 1_024n);
    for (const [key, log] of this.reported) if (log.blockNumber < floor) this.reported.delete(key);
  }
}
