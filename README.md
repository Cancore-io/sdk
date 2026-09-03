# Cancore SDK

The packages a third-party dApp — or a wallet build — installs from npm.

| Package | npm | What it is |
| --- | --- | --- |
| [`@cancore/dapp-connector`](packages/dapp-connector) | [`@cancore/dapp-connector`](https://www.npmjs.com/package/@cancore/dapp-connector) | A CIP-0103 provider (remote profile) that asks a Cancore wallet to sign. No keys, ever. |
| `@cancore/wallet` | *not published yet* | The wallet core: key material, signing, storage contracts, the operations-envelope client. |

**Full documentation: <https://docs.cancore.io/sdk/overview>.**

## Why `@cancore/wallet` is not here yet

It holds key material, and the key-storage-at-rest audit that gates its
publication has not been done. Publishing a wallet core before that audit would
mean other people's funds sitting behind a storage format nobody reviewed.

It lives in the Cancore frontend repository until then, and moves here — same
history, same treatment — when the audit clears. The connector never held a key,
so nothing gated it.

## Working in this repository

```bash
npm install          # npm workspaces, Node >= 20
npm test             # jest, plain node — no jsdom anywhere
npm run typecheck    # tsc --build, strict, noUncheckedIndexedAccess on
npm run build        # tsup: ESM + .d.ts per package
```

ESM only. The connector's whole transport is `fetch`, `EventSource` and
`postMessage`; a runtime old enough to need CommonJS does not have them, so a CJS
build would be a build nobody can use pretending otherwise.

## Releasing

A package is published by pushing a tag, never by hand:

```bash
git tag dapp-connector-v0.1.1 && git push origin dapp-connector-v0.1.1
```

The `publish` workflow builds from that tag, runs the tests it publishes
against, and publishes with npm provenance — so the tarball on npm is traceable
to the commit and the workflow that produced it.

## License

Apache-2.0. See [LICENSE](LICENSE).
