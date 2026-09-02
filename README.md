# `@cancore/dapp-connector`

What a third-party dApp loads to reach a Cancore wallet: a **CIP-0103 provider, remote
(asynchronous) profile**, over Cancore's JSON-RPC + SSE surface, plus the consent ceremony
that obtains a grant in the first place, plus a PartyLayer discovery adapter around both.

No dependencies — the transport is `fetch`, `EventSource` and `postMessage`. **No keys are
ever here.** A request becomes a row the wallet owner sees and answers on their own device.

```ts
import { CancoreProvider } from '@cancore/dapp-connector';

const provider = new CancoreProvider({
  host: 'https://app-dev.cancore.app',
  appName: 'My dApp',
  scopes: ['wallet:accounts', 'wallet:sign'],
});

await provider.request({ method: 'connect' });        // opens the consent popup
const accounts = await provider.request({ method: 'listAccounts' });
```

---

## 1. Why this exists next to the official provider

`@canton-network/core-provider-dapp` ships a `DappAsyncProvider` for this transport. Two
things stopped us shipping over it, both upstream's to fix:

- its `HttpTransport` throws the whole JSON-RPC envelope, so what a dApp catches has no
  numeric `code` at the top — the one thing EIP-1193 and CIP-0103 promise. Every error handler
  written against the standard misses;
- it adopts a session token from **any** `postMessage` carrying
  `SPLICE_WALLET_IDP_AUTH_SUCCESS` without reading `event.origin`, which lets any frame on the
  dApp's page repoint the provider at another wallet.

This package is a client, not a second wallet. The methods belong to the server
(`apps/trading/src/dapp-rpc`).

## 2. Options

```ts
interface CancoreProviderOptions {
  host: string;                 // wallet origin, e.g. https://app-dev.cancore.app
  appName?: string;             // shown on the consent screen (display only)
  scopes?: string[];            // default ['wallet:connect','wallet:accounts']; add 'wallet:sign' to sign
  session?: CancoreSession;     // a grant you already hold — skips the ceremony
  win?: WindowLike;             // seams for tests / non-browser hosts
  fetchImpl?: FetchLike;
  openStream?: (url: string) => StreamLike;
  schedule?: (run: () => void, ms: number) => void;
}
```

`CancoreSession` is `{token, rpcUrl, scopes, expiresAt}` — an opaque `cs_…` grant, the
absolute URL of `POST /dapp/rpc` **as the wallet itself reported it**, and the grant's limits.
Persist it and pass it back as `session` to skip the popup on the next visit; the wallet owner
can revoke it at any time from their Sessions screen, and every call then fails with `4900`.

## 3. The consent ceremony

`connect` runs it, or call `runConnectCeremony({host, appName, scopes, win})` directly.

```
dApp                                     wallet (host origin)
  │  window.open(`${host}/connect`)  ──────────▶  consent page
  │  postMessage {cancore:connect-request} ──▶    (repeated every 400 ms)
  │                                              user reads app name + scopes, approves
  │  ◀── postMessage {cancore:connect-result, token, scopes, expiresAt, rpcUrl}
```

Three rules this side owes, each for a reason worth keeping:

1. **The popup opens synchronously**, before the first `await` in the caller's chain — a popup
   opened after an await is a popup the browser blocks.
2. **The handshake is posted repeatedly**, because the wallet never acknowledges it: the
   consent page may navigate away to a login and come back, and an ack-then-wait dApp would be
   waiting for a message nobody will resend.
3. **The answer is accepted only from the window we opened, and only when the browser stamped
   it with the wallet's origin.** That token is a bearer credential; a page that is merely
   `postMessage`-ing at you is not the wallet. Outbound messages name the wallet's origin
   explicitly — `'*'` would hand the handshake to whatever the popup navigated to.

Ceremony timeout: 5 minutes (what the official SDK waits for a remote `connect`).

## 4. Methods

CIP-0103's ten, plus three vendor extensions. Anything else is `-32601` locally, without a
round trip.

| Method | Scope | Notes |
| --- | --- | --- |
| `status` | `wallet:connect` | |
| `connect` | `wallet:connect` | runs the ceremony when there is no session |
| `isConnected` | `wallet:connect` | |
| `disconnect` | `wallet:connect` | |
| `getActiveNetwork` | `wallet:connect` | |
| `listAccounts` | `wallet:accounts` | |
| `getPrimaryAccount` | `wallet:accounts` | |
| `signMessage` | `wallet:sign` | message ≤ 4096 chars |
| `prepareExecute` | `wallet:sign` | |
| `ledgerApi` | — | answered **4200 Unsupported Method** by the wallet, on purpose |
| `cancore_streamTicket` | `wallet:connect` | one-shot 30 s ticket for the event stream |
| `cancore_getTxOutcome` | `wallet:sign` | outcome of a `prepareExecute`, by `commandId` |
| `cancore_getMessageSignature` | `wallet:sign` | outcome of a `signMessage`, by `messageId` |

`ledgerApi` is refused deliberately: a server-side provider must not proxy ledger reads per the
CIP, and handing out an access token would be worse. It stays in the known list so the refusal
carries the code the spec names.

`signMessage` and `prepareExecute` share one scope on purpose. A finer split would be a false
comfort: an EIP-4361-style message *is* a login credential for somebody else's site, which is
at least as dangerous as a swap the user is shown in full before signing.

### Asking for a signature

```ts
const { messageId, userUrl } = await provider.request({
  method: 'signMessage',
  params: { message: 'Sign in to My dApp\nNonce: 7f3a…' },
});
// userUrl → the wallet screen where the person reads and signs it
```

```ts
const result = await provider.request({
  method: 'prepareExecute',
  params: {
    commandId: 'my-correlation-id',        // optional; minted for you if absent
    commands: [ /* Daml commands */ ],
    actAs: ['alice::1220…'],
    readAs: [],
    disclosedContracts: [],
    synchronizerId: undefined,
    packageIdSelectionPreference: [],
  },
});
// → {userUrl}  (plus {commandId} only when the wallet minted it, so you can correlate)
```

Neither call returns a signature. Both return a **place the person goes**; the answer arrives
on the event stream, or from the outcome lookups below.

## 5. Events

The provider subscribes to `GET <rpcUrl>/events` over SSE, authenticated by a one-shot 30 s
ticket from `cancore_streamTicket` (`EventSource` cannot set headers, so what authenticates
the stream ends up in access logs and `Referer` — a short-lived ticket keeps that survivable).
A dropped stream is reopened with a **fresh** ticket, because the browser's own reconnect would
replay a spent one.

```ts
provider.on('accountsChanged', (accounts) => { /* … */ });
```

Emitted: `connected`, `statusChanged`, `accountsChanged`, `txChanged`, `messageSignature`.

**The stream has no replay buffer.** A dApp whose connection dropped between the request and
the user's confirmation cannot learn the outcome from the stream, and `status` has no field
for it — that is what the two vendor lookups are for:

```ts
await provider.request({ method: 'cancore_getTxOutcome',        params: { commandId } });
await provider.request({ method: 'cancore_getMessageSignature', params: { messageId } });
```

Treat them as the recovery path, not the polling loop: same scope as the request they report
on, and each discloses one outcome to the grant that asked for it.

## 6. Errors

```ts
const RpcCode = {
  METHOD_NOT_FOUND: -32601,
  TIMED_OUT:        -32002,
  INTERNAL:         -32603,
  USER_REJECTED:    4001,
  DISCONNECTED:     4900,
};
```

Every rejection is a `ProviderRpcError` — `{code, message, data?}` — with the numeric `code` at
the top, which is the whole point of this package existing (§1). `4001` is the person saying
no; `4900` is no usable grant (never granted, revoked, or expired) and means: run the ceremony
again. `rpcError(code, message)` builds one if you are wrapping this provider in your own.

## 7. PartyLayer adapter

```ts
import { cancoreAdapterFactory, CANCORE_PROVIDER_ID } from '@cancore/dapp-connector';

const factory = cancoreAdapterFactory({ appName: 'My dApp', scopes: ['wallet:sign'] });
const adapter = factory.create(hostFromRegistry);   // networkHosts[network]
adapter.getInfo(); adapter.detect(); adapter.provider(); adapter.teardown();
```

A factory rather than a constructed adapter, because the host is per network and upstream
adapters seal it at construction. PartyLayer resolves `networkHosts[network]` from the registry
entry and calls `create(host)` — so no Cancore URL is hardcoded in anybody's app.

## 8. What a dApp cannot do here

- Read a balance or query the ledger (`ledgerApi` is refused; there is no read scope in this
  transport).
- Obtain a key, a seed, or an access token.
- Reach any Cancore route its grant's scopes do not name — `SessionScopeGuard` is
  deny-by-default, and routes without `@RequiresScope` are closed to scoped grants entirely.
- Keep a grant the owner revoked: revocation is immediate and every later call is `4900`.
