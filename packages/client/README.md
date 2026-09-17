# `@cancore/client`

A typed client for the Cancore API. Three entries: the exchange (`./swap`), the USDCx
bridge (`./bridge`) and live order updates (`./realtime`). **No keys.** Where a step needs a
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

**Which credential trades.** The client sends whatever `request` adds; the API decides what it
accepts. The order, pool and bridge routes take a user's own session token — the JWT issued
at sign-in, by `POST /auth/login` for an email-and-password account, or by `POST /auth/challenge`,
a signature from the wallet key, then `POST /auth/login-signature` for a key-based one.

An app-session grant (`cs_…`) cannot trade, whether it came from the dApp connector's consent
popup or from a device flow. No grantable scope covers orders, pool trades or the bridge, and
the routes refuse it before looking it up:

| Routes | What a grant gets back |
| --- | --- |
| `/orders/*`, `/canton-wallet/bridge/*` | `403 This route declares no scope and is closed to app sessions` |
| `/auto-trader/*` | `401 Unauthorized` |

A grant works where a route declares a scope: the connector's wallet RPC, and the agent queue
that `@cancore/mcp` proposes trades through.

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

The pool-trade routes (`/auto-trader/*`) are a separate service the gateway document does not
include; their shapes are written from the responses the Cancore app itself consumes, and
the test says so rather than skipping them silently.

## Using the pieces

```ts
import { swap } from '@cancore/client/swap';            // just the exchange
import { bridge } from '@cancore/client/bridge';        // just the bridge
import { orderUpdates } from '@cancore/client/realtime'; // just the push feed
import { createHttp } from '@cancore/client';           // the seam, for a route this client lacks
```

Full documentation: <https://docs.cancore.io/sdk/client>

## License

Apache-2.0.
