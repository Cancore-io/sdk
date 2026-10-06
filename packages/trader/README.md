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
  rpc: { 'eip155:1': [alchemy1, infura1], 'eip155:56': [bsc1] },  // in order of preference
  chains: {                                      // pinned routers and read policy, from the node's own config
    'eip155:1': { router: ETH_ROUTER, openConfirmations: 12, maxHeadLagBlocks: 5,
                  minTicketTtlSec: 120, requiredProofWindowSec: 2_700, sendGuardSec: 60, minGasWei: 5n * 10n ** 16n },
    'eip155:56': { router: BSC_ROUTER, openConfirmations: 15, maxHeadLagBlocks: 5,
                   minTicketTtlSec: 60, requiredProofWindowSec: 1_800, sendGuardSec: 30, minGasWei: 10n ** 17n },
  },
  tickets: { deltaIssueMs: 3_000 },             // δ_issue (protocol S-2)
  store,                                         // FillerStore — the filler node passes its Postgres store
  webSocket,                                     // WebSocketFactory (Node 20 has no global WebSocket)
  logger,
  events,
});

filler.onQuoteRequest(async (req) => price(req));          // → { amountOut, validUntil } | null to skip
filler.onReconfirm(async (r) => inventory.has(r));         // → boolean
filler.onTicketOffer(async (o) => (risk.allows(o) ? 'accept' : { decline: 'RISK_LIMIT' }));
await filler.start();
```

`createFiller` validates everything it is given and throws `FillerConfigError` (with the offending `field`)
for anything missing or malformed — never a `ReferenceError` later. It opens no connection until `start()`.

## The filler

| Member | Returns | Does | Task |
|---|---|---|---|
| `onQuoteRequest(hook)` | `void` | price for a `quote.request` (with `payout` and `fee` added): `{ amountOut, validUntil }` or `null` | CAN-1852 |
| `onReconfirm(hook)` | `void` | stand behind `order.minReceived` for an opened order (with `payout` and `fee` added): `boolean` | CAN-1852 |
| `onTicketOffer(hook)` | `void` | take the ticket: `'accept'`, `'decline'` (`OTHER`) or `{ decline: reason, detail? }` | CAN-1861 |
| `start()` | `Promise<void>` | login by challenge, heartbeat, reconnect, REST fallback; reconcile from the store; then quote, take tickets, fill, settle. Needs all three hooks. Resolves at the first `auth.ok` | CAN-1847 |
| `stop()` | `Promise<void>` | closes the session; in-flight work stays in the store for any replica | CAN-1847 |
| `selfSettle(orderHash)` | `{ txHash }` | settle one order now from its verified attestation set | CAN-1856 |
| `verifyDraw(orderHash)` | `{ winner, recomputedWinner, match, drandRound }` | V2 only: recompute the draw | CAN-1848 |
| `verifyEscrow(ticket)` | `{ ok, reason?, detail?, checks }` | the checks before a receipt for an issued ticket whose offer is stored; also runs before every receipt | CAN-1854 |
| `bindStake(stakingSigner, { chain })` | `StakeBindingRequest` | sign a `StakeBinding` with the staking key | CAN-1857 |
| `stats()` | `{ won, delivered, noShow, reliability, capacityUsd, inFlightUsd }` | filler statistics | CAN-1940 |

## The connection to filler-gateway

`start()` opens one WebSocket session per replica to `gatewayUrl` (`/v1`, protocol §3.1) and keeps it up.

- **Login.** On `auth.challenge` the quote key signs `FillerAuth{fillerId, nonce, expiresAt}` and the SDK
  sends `auth.response` with `protocolVersion: "1"`. Until `auth.ok` it sends nothing else.
- **Every filler message is signed.** Each frame and REST body the SDK sends — `auth.response`, `quote`,
  `quote.reconfirm.reply` (a decline too), `ping`, `pong` and the ticket actions — carries `fillerId`, `sentAt`
  and `msgSig`: the quote key's signature over `FillerMessage{keccak256(JCS(message without msgSig))}`
  (protocol §3.4). The quote key is the filler's message key until the signer interface is reworked (CAN-2151). `start()`
  resolves at the first `auth.ok`, rejects with `UnsupportedVersionError` when filler-gateway does not serve
  v1 (not retried), and with `FillerStoppedError` when `stop()` comes first. Any other refusal is retried.
- **Every filler-gateway frame is verified** before anything reads it: `sig` must recover, over
  `GatewayMessage{keccak256(JCS(frame without sig))}`, to `gatewaySigner` from the config (never to an
  address a frame names), and `fillerId` must be this filler's (absent only on `auth.challenge` and a
  pre-login `error`). A frame that fails is dropped and logged (`filler-gateway: frame dropped`, with the
  reason). The same holds for every filler-gateway message in a REST response.
- **Heartbeat.** filler-gateway pings; the SDK answers `pong` and pings every `heartbeatIntervalMs` of
  `auth.ok`. With no frame for `transport.heartbeatMisses` (default 3) intervals the SDK closes and reconnects.
- **Reconnect.** Exponential backoff with equal jitter: `min(maxDelayMs, initialDelayMs × 2ⁿ)` scaled into
  `[0.5, 1)`, defaults 500 ms → 30 s, reset after a login. No `auth.ok` within `transport.loginTimeoutMs`
  (15 s) counts as a failed connection.
- **REST fallback** (§3.6) on the same host (`wss` → `https`). The SDK logs in by
  `GET /v1/filler/auth/challenge` + `POST /v1/filler/auth` (the `auth.response` names the challenge in its
  optional `nonce`) and keeps the bearer token until shortly before
  it expires (renewed once on a 401). While the session is down it polls `GET /v1/filler/tickets` every
  `transport.restPollIntervalMs` (2 s), and sends ticket intents, receipts and declines as
  `POST /v1/filler/tickets/{orderHash}/{attempt}/{intent|receipt|decline}`. After every login it pulls once
  more. Frames with no REST route (`quote`, `quote.reconfirm.reply`, `fill.reported`) are not sent while down.
- **Evidence.** Every verified frame is written to the store's evidence journal as the exact bytes received
  (id = keccak256 of the bytes), under the order lock when it names an order. `quote.ack` is attached to its
  quote, `ticket.intent.ack` to its ticket attempt.
- **Several replicas, one `fillerId`** (T-10). Any frame may arrive on any replica's session, twice, or over
  both WebSocket and REST; frame handling is idempotent against the store. Frame ids are
  `<instanceId>:<start time>:<sequence>`, unique across replicas and restarts.
- **Errors.** An `error` frame or REST error body becomes a `GatewayError` (`code`, `known`, `re`,
  `httpStatus`). A code this SDK does not know keeps `known: false` and is handled as generic (V-2). Unknown
  frame types and unknown fields are ignored.

## Reading the chains

The SDK reads the routers itself, with the node's own RPC (INV-10): a ticket is Cancore's word, the chain is
the fact. Router addresses come only from `chains.<caip2>.router` in the config, never from a filler-gateway
message.

- **Endpoints.** `rpc.<caip2>` is used in order. Before its first use every endpoint answers `eth_chainId`;
  one that names another chain is never used again, and when none serves the configured chain the read fails
  with `ChainReadError` reason `wrong-chain` (filler-node C-1). A transport or node error moves the request
  to the next endpoint; a revert is the chain's answer and is not retried elsewhere. Reads at a depth start
  from the head of every endpoint, and one whose head trails the best by more than `maxHeadLagBlocks` is
  passed over while a fresher one answers. All endpoints failing is `unavailable`.
- **Depth, one block.** A read names its block: `'latest'`, `'safe'`, `'finalized'`, `{ confirmations: n }`
  (head − n; escrow checks read at `openConfirmations`), `{ blockNumber }` or `{ blockHash }`. The tag is
  resolved to one block header, and calls carry its hash (EIP-1898 `{ blockHash, requireCanonical: true }`):
  an endpoint on another fork fails the call rather than answering from its own block at that height, and
  `pin(at)` hands the same hash to every call of one check. The endpoints must support EIP-1898 for
  `eth_call` and `eth_getBalance` (geth, erigon, reth, anvil and the large providers do).
- **`RouterReader`** — `intents`, `filled`, `ticketSigners`, `proofWindow`, `attestationSetFor`,
  `getAttestorSet`, `revokedAttestors`, `currentSetId`, `isMember`, `sourceOrderHash`, `hashOrder`,
  `hashTicket`, `hashFillProof`, `minInput`. Calls and results are encoded from `CANCORE_ROUTER_ABI` of
  `@cancore/contracts` by the package's own small ABI codec (no ABI library dependency); an answer that does
  not decode — empty data from an address without code included — is `malformed`, never a value. The router
  has no filler registry, so nothing about a filler is read.
- **Local digests** — `hashOrder(order, { chainId, router })`, `hashTicket(ticket)`,
  `hashFillProof(proof, { chainId, router })`: `hashTypedData` of `@cancore/contracts` in the router's
  domains, equal to the router's views and to the golden vectors.
- **Events** — `RouterEventWatcher` polls `eth_getLogs` for `IntentOpened`, `Filled`, `Settled`, `Refunded`
  and reports a log only once it is `confirmations` deep. A deeper reorg is found by re-reading block hashes:
  the replaced log is reported `removed`, the scan rewinds, and what the new chain holds is reported `added`.
  An event's identity is `(name, orderHash)`; between two `added` of one identity there is always a
  `removed`. The cursor is in memory: persist `cursor` to resume after a restart.

`FakeChain` in `./filler/testing` is an in-memory chain behind `EvmRpc` — routers with scripted state, ERC-20
balances, blocks, logs and `reorg(fromBlock)`; `endpoint({ headLag, chainId })` adds endpoints over the same
chain for failover tests.

## Tickets

Per attempt `(orderHash, attempt)` the SDK keeps a state in the store and moves it only under the order's lock,
from the state it decided in — two replicas never send two answers for one attempt:

```
offered ──► intent-sent ──► intent-acked ──► checking ──► receipted ──► filled
   │             │               │               └──────► declined
   └─────────────┴───────────────┴──► declined          (any) ──► expired
```

- **Offer.** `ticket.offer` → `onTicketOffer(offer)`. `'accept'` signs `TicketIntent` with the offer's values,
  the `fillerId`, the `deliveryKey` (the fill key of the EVM destination; the zero address for a Canton
  destination) and the `repayTo` (the fill key's address on an EVM source, padded — the source chain's key, else
  the destination's; the hash of `ledger.party` on a Canton source), with the message key, and sends
  `ticket.intent`; `{ decline: reason }` sends `ticket.decline`
  with `NO_INVENTORY`, `RISK_LIMIT`, `PRICE_MOVED`, `PAUSED` or `OTHER` (plain `'decline'` is `OTHER`). A hook
  that throws, or is still silent `tickets.offerReplyMarginMs` (250 ms) before `acceptBy`, declines `OTHER`
  (T-21: silence costs more than a decline). The kill-switch declines `PAUSED` without asking. Nothing is sent
  after `acceptBy`. `ticket.intent.ack` is kept on the attempt.
- **Issued.** `ticket.issued` → the checks below → `ticket.receipt` (`TicketReceipt{hashTicket(ticket),
  keccak256(ticketSig)}`) or `ticket.decline` with the failed check's code (T-22, T-23). An issued ticket with no
  consent behind it, or a Canton-form one, is declined. Nothing is sent after `validUntil`.
- **Write ahead, sign once.** Every move is written before its message goes out; `sentAtMs` marks that it went.
  After a restart (every login) open attempts resume from the store: an unanswered offer is decided, a stored
  message that never went out is sent again — the same bytes, never re-signed — while its deadline lasts, an
  interrupted check runs again. Redelivered frames change nothing.
- **Fill only after the receipt.** The delivery asks for a receipted attempt whose receipt went out; in every
  other state there is nothing to fill.
- **Outcome.** `ticket.expired` is stored on the attempt and reported as stage `ticket.expired` with its result
  (an unknown result as `OTHER`); `penalty.applied` and `order.settled` become the `penalty` and `settled`
  events; every decline the `declined` event.

## Checks before the receipt

Before the SDK signs a `ticket.receipt` — and when the node calls `verifyEscrow(ticket)` — it runs the checks
of fillers.md §4.5 for an EVM source and an EVM-form ticket, with its own RPC and the pinned routers (INV-10).
They stop at the first failure, and the failure is the `ticket.decline` reason:

| Check | What | Decline |
|---|---|---|
| V-T4 | `ticket.issued` arrived by `acceptBy + tickets.deltaIssueMs` | `TICKET_ISSUED_LATE` |
| V-T2 | the ticket repeats the offer (`orderHash`, `attempt`, `validFrom`, `validUntil`), names this filler's `fillerId`, and carries the `deliveryKey` and `repayTo` of its signed `ticket.intent` (T-15) | `TICKET_MISMATCH` |
| V-T3 | `validUntil < fillDeadline`; `validUntil − validFrom ≥ minTicketTtlSec`; at least `sendGuardSec` left | `TICKET_BEYOND_DEADLINE`, `TICKET_TTL_TOO_SHORT` |
| V-E1 | `orderHash` is the order's digest in the source router's domain | `ESCROW_MISMATCH` |
| V-E2 | `intents(orderHash).status == Opened`, read `openConfirmations` deep on the source | `ESCROW_NOT_OPEN` |
| V-E3 | `refundAfter − fillDeadline ≥ requiredProofWindowSec` of the destination | `PROOF_WINDOW_TOO_SHORT` |
| V-T1 | the ticket signer is in `ticketSigners` of the config and `ticketSigners(signer)` on the destination router | `TICKET_SIGNER_UNKNOWN` |
| V-E4 | `repayTo` will be paid: the input token's blocklist view on the source is false for it | not read yet (CAN-2151): reported `skipped`; that `repayTo` is the node's own is held by V-T2 |
| V-E5 | not `filled` on the destination; balance and allowance ≥ `amountOut`, gas ≥ `minGasWei` | `OTHER` (`already-filled`), `NO_INVENTORY` |

A fact that cannot be read declines with the code of the check that needed it (`unverifiable: …` in the
detail): an unverifiable ticket is never receipted. No setting turns a check off. Each check's result —
`passed`, `failed` or `skipped` (V-E4 for now) — is emitted as stage `ticket.checked`. V-T4 compares the
time `ticket.issued` arrived, which the protocol client writes on the attempt when the frame is received; a
ticket whose arrival is not recorded is refused as unverifiable. A Canton source and a Canton-form ticket are declined `OTHER` until their
checks land; V1 does not check the draw.

## Quotes

`quote.request` → `onQuoteRequest(request)` → a `FillerQuote` signed by the quote key (protocol §3.5 «Quotes»).

- **Payout.** `request.payout` is what the source pays for `inputAmount` (the total `T`), fee taken;
  `request.fee = T − payout` (§3.11). EVM source: `⌊T × 10 000 / (10 000 + feeBps)⌋` (`T = 105`,
  `feeBps = 500` → 100), exported as `evmFillerPayout`. Canton source (T-12): the ledger formula,
  `roundHalfEven(T × 10 000 / (10 000 + feeBps))` in 10⁻¹⁰ units (`1000.0` at `feeRate 0.003` →
  `997.0089730808`, one unit above the EVM formula), exported as `cantonFillerPayout`. `quote.reconfirm`
  uses the same split by the order's origin.
- **Filler id.** `FillerQuote` names the filler's `fillerId` (protocol §3.3); it carries no address. A request is
  quoted only when the filler has a fill key on the destination chain (for a Canton destination, on the source).
- **Not sent** (stage event `quote.skipped` with the reason): at or after `windowCloseAt` — checked before
  the hook, after it and after signing; `validUntil × 1000 < windowCloseAt + quoteTtlMs` (equality is fine);
  `inputAmount` below the source router's `minInput` (T-16, read off the pinned source router; when it cannot
  be read, `chain-unavailable`); the hook returned
  `null`, threw, or returned a zero or out-of-range amount; the kill-switch is on; the session is down (a quote
  has no REST route); a byte-identical redelivery of a request already handled.
- **Nonce.** `store.quotes.nextNonce(requestId, quoteKey)`: strictly increasing per request across replicas
  and restarts, so a later quote in the window replaces the earlier one.
- **Firm price.** Each sent quote is stored before it goes out and stays there as the firm price until its
  `validUntil` (T-4); its `quote.ack` is attached when it arrives.
- **Reconfirm.** `quote.reconfirm` is accepted only at `order.minReceived` — a frame whose `amountOut`
  differs is declined without asking the hook (T-20) — and only before `replyBy`. An accepted reply signs
  `FillerQuote{requestId, filler, minReceived, validUntil, nonce}` with a fresh nonce and
  `validUntil = ⌈replyBy / 1000⌉ + ticketTtl + 30 s`. Declines carry no signature.
- **Reconciliation.** After every login the SDK reads `GET /v1/filler/quotes?since=` (last 15 minutes),
  attaches every verified ack the store missed and logs quotes filler-gateway holds that the store does not.

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

Keys are separate by purpose: the **quote** key is the message key — it signs `FillerAuth`, `FillerQuote`,
`TicketIntent`, `TicketReceipt` and the envelope `msgSig` of every message; the **fill** key of each EVM chain
sends the `fill` / `settle` transactions and is the `deliveryKey` of its tickets; the **staking**
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
  createFakeFetch,
  createFakeWebSocketFactory,
  createTestGatewaySigner,
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
- `createTestGatewaySigner(privateKey, clock?)` signs crafted filler-gateway frames the way filler-gateway
  does (`frame(body)` adds `sentAt` and `sig`); pin its `address` as `gatewaySigner`.
- `createFakeFetch(routes)` is an `HttpFetch` answering `"METHOD /path"` routes and recording requests — the
  REST side of filler-gateway in a test.
- `createTestTypedDataSigner(privateKey)` — the reference behaviour of the signer contract, for test keys.

## License

Apache-2.0
