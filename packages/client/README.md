# `@cancore/client`

A typed client for the Cancore API. Two entries: the exchange (`./swap`) and the USDCx
bridge (`./bridge`). **No keys.** Where a step needs a signature, the client hands you a hash
and takes the signature back — signing stays with `@cancore/wallet` or the dApp connector.

```bash
npm install @cancore/client
```

No runtime dependencies. The transport is `fetch`, and you inject the function that adds
your credential.

## Quick start

```ts
import { createClient } from '@cancore/client';

const cancore = createClient({
  baseUrl: 'https://api.cancore.io',
  // The client does not know how you authenticate — it asks you.
  request: (url, init) => fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }),
});

// A pool trade: a live price, then the trade at that price.
const quote = await cancore.swap.quote({ pairConfigId: 'cc-usdcx', sourceAmount: '5' });
const { orderId } = await cancore.swap.execute(quote.quoteToken);
const order = await cancore.swap.track(orderId);       // polls until a terminal status
```

`request` receives the absolute URL and the init the client built (method, JSON headers,
body). Return a `Response`. A user JWT, an app-session grant, a device-flow token — the client
does not care which.

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
| `quote({ pairConfigId, sourceAmount })` | `POST /auto-trader/quote` | a live pool price, good for `expiresInSec` |
| `execute(quoteToken)` | `POST /auto-trader/execute` | trade at that price; returns the order the pool opened for you |
| `track(id, options?)` | polls `GET /orders/{id}` | until `completed`, `cancelled`, `refunded` or `delivery_failed` |

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
import { swap } from '@cancore/client/swap';      // just the exchange
import { bridge } from '@cancore/client/bridge';  // just the bridge
import { createHttp } from '@cancore/client';     // the seam, for a route this client lacks
```

Full documentation: <https://docs.cancore.io/sdk/client>

## License

Apache-2.0.
