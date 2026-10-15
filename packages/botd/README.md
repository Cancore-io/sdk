# `@cancore/botd`

```sh
npm install @cancore/botd
```

A self-custody trading daemon for Cancore. It holds one bot account's key, trades for it through
the API, and lets an AI agent (through [`@cancore/bot-mcp`](../bot-mcp)) place trades only inside
limits the owner set.

- `cancore-botd` — the daemon: encrypted keystore, default-deny risk gate, hash-chained audit log,
  two local unix-socket JSON-RPC 2.0 endpoints (agent and owner).
- `cancore-bot` — the owner CLI: `init`, `unlock`/`lock`, `status`, `limits show|set`,
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
`feeRecipientPartyId` and `network` come from the config.

**Risk gate.** Default-deny: omitted limits allow nothing. Every trade command is checked against
fresh reference prices; if the price feed is unreachable there is no reference and the gate
refuses. The decision is written to the audit log before anything touches the key.

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
     "baseUrl": "https://api.cancore.io",
     "network": "mainnet",
     "ownerParty": "<your own wallet's party id>",
     "maxFee": "1"
   }
   ```

   `ownerParty` is your own party (the Wallet page shows it). Defaults: `daemonUser` `cancore-bot`,
   `clientsGroup` `cancore-bot-clients`, `stateDir` `/var/lib/cancore-bot`, `agentSocket`
   `/run/cancore-bot/bot.sock`, `ownerSocket` `/run/cancore-bot/owner.sock`, `baseUrl`
   `https://api.cancore.io`. Pinned fee fields (`venuePartyId`, `maxFeeRate`, `feeRecipientPartyId`)
   default to the SDK's values for Cancore's hosts.

4. **Create the keystore.** `init` asks for a recovery phrase and a passphrase. It derives the key
   at account 0 of that phrase, so **use a new phrase made for this bot, never your wallet's phrase**
   (account 0 of your wallet phrase is your own wallet). `init` does not generate a phrase yet; make
   one with the wallet package and write it down offline — it is the only backup of the key:

   ```sh
   node --input-type=module -e "import('@cancore/wallet').then(w => console.log(w.newMnemonic(256)))"
   sudo -u cancore-bot cancore-bot init
   ```

   It prints the bot's public key. Pick a long passphrase; it is what stands between a copy of
   `keystore.json` and the key.

5. **Register and onboard the account.** The daemon does **not** register an account or onboard a
   party (it never signs topology). Do it once with the SDK, with the same phrase, in a short script
   you run by hand and delete (the phrase typed in, never saved):

   ```ts
   import { providerFromMnemonic } from '@cancore/wallet';
   import { createSelfCustody } from '@cancore/client/selfcustody';

   const signer = await providerFromMnemonic(process.env.PHRASE!); // account 0, as `init` derives
   const bot = createSelfCustody({ baseUrl: 'https://api.cancore.io', signer });
   await bot.session.register({ inviteCode: process.env.CANCORE_INVITE_CODE! });
   const me = await bot.onboard();
   console.log('party', me.partyId);
   ```

   ```sh
   read -rs PHRASE && PHRASE="$PHRASE" npx tsx onboard.ts && unset PHRASE
   ```

   See the [partner guide, section 4](../../docs/partner-guide.md#4-registration-and-onboarding) for
   registration (invite code, `409`, `FAILED`) and [Run a bot, section 5](../../docs/run-a-bot.md#5-onboard)
   for what `onboard()` checks. The printed `partyId` is the bot's address. `cancore-bot status`
   does not show it yet.

6. **Start the daemon.**

   ```sh
   sudo systemctl enable --now cancore-botd
   journalctl -u cancore-botd -f    # "cancore-botd listening on …"
   ```

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
     "maxCommandsPerMinute": 10
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

   Amounts are decimal strings, at most 15 integer and 10 fraction digits. Unknown fields are
   rejected.

9. **Unlock**, and check:

   ```sh
   sudo -u cancore-bot cancore-bot unlock
   sudo -u cancore-bot cancore-bot status
   ```

   On unlock the daemon starts the settlement loop and reconciles orders that settled or ended while
   it was down.

## Day to day

```sh
sudo -u cancore-bot cancore-bot status                 # locked, paused, strategies, version
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
| every trade `price_deviation_exceeded` | no market rate for the pair (feed down, unknown pair), or price too far | check the pair is listed; widen `maxPriceDeviationBps` |
| starts `paused` with `audit log truncated or broken` | the log lost entries the state had seen | `audit verify`, investigate, then `resume` |
| `withdraw goes only to the owner party pinned in the config` | `--to` differs, or no `ownerParty` | set `ownerParty`, restart the daemon |
| `strategy.start` returns an internal error | grid and dca loops are not implemented yet | place orders with `order.make` |

## Not implemented yet

- The grid and dca strategy loops: `strategy.start` passes the risk gate and then fails.
- `init` does not generate a phrase; registration and onboarding are done with the SDK (step 5).
- `status` does not report the bot's `partyId`.
- `orders.list` knows only the daemon's open orders: `filled` and `cancelled` return an empty list.
- `balances` reports `locked` as `0`.
- Platforms other than Linux with systemd.
