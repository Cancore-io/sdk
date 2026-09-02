# `@cancore/dapp-connector`

What a third-party dApp loads to reach a Cancore wallet: a CIP-0103 provider (remote profile)
over Cancore's JSON-RPC + SSE surface, the consent ceremony that obtains a grant, and a
PartyLayer discovery adapter around both. No dependencies. **No keys are ever here.**

```ts
import { CancoreProvider } from '@cancore/dapp-connector';

const provider = new CancoreProvider({
  host: 'https://app-dev.cancore.app',
  appName: 'My dApp',
  scopes: ['wallet:accounts', 'wallet:sign'],
});

await provider.request({ method: 'connect' });
const accounts = await provider.request({ method: 'listAccounts' });
```

**Full documentation: <https://docs.cancore.io/sdk/dapp-connector>** — the ceremony and the
three rules it owes, all thirteen methods with their scopes, the event stream and why the two
vendor outcome lookups exist, the error codes, and what a dApp cannot do here.

Source of that page: `docs/docs/sdk/dapp-connector.md` in this repo.
