# Run a bot: from the key in your wallet to the first trade

For a person who made a bot account in the Cancore web wallet and wants a program to trade from
it. The program holds the bot's key and nothing else: Cancore never sees that key, and the bot
never sees your recovery phrase.

Written against `@cancore/client` **0.9.0** and `@cancore/wallet` **0.3.0**. The `ts` blocks on
this page are one program cut into steps. Joined in order they are
[`packages/client/examples/bot.ts`](../packages/client/examples/bot.ts): CI typechecks that file
(`npm run typecheck`), and a test keeps the page and the file identical.

A partner running a market maker with an invite code starts with the
[partner guide](partner-guide.md) instead. This page links to it for what the two have in common.

1. [What a bot account is](#1-what-a-bot-account-is)
2. [Get the key from the wallet](#2-get-the-key-from-the-wallet)
3. [Install](#3-install)
4. [Sign in](#4-sign-in)
5. [Onboard](#5-onboard)
6. [Check the balance](#6-check-the-balance)
7. [Fund the bot](#7-fund-the-bot)
8. [First trade](#8-first-trade)
9. [Withdraw to the owner](#9-withdraw-to-the-owner)
10. [Limits and refusals](#10-limits-and-refusals)
11. [Security](#11-security)

## 1. What a bot account is

- **An ordinary self-custody account**: its own Ed25519 key, its own Canton party, its own
  balance. Every step that needs the account's authority comes back from the API as a prepared
  transaction. The SDK signs it with the bot's key and sends only the signature.
- **Its key is derived from your recovery phrase, one way.** The wallet derives it at
  `m/44'/6767'/N'/0'/0'`, with N from 1 to 5. Account 0 is your own wallet. Every step of the path
  is hardened, so a bot's key says nothing about the phrase or about any other account of it. The
  phrase never leaves the wallet. The bot's process gets its own key and nothing else.
- **Role `user`.** No partner role, no cashback, no fee privileges: a bot pays the platform fee
  and the CC network fee like any other account.
- **Yours to stop, not to spend.** The API counts a bot and its owner as one person
  ([section 10](#10-limits-and-refusals)). From the wallet the owner can stop and resume a bot,
  see its balances, orders and trades, and cancel its open orders — with the owner's own session,
  no bot key needed. What no owner route does is move a bot's funds: every transfer and every trade
  of a bot is signed with the bot's key.

## 2. Get the key from the wallet

In the web app open **Wallet → Settings → My bots**, name the bot and enter your wallet password.
The wallet derives the next free key, creates the bot's account with it, and shows the key: **64
hex characters**. That string is the bot's private key, and the only thing its process needs.

- The key is stored nowhere. **Show key** derives it again whenever you enter the wallet password.
- The wallet must be a self-custody wallet that holds its recovery phrase on this device. A wallet
  imported from a bare key has nothing to derive from.
- The section is not open to every account yet: today the app shows it to Cancore's internal
  roles only.
- **Five bots per owner, for life.** You cannot delete a bot or hand a slot back, and a bot
  account cannot make bots of its own.
- **There is no key rotation.** If Cancore removes a bot, its slot is free again, and the next bot
  you make gets the very same key. A leaked key is dealt with by emptying that bot
  ([section 9](#9-withdraw-to-the-owner)) and never using it again.

## 3. Install

Node.js 20 or newer. The packages are ESM only: use `"type": "module"`, and run TypeScript with
`tsx` or compile it first.

```bash
npm install @cancore/client @cancore/wallet
```

**`@cancore/wallet` 0.3.0 and `@cancore/client` 0.9.0 are merged but not published to npm yet.**
npm still serves wallet 0.2.0, which has no `providerFromSeed`, and client 0.8.0. Until both are on
npm, build them from this repository and install the tarballs instead:

```bash
git clone https://github.com/Cancore-io/sdk && cd sdk
npm install && npm pack -w @cancore/wallet -w @cancore/client    # builds, then writes both .tgz here
cd ../my-bot && npm install ../sdk/cancore-client-0.9.0.tgz ../sdk/cancore-wallet-0.3.0.tgz
```

Client 0.9.0 needs wallet 0.3.0: it tells the wallet which operation it is signing for, and an
older wallet would ignore that.

## 4. Sign in

```ts
// One bot account, from the key the wallet shows to a first trade. Run ONE process per bot.
//   CANCORE_BOT_KEY=… npx tsx bot.ts
import { providerFromSeed } from '@cancore/wallet';
import { createSelfCustody, type ConsentedDocument } from '@cancore/client/selfcustody';

const env = process.env;
// The key comes from your secret store through the environment. Never put it in the source, and never print it.
if (!env.CANCORE_BOT_KEY) throw new Error('set CANCORE_BOT_KEY: the 64 hex characters the wallet showed');
const signer = await providerFromSeed(env.CANCORE_BOT_KEY);
// MAX_FEE is the most CC of network fee the bot may pay for one send or one merge. The stand sets that fee and
// the SDK has no ceiling of its own: without one, a send or a merge is refused before anything is asked of the API.
const bot = createSelfCustody({ baseUrl: env.CANCORE_API ?? 'https://api-dev.cancore.app', signer, maxFee: env.MAX_FEE });
await bot.session.login(); // the wallet created the account, so there is no sign-up
```

- `providerFromSeed` takes exactly 64 hex characters (surrounding whitespace is dropped) and
  refuses anything else. A truncated paste would otherwise be a valid key of some other, empty
  account.
- `createSelfCustody` takes the signer and the API host. `CANCORE_API` defaults to dev here; the
  hosts of the other stands, and what to pass for a host the SDK does not know, are in the
  [partner guide, section 2](partner-guide.md#2-prerequisites).
- `login()` asks the API for a challenge, signs it with the key and gets a JWT. After that the
  session renews the JWT, and signs in again on a `401`, by itself.
- A key the API has no account for makes `login()` throw a `CancoreApiError` with `errorCode`
  `ACCOUNT_NOT_FOUND`: what you pasted is not the key of a bot that exists on this stand.

## 5. Onboard

```ts
const me = await bot.onboard(); // completes whatever setup is missing (party, CC receipts); signs nothing when none is
console.log('party', me.partyId); // the address the owner funds
```

Setting a bot up is two steps:

1. **A Canton party.** The API prepares the topology transaction, and the bot's key signs it.
2. **CC receipts.** A transfer preapproval, paid by the venue, so that CC sent to the bot lands
   directly instead of waiting as an offer.

The party is held to the key, every time. `onboard()` reads the party the account has — made just
now, made earlier by the wallet, whichever — and unless it is `<name>::<fingerprint of this key>`
and nothing else, it throws a `ForeignPartyError` instead of returning an address: that party is
not this key's, so it is not one to fund for this bot. When the party is still to be made,
the same holds for the one the API proposes, or the key signs nothing.

What that does not cover: the party's topology is the one thing the key signs without being able
to read it — the API sends its hash, not the transaction. The name is checked; what else the
topology says is taken on the API's word. Create a bot's party against an API you trust for that
one step.

The wallet normally does both when it makes the bot. `onboard()` then finds nothing missing and
asks for no signature. Make it the first call of every bot process all the same: it is safe to
repeat, it does only what is missing, and so it completes a bot whose setup did not finish, or one
made before the wallet did this for it. Either way it returns the account (`id`, `partyId`, `roles`,
`status`), and the `partyId` it returns is the address to fund: `bot.me()` reads the same fields
again later, as the API gives them, unchecked.

## 6. Check the balance

```ts
console.log('CC', (await bot.balance('CC')).balance); // a decimal string; or 'CBTC', 'USDCx', …
```

Amounts are decimal strings everywhere in the SDK. A new bot holds nothing.

## 7. Fund the bot

From your own wallet, send CC (or another token) to the bot's party id, as you would to anyone.
The wallet normally sets the bot up when it makes it, so you can fund it straight away, before
its process has ever run. **My bots** shows each bot's address, and checks it against a key of
your phrase first (**Show address** asks for the wallet password). It is the party the bot prints
in section 5. Do not send to an address the wallet does not confirm. A bot the wallet shows no
address for is not set up yet: start it once, let `onboard()` finish, and fund it then.

CC lands directly once CC receipts are enabled. Anything that arrives as an offer waits until the
bot accepts it:

```ts
// A token that arrived as an offer waits for this key's signature. One refusal does not stop the rest.
// The list comes from the API, so the network fee of the accepts is paid only out of the budget given here —
// for the whole call, however many there are. With MAX_FEE unset no fee is paid, and it stays the bot's debt.
const { accepted, failed } = await bot.acceptIncoming(undefined, { maxFee: env.MAX_FEE });
for (const t of accepted) console.log('accepted', t.amount, t.instrumentId);
for (const f of failed) console.error('not accepted', f.transfer.contractId, f.error);
```

Keep some CC on the bot whatever it trades: it pays the CC network fee on its own transfers
([section 9](#9-withdraw-to-the-owner)).

- **What an accept costs is yours to cap, for the whole call.** `acceptIncoming` works through a
  list the API supplies, and each accept can carry a network fee. The SDK pays those fees only out
  of the `maxFee` you give that call, in total: with a budget of 12 CC and a fee of about 10, one
  accept pays its fee and the next is refused and listed in `failed`. Raise the budget, or call
  again — each call is a new budget, so how often you call is part of what you allow. With no
  `maxFee` on the call, no fee leg is asked for or signed, and each accept's fee stays the bot's
  debt: the API collects it on the fee leg of a later send, where it counts toward that send's
  `maxFee`. The account's own `maxFee` is never spent here.
- **Accept what you expect.** Anyone can send the bot a transfer. Pass a filter —
  `acceptIncoming((t) => t.instrumentId === 'CBTC')` — when the bot should take only some.

## 8. First trade

Every Canton↔Canton order settles through allocation-DvP: both legs and the platform fee move in
one ledger transaction, or nothing moves. The SDK reads every prepared transaction and holds it to
the order before the key signs it ([partner guide, section 1](partner-guide.md#1-overview)).

**The counterparty is somebody else.** A bot cannot trade with its owner, or with another bot of
the same owner ([section 10](#10-limits-and-refusals)).

**Terms first.** Each account accepts the stand's documents for itself; the owner's acceptance
does not cover the bot. The list of documents comes from Cancore
([partner guide, section 4](partner-guide.md#4-registration-and-onboarding)):

```ts
// Orders are refused until this account has accepted the documents the stand requires. Accept only what you read.
const terms = await bot.legalStatus();
if (!terms.accepted && terms.requiredVersion) {
  if (!env.CANCORE_LEGAL_DOCUMENTS) throw new Error(`the stand requires terms ${terms.requiredVersion}: set CANCORE_LEGAL_DOCUMENTS`);
  await bot.acceptTerms(terms.requiredVersion, JSON.parse(env.CANCORE_LEGAL_DOCUMENTS) as ConsentedDocument[]);
}
```

**As maker.** `CANCORE_PAIR_ID` is a trading pair whose base and quote are both on Canton; the
[partner guide, section 6](partner-guide.md#6-orders) shows how to list them.

```ts
// Maker (CANCORE_PAIR_ID, SELL_AMOUNT, ASK_AMOUNT): place one order and settle it once somebody else takes it.
if (env.CANCORE_PAIR_ID && env.SELL_AMOUNT && env.ASK_AMOUNT) {
  // side 'sell': offer SELL_AMOUNT of the pair's base token, want ASK_AMOUNT of its quote token.
  const order = await bot.swap.createForPair({ tradingPairId: env.CANCORE_PAIR_ID, sourceAmount: env.SELL_AMOUNT, targetAmount: env.ASK_AMOUNT, side: 'sell' });
  console.log('placed', order.id);
  const { swap } = await bot.make(order.id, { autoWithdraw: true }); // waits for a taker, signs, funds its leg, waits for the settle
  console.log('settled', swap.id, swap.status);
}
```

`make` waits until the order is taken, signs the proposal, funds the bot's leg after the taker's,
and returns once the trade has settled. All its waiting shares one budget, `deadlineMs`, 45 minutes
by default. If nobody takes the order in that time it rejects with a `SettleError` and the order
stays open: run `make(order.id)` again to keep waiting, or `bot.swap.cancel(order.id)`.

**As taker.** The order id comes from the book (`bot.swap.listOpen(...)`) or from whoever placed
it.

```ts
// Taker (CANCORE_ORDER_ID, PAY_TOKEN, MAX_PAY): take one open order. The bot pays its target amount and gets its source amount.
if (env.CANCORE_ORDER_ID) {
  const order = await bot.swap.get(env.CANCORE_ORDER_ID);
  if (order.status !== 'open' || order.dvp !== true) throw new Error(`order ${order.id} is ${order.status}, dvp=${order.dvp}`);
  if (order.targetTokenName !== env.PAY_TOKEN || !(Number(order.targetAmount) <= Number(env.MAX_PAY))) {
    throw new Error(`order ${order.id} asks ${order.targetAmount} ${order.targetTokenName}: set PAY_TOKEN and MAX_PAY to agree to it`);
  }
  // autoSplitForFee: the platform fee needs a holding of its own (CC only). autoWithdraw: release our funds if the maker never funds.
  const { swap } = await bot.take(order.id, { autoSplitForFee: true, autoWithdraw: true });
  console.log('settled', swap.id, swap.status);
}
```

`take` accepts the order, signs the approval, funds the bot's leg and the platform fee, and
returns once the trade has settled. The fee needs a holding of its own: `autoSplitForFee` makes
one when the bot pays in CC, and paying in another token needs a second holding of that token
([partner guide, section 5](partner-guide.md#5-funding-and-wallet-management), "The fee holding").
Two things in the block are not optional:

- **The `dvp` check.** The SDK settles only orders placed with `dvp: true`, as every
  Canton↔Canton order it places is. Checking before `take` keeps the bot from accepting an order
  it cannot settle.
- **The price check.** `take` pays whatever the order asks. `PAY_TOKEN` and `MAX_PAY` are your
  agreement to it.

`make` and `take` resume a trade from its first unfinished step, so run them again after a crash.
**Run one process per bot**: two processes with the same key do not see each other, and both sign.
A bot that trades all day runs `bot.serve()` instead of calling `make` and `take` itself: one loop
settles every trade of the account, and your code only places and cancels orders
([partner guide, section 7](partner-guide.md#7-settling-trades)).

## 9. Withdraw to the owner

```ts
// Withdraw (CANCORE_OWNER_PARTY, WITHDRAW_AMOUNT, optional WITHDRAW_TOKEN): an ordinary send, signed by the bot.
if (env.CANCORE_OWNER_PARTY && env.WITHDRAW_AMOUNT) {
  await bot.send({ receiverPartyId: env.CANCORE_OWNER_PARTY, amount: env.WITHDRAW_AMOUNT, tokenId: env.WITHDRAW_TOKEN }); // no tokenId: CC
  console.log('sent', env.WITHDRAW_AMOUNT, env.WITHDRAW_TOKEN ?? 'CC');
}
```

`CANCORE_OWNER_PARTY` is your own party id: the **Wallet** page shows it, with a copy button.
Nobody but the bot can move the bot's balance, so withdrawing is the bot's own send.

- **The bot pays the CC network fee.** A send is the transfer plus a network fee in CC, both
  signed by the bot, whatever token is sent. The fee is a leg of the send when the bot has a second
  CC holding to pay it from; when it has only one, the API defers it and the SDK pays it right
  after, as a second signed step. A CC withdrawal needs the fee on top of the amount, so do not
  send the last of the CC.
- **What the bot signs is read first.** Before the key signs, the SDK reads the transactions from
  their bytes and holds them to what you asked for: `receiverPartyId` is given exactly `amount`,
  nobody else is paid but the network fee to the venue's fee party, and the bot ends up poorer by
  at most `amount` plus `maxFee` CC — the fee the API defers to a second step included. Anything
  else is refused — a `CeremonyError` at stage
  `prepare` whose `cause` is an `UnverifiedTransactionError` — and nothing is signed. This works
  for CC to an owner who can receive it directly (every wallet account can) and for a registry
  token such as CBTC, where the owner then accepts the transfer in the wallet.
- **`maxFee`** is the most network fee one send may cost, all of it together, and it is yours to
  set — once for the account, as [section 4](#4-sign-in) does from `MAX_FEE`, or per call
  (`bot.send({ ..., maxFee })`). The SDK has no number of its own: each stand sets its fee by an
  admin's rule, fixed or priced from cost, and it changes. A send with no ceiling is refused before
  the API is asked for anything ("no ceiling was set on its network fee"), a send above it is
  refused before the key signs ("more than the … fee it allows"). `GET /tokens/transfer/estimate-fee`
  quotes the fee: on the dev stand a transfer cost about 9.4 CC on 2026-10-12, so `MAX_FEE=12`
  passed there. A fee debt the API collects on the same leg counts toward it. `consolidate` is held
  to the same ceiling; an accept is not ([section 7](#7-fund-the-bot)).
- The answer of a send whose fee was deferred carries `deferredFee`. `'paid'`: the second step was
  signed and submitted. `'waived'`: the API asked for nothing. `'owed'` (with `feeError`): the SDK
  did not see the fee paid — it was refused (above what the send left of `maxFee`, for one), or its
  submit failed, and then it may yet have gone through (`feeError.stage` is `'submit'`). In every
  case the send itself went through: do not send again. An unpaid fee stays the bot's debt and is
  collected with a later send.
- A send that fails with a `CeremonyError` at stage `submit` may still have gone through. Check
  `bot.balance()` before sending again
  ([partner guide, section 9](partner-guide.md#9-errors-and-troubleshooting), "Retries").

## 10. Limits and refusals

The API counts an owner and their bots as one person.

| Rule | What you see |
| --- | --- |
| **No trading inside the family.** An owner and a bot, or two bots of one owner, cannot be the two sides of an order, nor of a swap started by a proposal with no accepted order. | Taking the order is refused with `403`, `Self-trade is not allowed: the order initiator and acceptor belong to the same person.` Making or accepting such a proposal is refused with `403`, `Self-trade is not allowed: both sides of this trade belong to the same person.` |
| **One request pool for all bots of one owner**, by default the size of one account's allowance. Each bot is guaranteed a fifth of it, so one bot cannot starve the others. The owner's own account is not part of the pool. | `429`, refused only when the pool is spent **and** this bot is past its share. The body carries `retryAfter` in seconds. |
| **Order caps count the family together.** Where a stand caps orders placed per hour, or orders accepted per 24 hours, the owner and all their bots share one allowance. | `429`, `Rate limit: max N orders per hour per user` or `Rate limit: max N accepted orders per 24 hours per user` |
| **The ordinary order guards** apply to a bot as to anyone: a minimum and a maximum order value, and a price too far from the market. | `400` when placing; the message names the guard. |
| **Terms.** No orders until the account has accepted the stand's documents. | `403`, `The platform documents must be accepted before trading.` |
| **Stopped by its owner.** The owner stopped the bot in the wallet. Its open orders were cancelled; a trade already under way runs to its end; `send` still works, so the bot can be emptied. | Placing or taking an order, and starting a swap by a proposal with no accepted order, is refused with `403`, `errorCode: ACCOUNT_STOPPED`, until the owner resumes the bot. |

How these reach your code:

- A `429` or a `400` is a `CancoreApiError` (`@cancore/client`): read `err.status`, `err.message`
  and `err.body`. The SDK does not retry a `429`. Back off and try again.
- A `403` is a `CancoreApiError` too, with the API's own words in `err.message` — the self-trade
  and the documents refusals of the table above arrive exactly so:

  ```text
  CancoreApiError: POST /orders/<id>/accept → 403: Self-trade is not allowed: the order initiator
    and acceptor belong to the same person.
  ```

- **One `403` is said differently:** when the stand has not opened allocation-DvP to the account,
  `take`, `swap.create` and `swap.createForPair` throw a `SettleError` that says so and that a
  Canton↔Canton order is never moved to HTLC instead. Only that refusal is rewritten.

Everything else `make`, `take` and `send` can throw (a fee above your ceiling, a pair not enabled
for DvP, an expired trade and how to release its funds) is in the
[partner guide, section 9](partner-guide.md#9-errors-and-troubleshooting).

## 11. Security

- **The key is full control of one bot, and of nothing else.** Whoever holds it can sign anything
  as that bot and move its whole balance. It opens neither your wallet, nor your phrase, nor your
  other bots.
- **Keep it in the process environment, injected by a secret store.** Never in source or a
  repository, an image, a log, a crash report, a chat, a ticket, or an AI model's context. Pasting
  it to an assistant to debug the bot is a leak.
- **What a stolen key costs is that bot's balance.** Keep on a bot what it needs to trade, and
  withdraw the rest.
- **Leaked, or in doubt: empty the bot at once** ([section 9](#9-withdraw-to-the-owner)), then
  stop using it. The key cannot be replaced or revoked, and no owner route moves a bot's funds.
  Stopping the bot in the wallet ends its trading — orders, and swaps started by a proposal with no
  accepted order — but not its sends: whoever holds the key can still move what is on it. The wallet shows the same key again under **Show key** if
  you need it to withdraw.
- **The key depends only on the phrase and the bot's number.** If you use one recovery phrase on
  two stands, the bot at index N has the same key on both: treat a key exposed on dev as exposed
  on mainnet.
- **What the SDK reads before the key signs:** every step of a trade (`make`, `take`,
  `withdrawAllocation`), `send`, `splitForFee`, `acceptIncoming`, `consolidate`, and the preapproval
  step of `onboard`. What it cannot read: the party's topology in `onboard` (the API sends a hash;
  the party's name is checked — [section 5](#5-onboard)), and anything you run through
  `execute()` yourself. `allowUnverified: true` on a call switches the reading off for that call —
  the key then signs what the API prepared, unread, and no `maxFee` — ceiling or budget — holds it. Leave it off unless you know why a ceremony
  cannot be read (an older gateway that sends no bytes; a token whose registry the SDK does not pin
  — add its admin with `instrumentAdmins` instead).
- **One process per bot**, and leave the SDK's checks on. The rest of the
  [partner guide's checklist](partner-guide.md#10-security-checklist-and-going-to-mainnet) applies
  to a bot as it does to a partner account.
