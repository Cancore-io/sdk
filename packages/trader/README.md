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
| `onQuoteRequest(hook)` | `void` | price for a `quote.request` (with `payout`, `fee` and `shownToUser: true` added — the user sees the quote with this filler's profile and picks the filler): `{ amountOut, validUntil }` or `null` | CAN-1852, CAN-2482 |
| `onReconfirm(hook)` | `void` | stand behind `order.minReceived` for an opened order this filler was picked for (with `payout` and `fee` added): `boolean`. A no or silence is a `RECONFIRM_DECLINE` (statistics only); a signed `ticket.decline` of the offer that follows is a `PICKED_DECLINE`, which counts towards a ban | CAN-1852, CAN-2482 |
| `onTicketOffer(hook)` | `void` | take the ticket: `'accept'`, `'decline'` (`OTHER`) or `{ decline: reason, detail? }` | CAN-1861 |
| `start()` | `Promise<void>` | login over REST, then the WebSocket with the token; heartbeat, reconnect, REST fallback; reconcile from the store; then quote, take tickets, fill, settle. Needs all three hooks. Resolves at the first `auth.ok` | CAN-1847 |
| `stop()` | `Promise<void>` | closes the session; in-flight work stays in the store for any replica | CAN-1847 |
| `selfSettle(orderHash)` | `{ txHash }` | settle one order now from its verified attestation set (pulled when none is held); `SettleError` with its `reason` when nothing was sent | CAN-1856 |
| `verifyDraw(orderHash)` | `{ winner, recomputedWinner, match, drandRound }` | V2 only: recompute the draw | CAN-1848 |
| `verifyEscrow(ticket)` | `{ ok, reason?, detail?, checks }` | the checks before a receipt for an issued ticket whose offer is stored; also runs before every receipt | CAN-1854 |
| `bindStake(stakingSigner, { chain })` | `StakeBindingRequest` | sign a `StakeBinding` with the staking key | CAN-1857 |
| `stats()` | `{ won, delivered, noShow, reliability, capacityUsd, inFlightUsd }` | filler statistics | CAN-1940 |

## The connection to filler-gateway

`start()` opens one WebSocket session per replica to `gatewayUrl` (`/v1`, protocol §3.1) and keeps it up.
It connects only after logging in.

- **Login (REST).** `GET /v1/filler/auth/challenge?fillerId=<fillerId>` returns a challenge signed by
  filler-gateway; the SDK checks the signature against `gatewaySigner` and that the challenge is addressed to
  its own `fillerId` (anything else is refused), the quote key signs `FillerAuth{fillerId, nonce, expiresAt}`,
  and `POST /v1/filler/auth` with `auth.response` (`protocolVersion: "1"`, the challenge's `nonce`) returns
  `{token, expiresAt}`. One token serves REST and the WebSocket; one login runs at a time for both, and the
  token is renewed 30 s before `expiresAt`, so a reconnect never offers an expired one. A failed login is
  retried with the reconnect backoff, always from a fresh challenge (a 401 of `POST /v1/filler/auth` means
  the challenge is gone). The login routes refuse unsigned until they have checked a signature; such a
  refusal is only a hint for the retry. The token never goes to the logger.
- **Connect.** Every (re)connect takes a valid token first, then calls the `WebSocketFactory` with the
  subprotocols `['cancore-filler.v1', 'bearer.<token>']`. filler-gateway authenticates the upgrade and sends
  `auth.ok` first; until it arrives the SDK sends nothing. A refused upgrade (400/401/403/429/503: an error and
  a close before the open), or any close before `auth.ok`, drops the token: the next attempt logs in again. A
  close `4002` (message key changed) or `4003` (filler suspended) drops it too.
- **Every filler message is signed.** Each frame and REST body the SDK sends — `auth.response`, `quote`,
  `quote.reconfirm.reply` (a decline too), `ping`, `pong` and the ticket actions — carries `fillerId`, `sentAt`
  and `msgSig`: the quote key's signature over `FillerMessage{keccak256(JCS(message without msgSig))}`
  (protocol §3.4). The quote key is the filler's message key until the signer interface is reworked (CAN-2151). `start()`
  resolves at the first `auth.ok`, rejects with `UnsupportedVersionError` when filler-gateway does not serve
  v1 (not retried; on the socket or from `POST /v1/filler/auth`), and with `FillerStoppedError` when `stop()`
  comes first. Any other refusal is retried.
- **Every filler-gateway frame is verified** before anything reads it: `sig` must recover, over
  `GatewayMessage{keccak256(JCS(frame without sig))}`, to `gatewaySigner` from the config (never to an
  address a frame names), and `fillerId` must be this filler's (absent only on an `error` that refuses a
  login). A frame that fails is dropped and logged (`filler-gateway: frame dropped`, with the
  reason). The same holds for every filler-gateway message in a REST response.
- **Heartbeat.** filler-gateway pings; the SDK answers `pong` and pings every `heartbeatIntervalMs` of
  `auth.ok`. With no frame for `transport.heartbeatMisses` (default 3) intervals the SDK closes and reconnects.
- **Reconnect.** Exponential backoff with equal jitter: `min(maxDelayMs, initialDelayMs × 2ⁿ)` scaled into
  `[0.5, 1)`, defaults 500 ms → 30 s, reset after a login. No `auth.ok` within `transport.loginTimeoutMs`
  (15 s from the start of the connect, the REST login included) counts as a failed connection.
  Gateway close `4001` (`SUPERSEDED`) warns that another instance is using this fillerId and waits at
  least 30 s before reconnecting, without jitter shortening that wait, even after a successful login.
  Only one local session per fillerId is active in gateway V1; run one filler node instance per fillerId
  to avoid repeated supersession. SDK-local heartbeat/login-timeout/unsupported-version closes use
  `4500`/`4501`/`4502`, distinct from the gateway's close codes.
- **Rate limits** (per `fillerId`, shared by REST and every session). An `error RATE_LIMITED` with
  `retryAfterMs` — on REST a 429 (unsigned, decided by the status), with `retryAfterMs` in the body or
  `Retry-After` — pauses the rate class
  of the refused message (`quote`, `ticket`, `service`, `read`, `login`): until it ends the SDK sends
  nothing of that class (a quote is not sent, a ticket action and a REST call of the class are refused locally
  with `RATE_LIMITED` and the remaining `retryAfterMs`, and retried after it), so a poll or a retry timer never
  hammers the limit. After a close `4029` (sustained excess, cooldown) the reconnect waits at least the last
  `retryAfterMs` filler-gateway named.
- **REST fallback** (§3.6) on the same host (`wss` → `https`), with the login's bearer token (renewed once on
  a 401). While the session is down it polls `GET /v1/filler/tickets` every
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
  (the deepest block with n confirmations, `head − (n − 1)`: a block counts its own confirmation, as
  Cancore's router indexer and the fill depth count; escrow checks read at `openConfirmations`: n confirmations,
  or the `'safe'` / `'finalized'` block of a chain that has them),
  `{ blockNumber }` or `{ blockHash }`. The tag is
  resolved to one block header, and calls carry its hash (EIP-1898 `{ blockHash, requireCanonical: true }`):
  an endpoint on another fork fails the call rather than answering from its own block at that height, and
  `pin(at)` hands the same hash to every call of one check. The endpoints must support EIP-1898 for
  `eth_call` and `eth_getBalance` (geth, erigon, reth, anvil and the large providers do).
- **Finality tags per network.** A tag in `openConfirmations` means what the chain's own node serves:
  Ethereum `safe` is the justified checkpoint (about one epoch behind the head) and `finalized` the
  finalized one (about two epochs); BNB Chain `finalized` is fast finality (a few blocks); on Arbitrum
  Orbit chains (Arbitrum One, Robinhood Chain) `safe` / `finalized` are the newest blocks whose batch is in
  a `safe` / `finalized` parent-chain block, minutes behind the head. Cancore's mainnet depths per network
  are in the intent-rail spec (meta `docs/intents/evm-finality.md`). `start()` asks every endpoint set for
  each configured tag once and refuses with `FillerConfigError` (`chains.<caip2>.openConfirmations`) when
  the chain's RPC does not serve it. The tag's lag counts against `requiredProofWindowSec` and
  `refundAfter`: a fill waits for it before it is done and before its settle is.
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
  and reports a log only once its block has `confirmations` confirmations (`head − block + 1`). A deeper reorg is found by re-reading block hashes:
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
  keccak256(ticketSig)}`; a Canton-form ticket: `CantonTicketReceipt`, `form: "canton"`) or `ticket.decline` with
  the failed check's code (T-22, T-23). An issued ticket with no consent behind it is declined, and so is a
  Canton-form one without `canton` configured. Nothing is sent after `validUntil`.
- **Write ahead, sign once.** Every move is written before its message goes out; `sentAtMs` marks that it went.
  After a restart (every login) open attempts resume from the store: an unanswered offer is decided, a stored
  message that never went out is sent again — the same bytes, never re-signed — while its deadline lasts, an
  interrupted check runs again. Redelivered frames change nothing.
- **Fill only after the receipt.** The delivery asks for a receipted attempt whose receipt went out; in every
  other state there is nothing to fill.
- **Outcome.** `ticket.expired` is stored on the attempt and reported as stage `ticket.expired` with its result
  (an unknown result as `OTHER`); `penalty.applied` and `order.settled` become the `penalty` and `settled`
  events; every decline the `declined` event.
- **One attempt per order** (filler-selection.md). The user picks the filler; there is no redraw. An offer
  of a later attempt of an order this filler was already offered is stale: declined `OTHER` without the hook.

## Delivery

Once a receipt went out, the SDK delivers the attempt on its EVM destination (fillers.md §4.6):

```
receipted ──► pending ──► sent ──► included ──► confirmed   (ticket → filled, `filled` event)
                 │          │  ▲        │
                 │          │  └─reorg──┘ (resent while the ticket is live)
                 └──────────┴──► failed (reverted; nonce spent elsewhere; cancelled after validUntil)
```

- **What is sent.** `fill(order, amount, ticket, ticketSig)` from the fill key the ticket names as
  `deliveryKey` (T-25), after re-checking that the issued ticket names this filler, its delivery key and its
  `repayTo` (S13). `amount` is the offer's `amountOut`; `delivery.fillAmount` may raise it to over-send a
  fee-on-transfer output — the router measures what the recipient got (T-26), kept as `received`. Below
  `order.minReceived` nothing is sent. `eth_estimateGas` runs first: a revert (`AlreadyFilled`,
  `TicketExpired`, an ERC-20 refusal) is named and nothing is sent.
- **sendGuard.** Nothing goes out with less than `chains.<caip2>.sendGuardSec` left to `validUntil` (T-29).
  A fill still pending after `delivery.replaceAfterMs` (30 s) is replaced on its nonce with both fees raised
  by `delivery.feeBumpPercent` (15 %, at least 10), while `validUntil` has not passed and never above
  `chains.<caip2>.maxFeePerGasWei`. Once the chain's own time is past `validUntil` the fill can never succeed,
  and its nonce is freed by a zero-value transfer to self.
- **Replacement caps** (F-3, R-14). A `fill` or `approve` is never replaced above 3× the first
  `maxFeePerGas` on its nonce (`REPLACEMENT_FEE_CAP_MULTIPLE`); a `cancel` counts from its own first
  cancel, so a fill stuck at its cap can always be cancelled up to `maxFeePerGasWei`. A `settle` has no relative cap — capping it
  would lose the payout when gas spikes — only `chains.<caip2>.maxFeePerGasWei`; within
  `settlement.alertBeforeRefundMs` of `refundAfter` it is replaced at that ceiling at once, so set the ceiling
  on every chain the filler settles on. A capped transaction stays as it is and is resent, same bytes, if a
  node drops it; stage `tx.capped` (`reason`: `relative-cap` or `ceiling`) reports it once.
- **Reorgs.** A fill or settle is done `chains.<caip2>.fillConfirmations` deep (a number; default
  `openConfirmations`, where a `'safe'` / `'finalized'` means done once that tag's block reaches the
  transaction's block). An
  inclusion that disappears is resent — the same bytes on the same nonce — while the ticket is live (T-30);
  the block header and receipt of the last inclusion seen stay on the fill record as evidence (R-3).
- **One writer per nonce** (N-9, N-34). Transactions go out only on nonces leased from the store
  (`delivery.nonceLeaseTtlMs`, default 60 s), recorded before they are broadcast; the lease is re-checked
  at the record and renewed while the nonce is driven. Every lease TTL a replica claims the expired leases of
  dead replicas and drives their nonces from the chain. A held nonce with nothing recorded is reused, so an
  abandoned send never strands the transactions behind it. A new nonce is `max(pending on chain, last
  allocated + 1)`, and the store never lowers its counter; so a `pending` above `latest` + the key's open
  nonces is not believed — that bound is used and stage `nonce.suspect` raised (CAN-2636). A real jump means
  something else sends from the delivery key.
- **Restart** (N-15). The fill record, the nonce journal and `filled(orderHash)` decide: a fill already
  recorded on a nonce is driven, never sent a second time; a receipted attempt with nothing under way is
  delivered.
- **Allowance.** The router is approved for the output asset when the allowance cannot cover a fill — up to
  `delivery.approvals[<caip2>][<token>]`, or exactly the fill without a limit; never unlimited by default. With
  a limit, the allowance is topped up at start when it has fallen below half of it. One approve per token at a
  time; a token that refuses to change a non-zero allowance is approved to zero first.
- **Events.** `filled { orderHash, attempt, txHash, amount }` once confirmed; stages `fill.sent` (nonce,
  gas limit, fees), `fill.replaced`, `fill.included`, `fill.reorged`, `fill.reverted`, `fill.cancelled`,
  `fill.confirmed` (`gasUsed`, `effectiveGasPrice`, `latencyMs`, `replacements`), `fill.refused`,
  `approve.sent`, `approve.confirmed`, `tx.capped`.

## Settlement

The filler settles its own fills; Cancore does not (fillers.md §4.7, T-33, T-34).

- **Signatures only from filler-gateway**, on both channels the SDK owns: `settle.attestations` pushed on the
  session, and `GET /v1/filler/attestations/{orderHash}` pulled for every confirmed fill without a settlement —
  at once after the fill, after every login and every `settlement.pullIntervalMs` (15 s), until `refundAfter`.
  The first set kept per `(orderHash, attempt)` wins; the node never polls attestors.
- **Verified before anything is sent.** The proof must be the filler's own: its fill (`fillRef`,
  `amountDelivered`, `filledAt`, `recipient`, `outputAsset`, `attempt`), its `fillerId`, its ticket's `repayTo`,
  and `setId = attestationSetFor(orderHash)` on the source router — never `currentSetId`. Signatures that do not
  recover to a non-revoked member of that set over that one digest are dropped (one bad extra would revert the
  whole `settle`); the lowest `threshold` signers go, strictly ascending. A proof other than the filler's own is a
  divergence: alert, nothing sent. So is a set that no longer verifies.
- **`eth_call` first**, then `settle(order, proof, sigs)` from the fill key of the source chain, on a leased nonce
  (the same machinery as `fill`); `IntentNotOpen` on an intent someone already settled is a success, a refund that
  won the race (R-5) is an alert.
- **Alerts** (stage `settle.alert`, `detail.kind`): `half-window` — unsettled at half the proof window since the
  fill (R-4); `refund-near` — unsettled `settlement.alertBeforeRefundMs` (1 h) before `refundAfter`; `refunded`,
  `settle-reverted`, `divergent`, `insufficient-signatures`, `set-not-active`, `mismatch`; `escrow-gone` — the source
  router no longer has the escrow of a delivered order (its open reorged out): the filler's advance is at risk. The
  order is read again every sweep and settles as before if a reorg brings the escrow back.
- **Reorgs.** A refund or a settlement read at the head alone leaves the settlement pending; it closes once it
  reads `fillConfirmations` deep on the source chain.
- **Events.** `attested` once a set passes; stages `attestations.received`, `settle.sent`, `settle.confirmed`,
  `settle.reverted`, `settle.refused`; `settled` from `order.settled`.
- **For a relayer**: `verifyAttestations` and `collectAttestations` are pure functions over a proof, its
  signatures and the set read from the router — no session, no store.
- **Canton source** (T-35…T-37, CAN-2321), with `canton` configured: the same two channels and the same
  own-proof check (`sourceChainId` a `canton:` network, `pubKey` signature entries), then `intent.settle` —
  `SwapIntent_SettleWithProof` prepared by Cancore with the signatures filler-gateway holds — checked by
  `checkIntentSettle` against the intent read afresh (it must still build the order delivered for) and the
  party's `ACTIVE` registry entry, signed with the party key, submitted. Only strictly before `refundAfter`
  (`deadline-passed` from then on). The k-of-n check against the `AttestorRegistry` is Daml's. The settlement
  is `confirmed` with the `updateId`; `order.settled` closes it.

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
| V-E2 | `intents(orderHash).status == Opened`, read `openConfirmations` deep on the source (n confirmations, or the `'safe'` / `'finalized'` block) | `ESCROW_NOT_OPEN` |
| V-E3 | `refundAfter − fillDeadline ≥ requiredProofWindowSec` of the destination | `PROOF_WINDOW_TOO_SHORT` |
| V-T1 | the ticket signer is in `ticketSigners` of the config and `ticketSigners(signer)` on the destination router | `TICKET_SIGNER_UNKNOWN` |
| V-E4 | `repayTo` will be paid: the input token's blocklist view on the source (USDC `isBlacklisted`, USDT `isBlackListed`) is false for it; a token without one passes; that `repayTo` is the node's own is held by V-T2 | `OTHER` (`repayTo-blocklisted`) |
| V-E5 | not `filled` on the destination; balance and allowance ≥ `amountOut`, gas ≥ `minGasWei` | `OTHER` (`already-filled`), `NO_INVENTORY` |

A fact that cannot be read declines with the code of the check that needed it (`unverifiable: …` in the
detail): an unverifiable ticket is never receipted. No setting turns a check off. Each check's result —
`passed`, `failed` or `skipped` — is emitted as stage `ticket.checked`. V-T4 compares the
time `ticket.issued` arrived, which the protocol client writes on the attempt when the frame is received; a
ticket whose arrival is not recorded is refused as unverifiable. V1 does not check the draw.

**Canton source** (an EVM-form ticket for an order whose `originChainId` is a `CANTON_ORIGIN_ID`). There is no
escrow on a router: the owner's give is a committed allocation only `SwapIntent_SettleWithProof` — this filler's
submission — pays out, strictly before `refundAfter`. V-C1…V-C6 run in place of V-E1…V-E4 (V-T1 and V-E5 stay,
on the destination), reading through Cancore — `GET /v1/filler/canton/intents/{orderHash}` and
`/party` — with `cantonSource` (a `CantonOperations`); the node has no Ledger API (operator decision T-1).
What can be recomputed is: the order and its hash from the intent's own fields, the legs from its amount and fee
rate. What cannot — that the intent and its allocation are live, `committed`, the executors, `refundAfter`,
`settlementDeadline`, the registry state — is Cancore's read of its participant, held to the protocol's rules:

| Check | What | Decline |
|---|---|---|
| V-C1 | a live `SwapIntent` with `ticket.orderHash` names this filler: its party and `fillerId` | `ESCROW_NOT_OPEN` (none), `ESCROW_MISMATCH` |
| V-C2 | the EVM-form order built from the intent's own terms (protocol §3.7) is `offer.order`, field by field | `ESCROW_MISMATCH` |
| V-C3 | that order's hash in the Canton source domain is `ticket.orderHash` | `ESCROW_MISMATCH` |
| V-C4 | the allocation `allocationCid` is live, a pinned registry template (`CANTON_ALLOCATION_TEMPLATES`), `committed`, the owner's, executors exactly operator and owner, `settlementDeadline == refundAfter`, legs exactly `payout` (`amount` less the fee, Numeric 10 half to even) to this party and `fee` to the operator | `ESCROW_NOT_OPEN` (not live), `ESCROW_MISMATCH` |
| V-C5 | `ticket.repayTo == keccak256(utf8(party))`; the `FillerRegistryEntry` of the party is `ACTIVE`; the instrument's pinned registry pays any party through a receipt-only allocation (`openReceipt`, T-9) | `TICKET_MISMATCH`, `OTHER` (`payout-not-ready`) |
| V-C6 | `refundAfter − fillDeadline ≥ requiredProofWindowSec` of the destination | `PROOF_WINDOW_TOO_SHORT` |

A node without `cantonParty` and `cantonSource` declines a Canton source `OTHER` at `form`.

**Canton destination** (a Canton-form ticket, CAN-1867). The ticket is the `DeliveryOrder` the party observes,
read through filler-gateway: it must be live under `deliveryOrderCid` with this order, attempt, `validUntil` and
the `repayTo` of the node's own `ticket.intent`, the order's `recipient` and `outputAsset` (the encodings of
`@cancore/contracts`) and an amount in `[minReceived, amountOut]`. V-T3 runs on `canton.destination`
(`minTicketTtlSec`, `sendGuardSec`), V-E1…V-E4 on the EVM source as for any EVM source, V-E3 against
`canton.destination.requiredProofWindowSec`, and V-E5 is the party's unlocked holdings of the instrument
(`NO_INVENTORY`). Delivery is `delivery.fill` (`filler.canton.fill`): before the party key signs, the decoded
transaction must be one `DeliveryOrder_Fill` of `cancore-intent` on that order, as the party alone; the order it
discloses must name the party, the node's `fillerId` and `repayTo` (T-48 on the ledger's own data), the
ticket's order, attempt, `validUntil` and the order's `fillDeadline`; under it, exactly the completed
`TransferFactory_Transfer` through a pinned factory of the order's amount to the recipient from the stated
holdings, the registry-entry fetch and one `DeliveryReceipt` with the same terms. The committed fill is
`confirmed` with its update id as `txRef`, and settles on the EVM source with `fillRef =
keccak256(utf8(updateId))`. A fill whose answer was lost (the order gone on the next try) is kept `sent`, and
its settlement adopts the attested `fillRef` of a proof that is otherwise exactly its own.

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
- **Reconfirm.** filler-gateway asks only the filler the user picked, when its price expired before the
  offer (FS-14): a `quote.reconfirm` whose `order.fillerId` is not this filler's is dropped unanswered, the
  hook not asked. It is accepted only at `order.minReceived` — a frame whose `amountOut`
  differs is declined without asking the hook (T-20) — and only before `replyBy`. An accepted reply signs
  `FillerQuote{requestId, filler, minReceived, validUntil, nonce}` with a fresh nonce and
  `validUntil = ⌈replyBy / 1000⌉ + ticketTtl + 30 s`. Declines carry no signature.
- **Reconciliation.** After every login the SDK reads `GET /v1/filler/quotes?since=` (last 15 minutes),
  attaches every verified ack the store missed and logs quotes filler-gateway holds that the store does not.

## Canton operations — what the node signs

The filler's Canton party is an external party on the Cancore participant: Cancore's backend prepares
each transaction, the node signs it with its party key, the backend submits (protocol §3.19). The node
never signs blind. Before signing, every leg passes these checks (`verifyTransactionLeg`,
`verifyTopologyLeg`); a leg that fails one throws `CantonRefusal` and nothing is signed:

- **Transaction leg.** `hashingSchemeVersion` must be `HASHING_SCHEME_VERSION_V2`, and `hash` must be
  the hash recomputed from `preparedTransaction`. The decoded transaction is returned as plain data
  (`CantonTransaction`: nodes, tagged `DamlValue`s), so the operation can check its economics against
  the node's own ticket or order. The V2 hashing is the SDK's own, on `@noble/hashes`, and is held by
  tests to `@canton-network/core-tx-visualizer`: no Node or DOM types are needed by a consumer.
- **Topology leg** (`party.allocate` only). `hash` must be the multihash recomputed from the topology
  transactions: each hashed with purpose 11, the set with purpose 55. The transactions (bare, or in
  Canton's versioned wrapper with nothing after its version) must create the summary's party and
  nothing else, all at serial 1:
  - the namespace is the fingerprint of the node key (`cantonFingerprint`);
  - the node key is the party's only signing key, threshold 1;
  - the party is hosted on the Cancore participant alone, with Confirmation, threshold 1.

  The participant to expect is pinned by the node, never taken from the backend. The backend checks
  only its own participant's hosting; everything else is checked here alone.
- **Any other leg kind** is refused (`legKind`).

Inside a filler, `FillerConfig.canton` names the party, its `CantonPartySigner`, the Cancore
participant (release data) and the policy for a Canton destination (`minTicketTtlSec`,
`requiredProofWindowSec`, `sendGuardSec`; no defaults). The party must be in the namespace of the
signer's key. `createFiller` then builds one `CantonOperations` on the session's own REST login and
message key, exposed as `filler.canton`; `createCantonOperations` builds a standalone one for a node
command run outside the session.

`CantonOperations` runs one operation end to end:
1. `canton.prepare`, then the verified `canton.prepared` answering it;
2. the leg checks above, then the operation's own check (`CantonOpCheck`) of the decoded transactions
   against what the node itself knows. The summary states the economics but is never trusted alone;
3. one Ed25519 signature per leg from the injected `CantonPartySigner` (the SDK holds no key);
4. `canton.submit`, and the verified `canton.submitted` for the same `operationId`.

A submit is retried with the same `operationId` on `CANTON_UNAVAILABLE`, `INTERNAL` or a transport
failure, three attempts in all. A prepare is never sent twice for one call. Prepares count in the
`cantonPrepare` rate class (an hourly budget) and submits in `canton`, so a spent budget pauses new
prepares only.

**Pinned registries.** Every check that meets a registry contract — `transfer`, `delivery.fill`,
the committed give (V-C4, V-C5) and `intent.settle` — holds it to `CantonOperations.registries`: by
instrument admin, the package id and templates of the registry (`CantonTransferFactory`: factory,
holding, pending transfer, V2 allocation, `openReceipt`). It is `CANTON_TRANSFER_FACTORIES`, the
published registries, unless `CantonConfig.registries` (or `CantonClientConfig.registries`) names
others — only for a network with its own registrar, such as a test stand; `registriesProblem`
checks such a pin before it is used. filler-gateway never supplies it.

`allocateParty()`, `acceptRegistry(fillerId)`, `transfer(params)` and `createPreapproval(admin)` carry their checks built in.
The party is recognised by its namespace, the fingerprint of the node key (its hint, the part before
`::`, is not checked):

- `createPreapproval` (CAN-2904): one transaction, one create and nothing else — the preapproval
  template of a registry pinned for the asked admin (`CantonTransferFactory.preapproval`, by package
  id), `receiver` the party, `admin` the asked one, the stated allowances and window (live), signed
  by the party alone. It lets transfers TO the party complete at once; nothing of the party's moves.
- `acceptRegistry`: one root, `FillerRegistryEntryProposal_Accept` on the stated proposal, acting as
  the party alone, creating exactly the `FillerRegistryEntry` of this fillerId and party, signed by
  the operator and the party;
- `transfer`: one root, `TransferFactory_Transfer` through the token-standard interface, acting as
  the party alone, moving the asked amount of the asked instrument to the asked party, spending the
  stated holdings, with the stated `executeBefore` still ahead. Under the root, by the decoded
  subtree:
  - the factory's template is pinned for the instrument admin, by package id and template
    (`CANTON_TRANSFER_FACTORIES`); an admin with no entry, or another factory, is refused;
  - the only exercises on the sender's contracts archive the stated inputs, each once and all of
    them (or are a service choice the entry lists);
  - every holding created is of the asked instrument and owned by the sender or the receiver;
  - direct: the receiver is credited exactly the amount; pending: nothing yet, the amount is locked
    to the sender under one offer of exactly this transfer;
  - the change to the sender is at most the stated inputs minus the amount.

`intent.settle` is run by the settlement (`checkIntentSettle`): one root, `SwapIntent_SettleWithProof` on
the intent the node read (same template), acting as the party alone, consuming it; the proof in the choice
is the node's own delivery, its `fillerEntryCid` the party's `ACTIVE` entry; nothing the party already signs
is consumed; one `SettlementFactory_SettleBatch` of a pinned registry whose legs are exactly `payout` from the
owner to the party and `fee` from the owner to the operator, split as the ledger splits; the party is
credited exactly the payout in unlocked holdings of the instrument.

`party()`, `holdings()`, `deliveryOrders()` and `intent(orderHash)` read the party's own state. `createCantonOperations` gives a node command a client with its own REST
login.

### The filler's own routes — `createFillerRoutes`

Cancore staff approve the routes a filler may serve; the filler switches each approved route on or
off itself (protocol §3.20). `createFillerRoutes({gatewayUrl, fillerId, gatewaySigner,
messageSigner})` gives a node command a client with its own REST login: `state()` reads every
approved route with `active`; `set(routes)` sends `routes.set` — the full list, sealed by the message
key — and returns the verified new `routes.state`. A route outside the approved ones is thrown as
`GatewayError` `ROUTE_NOT_APPROVED`, and nothing changed.

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
}, protocols: readonly string[]) => { send(text: string): void; close(code?: number, reason?: string): void };
```

`protocols` is `['cancore-filler.v1', 'bearer.<token>']`: offer it unchanged as the subprotocols of the
upgrade (`Sec-WebSocket-Protocol`), and do not log it — it carries the bearer token. A refused upgrade must
reach the SDK as `onError` and/or `onClose` without `onOpen`. With the `ws` package:

```ts
import WebSocket from 'ws';
const webSocket: WebSocketFactory = (url, h, protocols) => {
  const ws = new WebSocket(url, [...protocols]);
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
- `HttpFetch` — the slice of `fetch` used for the login, the REST fallback and drand relays (`status`,
  `text()`, and `headers.get` for `Retry-After`). Defaults to the global `fetch`.

## Testing — `@cancore/trader/filler/testing`

Fixtures for this package's tests and for filler nodes built on it. Not for production.

```ts
import {
  InMemoryFillerStore,
  fillerStoreConformance,
  FakeClock,
  FakeEvmRpc,
  createFakeFetch,
  createFakeGatewayLogin,
  createFakeWebSocketFactory,
  createTestGatewaySigner,
  createTestTypedDataSigner,
  createTestFillSigner,
  createRecordingEventSink,
  createRecordingLogger,
  FakeChain,
} from '@cancore/trader/filler/testing';
```

- `InMemoryFillerStore(clock?)` keeps the store contract (serialised per-order transactions with rollback,
  idempotent writes, leases by store time); two fillers on one instance model two replicas on one database.
  `setAvailable(false)` simulates an outage; `journal()` lists the evidence.
- `fillerStoreConformance` contains runner-independent `{ name, run }` cases for a store adapter.
  Give each case a fresh store and call `run(store, deepEqual)` with your runner's deep equality assertion.
  The cases cover recovery records, unsent messages, rollback, reconfirmed quotes, evidence and nonce fencing.
- `FakeClock` moves only on `advance(ms)`. `FakeEvmRpc` answers scripted methods and records calls.
- `createFakeWebSocketFactory()` hands out `FakeSocket`s: the test plays `filler-gateway` and feeds crafted
  frames with `receive(frame)`; `protocols` / `token` show what the SDK offered on the upgrade, `refuse(status)`
  refuses it.
- `createFakeGatewayLogin(gatewaySigner, { fillerId, clock })` — filler-gateway's login: `routes` for
  `createFakeFetch` (a challenge addressed by `fillerId`, a fresh token per `POST /v1/filler/auth`) and
  `accept(socket)`, which opens an upgrade that offers `cancore-filler.v1` and a live token and sends `auth.ok`
  first, and refuses any other.
- `createTestGatewaySigner(privateKey, clock?)` signs crafted filler-gateway frames the way filler-gateway
  does (`frame(body)` adds `sentAt` and `sig`); pin its `address` as `gatewaySigner`.
- `createFakeFetch(routes)` is an `HttpFetch` answering `"METHOD /path"` routes (with optional `headers`) and
  recording requests — the REST side of filler-gateway in a test.
- `createTestTypedDataSigner(privateKey)` — the reference behaviour of the signer contract, for test keys.
- `createTestFillSigner(privateKey)` — a `FillSigner` that also signs real EIP-1559 transactions;
  `decodeSignedTransaction(raw)` reads one back with its sender.
- `FakeChain` — blocks, routers, tokens and logs behind `EvmRpc`, with a mempool: `eth_sendRawTransaction`
  (replacements need +10 % on both fees), `mine()` includes and executes `fill`, `approve` and transfers,
  receipts, `minTip` to keep transactions stuck, `setTimestamp` for block times, and `reorg(fromBlock)` that
  undoes what the replaced blocks did (`dropOnReorg` drops their transactions instead of re-queuing them).

## License

Apache-2.0
