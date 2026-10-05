# `@cancore/client`

A typed client for the Cancore API. Five entries: the exchange (`./swap`), the USDCx
bridge (`./bridge`), live order updates (`./realtime`), scoped trading grants (`./auth`) and a
self-custody account a program runs with its own key (`./selfcustody`). **No keys.** Where a
step needs a signature, the client hands you a hash and takes the signature back — signing
stays with `@cancore/wallet` or the dApp connector.

```bash
npm install @cancore/client
```

No runtime dependencies. The transport is `fetch`, and you inject the function that adds
your credential; the realtime entry takes a socket the same way. The one exception is
`./selfcustody`, which imports `@cancore/wallet` (a peer dependency) for how a prepared
transaction is signed.

## Quick start

```ts
import { createClient } from '@cancore/client';

const cancore = createClient({
  baseUrl: 'https://api.cancore.io',
  // The client does not know how you authenticate — it asks you.
  request: (url, init) => fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }),
});

// A pool trade: pick a pair the venue quotes, get a live price, trade at that price.
// `pairConfigId` is the pair's UUID — the service rejects symbols like 'CC/USDCx' with a 400.
const [pair] = await cancore.swap.pairs({ sourceToken: 'CC', targetToken: 'USDCx' });
const quote = await cancore.swap.quote({ pairConfigId: pair.id, sourceAmount: '5' });
const { orderId } = await cancore.swap.execute(quote.quoteToken);
const order = await cancore.swap.track(orderId);       // polls until a terminal status
// …or wait on the push feed instead — see `./realtime` below.
```

`request` receives the absolute URL and the init the client built (method, JSON headers,
body). Return a `Response`.

**Which credential.** The client sends whatever `request` adds; the API decides what it
accepts. Two kinds of credential work:

- **A user's own session token**, the JWT issued at sign-in: by `POST /auth/login` for an
  email-and-password account, or by `POST /auth/challenge`, a signature from the wallet key,
  then `POST /auth/login-signature` for a key-based one. It opens every route below.
- **A grant** (`cs_…`), which a person approved for your program. It carries scopes and, to
  trade, limits, and it opens only the routes its scopes name. Trading scopes work where the
  API enables them. See [Trading under a grant](#trading-under-a-grant).

## Trading under a grant

A program that trades for somebody should not hold their login. `@cancore/client/auth` asks
them for a grant instead: scoped to what the program does, capped by a budget they read and
approve, and revocable from their wallet. This is the device flow (RFC 8628). Your program
asks, the person approves in a browser, and your program receives a token of its own.

```ts
import { createClient } from '@cancore/client';
import { requestGrant } from '@cancore/client/auth';

const grant = await requestGrant({
  baseUrl: 'https://api.cancore.io',
  appUrl: 'https://cancore.io', // where the wallet is served; the consent page lives there
  appName: 'Rebalancer',
  scopes: ['orders:write', 'orders:read'],
  limits: { maxOrderUsd: 250, windowUsd: 1000, windowSeconds: 86_400 },
});

console.log(`Open ${grant.verificationUri} and check that it shows ${grant.userCode}`);
const token = await grant.wait(); // resolves once the person approves

const cancore = createClient({
  baseUrl: 'https://api.cancore.io',
  request: (url, init) => fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }),
});
```

Trading grants work where the API enables them. Where it does not, `requestGrant` rejects
with the API's own 400 naming the scope (`Unknown scope: orders:write. Allowed scopes: …`),
and the trading routes refuse any grant.

**What the person sees.** They open the page, sign in to their wallet if they are not signed in
yet, and see the code, the app name you sent, the scopes you asked for and, for a trading
grant, the limits. The code must match the one your program printed. If it does not, the
request is not yours and they should decline. Then they approve or decline. Nothing is granted
before that, and only that page can approve: your program cannot approve its own request. The
grant lasts until it expires or the person revokes it. After that every call answers 401, and
your program asks again.

**`requestGrant(options)`**

| Option | Meaning |
| --- | --- |
| `baseUrl` | gateway root |
| `appName` | the name the consent page shows |
| `scopes` | what the grant may do, see the table below |
| `limits` | the budget; required with `orders:write` or `pool:trade`, refused without them |
| `appUrl` | where the wallet is served. The API answers with a path on that host, and with `appUrl` set, `verificationUri` is a full URL. Not derived from `baseUrl`, because the API and the wallet are not always one host apart |
| `request`, `fetchImpl` | the same transport seam as the rest of the client. No credential is needed: this call is how you get one |

It resolves to `{ userCode, verificationUri, expiresAt, wait(options?) }`. The device code the
API issued stays inside. It is a credential in waiting and is never handed to you.

**`wait({ signal?, sleep? })`** polls at the interval the API sets and resolves to the token.
The token is handed over exactly once.

| Outcome | What `wait` does |
| --- | --- |
| approved | resolves to the token |
| declined | rejects with `GrantDeniedError` |
| nobody approved it before `expiresAt`, or it was already collected | rejects with `GrantExpiredError` |
| the API answers 429 | slows down: five more seconds per poll from then on (RFC 8628 `slow_down`), longer if the answer says so |
| `signal` aborts | rejects with the signal's `reason`. A poll already in flight is never cut off, so a collected grant is never dropped. The request stays live until `expiresAt`: call `wait` again and the code on the person's screen keeps working |
| any other error | rejects with `CancoreApiError` |

**Limits.** Required with a spending scope, refused without one, and immutable once issued. A
different budget is a different grant.

| Field | Meaning | The API's bounds |
| --- | --- | --- |
| `maxOrderUsd` | ceiling on the USD value of one order or pool trade | above 0, at most 100,000 |
| `windowUsd` | ceiling on the USD committed within one rolling window; at least `maxOrderUsd` | above 0, at most 1,000,000 |
| `windowSeconds` | length of that window, in whole seconds | 60 to 2,592,000 (30 days) |
| `pairIds` | trading-pair ids the grant may trade, in either direction; omit for any pair | 1 to 50 uuids |

`requestGrant` throws a `TypeError` before sending anything for a request the API would refuse
anyway: a spending scope without limits, limits without one, a figure that is not a positive
number, a figure outside the bounds above, a fractional window, a window budget under the
per-order cap, or a `pairIds` that is empty, too long or holds anything but uuids. The API stays
authoritative: whatever it refuses, it answers 400 naming what is wrong.

Creating, accepting and pool-executing count against the window. A pool quote is checked
against `maxOrderUsd` and `pairIds` but moves nothing, so it does not count. Cancelling is never
refused by a budget. A trade the API cannot price in USD is refused.

**Which method needs which scope.**

| Method | Route | Scope |
| --- | --- | --- |
| `swap.listOpen(query?)` | `GET /orders` | `orders:read` |
| `swap.listMine(query?)` | `GET /orders/my` | `orders:read` |
| `swap.get(id)` | `GET /orders/{id}` | `orders:read` |
| `swap.track(id, options?)` | polls `GET /orders/{id}` | `orders:read` |
| `swap.create(input)` | `POST /orders` | `orders:write` |
| `swap.createForPair(input)` | `POST /orders/pair` | `orders:write` |
| `swap.accept(id)` | `POST /orders/{id}/accept` | `orders:write` |
| `swap.cancel(id)` | `POST /orders/{id}/cancel` | `orders:write` |
| `swap.pairs(query?)` | `GET /auto-trader/pairs` | not open to a grant |
| `swap.quote(input)` | `POST /auto-trader/quote` | `pool:trade` |
| `swap.execute(quoteToken)` | `POST /auto-trader/execute` | `pool:trade` |
| `bridge.limits()`, `bridge.history(query?)`, `bridge.checkOnboarding()`, `bridge.estimateCost(input)` | `/canton-wallet/bridge/*` | not open to a grant |
| `bridge.mint(input)`, `bridge.burn(input)`, `bridge.prepareInteractive(input)`, `bridge.submitInteractive(input)`, `bridge.executeInteractive(input, sign)` | `/canton-wallet/bridge/*` | not open to a grant |
| `orderUpdates(socket, handler)`, `waitForOrder(socket, id, options?)` | the `/presence` socket | not open to a grant: the handshake takes a user's session token only. Use `swap.track` |
| `requestGrant(options)`, `wait(options?)` | `POST /auth/device/authorize`, `POST /auth/device/token` | none: this is how you get one |

`swaps:read` is the fourth trading scope. It opens `GET /htlc/swaps`, `GET /htlc/swaps/{id}/full`
and `GET /htlc/{id}`, which this client does not wrap. Reach them through `createHttp`.

A grant does not sign. Where the swap after an order needs the account holder's signature
(self-custody legs), that still happens in their wallet.

**What a refusal looks like.** Every refusal is a `CancoreApiError` whose message keeps the API's
own words, and a limit refusal names the limit, so a program can act on it:

| Answer | Meaning |
| --- | --- |
| `403: Grant limit "maxOrderUsd" exceeded: this trade is worth $900.00, the grant allows $250.00 per order` | one trade over the per-order cap: split it |
| `403: Grant limit "windowUsd" exceeded: this trade is worth $300.00, the grant has $150.00 left of $1000.00 per 86400s` | the window is spent: wait, or trade less |
| `403: Grant limit "pairIds": this grant may not trade pair …` | the pair is not on the allow-list |
| `403: Grant limit "maxOrderUsd": this trade has no USD price, so it cannot be checked against the grant budget.` | the API cannot price it, so it refuses it |
| `403: Session is missing the required scope: pool:trade` | the grant lacks the scope |
| `403: This route declares no scope and is closed to app sessions` | no scope opens this route to a grant |
| `401` | the grant expired or was revoked: ask again |

```ts
import { CancoreApiError } from '@cancore/client';

try {
  await cancore.swap.createForPair(input);
} catch (err) {
  const limit = err instanceof CancoreApiError && err.status === 403 ? /Grant limit "(\w+)"/.exec(err.message)?.[1] : undefined;
  if (limit === 'maxOrderUsd') { /* split the order */ }
  else if (limit === 'windowUsd') { /* wait for the window to roll */ }
  else throw err;
}
```

## `@cancore/client/swap`

| Method | Route | What it is |
| --- | --- | --- |
| `listOpen(query?)` | `GET /orders` | offers on the venue |
| `listMine(query?)` | `GET /orders/my` | orders you created or accepted |
| `get(id)` | `GET /orders/{id}` | one order |
| `create(input)` | `POST /orders` | an offer named by network + token address on both sides |
| `createForPair(input)` | `POST /orders/pair` | the same offer, named by a trading pair the venue lists |
| `accept(id)` | `POST /orders/{id}/accept` | take the other side |
| `cancel(id)` | `POST /orders/{id}/cancel` | withdraw your offer |
| `pairs(query?)` | `GET /auto-trader/pairs` | the pool pairs the venue quotes, with the `id` that `quote` takes |
| `quote({ pairConfigId, sourceAmount })` | `POST /auto-trader/quote` | a live pool price, good for `expiresInSec` |
| `execute(quoteToken)` | `POST /auto-trader/execute` | trade at that price; returns the order the pool opened for you |
| `track(id, options?)` | polls `GET /orders/{id}` | until `completed`, `cancelled`, `refunded` or `delivery_failed` |

The push feed is the other way to follow an order — `./realtime`, below.

Every shape is the API's own DTO, field for field — `Order` is `OrderResponseDto`,
`CreateOrderInput` is `CreateOrderDto` — and a test holds them to the gateway's OpenAPI
document. Amounts are decimal **strings** everywhere except the pool quote, which the
service takes as a number; the client converts, so pass either.

A `Quote` also reports `subsidized`: the venue sometimes quotes better than market on the
direction that rebalances its pool, and that flag is how you tell such a price from a
plain one before showing it to anyone.

`track` reports every poll through `onUpdate`, stops on an `AbortSignal`, and gives up after
`timeoutMs` (default 15 minutes) with `TrackTimeoutError` — which carries the last order it
saw, so you are never left with a bare timeout.

**What `accept` does not do.** It is a POST. Where the swap that follows needs your
signature — self-custody legs — that ceremony runs through
`@cancore/wallet/operations` (or the dApp connector), not through this client.

## `@cancore/client/selfcustody`

A self-custody Canton account run entirely by a program — a partner's trading service, a
bot. The account's key signs every step that needs its authority: its sign-in, its Canton
party, each leg of a swap, the acceptance of a delivery or a cashback payout. Only the
signatures leave your process; the API never holds the key.

```ts
import { providerFromMnemonic } from '@cancore/wallet';
import { createSelfCustody } from '@cancore/client/selfcustody';

// One recovery phrase holds any number of accounts: m/44'/6767'/{account}'/0'/0'.
// The signer is { public_key, signMessage, signChallenge, signPreparedHash } — see below.
const signer = await providerFromMnemonic(process.env.PHRASE!, { account: 0 });
const acct = createSelfCustody({ baseUrl: 'https://api.cancore.io', signer });

// Once per account: sign up with your invite code (it grants the partner role), then create
// the account's Canton party and enable CC receipts. Both are safe to run again.
await acct.session.register({ inviteCode: 'ABCD-EFGH-JKMN' });
await acct.onboard();
// Every later run just signs in — `acct.session.login()` — or lets the first request do it.

// Orders are refused until the stand's documents are accepted — the ones you read.
const { accepted, requiredVersion } = await acct.legalStatus();
if (!accepted && requiredVersion) await acct.acceptTerms(requiredVersion, documentsYouRead);

// The maker places the order and settles its side; the taker (another account, another
// process, another partner) settles the other. Each call returns when the swap has settled
// (allocation-DvP, see "How a trade settles") and this account's proceeds are in.
const order = await acct.swap.createForPair({ tradingPairId, sourceAmount: '100', targetAmount: '20' });
const { swap, flow } = await acct.make(order.id);   // swap.status 'dvp_settled', flow 'dvp'
// …elsewhere: await other.take(order.id);

// Registry-token deliveries and cashback payouts wait for this account's signature.
await acct.acceptIncoming();
await acct.cashback.collect();   // claim, then accept this claim's payouts as they arrive
```

| Member | What it does |
| --- | --- |
| `session.register(input?)` | `register-challenge` → signed `register`, carrying `inviteCode` when given |
| `session.login()` | `challenge` → signed `login-signature` |
| `session.request` | the authenticated transport: renews the JWT before it expires, signs in again on a 401 |
| `me()` | `GET /auth/me` |
| `onboard()` | `wallet.topology` (the party, signed by the key) then `tokens.preapproval` (CC receipts, venue-paid); skips what exists |
| `legalStatus()` / `acceptTerms(version, documents)` | `GET` / signed `POST /legal/consent` |
| `make(orderId, options?)` | maker: wait for the taker, record the DvP trade and sign its proposal, fund its leg after the taker, wait for the atomic settle |
| `take(orderId, options?)` | taker: accept the order, sign the approval, fund its legs (the platform fee among them), wait for the atomic settle |
| `swap.create(input)` / `swap.createForPair(input)` | `POST /orders` / `POST /orders/pair`; a Canton↔Canton order is always sent with `dvp: true` (for a pair, read from `GET /trading-pairs/{id}`) |
| `incoming()` / `accept(transfer)` / `acceptIncoming(filter?)` | transfers waiting for this account's signature |
| `send(input)` / `consolidate(tokenId?)` / `balance(instrumentId)` | move, merge and read this account's tokens |
| `splitForFee(tokenId, feeAmount, { allowUnverified? })` | give the DvP platform fee a holding of its own (a self-send, verified from its bytes; CC only) |
| `faucet()` | test CC from the dev stand's faucet, see [Test funds on dev](#test-funds-on-dev) |
| `cashback.summary()` / `claims()` / `claim()` / `collect(options?)` | partner cashback (role `partner-bot`) |
| `execute(type, params?)` | any operation of `GET /wallet/operations`: prepare, sign every leg, submit |
| `swapState(swapId)` | `GET /htlc/{id}` |

**The signer.** `createSelfCustody` and `createSession` take any object of this shape, and
`providerFromMnemonic` (`@cancore/wallet`) returns exactly it:

| Field | What it is |
| --- | --- |
| `public_key` | the hex Ed25519 public key, the account's identity. Snake case, because it is the Loop provider's field |
| `signMessage(message)` | raw bytes as a binary string (one char per byte) → lowercase hex signature |
| `signChallenge(challenge)` | optional; the login-challenge path, preferred over `signMessage` when present |
| `signPreparedHash(hashB64)` | optional; base64 32-byte prepared-transaction hash → base64 signature |

`deriveWalletKey` returns key material, not a signer, and names the same key `publicKeyHex`.
Passing that object here is refused at once with a `TypeError` that names `public_key`.

**Register with your invite code.** A partner gets a single-use code (`XXXX-XXXX-XXXX`) from
Cancore and passes it to `register`. The code rides on the sign-up request itself: the account
is created and the code's role (`partner-bot`) granted in one request, and an unused code
stands in for the stand's captcha, so a program needs no `captchaToken`. No email is needed
either. If the sign-up comes back with `status: 'FAILED'` (the account's activation did not
finish), call `register` again with the same key and the same code: the API knows the code
as this key's and grants the role again instead of refusing it as used. A code the API does
not know, or one another key redeemed, is refused (`404` / `409`) — the SDK never signs up
without it. A `409` "Public key already registered" means an earlier sign-up went through:
`login()` instead. Against a gateway whose sign-up does not take the code yet (mainnet, until the
invite-on-sign-up change ships there) `register` signs up without it and then redeems it with
`POST /auth/redeem-invite`, as before.

**How a trade settles.** Every Canton↔Canton order settles through allocation-DvP: both legs
(and the platform fee) move in one ledger transaction, with no hash lock, no escrow and no
preimage. There is no HTLC fallback. The stand refuses at the earliest point it can, and each
refusal is a `SettleError` that says why, before anything is signed:

- DvP not open to the account (`403`, `DVP_NOT_ALLOWED`): when placing the order
  (`swap.create` / `createForPair`), when taking it (`take`), or when the maker records the trade.
- The pair not enabled for DvP on this stand: `make` refuses before the trade is recorded.
- The taker's wallet keeps the order's target token in a single holding
  (`DVP_FEE_HOLDING_REQUIRED`): the platform fee needs a holding of its own. By default `take`
  ends with a `SettleError` naming the fee; run `splitForFee(tokenId, feeAmount)`, which sends the
  fee amount to this account and leaves the fee and the change in two holdings, then `take()`
  again. With `{ autoSplitForFee: true }` `take` does it itself and takes once more — once; a
  second refusal or a failed split is a `SettleError`. It first holds the fee the venue names to
  the order (at most the target amount × `maxFeeRate`) and checks the change still covers the
  trade leg; nothing is sent otherwise. The split's send is read before it is signed, like a DvP
  step: its hash recomputed from its bytes, only the account's own holdings spent, a holding of
  exactly the fee created for it, nothing for anyone but the network fee's recipient (pinned per
  network, `DEFAULT_NETWORK_FEE_RECIPIENTS`; add with `networkFeeRecipients`), and the whole cost
  — the quoted network fee, any fee debt the API collects on the same leg, and a holding-fee
  margin of 1% of the fee (at most 1 CC) — within `maxSplitCost` (default 2 CC). An account with
  more fee debt than that is told to settle it first. **An API that does not return the send's
  bytes** (until backend CAN-2132 is deployed) **gets the split refused**: pass
  `{ allowUnverified: true }` to `splitForFee`, or `allowUnverifiedSplit: true` with
  `autoSplitForFee`, to sign it without local verification (`verified: false`); a send with bytes
  for some legs only is never signed. On testnet neither the CC admin nor the fee recipient is
  pinned: pass `instrumentAdmins` and `networkFeeRecipients`. The split is CC only: the API refuses a registry-token send to oneself, so a CBTC or USDCx taker
  gets a separate holding by receiving that token in a second transfer. Against an older gateway
  that refuses only when the maker records the trade, `make` names the taker's party and the
  fee; the taker runs `splitForFee(tokenId, feeAmount)` and the maker runs `make()` again.

A swap an earlier client opened as HTLC is refused the same way, and so is an order placed
without `dvp: true`: the order's own choice decides the mechanic, so place Canton↔Canton orders
with `acct.swap.create` / `createForPair`, which ask for DvP.

```
maker (make)                          API / venue                          taker (take)
  │                                       │   POST /orders/{id}/accept          │
  │  GET  /htlc/dvp/instruments           │◄────────────────────────────────────│
  │  POST /htlc/proposals {dvp:true}  ───►│  draft: legs main, counter, fee     │
  │  sign dvpCreateProposal ─────────────►│  SwapProposal (maker's signature)   │
  │                                       │◄──────────── sign dvpAcceptProposal │
  │                                       │  venue: proposal → SwapTrade        │
  │                                       │◄─ sign dvpAllocateLeg (counter+fee) │
  │  sign dvpAllocateLeg (main) ─────────►│  all legs allocated                 │
  │                                       │  venue: SwapTrade_Settle (1 tx)     │
  │  GET /htlc/swaps/{id}/full … dvp_settled                    … dvp_settled │
```

Each `sign …` is `POST /canton-wallet/htlc/prepare-command` with `{ operationType, params: {
swapId } }`, a check of every prepared transaction the API returns, the account's signature
over each one's hash (the same signer as every other ceremony), and
`POST /canton-wallet/htlc/submit-signed`. The account names the swap and nothing else.

**Every DvP step is read before it is signed.** (So is the fee split's send, unless the caller
allows it blind — see above.) The signature covers the hash of a prepared transaction, so
before the key is used the account takes the transaction's bytes (`preparedTransactions[]`),
recomputes the hash from them with Canton's hashing scheme v2 (`@canton-network/core-tx-visualizer`)
and refuses on any difference. It then walks the whole decoded tree, not just its command:

- every node is reachable from the one command, and none is rolled back;
- the proposal steps run Cancore's own swap package, pinned by package name AND package id
  (`DEFAULT_TRUSTED_PACKAGES`; add ids with `trustedPackages`) — a name alone is not trusted,
  since anyone can upload a package under any name — and are exactly their own shape (one
  create; one approval that recreates the proposal);
- an allocation's trust anchor is the instrument admin, not a package id: the registries (the
  DSO for CC, the Digital Asset utility for registry tokens) upgrade their packages on their own
  schedule. The allocation goes through the token standard's `AllocationFactory` interface,
  pinned by its package id, on a factory that is disclosed with the transaction, of the same
  template (package name, module, entity; under a Daml upgrade it may run a newer package id
  than it was created with) and signed by the instrument admin. The admin is pinned in the SDK
  per network and instrument (`DEFAULT_INSTRUMENT_ADMINS`: the DSO party for CC; the CBTC,
  USDCx and HECTO registrars), and the one the stand's `GET /htlc/dvp/instruments` names must
  be on that network's list, or the trade is refused before anything is recorded. The network
  comes from `baseUrl` for the Cancore API hosts (`API_NETWORKS`) or from the `network` option;
  an unknown host without it trusts no admin. A token not listed for the network is added with
  `instrumentAdmins` (added to the defaults, never replacing them). CC on testnet has no pinned
  admin yet: pass the testnet DSO party there;
- a contract the signer signs must look like its own holding (an `owner` that is the signer and
  an amount) or be the allocation record of exactly this leg (executor, trade, sender, receiver,
  amount and instrument as checked), and a choice it acts in must be the factory's, one on its
  own holding, or one on a contract the instrument admin signed. This is a check of shape, not of
  template: a contract shaped like a holding passes it whatever its code;
- in an allocation, no node may create a holding owned by anyone but this account; what is
  locked is at most the leg's amount, of the leg's instrument and nothing else; every holding spent is this account's and disclosed; no
  more of an instrument is spent than the leg locks; and no party appears in any created
  contract or choice argument but this account, the venue, the leg's receiver and the
  registry's own parties (the factory's signatories and stakeholders) — a transfer, lock or
  instruction for anyone else is refused;
- every deadline in it (the proposal's expiry, the allocation's `allocateBefore` and
  `settleBefore`) lies between now (less five minutes of clock skew) and
  `maxSettlementWindowMs` ahead (default 3 hours), and `requestedAt` within that window before
  now: the API cannot keep the account's funds locked for longer.

**What this guarantees, and what it still trusts.** Against a dishonest or compromised API, the
account signs only: the proposal and approval of exactly the order's trade (its amounts,
instruments, parties, the venue, and a fee no higher than the ceiling), and allocations that,
as far as the transaction shows, lock at most each leg's amount for this trade's executor, under
a factory its pinned instrument admin signed, with no holding leaving the account in that
transaction and no deadline beyond the window.

What it trusts is each listed instrument admin, and with more than its token. The allocation
record the account signs is executed later (`Allocation_ExecuteTransfer`, triggered by the
executor) by the admin's code with the sender's authority, and the admin's code also runs the
allocation itself. Checking the transaction cannot bound that code: an honest admin's
participants re-run it and refuse anything else, but a dishonest admin on the list could act
with the account's authority. Trade only tokens whose registry you trust that far, and add
admins with `instrumentAdmins` only on the same terms.

It then holds the command to the trade it agreed to, read from the order,
`GET /htlc/dvp/instruments` (each instrument's admin) and `GET /htlc/fee-config` (fee rate, fee
receiver and venue), never from the swap row: the transaction acts as this account only, is
the one command the step is made of, and every leg in it is the order's main leg, the counter
leg, or a platform fee within the published rate, with the counter leg and the fee adding up
to the order's `targetAmount`. An allocation must hand settlement to the venue and name this
trade. Anything else, a transaction it cannot decode included, is a `CeremonyError` at the
`prepare` stage and nothing is signed.

The fee is held to a ceiling the API cannot move: `maxFeeRate`, default `'0.015'` (1.5%, this
SDK's default ceiling). A stand that publishes a higher rate is refused — by `make` before the
trade is recorded, by `take` before it signs. Pin from your own configuration, too:
`venuePartyId` (the venue every allocation must hand settlement to) and `feeRecipientPartyId`
(the only party the fee may be paid to).

What the account signs:

| Step | Who | What the signature authorises |
| --- | --- | --- |
| `dvpCreateProposal` | maker | the trade proposal with every leg's terms, approved by the maker |
| `dvpAcceptProposal` | taker | the taker's approval of those terms |
| `dvpAllocateLeg` | taker, then maker | one allocation per leg it sends, each locking the leg's holdings for the venue to settle; the taker signs two, its leg and the platform fee |

The platform fee is a third leg carved out of the leg delivering to the maker (the same rate as
HTLC), so the taker's outflow is the order's `targetAmount` and the maker receives it net of
the fee. The taker funds first and the maker last, so neither side hands the other a free
option. The venue settles once every leg is funded. Proceeds land with the settle itself, so
`delivery` is always `'direct'` and nothing is left to accept. A trade nobody funds in time
ends `dvp_expired`, a `SettleError` on both sides.

**Who releases a funded leg that never settles.** The taker funds first, so a maker that never
funds leaves the taker's allocations (its leg and the fee) locked. They stay locked until the
trade's settle deadline; a few minutes after it the venue's recovery aborts the trade
(`SwapTrade_Abort`), which cancels every allocation still live in the same transaction, and
the swap reads `dvp_expired`. The `SettleError` the taker gets says which happened: released,
or still locked. If recovery could not release them (the abort was refused, or the trade was
already gone), they are still locked: this client has no way to withdraw a DvP allocation
itself yet, so contact Cancore support with the swap id. A `take` whose own deadline runs out
first says the allocations stay locked until the venue releases them.
`make` and `take` resume: an order whose trade exists picks up at the first step not yet
done. `timeoutHours` only fills the proposal request's required field (one the stand offers,
by default the shortest of at least 15 minutes); the trade's windows are the venue's.

**What it retries, and what it does not.** A submit is never re-sent blindly: the only
retries are the ones the API says are safe. Every decision is taken on the refusal's
`errorCode`, in one place (`refusalOf`):

| `errorCode` | What the account does |
| --- | --- |
| `SUBMISSION_TIMEOUT_RETRYABLE` | resubmits the same signatures (up to twice) — never prepares again; Canton deduplicates on the command id |
| `PREPARED_SUBMISSION_EXPIRED` | prepares and signs again, once — only where that is safe (the DvP steps of `make` / `take`) |
| `DVP_NOT_ALLOWED` | a `SettleError` wherever it comes (placing, taking, recording the trade): DvP is not open to this account on this stand |
| `DVP_FEE_HOLDING_REQUIRED` | a `SettleError` saying who must split its balance: at `take`, this account (`splitForFee`, then `take()` again); at `make`, the taker (then `make()` again). With `autoSplitForFee: true`, `take` splits the fee off itself (CC, the send verified from its bytes, or blind with `allowUnverifiedSplit`) and takes once more |
| `ACCOUNT_NOT_FOUND` (at sign-in) | asks for a new challenge up to twice more, 1 s then 2 s apart. The gateway answers an existing key with this 404 when its challenge is slow (a known gateway issue), most often right after sign-up; three in a row surfaces it |
| anything else | surfaces it |

A gateway that sends no code for the first two (mainnet, until the error-code registry ships there) is
read by the text of its message instead. Mainnet already sends `ACCOUNT_NOT_FOUND` as a code. What surfaces is a `CeremonyError` (with what the
prepare had said, and the refusal's `errorCode` when it carried one) or a `SettleError` (with
the last state seen).

Canton↔Canton orders only: an EVM leg is locked by an EVM key, which is not this signer, so
`make` / `take` refuse an order with one before anything is signed.

### Test funds on dev

`acct.faucet()` asks the dev stand's faucet for test CC for this account's party. It signs the
faucet terms with the account key and posts `POST /faucet/request` with
`{ agreementSignature, agreementTimestamp }`. The signed text is
`CANCORE_FAUCET_TERMS_OF_SERVICE_V1:<partyId>:<agreementTimestamp>`, where the timestamp is epoch
milliseconds, and the signature is the `signMessage` hex. The faucet pays the party in the
session's JWT, so run `onboard()` first. Today it pays 1,000 CC per party once every 48 hours.
It answers `429` while the party is cooling down and `503` when the pool is empty or paused.
The faucet pays CC only. Only dev runs one: testnet and mainnet answer `503`.

## `@cancore/client/realtime`

`track` polls. The gateway also pushes every order change over Socket.IO, and this entry
reads that feed — without adding a dependency. The socket is injected exactly the way
`request` is, so `socket.io-client` stays on your side:

```ts
import { io } from 'socket.io-client';
import { orderUpdates, waitForOrder } from '@cancore/client/realtime';

const socket = io(`${baseUrl}/presence`, { auth: { token }, transports: ['websocket'] });

const stop = orderUpdates(socket, (order) => console.log(order.id, order.status));
const settled = await waitForOrder(socket, orderId);   // resolves on the first terminal update
stop();
```

| Export | What it is |
| --- | --- |
| `orderUpdates(socket, handler)` | every order update the venue broadcasts; returns the unsubscribe |
| `waitForOrder(socket, id, options?)` | resolves on the first update for `id` that is terminal |
| `ORDER_UPDATED_EVENT` | the event name, `order:updated` |
| `SocketLike` | the two methods this entry uses — `socket.io-client`'s `Socket` satisfies it, and a test compiles that claim rather than asserting it in prose |
| `OrderWaitTimeoutError` | `waitForOrder` gave up; `last` is the most recent update it saw, if any |

Nothing is added to your install: `socket.io-client` is not a dependency of this package,
runtime or peer — `SocketLike` is two methods, so a stub or another Socket.IO build does
just as well.

`/presence` is the namespace and `auth.token` is the credential — the handshake is rejected
without it. There is no join message to send: the gateway verifies the token and puts the
socket in that user's room itself.

**The feed is not filtered for you.** `order:updated` goes to every connected client, so
orders you have nothing to do with arrive too — `waitForOrder` filters by id, `orderUpdates`
hands you everything. The payload is the same `Order` the REST API returns, minus the
counterparties' `ethAddress`/`tronAddress`, which the broadcast strips.

`waitForOrder` takes `{ isTerminal?, timeoutMs?, signal? }`, gives up after 15 minutes like
`track`, and — unlike `track`, which always holds an order it just fetched — **rejects** on
abort rather than resolving, with the signal's own reason. An order that was already
terminal before you subscribed sends no further update; `swap.get(id)` answers that, this
waits for a transition.

The event name and the payload fields this entry reads are pinned in
`contract/realtime-events.contract.json` with the backend file:line each came from, and a
test holds them to `spec/openapi.json`.

## `@cancore/client/bridge`

| Method | Route | For |
| --- | --- | --- |
| `limits()` | `GET /canton-wallet/bridge/limits` | `{ minBurnAmount, maxBurnAmount }` |
| `history(query?)` | `GET /canton-wallet/bridge/history` | your bridge operations, paginated |
| `checkOnboarding()` | `POST …/check-onboarding` | has this party accepted the bridge agreement? |
| `estimateCost({ operation, amount })` | `POST …/estimate-cost` | fee, traffic cost and the recommended CC to hold |
| `mint(input)` / `burn(input)` | `POST …/mint`, `POST …/burn` | **custodial** — the backend signs |
| `prepareInteractive(input)` | `POST …/prepare-interactive` | **self-custody**, step one: a hash to sign |
| `submitInteractive({ submissionKey, signature })` | `POST …/submit-interactive` | step two: the signature over it |
| `executeInteractive(input, sign)` | both | with your signer between them |

```ts
import { signPreparedHashBase64 } from '@cancore/wallet/operations';

await cancore.bridge.executeInteractive(
  { operation: 'burn', amount: '10', ethRecipient: '0x…' },
  (hash) => signPreparedHashBase64(signer, hash),
);
```

The signer sees a base64 hash and returns a base64 signature. That is the whole exchange —
the key it uses never crosses into this package.

## Errors

Every non-2xx answer is one `CancoreApiError` with `status`, `method`, `path` and the parsed
`body`, and a message that keeps the server's own words:
`POST /orders → 400: sourceAmount must be positive`. A cap or a validation message reads as
guidance, not as a transport failure.

A refusal the gateway has a name for also carries it: `err.errorCode` is one of `SdkErrorCode`,
the closed registry the gateway publishes as an enum in its OpenAPI document (`SDK_ERROR_CODES`
is that list, generated by `npm run spec:refresh`, never typed by hand). It reads `errorCode` from
the body and falls back to `code`, which a gateway older than the registry sends alone; a body
with neither, or with a code this version does not know, leaves it `undefined`
(`sdkErrorCodeOf(body)` is the same rule, for a body you hold elsewhere). Switch on it
exhaustively and the compiler tells you the day a new code is published:

```ts
import { CancoreApiError, isSdkError, type SdkErrorCode } from '@cancore/client';

const assertNever = (code: never): never => {
  throw new Error(`Unhandled SdkErrorCode: ${String(code)}`);
};

function say(code: SdkErrorCode): string {
  switch (code) {
    case 'KEY_IN_USE':
      return 'This key already belongs to another account.';
    case 'MAINTENANCE_MODE':
      return 'The venue is under maintenance.';
    case 'NOT_ELIGIBLE':
    case 'MIGRATION_REQUIRED':
      // …one `case` per code, grouped where the answer is the same…
      return 'Not available for this account.';
    default:
      return assertNever(code); // fails `tsc` until every code has a branch
  }
}

try {
  await cancore.swap.createForPair(input);
} catch (err) {
  if (isSdkError(err, 'KEY_IN_USE')) { /* err.errorCode is narrowed to 'KEY_IN_USE' */ }
  const code = err instanceof CancoreApiError ? err.errorCode : undefined;
  if (code === undefined) throw err; // no code, or one from a newer gateway: surface it as it is
  console.error(say(code));
}
```

`errorCode` needs a gateway that publishes the registry: backend
[#1907](https://github.com/Cancore-io/backend/pull/1907). On an older one it is
`undefined` for every body that has no `code`, and the self-custody account falls back to the text
of the message for the six swap refusals it acts on.

## Which API this was written against

`spec/openapi.json` is a snapshot of the gateway's OpenAPI document. A test drives every
client method against a recording transport and checks that each route it *actually* calls
exists in the document with that method, and that every request field the client sends —
and every response field it types — is a field the DTO has. `npm run spec:refresh` pulls a
fresh document; a red test after that is the API having moved.

The pool-trade routes (`/auto-trader/*`) are in that document with their fields, and are
checked like every other route: `ListPairsQuery`, `Pair`, `Quote` and `Executed` are held to
`PairListItemDto`, `QuoteResultDto` and `ExecuteResultDto`.

`SDK_ERROR_CODES` and `SdkErrorCode` come from the same document. `npm run spec:refresh`
writes `src/sdk-error-codes.ts` from its `SdkErrorCode` enum (and fails on a document without
one), and a test compares the two.

The device-flow routes are in the document only in part. `requestGrant`'s body and the
limits are checked like every other request type, but the document types neither the poll
body nor either answer, so those shapes in `./auth` are written from what the service
returns. The same kind of test pins that gap.

The snapshot is a test fixture and is not published: `files` is `dist`, `README.md` and
`LICENSE`, so the document growing — it covers the whole venue now, operator routes
included — costs the install nothing. A route existing in it is not a reason for this
client to wrap it, and a test holds the client off the operator surface.

## Using the pieces

```ts
import { swap } from '@cancore/client/swap';            // just the exchange
import { bridge } from '@cancore/client/bridge';        // just the bridge
import { orderUpdates } from '@cancore/client/realtime'; // just the push feed
import { requestGrant } from '@cancore/client/auth';    // just the grant request
import { createHttp } from '@cancore/client';           // the seam, for a route this client lacks
```

Full documentation: <https://docs.cancore.io/sdk/client>

## License

Apache-2.0.
