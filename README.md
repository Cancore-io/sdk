# Cancore SDK

The packages a third-party dApp, an AI agent, or a wallet build installs from npm.

| Package | npm | What it is |
| --- | --- | --- |
| [`@cancore/dapp-connector`](packages/dapp-connector) | [`@cancore/dapp-connector`](https://www.npmjs.com/package/@cancore/dapp-connector) | A CIP-0103 provider (remote profile) that asks a Cancore wallet to sign. No keys, ever. |
| [`@cancore/mcp`](packages/mcp) | [`@cancore/mcp`](https://www.npmjs.com/package/@cancore/mcp) | An MCP server that lets an AI agent ask a wallet owner for a trade. The agent queues a request; the owner signs it in their own wallet. |
| [`@cancore/client`](packages/client) | *not published yet* | A typed client for the API: orders and pool trades (`./swap`), the USDCx bridge (`./bridge`). Hands out hashes to sign, never holds a key. |
| [`@cancore/wallet`](packages/wallet) | [`@cancore/wallet`](https://www.npmjs.com/package/@cancore/wallet) | The wallet core: key material, signing, storage contracts, the operations-envelope client. |

**Full documentation: <https://docs.cancore.io/sdk/overview>.**

The four answer four different questions. A dApp that wants a signature from
somebody else's wallet takes the **connector**. An agent that wants to propose a
trade its owner will approve takes **mcp**. A program that trades or bridges
through the API under its own credential takes **client**. A build that owns the
keys itself — a wallet, a CLI, a signer — takes **wallet**.

## Why one of them is not on npm yet

`@cancore/client` holds nothing and is gated only by never having had a first
release — see the note at the end about what that costs.

## What none of them can do

None of these packages signs anything on its own behalf. The connector asks a
wallet; the MCP server queues a request and returns its id; the client hands out
a hash and takes a signature back; the wallet core signs only with a key the
person unlocked. There is no code path here that
moves funds without a human at a keyboard, and that asymmetry is the design
rather than an omission.

## Working in this repository

```bash
npm install          # npm workspaces, Node >= 20
npm test             # jest: plain node, plus jsdom for the wallet's ./web entry
npm run typecheck    # tsc, strict; each package also has its own tsconfig
npm run build        # tsup: ESM + .d.ts per package
```

Two details worth knowing before a first change:

- **The node test project has no setup file, on purpose.** It is what proves the
  wallet core and the connector are runtime-agnostic. The moment one of them
  needs a browser shim to pass, the extraction has failed. Only
  `packages/wallet/src/web` — IndexedDB and WebAuthn — runs under jsdom.
- **Node types live in `packages/mcp/tsconfig.json`, not in the root config.**
  The MCP server is the only package that runs on a machine; handing `node` to
  every package would let a browser package reach for `fs` and still typecheck.

ESM only, everywhere. The connector's whole transport is `fetch`, `EventSource`
and `postMessage`, and the wallet core is WebCrypto — a runtime old enough to
need CommonJS has none of them, so a CJS build would be a build nobody can use
pretending otherwise.

## Releasing

A package is published by pushing a tag, never by hand:

```bash
git tag dapp-connector-v0.1.1 && git push origin dapp-connector-v0.1.1
```

The prefix is the **directory** under `packages/`, not the npm name: `mcp-v0.1.0`
publishes `@cancore/mcp`. The workflow also refuses a tag whose version does not
match the manifest, because otherwise the version on npm is not the version the
tag claims and nobody can tell afterwards.

The `publish` workflow builds from that tag, runs the tests it publishes
against, and publishes through **npm trusted publishing**: GitHub Actions mints
an OIDC token, npm exchanges it for a short-lived publish right, and attaches
provenance by itself. There is no npm token in this repository — nothing to
leak, rotate, or answer a 2FA prompt for.

Each package's trusted publisher is configured once on npmjs.com against this
repository and the `publish.yml` workflow filename.

### The exception: a package's very first version

Trusted publishing cannot make the first release of a NEW package — the
publisher is configured in the package's settings, and until something is
published there is no package to configure. So version one goes out by hand:

```bash
npm run release:connector -- --otp=<code>
npm run release:mcp -- --otp=<code>
npm run release:wallet -- --otp=<code>
npm run release:client -- --otp=<code>
```

From the repository root, and note the package name in each. `npm publish` at
the root publishes the ROOT — which is `private: true` and refuses, after
printing a tarball listing of the whole repository that looks alarming and is
not what would have been sent. Naming the workspace is what makes the command
mean what it reads like.

`npm pack` runs each package's `prepack` build with `--silent`, because
`npm pack --silent` prints the tarball name to stdout and callers capture it —
a chatty build ends up inside the filename.

## License

Apache-2.0. See [LICENSE](LICENSE).
