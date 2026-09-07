# `@cancore/mcp`

An MCP server that lets an AI agent ask a Cancore wallet owner for a trade.

The agent queues a request. The owner reviews it in their own wallet and signs it with
their own key. **No key, token or prepared transaction ever reaches the agent** — the API
this server speaks does not offer one. The worst a prompt-injected agent achieves here is a
request the owner declines.

## Install

```bash
npx @cancore/mcp
```

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

| Variable | Meaning |
| --- | --- |
| `CANCORE_API_URL` | the Cancore gateway the agent talks to |
| `CANCORE_APP_URL` | where the wallet is served — the consent page lives there |
| `CANCORE_APP_NAME` | how the server introduces itself on the consent page (default `Cancore MCP`) |
| `CANCORE_GRANT_FILE` | where the approved grant is stored (default `~/.config/cancore-mcp/grants.json`) |

Both URLs have to be set explicitly. They are not derived from one another: on one stand
that derivation is right and on another it is wrong, and a consent page on the wrong stand
is the kind of mistake you only notice by what it does there.

## First run

1. The agent calls `cancore_connect_wallet`. Your browser opens the consent page and the
   tool answers with a short code.
2. **The page must show the same code.** If it does not, the request is not the one your
   agent started — decline it.
3. You approve. The server keeps a scoped grant (`agent:propose`, `agent:read`); the token
   is written to the grant file and never returned to the agent.

The grant is stored per stand, so a dev grant cannot be carried to mainnet by accident. You
can revoke it in the wallet at any time.

## Tools

| Tool | What it does |
| --- | --- |
| `cancore_connect_wallet` | asks the owner for a scoped grant, and waits a bounded while |
| `cancore_propose_autotrade` | queues a pool trade — name the pair by token symbol, never a rate |
| `cancore_propose_order` | queues a cross-chain swap offer for the owner's create-order form |
| `cancore_propose_transfer` | queues a transfer |
| `cancore_intent_status` | the outcome of one queued request: pending, executed or rejected |
| `cancore_list_intents` | what is still waiting for the owner |

An auto-trade carries no rate on purpose. A rate proposed now is a rate that no longer
exists when the owner answers, so the wallet prices the pair live at the moment of the
press and shows what the trade would actually buy.

## What this package is not

It does not sign, hold keys, or read balances. Amount caps and queue limits are enforced by
the server and deliberately not restated in the tool descriptions an agent reads: a
description is reachable by whoever writes the prompt, the server is not.

The grant file is `0600` and nothing more — no keyring, no encryption at rest. Anything
running as your user can read it, the same as the `~/.aws` and `~/.kube` files next to it.

## Using the pieces directly

```ts
import { AgentQueueClient, CancoreSession, createServer } from '@cancore/mcp';
```

`CancoreSession` is the whole surface without the transport; `AgentQueueClient` is the REST
client under it. Both are useful if you are embedding the tools in a server of your own.

Full documentation: <https://docs.cancore.io/sdk/mcp>
