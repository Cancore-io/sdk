# `@cancore/client`

A typed client for the Cancore API. Four entries: the exchange (`./swap`), the USDCx
bridge (`./bridge`), live order updates (`./realtime`) and scoped trading grants (`./auth`). **No keys.** Where a step needs a
signature, the client hands you a hash and takes the signature back — signing stays with
`@cancore/wallet` or the dApp connector.

```bash
npm install @cancore/client
```

No runtime dependencies. The transport is `fetch`, and you inject the function that adds
your credential; the realtime entry takes a socket the same way.

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
signature — self-custody HTLC legs — that ceremony runs through
`@cancore/wallet/operations` (or the dApp connector), not through this client.

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

## Which API this was written against

`spec/openapi.json` is a snapshot of the gateway's OpenAPI document. A test drives every
client method against a recording transport and checks that each route it *actually* calls
exists in the document with that method, and that every request field the client sends —
and every response field it types — is a field the DTO has. `npm run spec:refresh` pulls a
fresh document; a red test after that is the API having moved.

The pool-trade routes (`/auto-trader/*`) are in that document now and are checked like every
other route — but only as routes. The document publishes their request DTOs with no
properties, declares no query parameters for the pair list and types no response for any of
the three, so `ListPairsQuery`, `Pair`, `Quote` and `Executed` stay written from what the
service returns. A test pins that gap instead of leaving it implied, and goes red the day
the document starts carrying the fields.

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
