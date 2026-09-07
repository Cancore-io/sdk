# `@cancore/dapp-connector`

What a third-party dApp loads to reach a **Cancore wallet**: a
[CIP-0103](https://github.com/global-synchronizer-foundation/cips) provider (remote profile)
over Cancore's JSON-RPC + SSE surface, the consent ceremony that obtains a grant, and a
PartyLayer discovery adapter around both.

```bash
npm install @cancore/dapp-connector
```

**No dependencies.** The transport is `fetch`, `EventSource` and `postMessage`.
**No keys, ever** — a request becomes a row the wallet owner answers on their own device, and
what comes back is the outcome, never the material.

## Quick start

```ts
import { CancoreProvider } from '@cancore/dapp-connector';

const provider = new CancoreProvider({
  host: 'https://app.cancore.io',      // the wallet's origin
  appName: 'My dApp',                  // shown on the consent screen
  scopes: ['wallet:accounts', 'wallet:sign'],
});

await provider.request({ method: 'connect' });          // opens the consent popup
const accounts = await provider.request({ method: 'listAccounts' });

// Asking for a signature returns a place the person goes — never a signature.
const { messageId, userUrl } = await provider.request({
  method: 'signMessage',
  params: { message: 'Sign in to My dApp\nNonce: 7f3a…' },
});

provider.on('messageSignature', ({ messageId, signature }) => { /* … */ });
```

## Options

| Option | Meaning |
| --- | --- |
| `host` | wallet origin, e.g. `https://app.cancore.io` — the only required option |
| `appName` | name shown on the consent screen; display only, the wallet trusts your origin, not this string |
| `scopes` | defaults to the read-only pair; add `wallet:sign` to ask for signatures |
| `session` | a grant you already hold — skips the ceremony entirely |
| `win`, `fetchImpl`, `openStream`, `schedule` | seams for tests and non-browser hosts |

`connect` must be called **inside the user's click**: the ceremony opens a popup, and a
browser blocks a `window.open` that is not synchronous with the gesture. The provider is
written so everything up to the open is synchronous.

## The grant

```ts
const session = provider.session;   // { token, rpcUrl, scopes, expiresAt } — or use runConnectCeremony
localStorage.setItem('cancore-session', JSON.stringify(session));
```

Pass it back as `session` next time and the popup never appears. The token is bound to your
origin by the backend, and `rpcUrl` is told to you by the wallet rather than hardcoded — a
stand can move its RPC endpoint without your build changing.

The owner can revoke a grant from their wallet at any moment; every later call then fails with
`4900`.

`runConnectCeremony({ host, appName, scopes, win })` runs only the ceremony, if you want to
obtain a grant without constructing a provider.

## Methods

Each is behind the scope it needs — `wallet:connect`, `wallet:accounts`, `wallet:sign`.

| Method | Scope | Returns |
| --- | --- | --- |
| `status` | — | wallet status |
| `connect` | `wallet:connect` | the grant; opens the consent popup unless one was supplied |
| `isConnected` | — | whether the grant is still usable |
| `disconnect` | — | drops the grant |
| `getActiveNetwork` | — | the network the wallet is on |
| `listAccounts` | `wallet:accounts` | the owner's accounts |
| `getPrimaryAccount` | `wallet:accounts` | the account the owner treats as primary |
| `signMessage` | `wallet:sign` | `{ messageId, userUrl }` — a place the person goes |
| `prepareExecute` | `wallet:sign` | `{ commandId, userUrl }` — same shape, for a transaction |
| `cancore_getMessageSignature` | `wallet:sign` | the signature for a `messageId`, once it exists |
| `cancore_getTxOutcome` | `wallet:sign` | the outcome for a `commandId`, once it exists |
| `cancore_streamTicket` | — | one-shot ticket the event stream authenticates with |

### Asking for a signature

`signMessage` and `prepareExecute` do not return a signature. They return an id and a
`userUrl`, because in the remote profile the person is somewhere else — another tab, another
device — and a signature exists only after they have looked at what they are signing. Show the
URL, then wait for the event or poll the outcome lookup.

Two methods are **answered `4200 Unsupported Method` by the wallet, on purpose**:
`ledgerApi`, because the CIP forbids a server-side provider from proxying ledger reads (and
handing out an access token is worse), and `prepareExecuteAndWait`, because it may only answer
once the transaction completes — which here waits on a human, so the wait could only ever time
out. Use `prepareExecute` plus `txChanged`.

They are listed as known methods so that the refusal is what you receive. `-32601` from this
library would say the method does not exist, which is a different sentence: the name is right,
the provider is not obliged.

## Events

```ts
provider.on('txChanged', (payload) => { /* … */ });
```

| Event | Fires when |
| --- | --- |
| `connected` | the stream is live |
| `statusChanged` | the wallet's status changed |
| `accountsChanged` | the owner's account list changed |
| `txChanged` | a transaction you prepared moved — including to its final state |
| `messageSignature` | a message you asked about was signed |

The stream is SSE, authenticated by a one-shot ticket, and reopened with a fresh ticket when
the connection drops (3 s between attempts — the stream has no replay buffer, and a reconnect
storm would only make that worse).

**Because there is no replay buffer**, a dropped mobile connection must not leave a dApp
unable to learn whether the user's money moved. That is what `cancore_getTxOutcome` and
`cancore_getMessageSignature` are for: ask again, at any time, and get the same answer.

## Errors

Every rejection carries a numeric `code` at the **top level**, as EIP-1193 and CIP-0103
promise. This is the reason the package exists rather than reusing the upstream async
provider, whose transport throws the whole JSON-RPC envelope instead — code first, so
`err.code === 4001` works.

| Code | Constant | Means |
| --- | --- | --- |
| `4001` | `USER_REJECTED` | the person said no |
| `4100` | `UNAUTHORIZED` | the grant does not carry the scope this method needs |
| `4200` | `UNSUPPORTED_METHOD` | a real method this provider is not obliged to serve |
| `4900` | `DISCONNECTED` | no usable grant — revoked, expired, or never obtained |
| `4901` | `CHAIN_DISCONNECTED` | the wallet is not connected to its network |
| `-32700 … -32603` | `PARSE_ERROR`, `INVALID_REQUEST`, `METHOD_NOT_FOUND`, `INVALID_PARAMS`, `INTERNAL` | JSON-RPC |
| `-32000 … -32005` | `INVALID_INPUT`, `RESOURCE_NOT_FOUND`, `RESOURCE_UNAVAILABLE`, `TRANSACTION_REJECTED`, `METHOD_NOT_SUPPORTED`, `LIMIT_EXCEEDED` | CIP-0103 application range |

`RpcCode` exports all sixteen; `rpcError(code, message, data?)` builds one in the same shape,
for tests and for wrapping.

## PartyLayer adapter

```ts
import { cancoreAdapterFactory } from '@cancore/dapp-connector';

const adapter = cancoreAdapterFactory({ appName: 'My dApp' }).create('https://app.cancore.io');
if (await adapter.detect()) {
  const provider = adapter.provider();
}
```

`getInfo()` returns the registry entry's shape (id, name, `type: 'remote'`, description, icon,
url), `detect()` asks whether that host really is a Cancore wallet, and `teardown()` closes
the stream. Nothing about a Cancore URL is hardcoded in your app.

## What it deliberately cannot do

Read a balance or query the ledger; obtain a key, a seed or an access token; or reach any
Cancore route the grant's scopes do not name. A prompt-injected dApp gets the same answer a
careless one does.

## Full documentation

**<https://docs.cancore.io/sdk/dapp-connector>** — the consent ceremony and the three rules it
owes, every method with its scope, the event stream, the error codes, and the PartyLayer
adapter.

## License

Apache-2.0.
