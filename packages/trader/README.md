# @cancore/trader

Programmatic trading on Cancore. Today it has one entry, **`@cancore/trader/filler`**: filler protocol v1
for a filler node — login to `filler-gateway`, quotes, tickets, fills, attestations and `settle`.

> **Status: skeleton (`0.1.0-rc.1`).** The configuration, the injected interfaces, the hooks and the method
> signatures are final for v1; the protocol behind the methods lands task by task (each unimplemented method
> throws `NotImplementedError` naming its task). Do not run it against a live `filler-gateway` yet.

```bash
npm install @cancore/trader @cancore/contracts
```

ESM only, Node ≥ 20. Runtime dependencies: `@cancore/contracts`, `@noble/curves`, `@noble/hashes`.

## Design in one paragraph

The package holds **no keys and no state**. Everything external is injected: signers (built by the node from
keys in its `.env`, one key per purpose), EVM RPC endpoints, the Canton ledger, a `FillerStore` for all state,
a clock, a logger, an event sink, a WebSocket factory and HTTP. Protocol frame shapes and EIP-712 types and
domains come from `@cancore/contracts` and are never re-typed here. Several replicas of one filler node run on
one shared store under one `fillerId`; every handler is idempotent, every state transition of an order runs
under that order's lock in the store, and EVM nonces are leased from the store.

## Quick start

```ts
import { createFiller } from '@cancore/trader/filler';
import { FILLER_GATEWAYS } from '@cancore/contracts';

const filler = createFiller({
  gatewayUrl: 'wss://<filler-gateway host>/v1',
  fillerId: 'acme-1',
  gatewaySigner: FILLER_GATEWAYS.testnet.gateway,
  ticketSigners: FILLER_GATEWAYS.testnet.ticketSigners,
  quoteSigner,                                   // TypedDataSigner over the quote key
  fillSigners: { 'eip155:1': fill1, 'eip155:56': fill56 },  // FillSigner per EVM chain
  rpc: { 'eip155:1': [alchemy1, infura1], 'eip155:56': [bsc1] },
  store,                                         // FillerStore — the filler node passes its Postgres store
  webSocket,                                     // WebSocketFactory (Node 20 has no global WebSocket)
  logger,
  events,
});

filler.onQuoteRequest(async (req) => price(req));          // → { amountOut, validUntil } | null to skip
filler.onReconfirm(async (r) => inventory.has(r));         // → boolean
filler.onTicketOffer(async (o) => (risk.allows(o) ? 'accept' : 'decline'));
await filler.start();
```

`createFiller` validates everything it is given and throws `FillerConfigError` (with the offending `field`)
for anything missing or malformed — never a `ReferenceError` later. It opens no connection until `start()`.

## The filler

| Member | Returns | Does | Task |
|---|---|---|---|
| `onQuoteRequest(hook)` | `void` | price for a `quote.request`: `{ amountOut, validUntil }` or `null` | CAN-1852 |
| `onReconfirm(hook)` | `void` | stand behind the quote for an opened order: `boolean` | CAN-1852 |
| `onTicketOffer(hook)` | `void` | take the ticket: `'accept'` or `'decline'` | CAN-1861 |
| `start()` | `Promise<void>` | login by challenge, heartbeat, reconnect, REST fallback; reconcile from the store; then quote, take tickets, fill, settle. Needs all three hooks | CAN-1847 |
| `stop()` | `Promise<void>` | closes the session; in-flight work stays in the store for any replica | CAN-1847 |
| `selfSettle(orderHash)` | `{ txHash }` | settle one order now from its verified attestation set | CAN-1856 |
| `verifyDraw(orderHash)` | `{ winner, recomputedWinner, match, drandRound }` | V2 only: recompute the draw | CAN-1848 |
| `verifyEscrow(ticket)` | `{ ok, reason? }` | own RPC / participant check; also runs before every receipt | CAN-1854 |
| `bindStake(stakingSigner, { chain })` | `StakeBindingRequest` | sign a `StakeBinding` with the staking key | CAN-1857 |
| `stats()` | `{ won, delivered, noShow, reliability, capacityUsd, inFlightUsd }` | filler statistics | CAN-1940 |

## Injected interfaces

### Signers — `TypedDataSigner`, `FillSigner`, `QuoteSigner`, `StakingSigner`

```ts
interface TypedDataSigner {
  readonly address: Hex;
  signTypedData(input: TypedDataInput): Promise<Hex>;   // TypedDataInput from @cancore/contracts
}
interface TransactionSigner {
  readonly address: Hex;
  signTransaction(tx: EvmTransactionRequest): Promise<Hex>;  // raw signed EIP-1559 tx; the SDK broadcasts it
}
interface FillSigner extends TypedDataSigner, TransactionSigner {}
```

Keys are separate by purpose: the **quote** key signs `FillerAuth` and `FillerQuote` only; the **fill** key of
each EVM chain signs `TicketIntent` / `TicketReceipt` and the `fill` / `settle` transactions; the **staking**
key signs one `StakeBinding` and is passed to `bindStake` only. `createFiller` refuses a fill key equal to the
quote key.

**Signature contract** (protocol §3.1): 65 bytes `r ‖ s ‖ v`, `s ≤ n/2` (low-s), `v ∈ {27, 28}`. The SDK
obtains every signature through `signTypedDataChecked`, which also recovers the signer and compares it with
`address`; a violation throws `SignatureContractError` with `violation` = `length` | `high-s` | `v` |
`zero-r-or-s` | `r-out-of-range` | `not-hex` | `signer-mismatch`, and the signature is not used. The helpers
are exported:

```ts
import { assertSignature, recoverTypedDataSigner, signTypedDataChecked } from '@cancore/trader/filler';
```

A transaction signer never picks a nonce and never broadcasts: the SDK leases the nonce from the store and
sends the raw transaction through `EvmRpc`.

### `EvmRpc` — several endpoints per chain

```ts
interface EvmRpc {
  readonly label: string;                                  // for logs; never the URL (it carries API keys)
  request<T>(req: { method: string; params?: readonly unknown[] }): Promise<T>;   // EIP-1193
}
type EvmRpcMap = { readonly [chain: `eip155:${string}`]: readonly EvmRpc[] };
```

Every chain in `fillSigners` needs at least one endpoint. How several are used (quorum, failover,
confirmation depth) is the SDK's business.

### `CantonLedger` — provisional

`party`, `activeContracts({ templateId })`, `exercise({ templateId, contractId, choice, argument })`. Needed
only for Canton routes; the Canton tasks may widen it.

### `FillerStore` — all state, shared by replicas

The filler node implements it on Postgres; one database serves every replica. The contract:

- **Async** everywhere.
- **`withOrder(orderHash, work)`** runs `work` in one transaction holding an exclusive lock on that
  `orderHash` (`SELECT … FOR UPDATE` or `pg_advisory_xact_lock`). Everything `work` writes through the
  `OrderTransaction` — ticket state per attempt, fills, the attestation set, the settlement, evidence — commits
  together, or rolls back when `work` throws. Different orders run concurrently.
- **Idempotent writes.** The evidence journal is keyed by message identity (keccak256 of the verbatim frame
  bytes) and the quote ledger by `quoteHash`; a repeated write returns `false` and changes nothing.
- **Nonce leases** (`store.nonces`): `allocate` returns `max(chain nonce, last allocated + 1)` leased to this
  replica (`instanceId`), with expiry by **store** time (`store.now()`); only the holder may `recordTransaction`
  / `complete`; `claimExpired` hands an expired lease to another replica.
- **Quote nonces** (`store.quotes.nextNonce`) strictly increase per `(quote key, requestId)` across replicas.
- `listOpenOrders()` for reconciliation after a restart; `getOverrides()` for the `paused` kill-switch.
- An outage is reported by throwing `FillerStoreUnavailableError`; the SDK then takes no work.

Records store the wire messages of `@cancore/contracts` as received (`TicketOffer`, `TicketIssued`,
`QuoteAck`, `OrderSettled`, …); frames the journal keeps are verbatim bytes.

### `WebSocketFactory`

```ts
type WebSocketFactory = (url: string, handlers: {
  onOpen(): void; onMessage(text: string): void; onClose(code: number, reason: string): void; onError(e: unknown): void;
}) => { send(text: string): void; close(code?: number, reason?: string): void };
```

With the `ws` package:

```ts
import WebSocket from 'ws';
const webSocket: WebSocketFactory = (url, h) => {
  const ws = new WebSocket(url);
  ws.on('open', h.onOpen);
  ws.on('message', (data, isBinary) => { if (!isBinary) h.onMessage(data.toString('utf8')); });
  ws.on('close', (code, reason) => h.onClose(code, reason.toString('utf8')));
  ws.on('error', h.onError);
  return { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) };
};
```

### `Clock`, `Logger`, `EventSink`, `HttpFetch`

- `Clock` — `now()` (unix ms) and `schedule(delayMs, callback) → cancel`. Defaults to the system clock.
- `Logger` — `debug/info/warn/error(message, fields?)`. The SDK never logs signatures, signed payloads,
  prepared transactions or keys. Defaults to silent.
- `EventSink` — `emit(event)`. Public events: `filled`, `attested`, `settled`, `penalty`, `declined`; plus
  `stage` events (`quote.sent`, `ticket.receipted`, `settle.sent`, …) for analytics. A throwing sink never
  stops the protocol. Defaults to a no-op.
- `HttpFetch` — the slice of `fetch` used for the REST fallback and drand relays. Defaults to the global
  `fetch`.

## Testing — `@cancore/trader/filler/testing`

Fixtures for this package's tests and for filler nodes built on it. Not for production.

```ts
import {
  InMemoryFillerStore,
  FakeClock,
  FakeEvmRpc,
  createFakeWebSocketFactory,
  createTestTypedDataSigner,
  createRecordingEventSink,
  createRecordingLogger,
} from '@cancore/trader/filler/testing';
```

- `InMemoryFillerStore(clock?)` keeps the store contract (serialised per-order transactions with rollback,
  idempotent writes, leases by store time); two fillers on one instance model two replicas on one database.
  `setAvailable(false)` simulates an outage; `journal()` lists the evidence.
- `FakeClock` moves only on `advance(ms)`. `FakeEvmRpc` answers scripted methods and records calls.
- `createFakeWebSocketFactory()` hands out `FakeSocket`s: the test plays `filler-gateway` and feeds crafted
  frames with `receive(frame)`.
- `createTestTypedDataSigner(privateKey)` — the reference behaviour of the signer contract, for test keys.

## License

Apache-2.0
