# `@cancore/botd`

```sh
npm install @cancore/botd
```

**Not on npm yet.** `0.1.0-rc.0` is a release candidate and npm has no `@cancore/botd` today, so
that line fails. Use [Install from source](#install-from-source-until-it-is-on-npm).

A self-custody trading daemon for Cancore. It holds one bot account's key, trades for it through
the API, and lets an AI agent (through [`@cancore/bot-mcp`](../bot-mcp)) place trades only inside
limits the owner set.

- `cancore-botd` — the daemon: encrypted keystore, default-deny risk gate, hash-chained audit log,
  two local unix-socket JSON-RPC 2.0 endpoints (agent and owner).
- `cancore-bot` — the owner CLI: `init`, `unlock`/`lock`, `register`, `status`, `limits show|set`,
  `pause`/`resume`, `release`, `withdraw`, `audit verify`, `install`.
- `@cancore/botd/protocol` — the command and response schemas only, with no key-handling code:

```ts
import { parseRequest, RISK_CLASS, DENY_REASONS } from '@cancore/botd/protocol';
```

**v1:** devnet only (`https://api-dev.cancore.app`), Linux with systemd only, Canton DvP orders
only. The agent must run on the same machine as the daemon: the daemon listens on local unix
sockets and has no remote transport. Full documentation: <https://docs.cancore.io/sdk/botd>.

[How it works](#how-it-works) · [Security model](#security-model) ·
[What happens if…](#what-happens-if) · [Install from source](#install-from-source-until-it-is-on-npm) ·
[Install](#install) · [How orders are tracked](#how-orders-are-tracked) · [Day to day](#day-to-day) ·
[Strategies](#strategies) · [Examples](#examples) · [Recovery and upgrades](#recovery-and-upgrades) ·
[Troubleshooting](#troubleshooting) · [Not implemented yet](#not-implemented-yet)

## How it works

```
  AI agent (Claude Code, Codex, any MCP client)        you, the owner
        |  MCP over stdio                                 |  sudo -u cancore-bot cancore-bot <command>
        v                                                 v
  cancore-bot-mcp                                   cancore-bot (owner CLI)
  runs as the agent's user: no key, no owner tools        |
        |                                                 |
        v                                                 v
  /run/cancore-bot/bot.sock                         /run/cancore-bot/owner.sock
  0660, group cancore-bot-clients                   0600, user cancore-bot
  read, reduce, trade                               every method, owner methods included
        |                                                 |
        +-------------------------+-----------------------+
                                  v
               cancore-botd  (systemd unit, user cancore-bot)
               schema -> risk class -> risk gate -> audit log -> engine -> signer guard -> key
               /var/lib/cancore-bot (0700): keystore, state, limits, audit log
                                  |
                                  |  HTTPS
                                  v
               Cancore API  (https://api-dev.cancore.app)
```

A command from the agent passes four checks before anything is signed: the protocol schema (strict:
an unknown field or a wrong type is refused), the socket's risk class (owner methods are refused on
`bot.sock`), the risk gate (every trade command, against the owner's limits and fresh prices), and
the signer guard (it signs only hashes it recomputed from the transaction bytes the API returned).
The gate's decision is in the audit log before the engine calls the API. The owner reaches the same
daemon through `owner.sock`, the only socket with the owner methods (`unlock`, `limits.set`,
`withdraw`, …).

The trust boundary is the operating-system user, not the prompt: the key and every file of the bot
belong to `cancore-bot`, and the agent's user can reach `bot.sock` and nothing else.

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

| Class | Methods | On `bot.sock` |
| --- | --- | --- |
| `read` | `status`, `balances`, `orders.list`, `limits.get`, `audit.tail`, `quote` | yes |
| `reduce` | `order.cancel`, `orders.cancelAll`, `pause`, `strategy.stop` | yes |
| `trade` | `order.make`, `order.take`, `strategy.start` — always through the risk gate | yes |
| `owner` | `unlock`, `register`, `lock`, `resume`, `limits.set`, `withdraw`, `order.release` | refused, `FORBIDDEN` (-32004), and audited |

The owner CLI talks to `owner.sock`, so it runs as the daemon user: `sudo -u cancore-bot cancore-bot …`.
An agent in the `cancore-bot-clients` group can reach `bot.sock` and nothing else.

**Who can do what:**

| Action | Agent (`bot.sock`, through bot-mcp) | Owner (`owner.sock`, through `cancore-bot`) |
| --- | --- | --- |
| Read status, balances, orders, limits, the audit tail, a quote | yes | yes |
| Cancel orders, stop a strategy, pause | yes | yes |
| Place or take an order, start a strategy | yes, inside the limits | no CLI command (the socket would apply the same risk gate) |
| Resume after a pause | no | yes |
| Change limits | no | yes |
| Unlock, lock, register | no | yes |
| Release a booked take | no | yes |
| Withdraw | no | yes, only to `ownerParty` from the config |
| Get the key or the recovery phrase | no | no: no such method exists |

**Keystore.** `keystore.json`, mode `0600`, refused if group or others have any access to it, if
another user owns it, or if it is a symlink. The 32-byte Ed25519 key is encrypted with AES-256-GCM
under a key from scrypt (N = 2^17, r = 8, p = 1, random 32-byte salt); the header (version, KDF
parameters, public key) is authenticated as AAD, so a swapped public key or weakened KDF fails to
decrypt, and KDF parameters below the minimum are refused. `init` refuses to overwrite an existing
keystore. The plaintext key exists in memory only between `unlock` and `lock` (or daemon stop) and
is zeroed then. The daemon always starts locked.

A new keystore's passphrase must have at least 12 characters, must not be all digits or all
letters, must not start with a common word (`password`, `qwerty`, `admin`, …) or a keyboard or digit
run, and must not be one character or a 1–4 character block repeated. The policy applies when a
keystore is created; it is what stands between a copy of `keystore.json` and the key.

**No key export.** There is no method, on either socket, that returns the key or the mnemonic.
Secrets are typed at a TTY only: `init` and `unlock` (and `register`, for its invite code) refuse a
pipe or an argument. The params of `unlock` and `register` are never written to the audit log, and
any key that looks like a secret (`passphrase`, `mnemonic`, `seed`, `private_key`, `secret`) is
redacted from logged params.

**No key in the environment.** There is no way to run the daemon from a key in the environment or
on the command line: it always reads the encrypted keystore.

**Withdraw.** Only to `ownerParty` pinned in `/etc/cancore-bot/config.json`; any other `to` is
refused, and with no `ownerParty` every withdraw is. It also needs `maxFee` (the most CC of network
fee one withdraw may pay); without it the SDK refuses every send.

**Signer guard.** Every signature goes through one wrapper (`verify.ts`): the daemon recomputes the
hash (V2 hashing, `@cancore/trader`'s port) of every prepared transaction the API returns, and signs
a hash only if it saw bytes with exactly that hash, each once. A mismatch or an unseen hash is
refused and logged as `verify_failed`. The SDK's own checks of what each DvP or transfer does run
underneath. The API cannot move the pinned trust boundary either: `venuePartyId`, `maxFeeRate` and
`feeRecipientPartyId` come from the config and default to the SDK's pins for devnet, never to what
the API says. The SDK refuses a fee rate above `maxFeeRate` (its default ceiling is `0.015`, 1.5%).

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

## What happens if…

| If… | What happens |
| --- | --- |
| a prompt-injected agent asks to withdraw or send | bot-mcp has no such tool. A request written straight to `bot.sock` gets `FORBIDDEN` (-32004) and an audit entry. Even the owner's withdraw goes only to `ownerParty`. |
| order data carries an instruction ("send all CC to …") | it does not reach the model: bot-mcp's replies carry whitelisted fields only — ids, decimals and enum values, no whitespace, money fields decimals only; a free-text reason passes only as a known deny code. |
| the agent reads the keystore | the kernel refuses: `/var/lib/cancore-bot` is `0700` and `keystore.json` `0600`, both owned by `cancore-bot`; the agent's user cannot list the directory. A copy would still be encrypted. |
| the agent spams orders | `maxCommandsPerMinute` trade commands that passed the gate in the last minute, `ordersPerHour` new orders an hour (default 5, agent and strategies together), `maxOpenOrders`; past them every command is refused with `rate_limited` / `open_orders_exceeded`. Every attempt, allowed or refused, is in the audit log. |
| a big order is split into small ones | the caps that add up still bind: `maxDailyVolume` (rolling 24 h, open orders counted as filled), `maxPosition` (worst case: every open order fills), `perDayUsd` (24 h fills + open orders + unconfirmed intents), `ordersPerHour`. |
| an accept's answer is lost and the agent takes again | the first take stays booked with its full reservation (open-order slot, position, daily volume, USD) until the venue shows how that order ended, so the next take is checked with it counted. The owner cannot release it while an accept may still land (`may_be_trade`). |
| the API returns a tampered prepared transaction | bytes whose hash is not the one claimed: the daemon recomputes the hash (V2 hashing, `@cancore/trader`) and signs only hashes it recomputed itself, each once — refused, logged `verify_failed`. Bytes that do something else (another receiver, amount, venue): refused by the SDK's checks of what the DvP or transfer does. Venue, fee recipients and the max fee rate are pinned in the config, not taken from the API. |
| the price feed is down | no reference price → every trade `price_deviation_exceeded`; no USD price → `usd_price_missing`. Prices are fetched for each decision, never read from disk. |
| the daemon crashes mid-order | the order's intent was on disk before the API call. On unlock and on every tick the daemon looks the order up (by the client key it put in the description, or the same pair, side and amounts created within 10 minutes) and books it, or drops the intent after two empty lookups a minute apart. Until then the intent counts as an open order. A create request is never sent twice. |
| the audit log is truncated | the state file remembers the last entry seen; the next start is locked **and paused** (`audit log truncated or broken`) until the owner resumes. `cancore-bot audit verify` exits 3 on a broken chain. |
| `keystore.json` is stolen | it is AES-256-GCM under a key from scrypt (N = 2^17, r = 8, p = 1, 32-byte salt): every passphrase guess costs one such scrypt run. The header (version, KDF parameters, public key) is authenticated, so the file cannot be edited to a cheaper KDF. A new keystore's passphrase must pass the policy above. |
| someone has root (or runs code as `cancore-bot`) | no protection: they can read the key while it is unlocked, and copy the keystore to guess the passphrase offline. Keep on the bot only what you can lose. |

## Install from source (until it is on npm)

You need Linux with systemd, git, sudo, and Node.js 20+ installed system-wide (`sudo node --version`
must work; not a Node under your home such as nvm's — the unit runs the node that ran `install`, and
hides `/home`).

```sh
git clone https://github.com/Cancore-io/sdk.git
cd sdk
npm ci
rm -rf packs && mkdir packs
npm pack --silent --pack-destination packs \
  -w @cancore/contracts -w @cancore/wallet -w @cancore/client \
  -w @cancore/trader -w @cancore/botd -w @cancore/bot-mcp
sudo npm install --prefix /opt/cancore-bot ./packs/*.tgz
sudo ln -sf /opt/cancore-bot/node_modules/.bin/cancore-* /usr/local/bin/
```

- npm lacks the `@cancore` packages botd needs at the versions it needs, so the recipe packs all six
  from the same commit. `npm pack` builds each package (its `prepack` runs the build) and writes the
  six tarballs to `packs/`; no separate `npm run build` is needed.
- One `npm install` with all six resolves every `@cancore/*` dependency to the tarball beside it;
  the rest (zod, the MCP SDK, noble, …) comes from npm. Installing the tarballs one at a time does
  not work: npm then looks the missing `@cancore` versions up on the registry. Install tarballs, not
  package folders (npm links a folder instead of copying it).
- `/opt/cancore-bot` is created by npm, root-owned `0755`; nothing in it is writable by group or
  others. The last line links `cancore-bot`, `cancore-botd` and `cancore-bot-mcp` into
  `/usr/local/bin`, which is on sudo's `secure_path` on Debian and Ubuntu.
- After the install nothing runs from the clone. Keep it anyway: it has the
  [skill](../../skills/cancore-trading/SKILL.md) for the agent, and you upgrade from it.

## Install

1. **Install the code** with the recipe [above](#install-from-source-until-it-is-on-npm). It
   leaves `cancore-bot`, `cancore-botd` and `cancore-bot-mcp` in `/usr/local/bin`.

2. **Create the user, group, directories and unit.** `--human` adds the user the agent runs as to
   `cancore-bot-clients`; `--dry-run` prints the plan and the unit without changing anything.

   ```sh
   sudo cancore-bot install --human "$USER" --dry-run
   sudo cancore-bot install --human "$USER"
   ```

   This creates `cancore-bot-clients`, the system user `cancore-bot`, `/etc/cancore-bot` (`0755`),
   `/var/lib/cancore-bot` (`0700`), and `/etc/systemd/system/cancore-botd.service`, then prints
   `next: systemctl enable --now cancore-botd`. It refuses a node or daemon path that a non-root
   user could rewrite, and writes the resolved path into the unit, for example
   `ExecStart=/usr/local/bin/node /opt/cancore-bot/node_modules/@cancore/botd/dist/daemon.js` (the
   dry run shows the unresolved `/usr/local/bin/cancore-botd`). Log out and in again for the group
   to apply: `id` must list `cancore-bot-clients`.

3. **Write the config**, `/etc/cancore-bot/config.json`, owned by root, `0644`. Every field is
   optional; these are the ones you normally set:

   ```sh
   sudo tee /etc/cancore-bot/config.json > /dev/null <<'EOF'
   {
     "baseUrl": "https://api-dev.cancore.app",
     "ownerParty": "<your own wallet's party id>",
     "maxFee": "1"
   }
   EOF
   sudo chmod 644 /etc/cancore-bot/config.json
   ```

   `ownerParty` is your own party (the Wallet page shows it).

   | Field | Default | Meaning |
   | --- | --- | --- |
   | `baseUrl` | `https://api-dev.cancore.app` | the API. v1: must be https on this host |
   | `network` | unset: taken from `baseUrl` (devnet) | v1 refuses anything but `devnet` |
   | `ownerParty` | unset: every withdraw refused | the only party `withdraw` sends to |
   | `maxFee` | unset: every withdraw refused | the most CC of network fee one withdraw may pay |
   | `ordersPerHour` | `5` | new orders an hour, agent and strategies together (the platform's per-user limit) |
   | `venuePartyId`, `maxFeeRate`, `feeRecipientPartyId` | the SDK's pins for devnet | trust boundary: the API cannot move them |
   | `daemonUser` | `cancore-bot` | the daemon refuses to run as anyone else (`--dev` skips this; development only) |
   | `clientsGroup` | `cancore-bot-clients` | group allowed on `bot.sock` |
   | `stateDir` | `/var/lib/cancore-bot` | must be the daemon user's, mode `0700` |
   | `agentSocket` | `/run/cancore-bot/bot.sock` | |
   | `ownerSocket` | `/run/cancore-bot/owner.sock` | |

   **v1 runs on devnet only.** The daemon refuses to start unless `baseUrl` is https on
   `api-dev.cancore.app` and `network` is unset or `devnet`: `cancore-botd v1 runs on devnet only;
   <url> is <network>`. Setting `network` or `venuePartyId` does not let another host through.

   Strict JSON: an unknown or misspelt key, or a wrong type, stops the daemon at start. The file must
   be owned by root (or the daemon user), not writable by group or others, not a symlink. A missing
   file at the default path means all defaults (so withdraw is refused). The config is read once at
   start: restart the daemon (then `unlock`) after a change.

4. **Create the keystore.** Three ways, each asking for a passphrase (twice) at the end; it must
   pass the policy in [Keystore](#security-model). All three need a terminal.

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
     `cancore-bot` with mode `0600` (no group or other bits), and not be a symlink:

     ```sh
     sudo install -o cancore-bot -g cancore-bot -m 600 /dev/stdin /var/lib/cancore-bot/import.key  # paste, Ctrl-D
     sudo -u cancore-bot cancore-bot init --import-key /var/lib/cancore-bot/import.key
     sudo shred -u /var/lib/cancore-bot/import.key
     ```

     The keystore stores the raw key either way; a key has no phrase, so keep the file's content as
     the backup.

   It prints the bot's public key: `{"publicKey": "<64 hex>"}`.

5. **Start the daemon.**

   ```sh
   sudo systemctl enable --now cancore-botd
   journalctl -u cancore-botd -f    # "cancore-botd listening on …"
   ```

6. **Unlock, register and onboard the account** (both prompt at the terminal):

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

8. **Set limits.** Until you do, every trade is refused (`rate_limited` first:
   `maxCommandsPerMinute` 0 is checked before anything else). Write a file and hand it over on
   stdin:

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

   **The `/dev/stdin` trap.** The CLI runs as `cancore-bot` and opens `/dev/stdin` again, and the
   kernel checks that open against the file itself. So `limits.json` must be readable by others
   (`644`, what the usual umask 022 gives): a `600` file fails, and so does a pipe
   (`cat limits.json | …`), with `cancore-bot: EACCES: permission denied, open '/dev/stdin'`. Limits
   are not secret: keep the file `644` and use `<`, never a pipe.

   | Field | Meaning | Omitted |
   | --- | --- | --- |
   | `allowedPairs` | `BASE/QUOTE` pairs that may trade (max 100); a take may match either orientation | none |
   | `maxOrderAmount` | per base instrument: one order's amount | nothing allowed |
   | `maxOrderNotional` | per quote instrument: one order's amount × price | nothing allowed |
   | `maxDailyVolume` | per base instrument: rolling 24 h fills + every open order on it as if filled + this order | nothing allowed |
   | `maxPosition` | per base instrument: net position if every open order on the side this order adds to filled | nothing allowed |
   | `maxOpenOrders` | open orders at once, including takes not settled yet and unconfirmed intents (0–1000) | `0` |
   | `maxPriceDeviationBps` | max distance of the price from the market rate, in bps (0–10000) | `0`: only the exact market rate passes |
   | `maxCommandsPerMinute` | trade commands per minute (0–600) | `0`: every trade `rate_limited` |
   | `perOrderUsd` | one order's value in USD | every trade `usd_cap_missing` |
   | `perDayUsd` | USD of 24 h fills (at fill-time value) + open orders + unconfirmed intents + this order | every trade `usd_cap_missing` |
   | `usdCapsOptOut` | `true` turns both USD caps off, explicitly | `false` |

   Amounts are decimal strings, positive, at most 15 integer and 10 fraction digits. Unknown fields
   are rejected. The daemon stores the limits in `/var/lib/cancore-bot/limits.json`; `limits show`
   prints them with the defaults filled in.

   USD values use the Cancore API's price per instrument (`sourcePriceUsd` of the listed pairs; a
   token that is only ever a pair's target is valued through the market rate, rounded up, the
   highest of several), fetched fresh for every decision, never from disk. An instrument without a
   USD price refuses the trade (`usd_price_missing`). A fill with no USD price at fill time is logged
   `usdValue: "unpriced"` and, while it is in the 24 h window, every trade is `usd_daily_exceeded`.

   The gate checks in this order, and the first failing check is the reason: locked → paused →
   `rate_limited` (per minute) → `instrument_not_allowed` → no reference price
   (`price_deviation_exceeded`) → per order (`no_rule` for a zero or negative amount or price,
   `price_deviation_exceeded`, `order_size_exceeded`, `notional_exceeded`) →
   `daily_volume_exceeded` → `position_exceeded` → `open_orders_exceeded` → USD (`usd_cap_missing`,
   `usd_price_missing`, `usd_order_exceeded`, `usd_daily_exceeded`) → for `order.make` the hourly
   budget (`rate_limited`). Takes: the order must be open, on an allowed pair (either orientation),
   and the amount the whole order, else `no_rule`.

9. **Check** (after a restart, `unlock` again first):

   ```sh
   sudo -u cancore-bot cancore-bot status
   ```

   Then connect the agent: [`@cancore/bot-mcp`, Setup from source](../bot-mcp/README.md#setup-from-source).

## How orders are tracked

**The book.** On unlock the daemon starts the settlement loop and reconciles orders that settled or
ended while it was down, and orders whose creation it could not confirm (below). While it runs it
reconciles the book every 30 s (a failed lookup backs off, doubling, at most 15 minutes): an order
stays booked, with its full reservation against the limits, until the venue shows how it ended —
completed by this account (booked as a fill once), taken by another account or ended (off the book,
no fill). Each 5 s tick reconciles first and only then lets strategies step, so a pause it raises
stops them in the same tick. A settle that arrives while the daemon is locked stays booked
(`settle_deferred` in the audit log) and the unlock's reconcile books it, priced.

**Takes, and `release`.** A take whose accept answer was lost stays booked, holding its open-order
slot and its reservation, for as long as the maker's order stays open — the daemon cannot tell
whether that accept landed, and releasing it early could let a real trade escape the limits. The
owner releases a booking with `cancore-bot release <orderId>` (`order.release`). The daemon calls the
queued take off either way (a refused release stops its retries too) and reads the order on the
venue. Taken by another account or ended → released, no fill. Still open with no taker → released
only if this unlock booked the take first and no accept of it is out: none was sent, or the venue
refused each one (a 4xx; a 409 only when it asks for a fee holding; never a 408). The venue claims an
order only at the end of a slow accept, so an open order proves nothing about an accept already
sent. Anything else (an accept in flight, one whose answer was lost, a booking from before this
unlock, this account as taker, a taker not reported yet, completed by this account) is refused with
`may_be_trade` and stays booked until the venue refuses that accept or shows how the order ended
(the venue cancels an open order once it expires). `pause` likewise keeps a take booked under an
earlier unlock. A fill on an order the book does not know pauses trading (`unbooked_fill`); a settle
for an order not on the book while intents are unresolved is held (`settle_pending`) and judged once
they drain, at most after an hour.

**Crash safety.** Every `order.make` (agent or strategy) is written to the state file as an intent,
with a client key, before the API is called; the key rides on the order as its description. An
unconfirmed intent counts as an open order for the risk gate. On unlock and on its ticks the daemon
looks for the order among one page of 100 of the bot's orders (the API's default order): by the
key, or, if the API rewrote the description, by the same pair, side and amounts created within 10
minutes of the intent. A match is adopted onto the book (and settles or ends like any other,
including a fill that happened while it was an intent); no match twice, a minute apart, drops the
intent. Intents younger than 60 s are not looked up at all. Limit: two identical orders within that
window, both with their description rewritten, cannot be told apart.

**Lost answers.** A make whose answer never arrives — a network error, a 5xx, a 408 or 429, the
engine's 20 s request timeout, or the socket's 30 s timeout of a trade method — returns
`unconfirmed` (code -32005) and keeps its intent; a strategy stays `running` and its slot stays
held. Each tick looks the intents up the same way an unlock does (unlock does it in the
background); a lookup that fails backs off (2, 4, 8 … minutes, at most 15). A dropped intent frees
the slot, so the strategy places it again. Any other 4xx (including a DvP refusal) is a definite
no: the intent and its hourly slot are dropped at once, and the caller gets `-32603 internal error`
(`daemon_error` through bot-mcp). An agent must not repeat an `unconfirmed` make: that is how
duplicates happen.

## Day to day

All commands run as `sudo -u cancore-bot cancore-bot …`, except `install`
(`sudo cancore-bot install …`). `--config <path>`, before or after the command, points at another
config (`cancore-botd --config <path>` too).

| Command | Does |
| --- | --- |
| `init` | new keystore from a new 24-word phrase: shown once, three random words asked back, then the passphrase twice; prints the public key. Refuses to overwrite an existing keystore. |
| `init --import` | from a phrase you type (account 0 of it): use a phrase made for this bot, never your wallet's |
| `init --import-key <file>` | from the 64-hex key "My bots" shows; the file must be owned by `cancore-bot`, mode `0600` (no group/other bits), not a symlink |
| `unlock` / `lock` | decrypt the key into the daemon / wipe it (lock also stops the strategies' loop and settlement until the next unlock) |
| `register` | register the account (invite code prompted, Enter for none), onboard its party, print `partyId` |
| `status` | `locked`, `paused`, `pauseReason`, `partyId`, strategies, `version` |
| `limits show` / `limits set <file>` | read / replace the limits (`limits set /dev/stdin < limits.json`) |
| `pause [reason]` / `resume` | stop trading (below) / lift a pause, the owner's alone |
| `release <orderId>` | drop a booked take once no accept of it can land |
| `withdraw --to <party> --instrument <CC or token id> --amount <n>` | only to `ownerParty`, needs `maxFee` and an unlocked daemon |
| `audit verify` | re-walks the hash chain: `{ok, entries}` or `{ok: false, brokenAt}`; exit 3 if broken |
| `install [--human <user>] [--exec <path>] [--dry-run]` | creates the group, user, directories and the systemd unit; `--dry-run` prints the plan and the unit |

A terminal is needed for `init` (all forms), `unlock` and `register`. Exit codes: 0 ok, 1 error
(`cancore-bot: <code> <message>` on stderr, e.g. `cancore-bot: -32002 unlock failed`), 2 usage,
3 broken audit chain. Answers are JSON on stdout, for example `status` while locked:
`{"locked": true, "paused": false, "strategies": [], "version": "0.1.0-rc.0"}`.

```sh
sudo -u cancore-bot cancore-bot status
sudo -u cancore-bot cancore-bot pause "going on holiday"
sudo -u cancore-bot cancore-bot resume
sudo -u cancore-bot cancore-bot lock
sudo -u cancore-bot cancore-bot withdraw --to <ownerParty> --instrument CC --amount 100
sudo -u cancore-bot cancore-bot release <orderId>
sudo -u cancore-bot cancore-bot audit verify
```

- **`pause`** marks the daemon paused first, so nothing new passes the gate. It stops every running
  strategy for good (`status: "stopped"`, `reason: "paused"`): `resume` does not restart it, start
  it again. It cancels the bot's own resting orders and calls off queued takes whose accept was not
  sent; accepted takes, and takes booked under an earlier unlock, stay booked and settle. While the
  daemon is locked it can cancel nothing. Only `resume` (owner) lifts a pause; the agent can pause
  (`trade_pause`), not resume. A pause the daemon raises itself (`unbooked_fill`, a broken audit log
  at start) leaves strategies and resting orders as they were: they continue after `resume`. Reads,
  cancels, `withdraw`, `limits set` and `release` all work while paused.
- **`lock`** wipes the key and stops the strategies' loop and the settlement loop: while locked the
  daemon signs nothing, so a trade already under way continues only after the next `unlock`.
  Strategies stay `running` and resume on that unlock. `register`, `withdraw`, `release` and the
  agent's trades, balances, quotes and cancels need the daemon unlocked (`-32002` otherwise).
- **`release <orderId>`** answers `{"orderId": …, "released": true}`, or refuses:
  `-32602 not released: no booked take with this id` (`not_a_take`), `-32603` with "try again" when
  the venue could not be read, `-32602` `may_be_trade` while an accept may still land
  ([Takes](#how-orders-are-tracked)).
- **`withdraw`** needs the daemon unlocked, `--to` equal to `ownerParty`, and `maxFee` in the
  config; it works while paused. `--instrument CC` sends CC; anything else is the token id. Any other
  `--to`: `-32004 withdraw goes only to the owner party pinned in the config`.
- **`audit verify`** checks the chain itself: a log cut at its end still verifies (`ok: true`, fewer
  entries); the daemon catches that case at start against the state file.
- The owner CLI has no command to place, take or list orders: the agent does that, or the web app.

## Strategies

`strategy.start` with `kind: "grid"` or `"dca"`; the config schemas are `gridConfig` / `dcaConfig`
in `src/riskgate.ts`.

- **grid** `{ side, levels (1–100), amountPerLevel, lowerPrice, upperPrice }` places
  `amountPerLevel` at `levels` prices spaced evenly from `lowerPrice` to `upperPrice`. Every level
  starts with an order on `side`, so a buy grid opens with a buy at every level, the levels at and
  above the market price included. A filled buy is sold one level up, a filled sell bought back one
  level down; the edge levels have no level beyond them. At start the gate checks all `levels`
  orders at once: both edge prices within `maxPriceDeviationBps`, `maxOpenOrders`, daily volume,
  position and the USD caps.
- **dca** `{ side, amountPerOrder, intervalSeconds (60 s – 30 days), maxOrders (1–10000) }` places
  `amountPerOrder` at the reference price every `intervalSeconds`, `maxOrders` in total. At start the
  gate checks one day's orders, min(`maxOrders`, ⌈86400 / `intervalSeconds`⌉), as if all of them
  rested at once, at the reference price, so `maxOpenOrders` must hold that many. With no reference
  price the start is refused `no_rule`, and a running DCA places nothing until a price is back.

Every strategy order is an `order.make` through the same trade lock, risk gate, audit log and
engine as an agent's. A refusal stops the strategy (`status: "denied"`, `reason` in `status`); the
daemon keeps running. Statuses: `running`, `rate_limited` (waiting for the hourly budget), `denied`
(a gate refusal), `failed` (another error, such as the API refusing an order), `stopped`
(`strategy.stop` or `pause`), `done` (a DCA placed all its orders). Strategy state lives in the
state file, and running strategies resume on unlock without placing a level (grid) or seq (dca)
twice. `pause` and `strategy.stop` stop the strategy for good and cancel its resting orders. A
strategy order cancelled by hand (`order.cancel`, `orders.cancelAll`, or in the web app) is not
placed again: its slot is listed in the strategy's `cancelledByUser` in `status`.

**Rate limit.** The platform accepts 5 new orders an hour per user. The daemon keeps one budget,
`ordersPerHour` in the config (default 5), for the agent and every strategy together. A strategy
that finds it spent waits with `status: "rate_limited"`; an agent's `order.make` past it is refused
with `rate_limited`.

## Examples

Prices, amounts and ids below are illustrative; the arithmetic is what the gate computes.

### Narrow limits for the first week

```json
{
  "allowedPairs": ["CC/USDCx"],
  "maxOrderAmount": { "CC": "100" },
  "maxOrderNotional": { "USDCx": "20" },
  "maxDailyVolume": { "CC": "500" },
  "maxPosition": { "CC": "300" },
  "maxOpenOrders": 3,
  "maxPriceDeviationBps": 200,
  "maxCommandsPerMinute": 5,
  "perOrderUsd": "20",
  "perDayUsd": "75"
}
```

One order is at most 100 CC, 20 USDCx of notional and $20; in 24 h at most 500 CC, counting open
orders; even if every open order fills, the position stays within ±300 CC; at most 3 open orders;
the price within 2% of the market rate; at most 5 trade commands that passed the gate in a minute;
at most $75 a day of fills, open orders and the new one. On top of that, the platform's 5 new orders
an hour (`ordersPerHour`).

### A one-off sell near the market

The agent asks `trade_quote { "base": "CC", "quote": "USDCx", "side": "sell", "amount": "100" }`
(the pool's price, say `0.1500`), then places
`trade_order_make { "base": "CC", "quote": "USDCx", "side": "sell", "amount": "100", "price": "0.1515", "ttlSeconds": 86400 }`.
Against the first-week limits: 100 ≤ 100; 100 × 0.1515 = 15.15 ≤ 20; 1% from 0.1500 < 2% (the gate
compares with its own reference, the API's market rate, not with the quote); about $15 ≤ $20 if CC
is ~$0.15. 150 CC is `order_size_exceeded`; a price 10× below the market is
`price_deviation_exceeded`. The ttl rounds up to whole hours (24 h here).

### A grid, and its economics

The agent calls `trade_strategy_start` with:

```json
{ "kind": "grid", "base": "CC", "quote": "USDCx",
  "config": { "side": "buy", "levels": 3, "amountPerLevel": "50", "lowerPrice": "0.1475", "upperPrice": "0.1525" } }
```

Levels 0.1475, 0.1500, 0.1525; the step 0.0025 is ≈ 1.67% of 0.15. A round trip is two fills:
assuming a 0.5% fee per fill, ≈ 1% in fees, leaving ≈ 0.67% for slippage and network cost; a step
under ~1% loses on every cycle. (The venue sets the fee and the SDK refuses a rate above
`maxFeeRate`; pin `maxFeeRate` to the rate you plan around.) The gate at start, all levels at once:
0.1475 and 0.1525 are 1.67% from a 0.1500 reference (< 2%; do not put a level right at the edge —
the market moves); 3 orders ≤ `maxOpenOrders` 3 (the grid then holds every open-order slot); position
3 × 50 = 150 ≤ 300; daily 150 ≤ 500; notional 50 × 0.1525 = 7.625 ≤ 20. With 5 new orders an hour
shared with the agent, 3 levels are placed within the hour; 20 levels would need 4 hours. The grid
opens with three buys, and the ones at 0.1500 and 0.1525 (at and above the market) are the first a
seller takes. A filled buy is sold one level up; the top level's fill has no level above it.

### DCA for a week

The agent calls `trade_strategy_start` with:

```json
{ "kind": "dca", "base": "CC", "quote": "USDCx",
  "config": { "side": "buy", "amountPerOrder": "50", "intervalSeconds": 21600, "maxOrders": 28 } }
```

50 CC every 6 hours, 28 orders. The gate checks one day at start, as if all of its orders rested
at once: min(28, ⌈86400 / 21600⌉) = 4 orders, 4 × 50 = 200 CC ≤ 500 daily, ≤ 300 position — but
4 open orders > `maxOpenOrders` 3, so with the first-week limits this start is refused
`open_orders_exceeded`. Raise `maxOpenOrders` to 4 (more if other orders rest at the same time).
Each order is then gated again: once 300 CC are bought or resting, the 7th order is
`position_exceeded` and the strategy stops (`denied`); for the whole week `maxPosition` needs
≥ 1400. Unfilled orders also pile up: at `maxOpenOrders` the strategy waits (it is not denied).

### A refusal, and `unconfirmed`

"Why did the last order fail?" The agent reads `trade_audit_tail { "n": 10 }`: each refused command
is an entry with `"decision": "deny"` and the reason. The owner sees the full entries, and checks the
chain:

```sh
sudo -u cancore-bot cancore-bot audit verify          # exit 0: intact, 3: broken
sudo tail -n 5 /var/lib/cancore-bot/audit.jsonl
```

- `price_deviation_exceeded` on every order priced near the market: most likely there is no
  reference price (the price feed is down). Wait; do not widen the corridor for it.
- `rate_limited`: more than `maxCommandsPerMinute` trade commands in the last minute, or the hourly
  budget of 5 new orders is spent (a grid often spends it).
- `unconfirmed` (-32005): the make's answer was lost and the order may exist. Do not repeat it.
  Within minutes `trade_orders_list` shows the order if it was created; if it was not, the daemon
  drops the intent and frees the slot.

### Emergency stop and withdraw

```sh
sudo -u cancore-bot cancore-bot pause "investigating"
sudo -u cancore-bot cancore-bot status
sudo -u cancore-bot cancore-bot withdraw --to <ownerParty> --instrument CC --amount 500
sudo -u cancore-bot cancore-bot lock
```

`pause`: strategies stopped (start them again after `resume`), resting orders cancelled, queued
takes called off; accepted takes still settle while unlocked. `withdraw` works while paused (it is
an owner method) and needs the daemon unlocked and `maxFee`. `lock` then stops everything,
settlement included: a trade already under way finishes after the next `unlock`. Tokens other than
CC are withdrawn the same way, with the token id in `--instrument`.

## Recovery and upgrades

### After a restart

The daemon always starts locked, after a reboot, a `systemctl restart` or a crash (the unit has
`Restart=on-failure`), and trading waits for you:

```sh
sudo -u cancore-bot cancore-bot unlock
```

On unlock it reconciles in the background: orders that settled or ended while it was down, and
intents whose creation it could not confirm. Strategies that were running resume. bot-mcp
reconnects by itself.

### Lost passphrase, phrase kept

```sh
sudo -u cancore-bot mv /var/lib/cancore-bot/keystore.json /var/lib/cancore-bot/keystore.json.lost
sudo -u cancore-bot cancore-bot init --import      # the bot's phrase, then a new passphrase
sudo -u cancore-bot cancore-bot unlock
```

The same key comes back (the same public key), under the new passphrase. `init` refuses to
overwrite a keystore (`keystore: /var/lib/cancore-bot/keystore.json already exists; refusing to
overwrite`), hence the `mv`. A bot made with `--import-key`: the same, with the key file again.
There is no command that changes a passphrase; these steps set a new one. Without the phrase (or the
key file) the key cannot be recovered.

### Moving to a new machine

Run one daemon per bot account: stop the old one for good before you unlock the new one. Each keeps
its own book, and a fill the other one made is an `unbooked_fill` that pauses it. The owner CLI has
no orders command: before you stop the old daemon, check what is still open in the web app or ask
the agent (`trade_orders_list`); `pause` cancels the bot's own resting orders. On the new machine:
install, config, `init --import` (or `--import-key`), start, `unlock` (the first unlock onboards the
account and learns its `partyId`), and set the limits again. The new state starts empty: there is no
24 h history, so the daily caps count from zero.

### Upgrading

```sh
cd sdk && git pull
npm ci
rm -rf packs && mkdir packs
npm pack --silent --pack-destination packs \
  -w @cancore/contracts -w @cancore/wallet -w @cancore/client \
  -w @cancore/trader -w @cancore/botd -w @cancore/bot-mcp
sudo systemctl stop cancore-botd
sudo rm -rf /opt/cancore-bot
sudo npm install --prefix /opt/cancore-bot ./packs/*.tgz
sudo systemctl start cancore-botd
sudo -u cancore-bot cancore-bot unlock
```

The links and the unit keep pointing at the same paths; the state, limits, keystore and audit log in
`/var/lib/cancore-bot` are untouched, and the old passphrase still unlocks. Run
`sudo cancore-bot install` again only if the node binary moved (the unit names its path).

### Removing it

First `pause`, `withdraw` what is on the bot to `ownerParty`, and `lock`. Then:

```sh
sudo systemctl disable --now cancore-botd
sudo rm /etc/systemd/system/cancore-botd.service && sudo systemctl daemon-reload
sudo rm -f /usr/local/bin/cancore-bot /usr/local/bin/cancore-botd /usr/local/bin/cancore-bot-mcp
sudo rm -rf /opt/cancore-bot
sudo rm -rf /var/lib/cancore-bot /etc/cancore-bot      # the keystore and the audit log: keep copies if you want them
sudo userdel cancore-bot && sudo groupdel cancore-bot-clients
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `cancore-botd must run as cancore-bot` | started by hand as another user | run it through systemd (`--dev` skips the check, for development only) |
| the daemon exits: `cancore-botd v1 runs on devnet only; <url> is <network>` | `baseUrl` is not on `api-dev.cancore.app`, or `network` is set to something other than `devnet` | use the default `baseUrl` and leave `network` unset: v1 runs on devnet only, and `network` or `venuePartyId` do not let another host through |
| the daemon exits: `<url> must be an https URL` | `baseUrl` is not https | `https://api-dev.cancore.app` |
| the daemon exits: `/etc/cancore-bot/config.json: writable by group or others` / `owned by uid …`, or `config: <field>: …` | the config's mode or owner, or an unknown key or a wrong type in it | `sudo chown root:root` and `sudo chmod 644` it; fix the field; restart |
| `sudo cancore-bot …` fails with `env: 'node': No such file or directory`, or `install` with `<path> is owned by uid …: install cancore-botd and node where only root can write` | no system-wide Node (nvm's is on your own `PATH` only), or node or the package lives where a non-root user can write | a system-wide Node.js 20+ (`sudo node --version` must work), then [Install from source](#install-from-source-until-it-is-on-npm) again |
| `a TTY is required to enter secrets` | `init`, `unlock` or `register` from a pipe or a script | run it in a terminal |
| `keystore: passphrase rejected (<code>): …` | a new keystore's passphrase fails the policy | a longer one: 12+ characters, letters with digits or symbols, no common word or repeated pattern |
| `keystore: … already exists; refusing to overwrite` | `init` on an existing keystore | move the old one aside only if you hold its phrase |
| `-32002 unlock failed` | a wrong passphrase, or `keystore.json` missing, corrupt, or with another owner or mode (any group or other bit): the daemon answers the same for all of them | retry; `sudo ls -l /var/lib/cancore-bot/keystore.json` must show `-rw-------` and `cancore-bot`; with the phrase, see [Recovery](#lost-passphrase-phrase-kept) |
| `-32002 keystore is locked` on `register`, `withdraw` or `release` | the daemon is locked | `unlock` first |
| `<file> is readable by group/others …; chmod 600 it` / `<file> is not owned by the current user` | `init --import-key` with a key file `cancore-bot` does not own at mode `0600` | write it with `sudo install -o cancore-bot -g cancore-bot -m 600 /dev/stdin …` as in step 4 |
| CLI `connect ENOENT` / `EACCES` | daemon not running, or CLI not run as `cancore-bot` | `systemctl status cancore-botd`; use `sudo -u cancore-bot` |
| `limits set` fails: `EACCES: permission denied, open '/dev/stdin'` | `limits.json` is not readable by others (e.g. `600`), or it came through a pipe | `chmod 644 limits.json`, and pass it with `<`, never a pipe |
| agent gets `socket_unavailable` | not in `cancore-bot-clients`, or no relogin | `id` should list the group |
| every trade `rate_limited` | `maxCommandsPerMinute` is `0` (no limits set yet) | set it |
| `order.make` `rate_limited` with `maxCommandsPerMinute` set | the hourly `ordersPerHour` budget is spent | wait; it is the platform's limit |
| `register` fails (`-32603 internal error`), or after the first unlock the audit log has `not registered: run cancore-bot register` | a new account, or a wrong invite code | `cancore-bot register` with the right code |
| paused with `pauseReason: unbooked_fill` | a trade settled on the bot account that the daemon never booked (for example one made by hand in the web app on the bot's account); the limits cannot account for it, so the bot stops placing orders (orders already resting stay on the venue and can still fill; strategies continue after `resume`) | check the audit log and the account's orders, then `cancore-bot resume`; do not trade by hand on the bot account |
| `order.cancel` fails with `reason: not_open` (`not_open` through bot-mcp) | the venue shows the order taken, settling or ended; cancelling it could leave an HTLC that still executes, so the daemon keeps it booked as a trade | nothing to do: it settles or ends on its own (audit log) |
| `order.cancel` answers `cancelled: true` but the order is still in `orders.list` (`trade_orders_list`) | the venue did not answer the status read, so the cancel was sent unconfirmed; the order stays booked (it still counts against open orders) until reconcile sees it ended, within about 30 s once the venue answers | nothing |
| a take stays in `trade_orders_list` for a long time, and `release` answers `may_be_trade` | its accept answer was lost and the maker's order is still open with no taker; it is kept booked on purpose ([Takes](#how-orders-are-tracked)) | nothing; it comes off once the order is taken by someone else, cancelled or expired |
| every trade `usd_cap_missing` | `perOrderUsd` or `perDayUsd` not set | set both, or `usdCapsOptOut: true` |
| every trade `usd_daily_exceeded`, audit shows a settle with `usdValue: "unpriced"` | a fill settled while the API gave no USD price (or one from before USD caps) is in the 24 h window; its value is unknown, so the whole day counts as spent | wait until that fill is 24 h old, or set `usdCapsOptOut: true` (owner, `limits.json`) to trade without USD caps meanwhile |
| every trade `usd_price_missing` | the API gives no USD price for an instrument involved | wait for the price feed; check the pair is listed |
| every trade `price_deviation_exceeded` | no market rate for the pair (feed down, unknown pair), or price too far | check the pair is listed; widen `maxPriceDeviationBps` only if the price really is too far |
| starts `paused` with `audit log truncated or broken` | the log lost entries the state had seen | `audit verify`, investigate, then `resume` |
| `withdraw goes only to the owner party pinned in the config` | `--to` differs, or no `ownerParty` | set `ownerParty`, restart the daemon, `unlock` |

## Not implemented yet

- `orders.list` knows only the daemon's open orders: `filled` and `cancelled` return an empty list.
- `balances` has no `locked` amount: the SDK does not list a party's allocations.
- `quote` for a buy sizes the pool request from the market rate, so the base amount it returns is
  close to the one asked, not exact.
- Networks other than devnet, and order types other than Canton DvP.
- A remote transport: the agent must run on the same machine as the daemon.
- Platforms other than Linux with systemd.
