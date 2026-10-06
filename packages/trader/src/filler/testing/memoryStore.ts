/**
 * `InMemoryFillerStore` — a `FillerStore` for unit tests. NOT for production:
 * a filler node passes its Postgres store, shared by every replica.
 *
 * It keeps the contract the Postgres store keeps, so tests written against it
 * hold for the real one: per-order transactions run one at a time and commit
 * or roll back as a whole, writes are idempotent by message identity, nonce
 * leases expire by store time. Two `createFiller` instances on one
 * `InMemoryFillerStore` model two replicas on one database.
 */
import type { Hex, QuoteAck } from '@cancore/contracts';
import type { EvmChainId } from '../chains';
import { FillerStoreUnavailableError } from '../errors';
import { systemClock, type Clock } from '../runtime';
import type {
  AttestationRecord,
  EvidenceEntry,
  FillerStore,
  FillRecord,
  InFlightTransaction,
  NonceAllocation,
  NonceLease,
  NonceLeases,
  NonceRecord,
  OrderTransaction,
  QuoteLedger,
  RuntimeOverrides,
  SettlementRecord,
  StoredQuote,
  TicketRecord,
} from '../store';

interface OrderState {
  tickets: Map<number, TicketRecord>;
  fills: Map<number, FillRecord>;
  attestations: Map<number, AttestationRecord>;
  settlement: SettlementRecord | undefined;
}

const TERMINAL_TICKET_STATES = new Set(['declined', 'expired']);

const emptyOrder = (): OrderState => ({ tickets: new Map(), fills: new Map(), attestations: new Map(), settlement: undefined });

/** Deep copy, so a caller holding a returned record cannot mutate the store behind its back. */
const copy = <T>(value: T): T => structuredClone(value);

const key = (chain: EvmChainId, address: Hex): string => `${chain}|${address.toLowerCase()}`;

export class InMemoryFillerStore implements FillerStore {
  private readonly orders = new Map<string, OrderState>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly evidence = new Map<string, EvidenceEntry>();
  private readonly quoteRecords = new Map<string, StoredQuote>();
  private readonly quoteNonces = new Map<string, bigint>();
  private readonly nonceRecords = new Map<string, NonceRecord[]>();
  private readonly nextNonces = new Map<string, bigint>();
  private overrides: RuntimeOverrides = { paused: false };
  private down = false;

  /** `clock` is the store's own time (Postgres `now()`); share a `FakeClock` with the test to drive lease expiry. */
  constructor(private readonly clock: Clock = systemClock) {}

  // --- test controls -------------------------------------------------------

  /** Simulates a database outage: every call rejects with `FillerStoreUnavailableError` until `setAvailable(true)`. */
  setAvailable(available: boolean): void {
    this.down = !available;
  }

  setOverrides(overrides: RuntimeOverrides): void {
    this.overrides = copy(overrides);
  }

  /** Every journalled entry, in append order. */
  journal(): readonly EvidenceEntry[] {
    return [...this.evidence.values()].map(copy);
  }

  // --- FillerStore ---------------------------------------------------------

  private check(): void {
    if (this.down) throw new FillerStoreUnavailableError('in-memory store is set unavailable');
  }

  async now(): Promise<number> {
    this.check();
    return this.clock.now();
  }

  async withOrder<T>(orderHash: Hex, work: (tx: OrderTransaction) => Promise<T>): Promise<T> {
    this.check();
    const id = orderHash.toLowerCase();
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => held);
    this.locks.set(id, tail);
    await previous;
    try {
      this.check();
      const draft = copy(this.orders.get(id) ?? emptyOrder());
      const staged: EvidenceEntry[] = [];
      let open = true;
      const guard = (): void => {
        if (!open) throw new Error(`OrderTransaction for ${id} used after its withOrder() settled`);
        this.check();
      };
      const tx: OrderTransaction = {
        orderHash: id as Hex,
        getTicket: async (attempt) => (guard(), copy(draft.tickets.get(attempt))),
        listTickets: async () => (guard(), [...draft.tickets.values()].sort((a, b) => a.attempt - b.attempt).map(copy)),
        putTicket: async (record) => void (guard(), draft.tickets.set(record.attempt, copy(record))),
        getFill: async (attempt) => (guard(), copy(draft.fills.get(attempt))),
        putFill: async (record) => void (guard(), draft.fills.set(record.attempt, copy(record))),
        getAttestations: async (attempt) => (guard(), copy(draft.attestations.get(attempt))),
        putAttestations: async (record) => void (guard(), draft.attestations.set(record.attempt, copy(record))),
        getSettlement: async () => (guard(), copy(draft.settlement)),
        putSettlement: async (record) => void (guard(), (draft.settlement = copy(record))),
        appendEvidence: async (entry) => {
          guard();
          const entryId = entry.id.toLowerCase();
          if (this.evidence.has(entryId) || staged.some((e) => e.id.toLowerCase() === entryId)) return false;
          staged.push(copy(entry));
          return true;
        },
      };
      try {
        const result = await work(tx);
        this.check();
        this.orders.set(id, draft);
        for (const entry of staged) this.evidence.set(entry.id.toLowerCase(), entry);
        return result;
      } finally {
        open = false;
      }
    } finally {
      release();
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }

  async listOpenOrders(): Promise<readonly Hex[]> {
    this.check();
    const open: Hex[] = [];
    for (const [id, order] of this.orders) {
      const liveTicket = [...order.tickets.values()].some(
        (t) => (!TERMINAL_TICKET_STATES.has(t.state) && t.state !== 'filled') || (t.state === 'declined' && t.sentAtMs === undefined),
      );
      const unsettledFill = order.fills.size > 0 && order.settlement?.state !== 'settled';
      if (liveTicket || unsettledFill) open.push(id as Hex);
    }
    return open.sort();
  }

  async appendEvidence(entry: EvidenceEntry): Promise<boolean> {
    this.check();
    const id = entry.id.toLowerCase();
    if (this.evidence.has(id)) return false;
    this.evidence.set(id, copy(entry));
    return true;
  }

  async getOverrides(): Promise<RuntimeOverrides> {
    this.check();
    return copy(this.overrides);
  }

  readonly quotes: QuoteLedger = {
    nextNonce: async (requestId: string, signer: Hex) => {
      this.check();
      const k = `${signer.toLowerCase()}|${requestId}`;
      const next = (this.quoteNonces.get(k) ?? 0n) + 1n;
      this.quoteNonces.set(k, next);
      return next;
    },
    recordQuote: async (quote: StoredQuote) => {
      this.check();
      const k = quote.quoteHash.toLowerCase();
      if (this.quoteRecords.has(k)) return false;
      this.quoteRecords.set(k, copy(quote));
      return true;
    },
    recordAck: async (ack: QuoteAck) => {
      this.check();
      const stored = this.quoteRecords.get(ack.quoteHash.toLowerCase());
      if (!stored || stored.ack) return false;
      stored.ack = copy(ack);
      return true;
    },
    listQuotes: async (requestId: string) => {
      this.check();
      return [...this.quoteRecords.values()].filter((q) => q.requestId === requestId).map(copy);
    },
  };

  readonly nonces: NonceLeases = {
    allocate: async (request: NonceAllocation) => {
      this.check();
      const k = key(request.chain, request.address);
      const floor = this.nextNonces.get(k) ?? 0n;
      const nonce = request.chainNonce > floor ? request.chainNonce : floor;
      this.nextNonces.set(k, nonce + 1n);
      const record: NonceRecord = {
        chain: request.chain,
        address: request.address.toLowerCase() as Hex,
        nonce,
        owner: request.owner,
        expiresAtMs: this.clock.now() + request.ttlMs,
        transactions: [],
        state: 'open',
      };
      this.nonceRecords.set(k, [...(this.nonceRecords.get(k) ?? []), record]);
      return leaseOf(record);
    },
    renew: async (lease: NonceLease, ttlMs: number) => {
      this.check();
      const record = this.held(lease);
      if (!record) return null;
      record.expiresAtMs = this.clock.now() + ttlMs;
      return leaseOf(record);
    },
    recordTransaction: async (lease: NonceLease, tx: InFlightTransaction) => {
      this.check();
      const record = this.held(lease);
      if (!record) return false;
      record.transactions = [...record.transactions, copy(tx)];
      return true;
    },
    complete: async (lease: NonceLease, minedHash: Hex) => {
      this.check();
      const record = this.held(lease);
      if (!record) return false;
      record.state = 'mined';
      record.minedHash = minedHash;
      return true;
    },
    claimExpired: async (request) => {
      this.check();
      const now = this.clock.now();
      const claimed: NonceRecord[] = [];
      for (const record of this.nonceRecords.get(key(request.chain, request.address)) ?? []) {
        if (record.state !== 'open' || record.expiresAtMs > now) continue;
        record.owner = request.owner;
        record.expiresAtMs = now + request.ttlMs;
        claimed.push(copy(record));
      }
      return claimed;
    },
    listOpen: async (chain: EvmChainId, address: Hex) => {
      this.check();
      return (this.nonceRecords.get(key(chain, address)) ?? [])
        .filter((r) => r.state === 'open')
        .sort((a, b) => (a.nonce < b.nonce ? -1 : 1))
        .map(copy);
    },
  };

  /** The record of `lease` if `lease.owner` still holds it by store time. */
  private held(lease: NonceLease): NonceRecord | undefined {
    const record = (this.nonceRecords.get(key(lease.chain, lease.address)) ?? []).find((r) => r.nonce === lease.nonce);
    if (!record || record.state !== 'open' || record.owner !== lease.owner || record.expiresAtMs <= this.clock.now()) return undefined;
    return record;
  }
}

const leaseOf = (record: NonceRecord): NonceLease => ({
  chain: record.chain,
  address: record.address,
  nonce: record.nonce,
  owner: record.owner,
  expiresAtMs: record.expiresAtMs,
});
