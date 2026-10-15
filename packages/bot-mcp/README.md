# `@cancore/bot-mcp`

```sh
npm install @cancore/bot-mcp
```

A stdio MCP server that lets an AI agent drive a local `cancore-botd` within the owner's limits. It is a thin client of the daemon's unix socket: no key, no signer, no strategy engine in this package.

It can read state, reduce risk and trade within limits. It has no tool to withdraw, send, export a key, change limits, unlock or resume: those are owner-only and live in the `cancore-bot` CLI.

## Tools

| Tool | Risk class | Effect |
|---|---|---|
| `trade_status` | read | daemon state: locked, paused, running strategies, version |
| `trade_balances` | read | balances per instrument: amount and locked |
| `trade_orders_list` | read | the bot's orders, filtered by status (default open) |
| `trade_limits_get` | read | the limits the owner set, read-only |
| `trade_audit_tail` | read | the last n audit-log entries |
| `trade_order_cancel` | reduce | cancels one open order |
| `trade_orders_cancelAll` | reduce | cancels every open order |
| `trade_pause` | reduce | pauses trading; only the owner can resume |
| `trade_strategy_stop` | reduce | stops a running strategy |
| `trade_order_make` | trade | places a limit order (maker) |
| `trade_order_take` | trade | fills an existing order (taker) |
| `trade_strategy_start` | trade | starts a grid or dca strategy |
| `trade_tools` | read | this table, for the agent |

Limits are enforced by the daemon. A refusal comes back as structured content `{ "denied": "<reason>" }`; a locked or paused daemon answers with an instruction for the owner. Results carry whitelisted fields only — memos, metadata and other counterparty text are dropped before the model sees them.

## Setup

The socket defaults to `/run/cancore-bot/bot.sock`; override with `--socket <path>` or `CANCORE_BOT_SOCKET`. The user running the agent must be in the `cancore-bot-clients` group.

Claude Code:

```sh
claude mcp add cancore-bot -- npx @cancore/bot-mcp
# custom socket
claude mcp add cancore-bot -- npx @cancore/bot-mcp --socket /path/to/bot.sock
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.cancore-bot]
command = "npx"
args = ["@cancore/bot-mcp"]
env = { CANCORE_BOT_SOCKET = "/run/cancore-bot/bot.sock" }
```

## Library

```ts
import { AGENT_METHODS, createServer, inventory } from '@cancore/bot-mcp';
```
