# Partner guide: trading on Canton with `@cancore/client`

For a partner who runs a trading bot or a market maker on Canton through Cancore with a
**self-custody** account. Your program holds the key. Cancore never sees it.

Written against `@cancore/client` **0.8.0** and `@cancore/wallet` **0.2.0**. Every snippet uses
the published API. The full examples in [section 11](#11-full-examples) are in this repository and
typechecked in CI (`packages/client/examples/`).

1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Seed and key management](#3-seed-and-key-management)
4. [Registration and onboarding](#4-registration-and-onboarding)
5. [Funding and wallet management](#5-funding-and-wallet-management)
6. [Orders](#6-orders)
7. [Settling trades](#7-settling-trades)
8. [Cashback](#8-cashback)
9. [Errors and troubleshooting](#9-errors-and-troubleshooting)
10. [Security checklist and going to mainnet](#10-security-checklist-and-going-to-mainnet)
11. [Full examples](#11-full-examples)

## 1. Overview

What you get:

- **A self-custody Canton account.** Its party is created by a topology transaction your key
  signs. Every later step that needs the account's authority comes back from the API as a
  prepared transaction. The SDK checks it, your key signs it, and only the signature is sent.
- **Atomic settlement.** Every Canton↔Canton trade settles through **allocation-DvP**. Both legs
  and the platform fee move in one ledger transaction. There is no hash lock, no escrow and no
  HTLC fallback. Either the whole trade settles or nothing moves.
- **Partner economics.** An account with the `partner-bot` role (granted by your invite code)
  can earn cashback on the platform fee of trades it takes from other automated accounts. Which
  trades qualify is narrower than "every trade": see [section 8](#8-cashback). Partner accounts pay
  **no network fee**.

What stays on your side: the recovery phrase (or the derived key) and the signer built from it.
`@cancore/client` takes a signer object and nothing else. It has no code path that sends key
material anywhere.

**What the SDK checks before every signature.** A signature covers the hash of a prepared
transaction, so a dishonest or compromised API could ask you to sign something other than your
trade. Before your key signs a DvP step, the SDK:

- recomputes the hash from the transaction bytes and refuses on any difference;
- requires the proposal steps to run Cancore's `cancore-swap` package, pinned by name **and**
  package id (`DEFAULT_TRUSTED_PACKAGES`);
- requires allocations to go through the token standard's `AllocationFactory`, signed by a pinned
  instrument admin (`DEFAULT_INSTRUMENT_ADMINS`: the DSO for CC, the CBTC/USDCx/HECTO registrars);
- holds every leg to the order: amounts, instruments, the counterparty, the venue as settlement
  executor, and a fee no higher than your ceiling (`maxFeeRate`, default 1.5%), paid only to one of
  Cancore's fee parties (`DEFAULT_FEE_RECIPIENTS`);
- refuses any transfer or lock for a party outside the trade, and any deadline more than 3 hours
  ahead (`maxSettlementWindowMs`).

If a check fails, the SDK signs nothing and throws a `CeremonyError` at the `prepare` stage:

```text
CeremonyError: dvpCreateProposal prepare failed: refusing to sign dvpCreateProposal:
  transaction 0: node 3 runs code from an untrusted package (cancore-swap 0a1b…)
SettleError: the stand's platform fee rate 0.02 is above this account's ceiling 0.015 (maxFeeRate)
```

The SDK still trusts the instrument admins it pins. Their code runs the allocation. The
[package README](../packages/client/README.md#cancoreclientselfcustody) explains exactly what
the checks guarantee and what they leave to the admins.

## 2. Prerequisites

- **Node.js 20 or newer** (CI runs 22). The packages are ESM only: use `"type": "module"` or
  `.mts`, and run TypeScript with `tsx` or compile it first.
- Install:

  ```bash
  npm install @cancore/client @cancore/wallet
  npm install socket.io-client   # optional: realtime events for serve()
  ```

- **An invite code** (`XXXX-XXXX-XXXX`) from Cancore. It is single-use, grants the `partner-bot`
  role and replaces the sign-up captcha. Ask for one per environment.

| Environment | `baseUrl` | Canton network | Notes |
| --- | --- | --- | --- |
| dev | `https://api-dev.cancore.app` | devnet | test CC from `faucet()` |
| testnet | `https://api-testnet.cancore.app` | testnet | CC has no pinned admin yet, see below |
| mainnet | `https://api.cancore.io` | mainnet | real funds |

The SDK reads the network from these hosts (`API_NETWORKS`) and picks the pinned admins and fee
parties for it. With any other host (a proxy, for example), pass `network: 'devnet' | 'testnet' |
'mainnet'`. Otherwise the SDK trusts no admin and refuses every trade.

On **testnet** the CC (Amulet) admin and the network-fee party are not pinned yet. Pass the testnet
DSO party yourself to trade CC there:

```ts
const acct = createSelfCustody({
  baseUrl: 'https://api-testnet.cancore.app',
  signer,
  instrumentAdmins: { Amulet: [process.env.TESTNET_DSO_PARTY!] }, // added to the pinned list, never replacing it
});
```

## 3. Seed and key management

One BIP39 recovery phrase can hold any number of accounts:
`m/44'/6767'/{account}'/0'/0'`. Account 0 is the same wallet the Cancore web app derives from that
phrase.

**Generate a phrase once, offline**, and put it in your secret manager:

```ts
import { newMnemonic, isValidMnemonic } from '@cancore/wallet';

const phrase = newMnemonic(256); // 24 words; newMnemonic() gives 12
console.log(isValidMnemonic(phrase)); // true
```

**Build the signer at startup** from the secret:

```ts
import { providerFromMnemonic } from '@cancore/wallet';
import { createSelfCustody } from '@cancore/client/selfcustody';

// CANCORE_MNEMONIC is injected by your secret manager. Never commit it or write it to a log.
const signer = await providerFromMnemonic(process.env.CANCORE_MNEMONIC!, { account: 0 });
const acct = createSelfCustody({ baseUrl: 'https://api-dev.cancore.app', signer });
```

`providerFromMnemonic` rejects a phrase that fails the BIP39 checksum, so a mistyped word cannot
silently derive a different, empty account. It returns `{ public_key, signMessage, signChallenge,
signPreparedHash }`, which is the signer `createSelfCustody` takes. Any other object of that shape
works too (an HSM wrapper, for example).

**Keeping only the derived key.** If the bot should not hold the phrase, derive the key once and
store `seedHex` instead. `seedHex` **is the private key**: keep it exactly like the phrase (secret
manager, never in git or a log).

```ts
import { deriveWalletKey, isValidMnemonic, hexToBytes, createEd25519Signer, createPasskeySigningProvider } from '@cancore/wallet';

// deriveWalletKey does not check the BIP39 checksum: a mistyped word derives a different, valid key.
if (!isValidMnemonic(phrase)) throw new Error('not a valid BIP39 recovery phrase');
// seedHex IS the private key: store it like the phrase (secret manager, never in git or a log).
const { seedHex, publicKeyHex } = deriveWalletKey(phrase, 'standard', 0); // once, offline
// At startup:
const signer = createPasskeySigningProvider(await createEd25519Signer(hexToBytes(seedHex)), publicKeyHex);
```

Do not pass the `deriveWalletKey` result itself as the signer. It names the key `publicKeyHex`,
not `public_key`, and `createSelfCustody` throws a `TypeError` for it.

**Backup.** The phrase is the account. Keep at least two offline copies in separate places, or use
your secret manager's own backup. With the phrase you can rebuild the account on any machine:
`login()` signs in with the key, and `onboard()` finds the existing party.

**Loss.** If you lose the phrase, the account and its funds are gone. Cancore holds no copy and
cannot recover or move them. If the phrase leaks, whoever has it controls the account: move the
funds to a new account at once ([`send()`](#5-funding-and-wallet-management)).

**Rotation.** The API cannot change an account's key. To rotate, create a new account (a new
`account` index or a new phrase, with a new invite code), move the funds with `send()`, and stop
using the old one.

## 4. Registration and onboarding

Run this once per account. Every step is safe to repeat:

```ts
import { isSdkError } from '@cancore/client';

try {
  await acct.session.login(); // an existing account: sign in with the key
} catch (err) {
  if (!isSdkError(err, 'ACCOUNT_NOT_FOUND')) throw err;
  // First run: sign up. The code rides on the sign-up request and grants partner-bot.
  const user = await acct.session.register({ inviteCode: process.env.CANCORE_INVITE_CODE! });
  // status 'FAILED' means the activation did not finish. The same key and code may register again.
  if (user.status === 'FAILED') await acct.session.register({ inviteCode: process.env.CANCORE_INVITE_CODE! });
}

const user = await acct.onboard(); // creates the Canton party (signed by the key), enables CC receipts
console.log(user.partyId, user.roles); // roles includes 'partner-bot'
```

- `register({ inviteCode, partyName?, email? })` is challenge → signed `POST /auth/register`. It
  needs no email and no captcha: an unused code (or one this same key already used) replaces the
  captcha. A `409 Public key already registered` means an earlier sign-up went through, so call
  `login()`. What a bad code returns depends on the stand: where the sign-up captcha is enabled
  (dev, for example), a code the API does not know, or one another key already used, is refused
  with **`403 Captcha is required`**, because the captcha check runs first. Without the captcha it
  is `404` (unknown) or `409` (used by another key). Check the code before anything else.
- After sign-up the session renews its JWT and signs in again on a `401` by itself. Every later run
  only needs `login()`. You can also skip it and let the first request sign in.
- `onboard()` checks `GET /auth/me` and creates the party only if it does not exist. It then
  enables the CC preapproval (venue-paid).

**Terms.** The API refuses orders until the stand's document bundle is accepted. The acceptance is
signed with the account key:

**The document list comes from Cancore.** The API records whatever you send and does not check it
against the stand's documents, so never invent or copy a key, version or URL. Put the list Cancore
gives you, for this stand, in your configuration, and refuse to start without it:

```ts
import type { ConsentedDocument } from '@cancore/client/selfcustody';

const { accepted, requiredVersion } = await acct.legalStatus();
if (!accepted && requiredVersion) {
  // A JSON array of { key, version, url }: the documents Cancore gave you and you read. No default.
  const raw = process.env.CANCORE_LEGAL_DOCUMENTS;
  if (!raw) throw new Error(`the stand requires terms ${requiredVersion}: set CANCORE_LEGAL_DOCUMENTS from Cancore's list`);
  const documents = JSON.parse(raw) as ConsentedDocument[];
  await acct.acceptTerms(requiredVersion, documents);
}
```

`requiredVersion: null` means the stand requires nothing. Acceptances are append-only, so
accepting the same version twice is harmless.

## 5. Funding and wallet management

```ts
const { balance, holdingsCount } = await acct.balance('CC'); // or 'CBTC', 'USDCx', …

// Transfers waiting for this key's signature: registry-token deliveries, cashback payouts.
const pending = await acct.incoming();
const { accepted, failed } = await acct.acceptIncoming(); // or acceptIncoming((t) => t.instrumentId === 'CBTC')

await acct.send({ receiverPartyId: 'other::1220…', amount: '25' }); // CC
await acct.send({ receiverPartyId: 'other::1220…', amount: '0.01', tokenId: 'CBTC' });

const merged = await acct.consolidate('CC'); // merges small holdings; 0 means already compact
```

CC is delivered straight into the account through the preapproval `onboard()` set up. Registry
tokens (CBTC, USDCx, …) arrive as transfers that your key must accept. Accept them with
`acceptIncoming()`, or run `serve({ acceptIncoming: true })`.

**Test CC on dev.** `await acct.faucet()` pays the account's party 1,000 CC, at most once every 48
hours. Run `onboard()` first. It answers `429` while the party is cooling down. Testnet and mainnet
answer `503`.

**The fee holding (DvP taker).** Both allocations of a trade are prepared before either one runs.
So the taker's platform-fee leg cannot be funded from the change of its trade leg: it needs a
holding of its own. If the taker keeps the order's target token in one holding, the take is
refused with `DVP_FEE_HOLDING_REQUIRED` (a `SettleError` that names the fee). Two ways to fix it:

```ts
// Before taking: give the fee a holding of its own (a self-send, verified from its bytes).
await acct.splitForFee('CC', '0.15');

// Or let take() do it once when the venue asks:
await acct.take(orderId, { autoSplitForFee: true });
```

`splitForFee` works for **CC only**. The API refuses a registry-token send to oneself. For CBTC or
USDCx, get a second holding by receiving the token in two separate transfers. The split checks
that the remaining balance still covers the trade leg, and that its cost is at most `maxSplitCost`
(default `'2'` CC).

## 6. Orders

Every order an account places goes through `acct.swap`. It is signed in as the account, and it
sends `dvp: true` for every Canton↔Canton order. That flag is what makes the order settle through
DvP. An order placed without it (by hand, or by an SDK older than 0.7) cannot settle here: cancel
it and place it again.

**Find a pair.** `createForPair` takes a trading pair's UUID. The client does not wrap the pair
list, so read it through the same session:

```ts
import { createHttp } from '@cancore/client';

const http = createHttp({ baseUrl, request: acct.session.request });
type TradingPair = { id: string; label: string; baseToken: { symbol: string }; quoteToken: { symbol: string } };
const pairs = await http.get<TradingPair[]>('/trading-pairs', { network: 'canton' });
const pair = pairs.find((p) => p.baseToken.symbol === 'CC' && p.quoteToken.symbol === 'CBTC');
```

Which pairs settle through DvP is configured per stand, and testnet and mainnet may enable fewer
pairs than dev. Ask Cancore which pairs are enabled where you trade. Pick a pair whose base and
quote are both on `canton`: the list also has cross-chain pairs. If a pair is not enabled for DvP,
`make` refuses before anything is recorded ([section 9](#9-errors-and-troubleshooting)).

`acct.swap.pairs()` and `quote()` / `execute()` are a different product: instant trades against
Cancore's pool, with no counterparty. A market maker does not need them.

**Place, list, cancel:**

```ts
// side 'sell' (the default): offer sourceAmount of the base token, want targetAmount of the quote token.
const order = await acct.swap.createForPair({ tradingPairId: pair!.id, sourceAmount: '100', targetAmount: '0.002', side: 'sell', expirationHours: 24 });

// Or by instrument on both sides (no pair id):
await acct.swap.create({
  sourceNetwork: 'canton', sourceTokenAddress: 'CC', sourceTokenName: 'CC', sourceAmount: '100',
  targetNetwork: 'canton', targetTokenAddress: 'CBTC', targetTokenName: 'CBTC', targetAmount: '0.002',
});

const book = await acct.swap.listOpen({ sourceNetwork: 'canton', targetNetwork: 'canton' }); // { items, page, pageSize, total }
const mine = await acct.swap.listMine({ statusFilter: 'open' });
const one = await acct.swap.get(order.id);
await acct.swap.cancel(order.id); // only while it is still open
const final = await acct.swap.track(order.id); // polls until completed / cancelled / refunded / delivery_failed
```

Amounts are decimal **strings** with at most 10 decimal places. An order goes through `open` →
`accepted` (taken) → `swap_created` (trade recorded) → `completed`.

## 7. Settling trades

The taker funds first and the maker funds last. Once every leg is funded, the venue settles all of
them in one transaction. Your proceeds land with the settle, so there is nothing to accept
afterwards.

| Step | Who signs | What it authorises |
| --- | --- | --- |
| `dvpCreateProposal` | maker | the trade proposal with every leg's terms |
| `dvpAcceptProposal` | taker | the taker's approval of those terms |
| `dvpAllocateLeg` | taker (its leg + fee), then maker | locking each leg's holdings for the venue to settle |

### Option A: one order at a time

```ts
// Maker: wait for the take, record the trade, sign, fund after the taker, wait for the settle.
const { swap, flow } = await acct.make(order.id); // swap.status 'dvp_settled', flow 'dvp'

// Taker (another account): accept, approve, fund the leg and the fee, wait for the settle.
const settled = await other.take(order.id, { autoSplitForFee: true, autoWithdraw: true });
```

`SettleOptions`: `deadlineMs` (default 45 minutes: stop waiting for the other side), `autoWithdraw`
(default `false`), `autoSplitForFee` / `allowUnverifiedSplit` (taker, default `false`),
`timeoutHours`, and `signal` (an `AbortSignal`). `make` and `take` resume a trade from its first
unfinished step, so you can run them again after a crash. Inside one process, a second
`make`/`take` of an order that is already settling joins the run in progress and never signs a step
twice. That guard lives in memory: two processes (or replicas) with the same key do not see each
other and both sign. **Run one process per account.**

### Option B (recommended for market makers): `acct.serve()`

One loop drives every DvP trade of the account. Your strategy only places and cancels orders:

```ts
import { io } from 'socket.io-client';

const socket = io(`${baseUrl}/presence`, {
  // Fresh JWT on every reconnect. A failed sign-in still answers (no token: the gateway refuses the
  // handshake) instead of an unhandled rejection that would kill the process.
  auth: (cb) => void acct.session.token().then((token) => cb({ token }), () => cb({})),
  transports: ['websocket'],
});
// socket.io never retries a refused handshake; the poll carries on, and this tries again.
socket.on('connect_error', () => {
  if (!socket.active) setTimeout(() => socket.connect(), 60_000);
});

const loop = acct.serve({
  socket, // optional: without it the reconcile poll alone drives the trades
  reconcileMs: 30_000, // safety-net poll (default 30 s)
  concurrency: 4, // orders being looked at or signing at once; waiting trades hold no slot
  autoWithdraw: true, // default true here: release our allocation of an expired trade
  acceptIncoming: true, // accept deliveries and cashback payouts on every poll
  onEvent: (e) => {
    switch (e.type) {
      case 'settled': console.log('settled', e.orderId, e.swapId); break;
      case 'expired': console.warn('expired', e.swapId, e.error.message, e.withdrawal); break;
      case 'withdrawn': console.log('released', e.swapId, e.withdrawal.withdrawn); break;
      case 'accepted': console.log('accepted transfer', e.transfer.contractId); break;
      case 'error': console.error('will retry next poll', e.orderId, e.error); break;
    }
  },
});

loop.take(someoneElsesOrderId); // optional: take an open order; the loop settles the taker side too
process.on('SIGTERM', () => void loop.stop().then(() => process.exit(0)));
```

- For each of your orders, once taken: `make` → `settled`. For each order you took (or queued with
  `loop.take`): `take` → `settled`. A trade that expired with your allocation still locked:
  `expired`, then `withdrawn` when `autoWithdraw` released it.
- **It never throws.** A failure is an `error` event, and the next poll looks at that order again.
  One failing order does not stop the others.
- **`stop()`** stops new signatures, finishes a step already in progress, and resolves. Waiting
  trades stop within one poll interval (`pollMs`, default 5 s). The next `serve()` resumes them.
  The loop keeps nothing on disk: after a restart it reads your orders and expired swaps again.
- It leaves alone orders with an EVM leg and orders placed without `dvp: true`. It does not price
  or place orders.

Your history: `await acct.listSwaps({ status: 'dvp_settled', page: 1, pageSize: 100 })` returns
one page, newest first. A page shorter than `pageSize` is the last.

### Expired trades and locked funds

A trade nobody funds in time ends `dvp_expired`, and both sides get a `SettleError`. A few minutes
after the settle deadline, the venue's recovery normally releases every allocation. If it could
not, your funded legs stay locked, and only your key can release them:

```ts
const w = await acct.withdrawAllocation(swapId); // { swapId, withdrawn, gone, failed }, one entry per leg
```

The SDK checks every withdraw before signing: it must return exactly your locked amount to you,
and involve no one outside the trade. `serve()` does this by default (`autoWithdraw: true`). `make`
/ `take` do it only when you pass `{ autoWithdraw: true }`. Otherwise the `SettleError` has
`withdrawable: true` and the swap id.

## 8. Cashback

How cashback accrues today. These rules describe the current backend and may change; **cashback
terms are set in your partner agreement**, which wins over this page.

- **Which trades.** Only trades between two automated accounts (`bot` or `partner-bot`) where at
  least one side is `partner-bot`: those trades are charged the partner fee. A trade with a regular
  (retail) account on either side is charged the retail fee and earns no cashback.
- **Who pays the fee.** It is carved out of the leg that delivers to the maker, not added on top.
  The taker sends the agreed amount (the fee part from a holding of its own, see
  [section 5](#5-funding-and-wallet-management)); the maker receives that amount minus the fee.
- **Who gets the cashback.** The account that funds the fee leg, which is the taker, if it has the
  `partner-bot` role. It accrues the full fee leg amount, in the fee's token. A maker accrues nothing
  on its orders that others take, partner or not.
- **When.** Settled trades created after cashback was switched on for the stand, about a minute
  after they settle.

Read and claim it:

```ts
const s = await acct.cashback.summary(); // { claimable, claimed, swapsAccrued, swapsClaimed, hasPendingClaim }
const history = await acct.cashback.claims(); // claims with their payout legs
const claim = await acct.cashback.claim(); // reserve everything claimable into one claim

// Or claim and accept the payouts in one call (waits up to 5 minutes by default):
const { accepted, pending } = await acct.cashback.collect({ waitMs: 10 * 60_000 });
```

A CC payout lands directly. A registry-token payout is a transfer that only your key can accept.
`collect()` accepts it, and so does `serve({ acceptIncoming: true })`. The API refuses a new claim
while `hasPendingClaim` is true.

## 9. Errors and troubleshooting

| Error | Thrown by | Means |
| --- | --- | --- |
| `CancoreApiError` (`@cancore/client`) | any call | a non-2xx answer: `status`, `method`, `path`, `body`, and `errorCode` when the gateway names the refusal |
| `SettleError` (`./selfcustody`) | `make`, `take`, order placement, `splitForFee`, `withdrawAllocation` | the trade cannot go on: `swapId`, `last` (the last swap/order seen), `withdrawable`, `withdrawal`. **No `errorCode`, no `cause`**: only the `message` says why |
| `CeremonyError` (`./selfcustody`) | any signing step | `operation`, `stage` (`'prepare'`: nothing was signed; `'submit'`: signed, the submit failed), `cause` (often a `CancoreApiError`), `meta`, and `errorCode` copied from `cause` when it is a `CancoreApiError` with a code |
| `TrackTimeoutError` | `swap.track` | still not terminal after `timeoutMs`; carries `last` |

The three are separate classes: a `CeremonyError` is **not** a `CancoreApiError`, and `isSdkError`
matches only a `CancoreApiError`. Check each one its own way:

```ts
import { isSdkError } from '@cancore/client';
import { CeremonyError, SettleError } from '@cancore/client/selfcustody';

try {
  await work();
} catch (err) {
  if (isSdkError(err, 'MAINTENANCE_MODE')) { /* a plain API refusal: err.status, err.body */ }
  else if (err instanceof CeremonyError && err.errorCode === 'WALLET_TOO_FRAGMENTED') { /* a signing step the API refused; err.cause is the API error */ }
  else if (err instanceof SettleError) { /* make/take/placement: err.message, err.swapId, err.withdrawable */ }
  else throw err;
}
```

`errorCode` is one of `SdkErrorCode`, or `undefined` for a body without a code this SDK version
knows. The codes a partner sees, and where each one arrives:

| `errorCode` | What happened | What to do |
| --- | --- | --- |
| `ACCOUNT_NOT_FOUND` | no account for this key (the SDK already asked again twice) | `register({ inviteCode })` |
| `DVP_NOT_ALLOWED` (403) | DvP is not open to this account on this stand. Arrives as a `SettleError` without the code: its message contains `allocation-DvP is not open to this account` | contact Cancore. Self-custody accounts are open on every stand that runs the current gateway |
| `DVP_FEE_HOLDING_REQUIRED` (409) | the taker's target token sits in one holding. Arrives as a `SettleError` without the code: its message contains `needs a holding of its own` and says who must split | taker: `splitForFee`, or `take(id, { autoSplitForFee: true })`; maker: run `make()` again after the taker splits |
| `DVP_FEE_BALANCE_INSUFFICIENT` (409) | the payer (`err.body.payerPartyId`) cannot cover the trade leg plus the fee | if the payer is you, top up; otherwise the counterparty must. 0.8.0 does not know this code yet: `errorCode` is `undefined`, so read `body.errorCode` of the `CancoreApiError` (for a `CeremonyError`, of its `cause`) |
| `SUBMISSION_TIMEOUT_RETRYABLE` | the submit timed out | handled: the SDK resubmits the same signatures (up to twice) |
| `PREPARED_SUBMISSION_EXPIRED` | the prepared transaction expired before the submit | handled for DvP steps: prepared and signed again, once |
| `WALLET_TOO_FRAGMENTED` | too many small holdings; from `send`/`consolidate` it arrives on a `CeremonyError` | `consolidate()`, then retry |
| `MAINTENANCE_MODE` | the venue is paused | retry later |

`SettleError` messages that do not carry a code:

- `…this pair is not enabled for DvP on this stand` — choose another pair, or ask Cancore.
- `…not an admin this SDK trusts for it` / `…admin for testnet not configured — pass
  instrumentAdmins` — a token or network the SDK does not pin ([section 2](#2-prerequisites)).
- `…is above this account's ceiling … (maxFeeRate)` — the stand charges more than you allow. Raise
  `maxFeeRate` only if you agree to the rate.
- `…was placed without dvp: true` — cancel the order and place it again with `acct.swap`.
- `…is dvp_expired …` — see [expired trades](#expired-trades-and-locked-funds).
- `timed out waiting for …` — the other side did not act within `deadlineMs`. Run `make`/`take`
  again to resume.

`CeremonyError` at `prepare` whose message contains `refusing to sign` means the SDK's check
refused the transaction. If the message says **`runs code from an untrusted package`**, Cancore
has deployed a `cancore-swap` release this SDK version does not pin. Cancore aims to publish an SDK
release with the new pin before deploying, but a stand has received a release first before
(`cancore-swap` 1.3.0 on dev, see the [CHANGELOG](../packages/client/CHANGELOG.md) for 0.7.1). What
to do:

1. **Update `@cancore/client` to the latest version** and restart.
2. If the latest version still refuses, stop trading on that stand and tell Cancore. Nothing was
   signed. A trade already in progress expires, and its allocations are released
   ([expired trades](#expired-trades-and-locked-funds)).
3. Do not work around it unless Cancore confirms the package id to you over a channel you trust:
   the only escape hatch, `trustedPackages: { swap: { 'cancore-swap': ['<id>'] } }`, adds an id you
   then trust with your key.

**Retries.** The SDK retries only what the API says is safe. It never re-sends a submit blindly. A
`CeremonyError` at `submit` may have reached the ledger, so check the swap (`swapState(swapId)`)
before you start the step again. `make`, `take` and `serve()` re-read the trade and resume, which is
always safe.

A `send()`, `splitForFee()` or `consolidate()` that failed with a `CeremonyError` at `submit` may
also have committed, and there is no swap to check. **Do not repeat it** until you know it did not
land:

- `acct.balance(tokenId)`: did the balance drop by the amount (and the fee)? This is the ledger's
  answer and the one to trust.
- The account's transfer history, `GET /tokens/transfers/my?direction=outgoing&tokenId=…` (the SDK
  does not wrap it; call it with `createHttp` as in [section 6](#6-orders)). A send whose submit
  request died half-way may be missing from it, so a missing row alone does not prove anything.

If you still cannot tell, contact Cancore support with the error before you send again. For
everything else, retry `5xx` and network errors with backoff, and treat `4xx` as final until you
change something.

## 10. Security checklist and going to mainnet

- [ ] The phrase or seed lives in a secret manager. It is injected at runtime, never in git, an
      image, a log or a crash report.
- [ ] Backups of the phrase are offline and tested: a fresh machine can `login()` with it.
- [ ] One account per bot (`account` index), and **one process per account**: no second replica
      with the same key. Separate accounts for dev, testnet and mainnet.
- [ ] `baseUrl` is one of the hosts in [section 2](#2-prerequisites), or `network` is set to match.
- [ ] Verification stays on. `allowUnverified` (`splitForFee`) and `allowUnverifiedSplit`
      (`take`/`serve`) sign a send the SDK could not read. Leave them off in production.
- [ ] Do not loosen the pins without a reason Cancore confirmed: `maxFeeRate`,
      `feeRecipientPartyId`, `instrumentAdmins`, `trustedPackages`, `maxSettlementWindowMs`. You can
      also pin `venuePartyId` from your own configuration.
- [ ] You run the **latest** `@cancore/client`, and you watch its
      [CHANGELOG](../packages/client/CHANGELOG.md). An `untrusted package` refusal means you must
      update.
- [ ] `serve()` runs with `autoWithdraw` on (the default), and your process handles `SIGTERM` with
      `loop.stop()`.
- [ ] You alert on `error` and `expired` events. Reconcile `cashback.summary()` against the trades
      that qualify ([section 8](#8-cashback)), not against every trade.
- [ ] Ask Cancore which pairs settle through DvP on each stand: that is configured per stand
      (testnet and mainnet may enable fewer pairs than dev, or none). Rehearse a full maker/taker
      round on a stand where your pair is enabled, then start mainnet with small sizes.

## 11. Full examples

Three files in [`packages/client/examples`](../packages/client/examples). CI typechecks them with
the package (`npm run typecheck`), and a test keeps the copies below identical to them.

Environment: `CANCORE_MNEMONIC`, `CANCORE_INVITE_CODE` (first run), `CANCORE_API` (default dev),
`CANCORE_ACCOUNT_INDEX`, `CANCORE_LEGAL_DOCUMENTS` (the JSON array of documents Cancore gave you,
when the stand requires them), plus the per-script variables in each header. The taker needs
`CANCORE_ORDER_ID`, `PAY_TOKEN` and `MAX_PAY`, and refuses mainnet (or an unknown host) without
`CANCORE_ALLOW_MAINNET=yes`.

`partner-account.ts` (shared: signer, sign-in, onboarding, terms):

```ts
// Shared by partner-maker.ts and partner-taker.ts: open the account, sign in, onboard, accept the terms.
import { providerFromMnemonic } from '@cancore/wallet';
import { isSdkError } from '@cancore/client';
import { createSelfCustody, type ConsentedDocument, type SelfCustodyAccount } from '@cancore/client/selfcustody';

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
};

export const baseUrl = process.env.CANCORE_API ?? 'https://api-dev.cancore.app';

export async function openAccount(): Promise<SelfCustodyAccount> {
  // The phrase comes from your secret store via the environment; it never leaves this process.
  const signer = await providerFromMnemonic(need('CANCORE_MNEMONIC'), {
    account: Number(process.env.CANCORE_ACCOUNT_INDEX ?? 0),
  });
  const acct = createSelfCustody({ baseUrl, signer });

  // Sign in; the first run signs up with the invite code instead.
  try {
    await acct.session.login();
  } catch (err) {
    if (!isSdkError(err, 'ACCOUNT_NOT_FOUND')) throw err;
    const inviteCode = need('CANCORE_INVITE_CODE');
    let user = await acct.session.register({ inviteCode });
    // An activation that did not finish: the same key and code may sign up again.
    if (user.status === 'FAILED') user = await acct.session.register({ inviteCode });
    if (user.status === 'FAILED') throw new Error('sign-up did not finish; run again later');
  }

  // The Canton party and CC receipts. Skips whatever already exists.
  const user = await acct.onboard();
  if (!user.roles.includes('partner-bot')) console.warn('this account has no partner-bot role: no cashback');

  // Orders are refused until the documents the stand requires are accepted. Only ever accept what you read.
  const { accepted, requiredVersion } = await acct.legalStatus();
  if (!accepted && requiredVersion) {
    const documents: unknown = JSON.parse(need('CANCORE_LEGAL_DOCUMENTS'));
    const isDocument = (d: unknown): d is ConsentedDocument =>
      typeof d === 'object' && d !== null && ['key', 'version', 'url'].every((k) => typeof (d as Record<string, unknown>)[k] === 'string');
    if (!Array.isArray(documents) || documents.length === 0 || !documents.every(isDocument)) {
      throw new Error('CANCORE_LEGAL_DOCUMENTS must be a JSON array of {"key","version","url"} strings, as Cancore gave them');
    }
    await acct.acceptTerms(requiredVersion, documents);
  }

  console.log(`signed in as ${user.partyId}`);
  return acct;
}
```

`partner-maker.ts`:

```ts
// A minimal Canton market maker: keep exactly one sell order on a pair, settle every trade with serve().
// Run ONE process per account: two processes with the same key would both quote and both sign.
//   CANCORE_MNEMONIC=… CANCORE_INVITE_CODE=… CANCORE_PAIR_ID=… npx tsx partner-maker.ts
import type { OrderStatus } from '@cancore/client';
import { io } from 'socket.io-client';
import { baseUrl, openAccount } from './partner-account';

const acct = await openAccount();
const me = await acct.me();
const tradingPairId = process.env.CANCORE_PAIR_ID;
if (!tradingPairId) throw new Error('set CANCORE_PAIR_ID (a pair whose base and quote are both on canton)');
const sell = process.env.SELL_AMOUNT ?? '10'; // base token offered per order
const ask = process.env.ASK_AMOUNT ?? '2'; // quote token wanted for it

console.log('CC balance', (await acct.balance('CC')).balance);

let stopping = false;

// Our orders on this pair in the given states. listMine also returns orders we took, so keep only the ones we placed.
const ownOrders = async (statuses: OrderStatus[]) => {
  const pages = await Promise.all(statuses.map((statusFilter) => acct.swap.listMine({ statusFilter, pageSize: 100 })));
  return pages.flatMap((p) => p.items).filter((o) => o.initiatorUserId === me.id && o.tradingPairId === tradingPairId);
};
const openOrders = () => ownOrders(['open']);

// One order at a time, from placing to settling: a taken order still holds our funds until it settles,
// so a new one is placed only once none of ours is open or in flight. Extra open orders (left by a
// crash) are cancelled. An open order left by an earlier run keeps that run's price: after a crash
// with a changed ASK_AMOUNT, cancel it by hand and the next tick quotes the new one.
const reconcile = async () => {
  // Open first: an order taken between the two reads then shows up in the second.
  const open = await openOrders();
  const inFlight = await ownOrders(['accepted', 'swap_created', 'claimed']);
  for (const o of inFlight.length > 0 ? open : open.slice(1)) await acct.swap.cancel(o.id);
  if (inFlight.length > 0 || open.length > 0 || stopping) return;
  // Canton↔Canton: the SDK sends dvp: true, so the order settles through allocation-DvP.
  const order = await acct.swap.createForPair({ tradingPairId, sourceAmount: sell, targetAmount: ask, side: 'sell' });
  console.log('placed', order.id);
};

// One reconcile at a time, so a settle and the timer never place two orders.
let quoting: Promise<void> = Promise.resolve();
const requote = () => {
  quoting = quoting
    .then(() => (stopping ? undefined : reconcile()))
    .catch((err: unknown) => console.error('quoting failed, next tick retries', err));
  return quoting;
};

// Realtime makes the loop react at once; without the socket the 30 s poll alone drives it.
const socket = io(`${baseUrl}/presence`, {
  // No token (sign-in failed): connect without one, the gateway refuses it and the handler below retries.
  auth: (cb) => void acct.session.token().then((token) => cb({ token }), () => cb({})),
  transports: ['websocket'],
});
// A refused handshake is never retried by socket.io itself; try again in a minute, the poll covers the gap.
socket.on('connect_error', () => {
  if (!socket.active && !stopping) setTimeout(() => {
    if (!stopping) socket.connect();
  }, 60_000);
});

const loop = acct.serve({
  socket,
  acceptIncoming: true, // registry-token deliveries and cashback payouts
  onEvent: (e) => {
    if (e.type === 'settled') console.log('settled', e.orderId, e.swapId);
    else if (e.type === 'expired') console.warn('expired', e.swapId, e.error.message);
    else if (e.type === 'withdrawn') console.log('released', e.swapId, e.withdrawal.withdrawn);
    else if (e.type === 'error') console.error('error', e.orderId ?? '', e.error);
    if (e.type === 'settled' || e.type === 'expired') void requote();
  },
});

await requote();
// Also once a minute: an order that expired by itself (expirationHours) sends no event.
const timer = setInterval(() => void requote(), 60_000);

// No cashback here: a maker never funds the fee leg, so it earns none (guide, section 8).

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void (async () => {
    stopping = true;
    clearInterval(timer);
    try {
      // Stop signing first and let the step in flight finish; taken orders resume on the next start.
      await loop.stop();
      await quoting;
      // Then pull the open offer, so nobody takes an order no process is serving.
      const cancels = await Promise.allSettled((await openOrders()).map((o) => acct.swap.cancel(o.id)));
      if (cancels.some((c) => c.status === 'rejected')) throw new Error('an open order could not be cancelled; cancel it by hand');
    } catch (err) {
      console.error('shutdown', err);
      process.exitCode = 1;
    } finally {
      socket.close();
      process.exit();
    }
  })();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

`partner-taker.ts`:

```ts
// A minimal taker: take one named Canton↔Canton order and settle the taker side.
//   CANCORE_MNEMONIC=… CANCORE_ORDER_ID=… PAY_TOKEN=… MAX_PAY=… npx tsx partner-taker.ts
// PAY_TOKEN is the token you pay with (the order's target token, e.g. CC), MAX_PAY the most of it you agree to pay.
// On mainnet also set CANCORE_ALLOW_MAINNET=yes.
import { API_NETWORKS, SettleError } from '@cancore/client/selfcustody';
import { baseUrl, openAccount } from './partner-account';

const orderId = process.env.CANCORE_ORDER_ID;
const payToken = process.env.PAY_TOKEN;
const maxPay = process.env.MAX_PAY;
if (!orderId || !payToken || !maxPay) {
  throw new Error('set CANCORE_ORDER_ID (the order to take), PAY_TOKEN (the token you pay) and MAX_PAY (the most you pay)');
}
const network = API_NETWORKS[new URL(baseUrl).hostname];
if (network !== 'devnet' && network !== 'testnet' && process.env.CANCORE_ALLOW_MAINNET !== 'yes') {
  // Mainnet, or a host the SDK cannot place: real funds may move, so refuse unless the operator opted in.
  throw new Error(`${baseUrl} may be mainnet; set CANCORE_ALLOW_MAINNET=yes to take orders there`);
}

const acct = await openAccount();
const order = await acct.swap.get(orderId);
if (order.status !== 'open' || order.dvp !== true) throw new Error(`order ${order.id} is ${order.status}, dvp=${order.dvp}`);
if (order.targetTokenName !== payToken) throw new Error(`order ${order.id} asks for ${order.targetTokenName}, not PAY_TOKEN ${payToken}`);
if (!(Number(order.targetAmount) <= Number(maxPay))) { // a MAX_PAY that is not a number refuses too
  throw new Error(`order ${order.id} asks ${order.targetAmount} ${order.targetTokenName}, above MAX_PAY ${maxPay}`);
}
console.log(`taking ${order.id}: pay ${order.targetAmount} ${order.targetTokenName}, get ${order.sourceAmount} ${order.sourceTokenName}`);

try {
  const { swap } = await acct.take(order.id, {
    autoSplitForFee: true, // CC only: split a fee holding off when the venue asks for one
    autoWithdraw: true, // release our allocation if the maker never funds
  });
  console.log('settled', swap.id, swap.status);
  // The taker funds the fee leg, so a qualifying trade earns cashback about a minute later (guide, section 8):
  // claim it from a later run or a scheduled job with acct.cashback.collect().
} catch (err) {
  if (!(err instanceof SettleError)) throw err;
  console.error(err.message);
  if (err.withdrawable && err.swapId) console.error(`still locked: await acct.withdrawAllocation('${err.swapId}')`);
  process.exitCode = 1;
}
```

Run the maker with one account (one process), then the taker with a second account (another
`account` index, or another partner) against an order the maker placed. The maker's `serve()` logs `settled` when the
taker's `take()` returns.
