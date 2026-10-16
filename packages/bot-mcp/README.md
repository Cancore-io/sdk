# `@cancore/bot-mcp`

```sh
npm install @cancore/bot-mcp
```

A stdio MCP server that lets an AI agent drive a local `cancore-botd` within the owner's limits. It is a thin client of the daemon's unix socket: no key, no signer, no strategy engine in this package.

It can read state, reduce risk and trade within limits. It has no tool to withdraw, send, export a key, change limits, unlock, lock or resume. `withdraw` exists, but only as an owner method on the daemon's owner socket, to the owner party pinned in the daemon's config, through the `cancore-bot` CLI; the agent socket refuses every owner method (`FORBIDDEN`). No key export exists anywhere.

Install and secure the daemon first: [`@cancore/botd`](../botd). For agents, the [`cancore-trading` skill](../../skills/cancore-trading/SKILL.md) explains how to use these tools.

## Tools

| Tool | Risk class | Effect |
|---|---|---|
| `trade_status` | read | daemon state: locked, paused, the bot's party, strategies (with slots cancelled by hand), version |
| `trade_balances` | read | balances per instrument |
| `trade_quote` | read | a live pool price for an amount of base; nothing is traded |
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

Limits are enforced by the daemon. Errors come back as structured content with `isError`:

| Reply | Meaning |
|---|---|
| `{ "denied": "<reason>" }` | the risk gate refused; `reason` is one of `DENY_REASONS` in `@cancore/botd/protocol` |
| `{ "error": "locked", "instruction": … }` | the keystore is locked; the owner runs `cancore-bot unlock` |
| `{ "error": "paused", "instruction": … }` | trading is paused; the owner runs `cancore-bot resume` |
| `{ "error": "forbidden" }` | the method is not allowed on this socket |
| `{ "error": "invalid_params", "issues": [...] }` | arguments failed the strict schema before reaching the socket |
| `{ "error": "socket_unavailable", "instruction": … }` | no daemon at the socket, or this user is not in `cancore-bot-clients` |
| `{ "error": "daemon_error", "code": n }` | anything else (for example the not-yet-implemented grid/dca loops) |
 Results carry whitelisted fields only — memos, metadata and other counterparty text are dropped before the model sees them.

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
