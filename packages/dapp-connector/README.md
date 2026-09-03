# `@cancore/dapp-connector`

What a third-party dApp loads to reach a **Cancore wallet**: a
[CIP-0103](https://github.com/global-synchronizer-foundation/cips) provider
(remote profile) over Cancore's JSON-RPC + SSE surface, the consent ceremony that
obtains a grant, and a PartyLayer discovery adapter around both.

**No dependencies.** The transport is `fetch`, `EventSource` and `postMessage`.
**No keys, ever** — a request becomes a row the wallet owner answers on their own
device, and what comes back is the outcome, never the material.

```bash
npm install @cancore/dapp-connector
```

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
```

Keep the grant (`provider.session`, or the one `runConnectCeremony` resolves
with) and pass it back as `session` next time to skip the popup. The owner can
revoke it from their wallet at any moment, and every later call then fails with
`4900`.

## What you get

- **The CIP's ten methods plus three vendor extensions**, each behind the scope
  it needs — `wallet:connect`, `wallet:accounts`, `wallet:sign`.
- **Errors with a numeric `code` at the top level**, as EIP-1193 and CIP-0103
  promise: `4001` the person said no, `4900` no usable grant, `-32601` unknown
  method. This is the reason the package exists rather than reusing the upstream
  async provider, whose transport throws the whole JSON-RPC envelope instead.
- **An event stream** (`accountsChanged`, `txChanged`, `statusChanged`,
  `messageSignature`, `connected`) over SSE, authenticated by a one-shot ticket,
  reopened with a fresh one when the connection drops.
- **Outcome lookups** — `cancore_getTxOutcome`, `cancore_getMessageSignature` —
  because the stream has no replay buffer and a dropped mobile connection must
  not leave a dApp unable to learn whether the user's money moved.
- **A PartyLayer adapter**: `cancoreAdapterFactory()` → `create(host)`, so no
  Cancore URL is hardcoded in your app.

## What it deliberately cannot do

Read a balance or query the ledger (`ledgerApi` is answered `4200 Unsupported
Method` by the wallet, on purpose — a server-side provider must not proxy ledger
reads per the CIP); obtain a key, a seed or an access token; or reach any Cancore
route the grant's scopes do not name.

## Full documentation

**<https://docs.cancore.io/sdk/dapp-connector>** — the consent ceremony and the
three rules it owes, every method with its scope, the event stream, the error
codes, and the PartyLayer adapter.

## License

Apache-2.0.
