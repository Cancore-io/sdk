# Cancore SDK

The packages a third-party dApp, an AI agent, or a wallet build installs from npm. Three are not on
npm yet (`@cancore/trader`, `@cancore/botd`, `@cancore/bot-mcp`): those install from this
repository.

| Package | npm | What it is |
| --- | --- | --- |
| [`@cancore/dapp-connector`](packages/dapp-connector) | [`@cancore/dapp-connector`](https://www.npmjs.com/package/@cancore/dapp-connector) | A CIP-0103 provider (remote profile) that asks a Cancore wallet to sign. No keys, ever. |
| [`@cancore/mcp`](packages/mcp) | [`@cancore/mcp`](https://www.npmjs.com/package/@cancore/mcp) | An MCP server that lets an AI agent ask a wallet owner for a trade. The agent queues a request; the owner signs it in their own wallet. |
| [`@cancore/contracts`](packages/contracts) | [`@cancore/contracts`](https://www.npmjs.com/package/@cancore/contracts) | The EVM contracts as data: ABIs, custom-error selectors, deployments per environment, the EIP-712 voucher, the network registry. No runtime code. |
| [`@cancore/client`](packages/client) | [`@cancore/client`](https://www.npmjs.com/package/@cancore/client) | A typed client for the API: orders and pool trades (`./swap`), the USDCx bridge (`./bridge`), live order updates over the gateway's socket (`./realtime`), scoped trading grants by device flow (`./auth`). Hands out hashes to sign, never holds a key. |
| [`@cancore/wallet`](packages/wallet) | [`@cancore/wallet`](https://www.npmjs.com/package/@cancore/wallet) | The wallet core: key material, signing, storage contracts, the operations-envelope client. |
| [`@cancore/trader`](packages/trader) | not on npm yet | Programmatic trading. `./filler`: filler protocol v1 for a filler node over injected signers, RPC, ledger and store. Holds no keys and no state of its own. Skeleton; not published yet. |
| [`@cancore/botd`](packages/botd) | not on npm yet | A self-custody trading daemon (Linux, systemd): holds one bot account's key in an encrypted keystore, trades behind owner-set default-deny limits, keeps a hash-chained audit log. Release candidate. |
| [`@cancore/bot-mcp`](packages/bot-mcp) | not on npm yet | An MCP server that lets an AI agent drive a local `cancore-botd` within those limits. No key, no withdraw, no limit changes. Release candidate. |

**Agent skills** live in [`skills/`](skills): [`cancore-trading`](skills/cancore-trading/SKILL.md)
teaches an agent to trade through `@cancore/bot-mcp`.

**Full documentation: <https://docs.cancore.io/sdk/overview>.**

**Partners** running a trading bot or market maker on Canton with their own key: start with the
[partner guide](docs/partner-guide.md).

**Your own bot**, on a bot account made in the Cancore wallet ("My bots") or from a program of
your own with `owner.bots.create` ([`@cancore/client`](packages/client) 0.13.0):
[Run a bot](docs/run-a-bot.md) goes from the key the wallet shows to the first trade.

The five answer five different questions. A dApp that wants a signature from
somebody else's wallet takes the **connector**. An agent that wants to propose a
trade its owner will approve takes **mcp**. A program that trades or bridges
through the API takes **client**. It runs on a user's own session token (the JWT
that user gets at sign-in) or on a grant that user approved for it. A grant
carries scopes and, to trade, limits; trading scopes work where the API enables
them, and no grant opens the bridge. Anything that talks
to the contracts directly — decoding an event, verifying a deployment, signing a
voucher — takes **contracts**, which is data rather than code. A build that owns
the keys itself — a wallet, a CLI, a signer — takes **wallet**.

## What none of them can do

None of these packages signs anything on its own behalf. The connector asks a
wallet; the MCP server queues a request and returns its id; the client hands out
a hash and takes a signature back; the wallet core signs only with a key the
person unlocked. There is no code path here that moves funds a person has not
approved. The approval is either one trade at a time, or a trading grant whose
scopes and limits they read on the consent page and can revoke. That asymmetry
is the design rather than an omission.

The exception is **botd**, by design: it holds a bot account's key and signs that account's
trades without asking each time. The owner chooses that for one bot wallet with its own small
balance, sets the limits it signs within, and alone can unlock, resume, change limits or withdraw
(to the owner's own party only). bot-mcp gives an agent none of those.

## Agentic trading: botd and bot-mcp

An AI agent trades a self-custody bot wallet without ever seeing its key. The key lives in a local
daemon, `cancore-botd`, under its own OS user. The agent sends commands through an MCP server,
`cancore-bot-mcp`; the daemon checks each one against the owner's limits and writes it to a
hash-chained audit log. The owner does everything else with a CLI, `cancore-bot`.

```
AI agent --MCP, stdio--> cancore-bot-mcp --bot.sock---------+
                                                            v
                                                      cancore-botd --HTTPS--> Cancore API
                                                            ^   key, limits, audit log
you --sudo -u cancore-bot--> cancore-bot --owner.sock-------+
```

| Action | Agent (`bot.sock`, through bot-mcp) | Owner (`owner.sock`, through `cancore-bot`) |
| --- | --- | --- |
| Read status, balances, orders, limits, the audit tail, a quote | yes | status, limits and the audit log; no CLI command for balances, orders or a quote |
| Cancel orders, stop a strategy, pause | yes | `pause` (it stops every strategy and, while the daemon is unlocked, cancels the resting orders) |
| Place or take an order, start a strategy | yes, inside the limits | no CLI command |
| Resume, change limits, unlock, lock, register, release a booked take | no | yes |
| Withdraw | no | yes, only to `ownerParty` from the config |
| Get the key or the recovery phrase | no | no: no such method exists |

**Status:** release candidates (`0.1.0-rc.0`), not on npm yet, so install from source. v1 runs on
devnet, testnet and mainnet, on the network of its `baseUrl` (devnet unless the config names
another host; what settles where: [Networks](packages/botd/README.md#networks)), on Linux with
systemd; the agent must run on the same machine as the daemon, as a user of its own without sudo
rights. v1 cannot create a Canton party for a new key, so the bot needs one before the daemon
gets its key: a bot made in the Cancore wallet (Settings → My bots) gets it from the wallet; a bot
made from a program with `owner.bots.create`
([Run a bot](docs/run-a-bot.md#or-make-the-bot-from-a-program)) gets it from its first `onboard()`
with `@cancore/client`, run once before the import.

**Quick start:** make the bot in My bots or from a program
([Install](packages/botd/README.md#install), step 4),
[install from source](packages/botd/README.md#install-from-source-until-it-is-on-npm), follow the
daemon's [Install](packages/botd/README.md#install) steps, then
[connect the agent](packages/bot-mcp/README.md#setup-from-source) and
[give it the skill](packages/bot-mcp/README.md#give-the-agent-the-skill):
[`cancore-trading`](skills/cancore-trading/SKILL.md) teaches it the hard rules (no secrets, no
owner actions), what to check before an order, and what each refusal means.

**Documentation:** <https://docs.cancore.io/sdk/botd> and <https://docs.cancore.io/sdk/bot-mcp>.

## Working in this repository

```bash
pnpm install         # pnpm workspace (pnpm-workspace.yaml), Node >= 26
pnpm test            # jest: plain node, plus jsdom for the wallet's ./web entry
pnpm run typecheck   # tsc, strict; each package also has its own tsconfig
pnpm run build       # tsup: ESM + .d.ts per package
```

pnpm is the version `packageManager` in `package.json` names (12.15.0); without one,
`npm install -g pnpm@12.15.0`. Sibling packages depend on each other through
`workspace:` ranges, which link the local copy; `pnpm pack` and `pnpm publish`
write the plain range into the tarball, so consumers keep installing with npm.

Two details worth knowing before a first change:

- **The node test project has no setup file, on purpose.** It is what proves the
  wallet core and the connector are runtime-agnostic. The moment one of them
  needs a browser shim to pass, the extraction has failed. Only
  `packages/wallet/src/web` — IndexedDB and WebAuthn — runs under jsdom.
- **Node types live in the tsconfig of a package that runs on a machine
  (`packages/mcp`, `packages/trader`), not in the root config.** Handing `node`
  to every package would let a browser package reach for `fs` and still
  typecheck. `@cancore/trader`'s published declarations need neither Node nor
  DOM types; CI checks that from the tarball.

ESM only, everywhere. The connector's whole transport is `fetch`, `EventSource`
and `postMessage`, and the wallet core is WebCrypto — a runtime old enough to
need CommonJS has none of them, so a CJS build would be a build nobody can use
pretending otherwise.

## Running CI on your personal runner (CAN-2942)

`ci.yml` runs on GitHub-hosted `ubuntu-latest` (this repository is public, so fork PRs never reach a self-hosted runner). A manual run can go to your own runner from gitops `tools/personal-runner` instead.

**Not working yet:** personal mode does nothing until this repository is added to the `personal-runners` runner group; that group is private-only and enrolling a public repository is an open operator decision (CAN-2942). Until then a `runner=personal` run queues with no runner to take it. Once enrolled:

```bash
gh workflow run ci.yml -R Cancore-io/sdk --ref <branch> -f runner=personal
```

PR and push runs always stay on `ubuntu-latest`; only a manual run with `runner=personal` goes to the runner of whoever dispatched it (`github.triggering_actor`), and dispatching needs write access. Setup, limits and troubleshooting: [personal runner guide](https://github.com/Cancore-io/gitops/blob/dev/tools/personal-runner/README.md).

## Making a change

Read [CONTRIBUTING.md](CONTRIBUTING.md) before the first PR. In short: comments
only for a why the code cannot carry (the why of a change goes into the
Linear ticket, the PR and the commit; `CAN-2777`),
names that say what the code does, `>= 90%` line coverage (`pnpm run coverage:check`),
local + `nx`/blast-radius mutation testing with 0 surviving mutants, `<= 500` LOC
per file (`< 300` LOC target; `pnpm run loc:check`), cognitive complexity `<= 12`
(`pnpm run complexity:check`), zero explicit `any` (`pnpm run any:check`),
discriminated-union ADTs with `assertNever`, a run on the local stand from
[Cancore-io/meta](https://github.com/Cancore-io/meta), its RTM row, a Qase run,
and the PR quality-gate checklist in [`.github/pull_request_template.md`](.github/pull_request_template.md).

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
against, and publishes with `pnpm publish` through **npm trusted publishing**:
GitHub Actions mints an OIDC token, npm exchanges it for a short-lived publish
right, and pnpm attaches provenance by itself. There is no npm token in this
repository — nothing to leak, rotate, or answer a 2FA prompt for.

Each package's trusted publisher is configured once on npmjs.com against this
repository and the `publish.yml` workflow filename.

### The exception: a package's very first version

Trusted publishing cannot make the first release of a NEW package — the
publisher is configured in the package's settings, and until something is
published there is no package to configure. So version one goes out by hand
(five packages here have had theirs):

```bash
pnpm run release:connector --otp=<code>
pnpm run release:mcp --otp=<code>
pnpm run release:wallet --otp=<code>
pnpm run release:client --otp=<code>
pnpm run release:contracts --otp=<code>
```

From the repository root, and note the package name in each. `pnpm publish` at
the root publishes the ROOT — which is `private: true` and refuses. Filtering on
the package is what makes the command mean what it reads like. `pnpm publish`
also refuses to run off `main` or from a dirty tree.

A prerelease (`0.2.0-rc.1`) by hand goes out with `--tag next`:
`pnpm run release:contracts --tag next --otp=<code>`, so that `latest` never
points at a release candidate.

`pnpm pack` runs each package's `prepack` build with `--silent`, so a pack
prints only its own output, never the build's.

## License

Apache-2.0. See [LICENSE](LICENSE).
