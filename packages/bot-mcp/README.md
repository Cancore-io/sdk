# `@cancore/bot-mcp`

```sh
npm install @cancore/bot-mcp
```

**Not on npm yet.** `0.1.0-rc.0` is a release candidate and npm has no `@cancore/bot-mcp` today, so
that line (and `npx @cancore/bot-mcp`) fails. Use [Setup from source](#setup-from-source).

A stdio MCP server that lets an AI agent drive a local `cancore-botd` within the owner's limits. It is a thin client of the daemon's unix socket: no key, no signer, no strategy engine in this package. Its binary is `cancore-bot-mcp`.

It can read state, reduce risk and trade within limits. It has no tool to withdraw, send, export a key, change limits, unlock, lock, resume, register, or release a booked take. `withdraw` exists, but only as an owner method on the daemon's owner socket, to the owner party pinned in the daemon's config, through the `cancore-bot` CLI; the agent socket refuses every owner method (`FORBIDDEN`). No key export exists anywhere.

Install and secure the daemon first: [`@cancore/botd`](../botd). For agents, the [`cancore-trading` skill](../../skills/cancore-trading/SKILL.md) explains how to use these tools.

**v1:** devnet only, like the daemon (where only CC, CBTC, cETH and HTEST settle); Linux with
systemd. bot-mcp talks to a local unix socket, so the agent (the MCP client that starts
`cancore-bot-mcp`) must run on the daemon's machine, as a user of its own in `cancore-bot-clients`.
Full documentation: <https://docs.cancore.io/sdk/bot-mcp>.

```
AI agent --MCP over stdio--> cancore-bot-mcp --bot.sock--> cancore-botd --HTTPS--> Cancore API
                             (agent's user, no key)        (user cancore-bot: key, limits, audit log)
```

## Tools

| Tool | Class | Arguments | Result |
| --- | --- | --- | --- |
| `trade_status` | read | — | `{locked, paused, partyId?, version, strategies: [{strategyId, kind, running, status, reason?, placed, fills, cancelledByUser}]}` — no pause reason |
| `trade_balances` | read | — | `{balances: [{instrument, amount}]}` for the instruments of `allowedPairs`; unlocked only |
| `trade_quote` | read | `base`, `quote`, `side` (`buy`/`sell`), `amount` | `{base, quote, side, amount, price, total, expiresInSec}` — pool price, nothing traded; unlocked only |
| `trade_orders_list` | read | `status`: `open` (default), `filled`, `cancelled`, `all` | `{orders: [{orderId, base, quote, side, amount, price, filled, status, createdAt}]}` — the daemon's own open book; `filled`/`cancelled` return `[]` |
| `trade_limits_get` | read | — | `{limits: {allowedPairs, maxOrderAmount, maxOrderNotional, maxDailyVolume, maxPosition, maxOpenOrders, maxPriceDeviationBps, maxCommandsPerMinute, perOrderUsd?, perDayUsd?, usdCapsOptOut}}` |
| `trade_audit_tail` | read | `n`: 1–1000, default 50 | `{entries: [{seq, at, method, riskClass, decision, reason?}]}` — no params, reason only as a deny code |
| `trade_order_cancel` | reduce | `orderId` | `{orderId, cancelled: true}` (may be unconfirmed), or `not_open` |
| `trade_orders_cancelAll` | reduce | — | `{cancelled: [orderId, …]}` — confirmed cancels only |
| `trade_pause` | reduce | `reason?` (≤ 500 chars) | `{paused: true}` |
| `trade_strategy_stop` | reduce | `strategyId` | `{strategyId, stopped: true}` (also for an unknown id) |
| `trade_order_make` | trade | `base`, `quote`, `side`, `amount`, `price`, `ttlSeconds?` (positive integer, rounded up to whole hours) | `{order: {orderId, base, quote, side, amount, price, filled: "0", status: "open", createdAt}}` |
| `trade_order_take` | trade | `orderId`, `amount` (the whole order) | `{orderId, filled: "0"}` — queued, settles in the background |
| `trade_strategy_start` | trade | `kind` (`grid`/`dca`), `base`, `quote`, `config` | `{strategyId}` |
| `trade_tools` | read | — | `{tools: [{tool, riskClass, effect}]}` |

- **Arguments.** Amounts and prices are decimal strings matching `^\d+(\.\d+)?$` (`"12.5"`, never
  `12.5`); a trade with more than 10 fraction digits is refused `no_rule`. Each tool's input schema
  is the daemon's own (`PARAMS` in `@cancore/botd/protocol`): the MCP SDK checks the arguments
  against it and drops unknown keys, and bot-mcp parses them again before anything reaches the
  socket.
- **Results** are whitelisted views of the daemon's answers: ids, decimals and enum values, no
  whitespace, so no free text; money fields carry decimals only; a reason passes only as a known
  deny code. Memos, metadata and any other counterparty text are dropped before the model sees
  them. Every reply is JSON text plus `structuredContent`; errors carry `isError: true`.
- **`trade_orders_list`** is the daemon's own book: its open orders and the takes not settled yet.
  Every item has `filled: "0"`, `status: "open"` and an empty `createdAt` (the book stores no fill
  amount or creation time). A make whose answer was lost appears once the daemon has confirmed it.
- **`trade_order_take`** needs an order id from elsewhere (the human, the web app): no tool lists
  the venue's book. `amount` is the whole order, in the base of the allowed pair's orientation.
- **`trade_strategy_start`** configs: grid `{side, levels (1–100), amountPerLevel, lowerPrice,
  upperPrice}`, dca `{side, amountPerOrder, intervalSeconds (60–2592000), maxOrders (1–10000)}`. Its
  progress shows in `trade_status`.
- **`trade_pause`**'s reason goes to the owner's `cancore-bot status` and the audit log, not back to
  the agent.
- **While locked**, the trade tools, `trade_balances`, `trade_quote`, `trade_order_cancel` and
  `trade_orders_cancelAll` answer `locked`; `trade_status`, `trade_limits_get`, `trade_audit_tail`,
  `trade_orders_list`, `trade_pause` and `trade_strategy_stop` still work. **While paused**, the trade
  tools answer `paused`; everything else works.

## Replies and errors

Limits are enforced by the daemon, not by these tools.

| Reply | When |
| --- | --- |
| `{ "denied": "<reason>" }` | the risk gate refused; reason from `DENY_REASONS` |
| `{ "error": "locked", "instruction": … }` | keystore locked: the owner runs `cancore-bot unlock` |
| `{ "error": "paused", "instruction": … }` | trading paused: only the owner can `resume` |
| `{ "error": "forbidden", "instruction": … }` | the method is not allowed on this socket (no tool here calls one) |
| `{ "error": "not_open", "instruction": … }` | `trade_order_cancel`: the order is taken, settling or ended; do not retry |
| `{ "error": "unconfirmed", "instruction": … }` | a make's answer was lost (or a trade tool's call outlived the daemon's 30 s timeout): the order may exist; do not place it again, check `trade_orders_list` within minutes |
| `{ "error": "invalid_params" }` | the daemon refused the parameters; for what an MCP client sees on a bad argument, see below |
| `{ "error": "socket_unavailable", "instruction": … }` | no daemon at the socket, or this user is not (yet) in `cancore-bot-clients` |
| `{ "error": "daemon_error", "code"?: n, "instruction"?: … }` | anything else, such as the API unreachable (`code: -32603`); on a trade tool it carries the unconfirmed instruction, since the order may have been placed (a make the API refused outright gets it too, and then `trade_orders_list` never shows it) |

The instructions, verbatim:

- `locked`: `The keystore is locked. The owner must act via the cancore-bot CLI; no tool here can change this. (cancore-bot unlock)`
- `paused`: `Trading is paused. The owner must act via the cancore-bot CLI; no tool here can change this. (cancore-bot resume)`
- `not_open`: `The order is taken, settling or ended; it cannot be cancelled. Do not retry.`
- `unconfirmed` (and `daemon_error` on a trade tool): `The order may exist. Do not place it again: the daemon confirms or drops it within minutes; check trade_orders_list.`
- `socket_unavailable`: `No cancore-botd socket at <path>: is the daemon running? Set --socket or CANCORE_BOT_SOCKET if it lives elsewhere.`, or `Permission denied on <path>: add this user to the cancore-bot-clients group (then log in again).`

**A bad argument** (a wrong type, or a string that is not a decimal) is answered by the MCP SDK
before bot-mcp runs: `isError: true` and a text such as
`MCP error -32602: Input validation error: Invalid arguments for tool trade_order_make: Expected string, received number at amount`
for `"amount": 100`. bot-mcp's own check, which answers
`{"error": "invalid_params", "issues": […]}`, comes after the SDK's, so an MCP client never sees it.

`DENY_REASONS`: `no_rule`, `instrument_not_allowed`, `order_size_exceeded`, `notional_exceeded`,
`daily_volume_exceeded`, `position_exceeded`, `open_orders_exceeded`, `price_deviation_exceeded`,
`rate_limited`, `verify_failed`, `paused`, `locked`, `usd_cap_missing`, `usd_price_missing`,
`usd_order_exceeded`, `usd_daily_exceeded`. What each means and what to do:
[the skill](../../skills/cancore-trading/SKILL.md#when-a-trade-is-refused) and
[the daemon's limits](../botd/README.md#install), step 8.

`verify_failed` and `unbooked_fill` are written by the daemon to the audit log. The agent sees
`verify_failed` there (`trade_audit_tail`), not in a command's reply: nothing is signed while a
command runs. A make only places the order, and its DvP is signed in the settlement loop once the
order is taken; a take answers `filled: "0"` as soon as it is queued. `unbooked_fill` is not a deny
code, so its entry reaches the agent without a reason.

## Setup from source

`cancore-bot-mcp` comes with the daemon: the
[botd from-source recipe](../botd/README.md#install-from-source-until-it-is-on-npm) installs it to
`/usr/local/bin/cancore-bot-mcp`. Set the daemon up first ([Install](../botd/README.md#install)).

**The agent's user, and logging in again.** The MCP client runs as the agent's own user, without
sudo rights: `cancore-agent` in the botd [Install](../botd/README.md#install), step 2
(`sudo cancore-bot install --human cancore-agent`). That user must be in `cancore-bot-clients` in
the session that starts the client: use a login that began after the install (for example
`sudo -iu cancore-agent`; for Claude Desktop, a desktop session of that user), check that `id`
lists `cancore-bot-clients`, then start (or restart) the MCP client. Everything below runs as that
user. bot-mcp reconnects by itself after a daemon restart; a group change needs a new client
process.

**Claude Code:**

```sh
claude mcp add cancore-bot -- cancore-bot-mcp
# custom socket
claude mcp add cancore-bot -- cancore-bot-mcp --socket /path/to/bot.sock
```

The default scope is `local` (this project directory only); add `-s user` for every project.

**Claude Desktop:** `claude_desktop_config.json` (Settings → Developer → Edit Config), then quit and
restart the app. It must run on the daemon's machine (official builds: macOS, Windows, Linux beta).

```json
{ "mcpServers": { "cancore-bot": { "command": "/usr/local/bin/cancore-bot-mcp", "args": [] } } }
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.cancore-bot]
command = "/usr/local/bin/cancore-bot-mcp"
args = []
```

Optionally `env = { CANCORE_BOT_SOCKET = "/run/cancore-bot/bot.sock" }`.

The socket defaults to `/run/cancore-bot/bot.sock`; override it with `--socket <path>` (or
`--socket=<path>`) or `CANCORE_BOT_SOCKET`; the flag wins.

## Give the agent the skill

The [`cancore-trading` skill](../../skills/cancore-trading/SKILL.md) is in the repository you
installed from. Install it for the agent's user, from a clone that user can read (or one of its
own):

- **Claude Code:** as the agent's user, from the clone,

  ```sh
  mkdir -p ~/.claude/skills/cancore-trading && cp skills/cancore-trading/SKILL.md ~/.claude/skills/cancore-trading/
  ```

  A new skill under `~/.claude/skills/` is picked up in the running session.
- **Claude Desktop / claude.ai:** upload the `skills/cancore-trading` folder as a ZIP in the Skills
  settings.
- **Codex:** put the text of `SKILL.md` into `~/.codex/AGENTS.md` (or a project's `AGENTS.md`).
- **Any other agent:** put it in its instructions.

## Example session

Live replies from a test run of the release candidate (the API was unreachable on purpose, so there
are no prices; ids and timestamps are throwaway). That run's allowed pair was CC/USDCx; the calls
below use CC/CBTC, a pair that settles on devnet, and no reply depends on the pair's name. `->` is
a tool call, `<-` its reply.

The daemon is running and locked:

```text
-> trade_status {}
<- { "locked": true, "paused": false, "version": "0.1.0-rc.0", "strategies": [] }

-> trade_order_make { "base": "CC", "quote": "CBTC", "side": "sell", "amount": "100", "price": "0.0000015" }
<- isError { "error": "locked", "instruction": "The keystore is locked. The owner must act via the cancore-bot CLI; no tool here can change this. (cancore-bot unlock)" }

-> trade_order_make { "base": "CC", "quote": "CBTC", "side": "sell", "amount": 100, "price": "0.0000015" }
<- isError MCP error -32602: Input validation error: Invalid arguments for tool trade_order_make: Expected string, received number at amount

-> trade_audit_tail { "n": 3 }
<- { "entries": [ …,
     { "seq": 4, "at": "2026-10-20T14:18:00.743Z", "method": "order.make", "riskClass": "trade", "decision": "deny", "reason": "locked" } ] }
```

The owner ran `sudo -u cancore-bot cancore-bot unlock`, and has set no limits yet:

```text
-> trade_limits_get {}
<- { "limits": { "maxOpenOrders": 0, "maxPriceDeviationBps": 0, "maxCommandsPerMinute": 0, "usdCapsOptOut": false,
     "allowedPairs": [], "maxOrderAmount": {}, "maxOrderNotional": {}, "maxDailyVolume": {}, "maxPosition": {} } }

-> trade_balances {}
<- { "balances": [] }                          # only the instruments of allowedPairs, and there are none

-> trade_order_make { "base": "CC", "quote": "CBTC", "side": "sell", "amount": "100", "price": "0.0000015" }
<- isError { "denied": "rate_limited" }        # maxCommandsPerMinute 0 is checked first

-> trade_quote { "base": "CC", "quote": "CBTC", "side": "sell", "amount": "100" }
<- isError { "error": "daemon_error", "code": -32603 }   # the API is unreachable

-> trade_orders_list {}
<- { "orders": [] }
```

The owner set the limits from step 8 of the [botd Install](../botd/README.md#install) (`CC/CBTC`
only):

```text
-> trade_order_make { "base": "CC", "quote": "CBTC", "side": "sell", "amount": "100", "price": "0.0000015" }
<- isError { "denied": "price_deviation_exceeded" }   # no reference price: the API is unreachable

-> trade_order_make { "base": "BTC", "quote": "USDCx", "side": "sell", "amount": "1", "price": "1" }
<- isError { "denied": "instrument_not_allowed" }

-> trade_order_cancel { "orderId": "nope" }
<- isError { "error": "daemon_error", "code": -32603 }

-> trade_strategy_stop { "strategyId": "nope" }
<- { "strategyId": "nope", "stopped": true }

-> trade_pause { "reason": "agent saw something odd" }
<- { "paused": true }

-> trade_status {}
<- { "locked": false, "paused": true, "version": "0.1.0-rc.0", "strategies": [] }
```

The owner's `sudo -u cancore-bot cancore-bot status` shows the reason the agent gave
(`"pauseReason": "agent saw something odd"`); `resume` answers `{"paused": false}`. A user outside
`cancore-bot-clients` gets, on any tool:

```text
<- isError { "error": "socket_unavailable", "instruction": "Permission denied on /run/cancore-bot/bot.sock: add this user to the cancore-bot-clients group (then log in again)." }
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `socket_unavailable`: `No cancore-botd socket at …` | the daemon is not running, or it listens elsewhere | the owner: `systemctl status cancore-botd`; `--socket` or `CANCORE_BOT_SOCKET` for another path |
| `socket_unavailable`: `Permission denied on …` | the client's user is not in `cancore-bot-clients` in this session | `sudo cancore-bot install --human <agent's user>` (or `usermod -aG`), a new login as that user, check `id`, restart the MCP client |
| `locked` on most tools | the daemon starts locked, after every restart | the owner: `sudo -u cancore-bot cancore-bot unlock` |
| `paused` on every trade tool | the agent or the owner paused, or the daemon paused itself (`unbooked_fill`, a broken audit log) | the owner reads `cancore-bot status` and resumes; strategies stopped by a pause must be started again |
| right after setup every make is `denied: rate_limited` and every take `denied: no_rule` | no limits yet: `maxCommandsPerMinute` is 0 and there is no allowed pair | the owner sets limits (`cancore-bot limits set`) |
| every trade `denied: price_deviation_exceeded` near the market | no reference price: the API or its price feed is down | wait; do not widen the corridor for it |
| `MCP error -32602: Input validation error: …` | an amount or price sent as a number, or a malformed value | decimal strings: `"100"`, `"0.15"` |
| `daemon_error` with `code: -32603` | the API is unreachable or failed | wait and read again; after a trade tool, check `trade_orders_list` before placing anything |
| `trade_balances` answers `[]` | no `allowedPairs` yet: it lists only their instruments | the owner sets limits |
| the client cannot start the server | `cancore-bot-mcp` is not on the client's `PATH` | the absolute path `/usr/local/bin/cancore-bot-mcp`, as in the Claude Desktop and Codex configs |

## Library

```ts
import { AGENT_METHODS, createServer, inventory } from '@cancore/bot-mcp';
```

`AGENT_METHODS` are the daemon methods an agent may reach (no owner method); `inventory()` is what
`trade_tools` returns; `createServer(getClient, version)` builds the MCP server over any client of
the agent socket. The package also exports `startServer`, `resolveSocketPath`, `DEFAULT_SOCKET` and
`toolName`.
