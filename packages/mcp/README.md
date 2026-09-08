# `@cancore/mcp`

An MCP server that lets an AI agent ask a Cancore wallet owner for a trade.

The agent queues a request. The owner reviews it in their own wallet and signs it with their
own key. **No key, token or prepared transaction ever reaches the agent** — the API this
server speaks does not offer one. The worst a prompt-injected agent achieves here is a request
the owner declines.

```bash
npx @cancore/mcp
```

## Install

Claude Code:

```bash
claude mcp add cancore -- npx -y @cancore/mcp \
  -e CANCORE_API_URL=https://api.cancore.io \
  -e CANCORE_APP_URL=https://cancore.io
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cancore": {
      "command": "npx",
      "args": ["-y", "@cancore/mcp"],
      "env": {
        "CANCORE_API_URL": "https://api.cancore.io",
        "CANCORE_APP_URL": "https://cancore.io"
      }
    }
  }
}
```

Any MCP client works — the transport is stdio and the server writes nothing but protocol to
stdout.

| Variable | Meaning |
| --- | --- |
| `CANCORE_API_URL` | the Cancore gateway the agent talks to |
| `CANCORE_APP_URL` | where the wallet is served — the consent page lives there |
| `CANCORE_APP_NAME` | how the server introduces itself on the consent page (default `Cancore MCP`) |
| `CANCORE_GRANT_FILE` | where the approved grant is stored (default `~/.config/cancore-mcp/grants.json`) |

Both URLs have to be set explicitly. They are not derived from one another: on one stand that
derivation is right and on another it is wrong, and a consent page on the wrong stand is the
kind of mistake you only notice by what it does there.

## First run

1. The agent calls `cancore_connect_wallet`. Your browser opens the consent page and the tool
   answers with a short code.
2. **The page must show the same code.** If it does not, the request is not the one your agent
   started — decline it.
3. You approve. The server keeps a scoped grant (`agent:propose`, `agent:read`); the token is
   written to the grant file and never returned to the agent.

The call waits a bounded while — 45 seconds by default, 5 to 300 by argument — and then
answers `pending` rather than failing. The request stays live and the next call resumes it, so
the code already on your screen keeps working. Minting a second code would teach you that a
mismatched code is normal, which is the one thing the consent page relies on you noticing.

## Tools

### `cancore_connect_wallet`

| Argument | Type | Meaning |
| --- | --- | --- |
| `appName` | string, optional | how to introduce itself on the consent page |
| `waitSeconds` | number, optional | how long to wait in this call, 5–300 (default 45) |
| `force` | boolean, optional | ask again even if this stand is already authorized |

Answers `{ status: 'granted' | 'denied' | 'pending', … }`. A `pending` answer carries
`userCode`, `page`, whether the browser `opened`, and whether the request was `resumed`.

### `cancore_propose_autotrade`

Buying one token for another straight from the Cancore pool, with no counterparty to wait for.

| Argument | Type | Meaning |
| --- | --- | --- |
| `sourceTokenName` | string | token symbol being spent, e.g. `CC` |
| `targetTokenName` | string | token symbol being bought, e.g. `CBTC` |
| `sourceAmount` | string | decimal amount to spend |
| `agentLabel` | string, optional | how to identify yourself to the owner (display only) |

The pair is named by **token symbol** and carries **no rate**, and neither is an abbreviation.
An agent on a scoped grant cannot read the pair list at all, so a pair id would be a value it
could not have obtained honestly — and a rate proposed now is a rate that no longer exists
when the owner answers. The wallet resolves the pair and quotes it live at the press, and
shows the owner what the trade would actually buy.

### `cancore_propose_order`

A cross-chain swap offer, reviewed in the owner's own create-order form.

| Argument | Type |
| --- | --- |
| `sourceNetwork`, `sourceTokenAddress`, `sourceAmount` | string |
| `targetNetwork`, `targetTokenAddress`, `targetAmount` | string |
| `sourceTokenName`, `targetTokenName` | string, optional display names |
| `agentLabel` | string, optional |

### `cancore_propose_transfer`

| Argument | Type | Meaning |
| --- | --- | --- |
| `receiverPartyId` | string | Canton party id (`hint::namespace`) |
| `amount` | string | decimal amount |
| `tokenId` | string, optional | instrument to send; defaults to the wallet's CC |
| `description` | string, optional | memo shown to the owner and carried with the transfer |
| `agentLabel` | string, optional |

### `cancore_intent_status`

`{ intentId }` → the outcome: `pending` (waiting for the owner), `executed` (signed and
committed) or `rejected`. The outcome, never the transaction.

### `cancore_list_intents`

No arguments. What is still awaiting the owner's decision.

## The grant

Stored at `~/.config/cancore-mcp/grants.json`, mode `0600`, **keyed by API base URL** — a dev
grant cannot be carried to mainnet by accident, and a token that goes to the wrong stand is
only noticed by what it does there.

This is the same file, in the same format, that the Go server in `Cancore-io/mcp-server`
writes. An owner who switches between the two runtimes does not approve twice.

Two refusals are told apart on purpose:

- **401** — the grant is no longer accepted. The server drops it and the next call asks you to
  connect again.
- **403** — the grant is live, it just was not approved for this. The grant is kept; dropping
  it would make you re-approve something you already approved.

Everything else is passed through with the server's own message, because a cap or a queue
limit reads as guidance, not as a transport failure.

## What this package cannot do

It does not sign, hold keys, or read balances. Amount caps and queue limits are enforced by
the server and deliberately **not** restated in the tool descriptions an agent reads: a
description is reachable by whoever writes the prompt, the server is not.

The grant file is `0600` and nothing more — no keyring, no encryption at rest. Anything
running as your user can read it, the same as the `~/.aws` and `~/.kube` files next to it. The
grant is revocable from the wallet and expires on its own.

## One contract, two runtimes

`contract/agent-tools.contract.json` is the agent surface written down: every tool's name,
description, arguments and required set, as `tools/list` announces them. This package tests
its running server against the file, and the Go server in `Cancore-io/mcp-server` tests
against its copy of the same file — so the two implementations that share a grant file also
provably share a surface. Change a tool here, regenerate the file with
`UPDATE_CONTRACT=1 npx jest contract`, and the Go side goes red until it follows.

## Using the pieces directly

```ts
import { CancoreSession, AgentQueueClient, createServer, registerAgentTools } from '@cancore/mcp';

const session = new CancoreSession(
  { apiBaseUrl, appBaseUrl, appName: 'My agent' },
  { fetchImpl, openBrowser },
);
registerAgentTools(myExistingMcpServer, session);
```

`CancoreSession` is the whole surface without the transport — six methods returning plain
JSON — and `AgentQueueClient` is the REST client under it, if you are talking to the queue
from something that is not an MCP server at all. `startAuthorization` / `awaitGrant` and
`loadGrant` / `saveGrant` / `forgetGrant` are exported for the same reason.

## Troubleshooting

**"this server has no access to the wallet yet"** — no grant for this `CANCORE_API_URL`. Run
`cancore_connect_wallet`.

**The consent page shows a different code** — decline it. Some other request is in flight.

**Nothing opens** — the browser launch is best effort by design (this server also runs
headless and over SSH). The tool always returns the URL; open it by hand.

**The client drops the connection at startup** — something wrote to stdout. Only the protocol
belongs there; this server puts its own warnings on stderr.

## Full documentation

**<https://docs.cancore.io/sdk/mcp>**

## License

Apache-2.0.
