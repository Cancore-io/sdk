# `@cancore/botd`

```sh
npm install @cancore/botd
```

A self-custody trading daemon for Cancore. It holds one bot account's key, trades for it through
the API, and lets an AI agent (through `@cancore/bot-mcp`) place trades only inside
limits the owner set.

- `cancore-botd` — the daemon: encrypted keystore, default-deny risk gate, hash-chained audit log,
  two local unix-socket JSON-RPC 2.0 endpoints (agent and owner).
- `cancore-bot` — the owner CLI: `init`, `unlock`/`lock`, `register`, `status`, `limits show|set`,
  `pause`/`resume`, `withdraw`, `audit verify`, `install`.
- `@cancore/botd/protocol` — the command and response schemas only, with no key-handling code:

```ts
import { parseRequest, RISK_CLASS, DENY_REASONS } from '@cancore/botd/protocol';
```

Linux with systemd only in v1.

## Security model

**Two users.** The daemon runs as its own system user `cancore-bot` (no login shell, no home). The
keystore, state, limits and audit log live in `/var/lib/cancore-bot` (mode `0700`, owned by
`cancore-bot`). The person and the agent run as their usual user.

**Two sockets** in `/run/cancore-bot`:

| Socket | Mode | Who connects | Methods |
|---|---|---|---|
| `bot.sock` (agent) | `0660`, group `cancore-bot-clients` | the agent, via bot-mcp | `read`, `reduce`, `trade` |
| `owner.sock` | `0600`, user `cancore-bot` | the owner CLI | everything, including `owner` |

Every method has a risk class (`RISK_CLASS` in `./protocol`):

- `read` — `status`, `balances`, `orders.list`, `limits.get`, `audit.tail`
- `reduce` — `order.cancel`, `orders.cancelAll`, `pause`, `strategy.stop`
- `trade` — `order.make`, `order.take`, `strategy.start`; always behind the risk gate
- `owner` — `unlock`, `lock`, `resume`, `limits.set`, `withdraw`; refused (`FORBIDDEN`) on the agent socket

The owner CLI talks to `owner.sock`, so it runs as the daemon user: `sudo -u cancore-bot cancore-bot …`.
An agent in the `cancore-bot-clients` group can reach `bot.sock` and nothing else.

**Keystore.** `keystore.json`, mode `0600`, refused if group/others can read it or if another user
owns it. The 32-byte Ed25519 key is encrypted with AES-256-GCM under a key from scrypt
(N = 2^17, r = 8, p = 1, random 32-byte salt); the header (version, KDF parameters, public key) is
authenticated as AAD, so a swapped public key or weakened KDF fails to decrypt. `init` refuses to
overwrite an existing keystore. The plaintext key exists in memory only between `unlock` and `lock`
(or daemon stop) and is zeroed then. The daemon always starts locked.

**No key export.** There is no method, on either socket, that returns the key or the mnemonic.
Secrets are typed at a TTY only: `init` and `unlock` refuse a pipe or an argument. `unlock` params
are never written to the audit log, and any key that looks like a secret (`passphrase`, `mnemonic`,
`seed`, `private_key`, `secret`) is redacted from logged params.

**Environment key.** `keyFromEnv` (a plaintext key in `CANCORE_BOT_KEY`) is for throwaway test bots:
it needs `insecureEnvKey: true` and is refused on `network: 'mainnet'` regardless. The daemon itself
does not use it; it always reads the keystore.

**Withdraw.** Only to `ownerParty` pinned in `/etc/cancore-bot/config.json`; any other `to` is
refused, and with no `ownerParty` every withdraw is. It also needs `maxFee` (the most CC of network
fee one withdraw may pay); without it the SDK refuses every send.

**Signer guard.** Every signature goes through one wrapper (`verify.ts`): the daemon recomputes the
hash (V2 hashing, `@cancore/trader`'s port) of every prepared transaction the API returns, and signs
a hash only if it saw bytes with exactly that hash, each once. A mismatch or an unseen hash is
refused and logged as `verify_failed`. The SDK's own checks of what each DvP or transfer does run
underneath. The API cannot move the pinned trust boundary either: `venuePartyId`, `maxFeeRate`,
`feeRecipientPartyId` and `network` come from the config. The venue is the SDK's pinned venue for the
network (`network`, or the one Cancore's `baseUrl` implies) unless `venuePartyId` is set; on a stand
with neither the daemon refuses to start.

**Risk gate.** Default-deny: omitted limits allow nothing. Every trade command is checked against
fresh reference prices; if the price feed is unreachable there is no reference and the gate
refuses. The decision is written to the audit log before anything touches the key. Trust boundary:
those reference prices come from the Cancore API, so the price corridor protects against a bad
order, not against a compromised API.

**Audit log.** `audit.jsonl`, append-only, fsynced per entry. Each entry carries the SHA-256 of the
previous one; `cancore-bot audit verify` re-walks the chain. The state file remembers the last entry
it saw, so a truncated or broken log makes the daemon start locked **and paused**
(`audit log truncated or broken`) until the owner resumes.

**systemd hardening** (`cancore-bot install` writes the unit): `ProtectSystem=strict`,
`ProtectHome=yes`, `PrivateTmp`, `PrivateDevices`, `NoNewPrivileges`, empty capability set,
`SystemCallFilter=@system-service`, `LimitCORE=0`, `UMask=0077`.

### Residual risks

- **root, or code execution as `cancore-bot`,** gets the key while it is unlocked, and the keystore
  file for an offline passphrase guess. The exposure is the bot wallet's balance: fund it with what
  you are prepared to lose, and withdraw profits to your own wallet.
- **A compromised daemon** (or a dependency of it) can do anything the key can. The limits are the
  daemon's own rules, not the ledger's.
- **The sudo timestamp cache.** After you run `sudo -u cancore-bot cancore-bot …`, sudo by default
  lets the same user run sudo again without a password for a few minutes. An agent running as that
  user could use the window to call owner commands. Turn the cache off for this command:

  ```
  # visudo -f /etc/sudoers.d/cancore-bot
  Defaults!/usr/local/bin/cancore-bot timestamp_timeout=0
  ```

  (use the path `command -v cancore-bot` prints). Better still, do not run the agent as a user with
  sudo rights.
- **Group members.** Anyone in `cancore-bot-clients` can trade within the limits, not only the agent.

## Install

1. **Install the package** (Node.js 20 or newer), globally so both binaries are on root's `PATH`:

   ```sh
   sudo npm install -g @cancore/botd
   ```

2. **Create the user, group, directories and unit.** `--human` adds the user the agent runs as to
   `cancore-bot-clients`; `--dry-run` prints the plan and the unit without changing anything.

   ```sh
   sudo cancore-bot install --human "$USER" --dry-run
   sudo cancore-bot install --human "$USER"
   ```

   This creates `cancore-bot-clients`, the system user `cancore-bot`, `/etc/cancore-bot` (`0755`),
   `/var/lib/cancore-bot` (`0700`), and `/etc/systemd/system/cancore-botd.service`. Log out and in
   again for the group to apply.

3. **Write the config**, `/etc/cancore-bot/config.json`, owned by root, `0644`. Every field is
   optional; these are the ones you normally set:

   ```json
   {
     "baseUrl": "https://api-dev.cancore.app",
     "network": "devnet",
     "ownerParty": "<your own wallet's party id>",
     "maxFee": "1"
   }
   ```

   `ownerParty` is your own party (the Wallet page shows it). Defaults: `daemonUser` `cancore-bot`,
   `clientsGroup` `cancore-bot-clients`, `stateDir` `/var/lib/cancore-bot`, `agentSocket`
   `/run/cancore-bot/bot.sock`, `ownerSocket` `/run/cancore-bot/owner.sock`, `baseUrl`
   `https://api-dev.cancore.app`, `network` `devnet`, `ordersPerHour` `5` (new orders an hour, agent and strategies together;
   the platform's per-user limit). Pinned fee fields (`venuePartyId`, `maxFeeRate`,
   `feeRecipientPartyId`) default to the SDK's values for Cancore's hosts; on any other `baseUrl`
   set `network` or `venuePartyId`, or the daemon does not start. **v1 runs on devnet only:** any other
   network (testnet, mainnet, or a host it cannot place) is refused at start, before the API is called.

4. **Create the keystore.** Three ways, each asking for a passphrase at the end. It must be at least 12 characters, mixing letters with digits or symbols, and not a common or repeated pattern (refused otherwise); it
   is what stands between a copy of `keystore.json` and the key.

   ```sh
   sudo -u cancore-bot cancore-bot init                         # new phrase (recommended)
   sudo -u cancore-bot cancore-bot init --import                # a phrase you already have
   sudo -u cancore-bot cancore-bot init --import-key <file>     # the key from Cancore "My bots"
   ```

   - **New phrase.** `init` generates a 24-word phrase, shows it once on the terminal, and asks
     three random words of it back before it writes anything. Write it down offline: it is the only
     backup of the key. The screen is cleared after.
   - **`--import`** takes a phrase you type and derives account 0 of it, with a warning: **use a
     phrase made for this bot, never your wallet's** (account 0 of your wallet phrase is your wallet).
   - **`--import-key <file>`** takes the 64-hex key the web app's "My bots" page gives. It is read
     from a file, never from an argument or the environment, and the file must be owned by
     `cancore-bot` with mode `0600`:

     ```sh
     sudo install -o cancore-bot -g cancore-bot -m 600 /dev/stdin /var/lib/cancore-bot/import.key  # paste, Ctrl-D
     sudo -u cancore-bot cancore-bot init --import-key /var/lib/cancore-bot/import.key
     sudo shred -u /var/lib/cancore-bot/import.key
     ```

     The keystore stores the raw key either way; a key has no phrase, so keep the file's content as
     the backup.

   It prints the bot's public key.

5. **Start the daemon.**

   ```sh
   sudo systemctl enable --now cancore-botd
   journalctl -u cancore-botd -f    # "cancore-botd listening on …"
   ```

6. **Unlock, register and onboard the account:**

   ```sh
   sudo -u cancore-bot cancore-bot unlock
   sudo -u cancore-bot cancore-bot register      # prompts for the invite code; Enter for none
   ```

   It registers the account (an already registered one is fine), creates its Canton party and
   enables CC receipts (`onboard()` of the SDK, with the daemon's signer; see
   [Run a bot, section 5](../../docs/run-a-bot.md#5-onboard)), and prints the `partyId`. A bot made
   in the web app's "My bots" is already registered: the first `unlock` onboards it by itself.
   `status` shows the `partyId` from then on; it is the bot's address.

7. **Fund the bot** with a small amount: from your own wallet, send CC (and the tokens you will
   trade) to the bot's `partyId`.

8. **Set limits.** Until you do, every trade is refused. Write a file and hand it over on stdin
   (the CLI runs as `cancore-bot`, which cannot read your home):

   ```json
   {
     "allowedPairs": ["CC/USDCx"],
     "maxOrderAmount": { "CC": "500" },
     "maxOrderNotional": { "USDCx": "100" },
     "maxDailyVolume": { "CC": "5000" },
     "maxPosition": { "CC": "2000" },
     "maxOpenOrders": 10,
     "maxPriceDeviationBps": 200,
     "maxCommandsPerMinute": 10,
     "perOrderUsd": "50",
     "perDayUsd": "500"
   }
   ```

   ```sh
   sudo -u cancore-bot cancore-bot limits set /dev/stdin < limits.json
   sudo -u cancore-bot cancore-bot limits show
   ```

   | Field | Meaning | Omitted |
   |---|---|---|
   | `allowedPairs` | `BASE/QUOTE` pairs that may trade (max 100) | none |
   | `maxOrderAmount` | per base instrument: one order's amount | nothing allowed |
   | `maxOrderNotional` | per quote instrument: one order's amount × price | nothing allowed |
   | `maxDailyVolume` | per base instrument: rolling 24 h traded amount | nothing allowed |
   | `maxPosition` | per base instrument: absolute net position, counting every open order as filled | nothing allowed |
   | `maxOpenOrders` | open orders at once, including taken ones not yet settled (0–1000) | `0` |
   | `maxPriceDeviationBps` | max distance of the order price from the market rate (0–10000) | `0` |
   | `maxCommandsPerMinute` | trade commands per minute (0–600) | `0`: every trade is `rate_limited` |
   | `perOrderUsd` | one order's value in USD | every trade is `usd_cap_missing` |
   | `perDayUsd` | USD value of fills in the rolling 24 h, plus open orders and unconfirmed intents, plus this order | every trade is `usd_cap_missing` |
   | `usdCapsOptOut` | `true` turns both USD caps off, explicitly | `false` |

   USD values use the Cancore API's price per instrument (`sourcePriceUsd` of the listed pairs), fetched
   fresh for every decision. An instrument without a USD price refuses the trade (`usd_price_missing`).

   Amounts are decimal strings, at most 15 integer and 10 fraction digits. Unknown fields are
   rejected.

9. **Check** (after a restart, `unlock` again first):

   ```sh
   sudo -u cancore-bot cancore-bot status
   ```

   On unlock the daemon starts the settlement loop and reconciles orders that settled or ended while
   it was down, and orders whose creation it could not confirm (below). While it runs it reconciles
   the book every 30 s (a failed lookup backs off): an order stays booked, with its full reservation
   against the limits, until the venue shows how it ended — completed by this account (booked as a
   fill once), taken by another account or ended (off the book, no fill). Each tick reconciles first
   and only then lets strategies step, so a pause it raises stops them in the same tick.

   **Deliberate:** a take whose accept answer was lost stays booked, holding its open-order slot and
   its reservation, for as long as the maker's order stays open — the daemon cannot tell whether that
   accept landed, and releasing it early could let a real trade escape the limits. An owner command
   to release such a booking after checking the order is planned as a follow-up.

**Crash safety.** Every `order.make` (agent or strategy) is written to the state file as an intent,
with a client key, before the API is called; the key rides on the order as its description. An
unconfirmed intent counts as an open order for the risk gate. On unlock and on its ticks the daemon looks
for the order among one page of 100 of the bot's orders (the API's default order): by the key, or, if the API rewrote the description,
by the same pair, side and amounts created within 10 minutes of the intent. A match is adopted onto
the book (and settles or ends like any other, including a fill that happened while it was an intent);
no match twice, a minute apart, drops the intent. Intents younger than 60 s are not looked up at all. Limit: two identical
orders within that window, both with their description rewritten, cannot be told apart.

**Lost answers.** A make whose answer never arrives (network error, timeout, 5xx) returns
`unconfirmed` (code -32005) and keeps its intent; a strategy stays `running` and its slot stays held.
Each tick looks them up the same way an unlock does (unlock does it in the background); a lookup that fails backs off
(2, 4, 8 … minutes, at most 15). A dropped intent frees the slot, so the strategy places it again. A
4xx refusal (including a DvP refusal) is a definite no: the intent and its hourly slot are dropped at once. An agent must not
repeat an `unconfirmed` make: that is how duplicates happen.

## Day to day

```sh
sudo -u cancore-bot cancore-bot status                 # locked, paused, partyId, strategies, version
sudo -u cancore-bot cancore-bot pause "going on holiday"
sudo -u cancore-bot cancore-bot resume
sudo -u cancore-bot cancore-bot lock                   # stops strategies, wipes the key
sudo -u cancore-bot cancore-bot withdraw --to <ownerParty> --instrument CC --amount 100
sudo -u cancore-bot cancore-bot audit verify           # exit 3 if the chain is broken
```

- `pause` stops every strategy and cancels the bot's own resting orders; orders it already took
  settle. Only `resume` (owner) lifts it. The agent can pause; it cannot resume.
- `withdraw` needs the daemon unlocked, `--to` equal to `ownerParty`, and `maxFee` in the config.
  `--instrument CC` sends CC; anything else is the token id.
- `--config <path>` points both binaries at another config file.

## Strategies

`strategy.start` with `kind: "grid"` or `"dca"`; the config schemas are `gridConfig` / `dcaConfig` in `src/riskgate.ts`.

- **grid** places `amountPerLevel` on the configured side at `levels` prices spaced evenly from `lowerPrice` to `upperPrice`. A filled buy is sold one level up, a filled sell bought back one level down.
- **dca** places `amountPerOrder` at the reference price every `intervalSeconds`, `maxOrders` in total.

Every strategy order is an `order.make` through the same trade lock, risk gate, audit log and engine as an agent's. A refusal stops the strategy (`status: "denied"`, `reason` in `status`); the daemon keeps running. Strategy state lives in the state file, and running strategies resume on unlock without placing a level (grid) or seq (dca) twice. `pause` and `strategy.stop` stop the loop and cancel the strategy's resting orders. A strategy order cancelled by hand (`order.cancel`, `orders.cancelAll`, or in the web app) is not placed again: its slot is listed in the strategy's `cancelledByUser` in `status`.

**Rate limit.** The platform accepts 5 new orders an hour per user. The daemon keeps one budget, `ordersPerHour` in the config (default 5), for the agent and every strategy together. A strategy that finds it spent waits with `status: "rate_limited"`; an agent's `order.make` past it is refused with `rate_limited`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `cancore-botd must run as cancore-bot` | started by hand as another user | run it through systemd (`--dev` skips the check, for development only) |
| `a TTY is required to enter secrets` | `init`/`unlock` from a pipe or script | run it in a terminal |
| `keystore: … readable by group/others` / `not owned by the current user` | file mode or owner changed | `chown cancore-bot: …/keystore.json && chmod 600 …` |
| `keystore: … already exists; refusing to overwrite` | `init` on an existing keystore | move the old one aside only if you hold its phrase |
| `-32002 unlock failed` | wrong passphrase or corrupt keystore | retry; the phrase plus a new `init` restores the key |
| CLI `connect ENOENT` / `EACCES` | daemon not running, or CLI not run as `cancore-bot` | `systemctl status cancore-botd`; use `sudo -u cancore-bot` |
| agent gets `socket_unavailable` | not in `cancore-bot-clients`, or no relogin | `id` should list the group |
| every trade `rate_limited` | `maxCommandsPerMinute` is `0` | set it |
| `order.make` `rate_limited` with `maxCommandsPerMinute` set | the hourly `ordersPerHour` budget is spent | wait; it is the platform's limit |
| daemon exits `no venue is pinned for …` | a `baseUrl` that is not one of Cancore's hosts | set `network` or `venuePartyId` |
| `register` fails, or the first unlock logs `not registered: run cancore-bot register` | a new account, or a wrong invite code | `cancore-bot register` with the right code |
| paused with `pauseReason: unbooked_fill` | a trade settled on the bot account that the daemon never booked (for example one made by hand in the web app on the bot's account); the limits cannot account for it, so the bot stops | check the audit log and the account's orders, then `cancore-bot resume`; do not trade by hand on the bot account |
| `order.cancel` fails with `reason: not_open` | the venue shows the order taken, settling or ended; cancelling it could leave an HTLC that still executes, so the daemon keeps it booked as a trade | nothing to do: it settles or ends on its own (`status`, audit log) |
| `order.cancel` answers `cancelled: true` but the order is still in `status` | the venue did not answer the status read, so the cancel was sent unconfirmed; the order stays booked (it still counts against open orders) until reconcile sees it ended, within about 30 s once the venue answers | nothing |
| `status` shows a take on the book for a long time | its accept answer was lost and the maker's order is still open with no taker; it is kept booked on purpose (see reconcile above) | nothing; it comes off once the order is taken by someone else, cancelled or expired |
| every trade `usd_cap_missing` | `perOrderUsd` or `perDayUsd` not set | set both, or `usdCapsOptOut: true` |
| every trade `usd_daily_exceeded`, audit shows a settle with `usdValue: "unpriced"` | a fill settled while the API gave no USD price (or one from before USD caps) is in the 24 h window; its value is unknown, so the whole day counts as spent | wait until that fill is 24 h old, or set `usdCapsOptOut: true` (owner, `limits.json`) to trade without USD caps meanwhile |
| every trade `usd_price_missing` | the API gives no USD price for an instrument involved | wait for the price feed; check the pair is listed |
| every trade `price_deviation_exceeded` | no market rate for the pair (feed down, unknown pair), or price too far | check the pair is listed; widen `maxPriceDeviationBps` |
| starts `paused` with `audit log truncated or broken` | the log lost entries the state had seen | `audit verify`, investigate, then `resume` |
| `withdraw goes only to the owner party pinned in the config` | `--to` differs, or no `ownerParty` | set `ownerParty`, restart the daemon |

## Not implemented yet

- `orders.list` knows only the daemon's open orders: `filled` and `cancelled` return an empty list.
- `balances` has no `locked` amount: the SDK does not list a party's allocations.
- `quote` for a buy sizes the pool request from the market rate, so the base amount it returns is
  close to the one asked, not exact.
- Platforms other than Linux with systemd.
