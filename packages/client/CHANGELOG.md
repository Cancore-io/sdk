# Changelog — `@cancore/client`

## 0.8.0

### Added

- `acct.serve(options?)` (`./selfcustody`): one long-running loop that drives every Canton↔Canton
  DvP trade of a self-custody account — the maker side of each of its orders once taken, the
  taker side of each it took (or queued with `handle.take(orderId)`), and a withdraw of its own
  allocation when a trade expires with it still locked (`autoWithdraw`, **on by default here**;
  `make` / `take` keep it off). Triggered by the realtime `order:updated` / `swap:updated` events
  when a socket is given, with a reconcile poll (`reconcileMs`, default 30 s) over the account's
  orders in flight and all its `dvp_expired` swaps (the newest page plus one older page per poll,
  wrapping), so a missed event or a restart never strands a trade; an expired trade still locked
  is an `expired` event once per swap, found by the poll or not. One handler per order;
  `concurrency` (default 4) bounds orders being looked at or signing a step, while waiting trades
  hold no slot; looks at expired swaps the poll lists take a slot only when no live trade wants one,
  so a restart over a long expired history never delays a live trade's signature, and `/auth/me` is
  read once per loop, not once per expired swap. Failures are `error` events, never throws; after
  `stop()` no new step is signed, and it resolves once the step under way is (a wait ends within
  one poll interval). Every signature still goes through `make` / `take` / `withdrawAllocation`,
  verified before signing. See README, "Running a market maker with serve()".
- `acct.listSwaps(query?)`: `GET /htlc/swaps` — one page (`page`, `pageSize` ≤ 100, `status`) of
  the account's swaps, HTLC or DvP, newest first.
- `acct.session.token()`: a fresh JWT, for the realtime socket's handshake.
- `SettleOptions.signal`: an `AbortSignal` checked before every new step (taking, recording the
  trade, each signature, autoWithdraw) and in every wait, never between a step's signing and its
  submit: once aborted, `make` / `take` sign nothing new and reject with a `SettleError`. An
  autoWithdraw stopped before its turn signs nothing and rethrows the trade's own error
  (`withdrawable: true`), not a failed withdrawal.
- `SWAP_UPDATED_EVENT` and `SwapUpdate` (`./realtime`), pinned in the realtime contract.

### Changed

- `make` / `take` of an order this account is already settling join the run in flight instead of
  starting a second one, so the same step is never prepared and signed twice. The joiner gets the
  run's result under the run's **own** options (`autoWithdraw`, `deadlineMs`, `signal` — so a
  stopped `serve()` rejects the joiner too); the joiner's options are ignored, except its `signal`,
  which ends only the joiner's own wait. `make` and `take` of one order share the run.

## 0.7.1

### Fixed

- DvP signing trusts `cancore-swap` 1.3.0 (`01208653516ab062e71274729caec86254a9ac55022561cb68c189bfd6fc6742`),
  now on dev: 0.7.0 refused every proposal step there with `runs code from an untrusted package`.
  1.3.0 changes only `Swap.Escrow` (`DvpLegDeposit` gains an optional `receiver`); the
  `SwapProposal` / `SwapTrade` templates the check reads are unchanged. Any future `cancore-swap`
  release needs its id pinned here, and the SDK released, before it is deployed to a stand
  partners use.

## 0.7.0

Canton↔Canton self-custody trades settle through allocation-DvP. This changes behaviour.

### Changed

- `make` / `take` (`./selfcustody`) settle every Canton↔Canton order through allocation-DvP:
  the maker records the trade and signs the proposal, the taker approves and funds its leg and
  the platform fee, the maker funds its leg, and the venue settles every leg in one
  transaction. **The HTLC path is gone for Canton↔Canton:** there is no hash lock, no escrow, no
  preimage and no claim, and no fallback to HTLC. A stand that has not opened DvP to the
  account, or has not enabled the pair for DvP, is a `SettleError` before anything is recorded.
- Every DvP transaction is checked before the account's key signs it: the hash is recomputed
  from the transaction's bytes and the transaction is held to the order (parties, instruments,
  amounts, fee within the published rate, the venue as executor). A transaction that does not
  hold is a `CeremonyError` at the `prepare` stage, and nothing is signed. The whole transaction
  tree is walked: the swap package pinned by name and id, the step's own shape, an allocation
  factory signed by a pinned instrument admin, no holding created for or spent from anyone but the signer beyond what
  the leg locks, no party outside the trade, and deadlines within a bounded window. New dependency:
  `@canton-network/core-tx-visualizer`.
- `acct.swap.create` and `acct.swap.createForPair` send `dvp: true` for a Canton↔Canton order.
- The DvP fee terms (rate, receiver, venue) are read for the order's own pool:
  `GET /htlc/fee-config?orderId=` with the account's session, after accept. A partner order is
  held to the partner fee party, a retail order to the retail one, and a fee leg to any other
  party is refused before signing. A backend older than the per-order route ignores `orderId`
  and answers its only (retail) pool; any refusal of the request propagates, with no retry
  without `orderId`. The pool's `maxFeeRate` never lifts the account's own ceiling
  (`maxFeeRate`, default 1.5%).
- The fee receiver the API names must be one of Cancore's fee parties for the network
  (`DEFAULT_FEE_RECIPIENTS`: `cancore-fee-{retail,partner,auto}`), or the trade is refused before
  anything is recorded or signed. `feeRecipientPartyId` (now `string | readonly string[]`) adds parties to
  that list instead of being the only one accepted.
- `Settled` gains `flow: 'dvp'`. `delivery` is always `'direct'`: the settle moves the holdings
  themselves, so `'accepted'` and `'pending'` are no longer produced by `make` / `take`
  (`acceptIncoming` still accepts any transfer that arrives otherwise).
- `HtlcSwap.status` also carries the DvP statuses (`DvpStatus`).
- `SettleOptions.timeoutHours` only fills the proposal request's required field; the trade's
  windows are set by the venue.

- `grossAmount` refuses an amount with more than ten decimals (`RangeError`) instead of
  truncating it.
- DvP refusals at order placement and at `take` (`DVP_NOT_ALLOWED`, `DVP_FEE_HOLDING_REQUIRED`)
  are `SettleError`s that say who must act.

- What the account trusts: each pinned instrument admin, with more than its token. The admin's
  code runs the allocation and, later, its execution with the sender's authority; checking the
  transaction cannot bound that code. See the README's "What this guarantees" section.
- The `SettleError` for an expired trade with a locked allocation points at `withdrawAllocation`
  instead of at Cancore support.

### Deprecated

- `SettleOptions.deliveryWaitMs`: there is no delivery left to wait for.

### Added

- `SelfCustodyOptions.venuePartyId`: pin the venue every allocation must hand settlement to.
- `SelfCustodyOptions.maxFeeRate` (default `'0.015'`, `DEFAULT_MAX_FEE_RATE`, this SDK's default
  ceiling): the highest platform fee rate the account accepts.
- `SelfCustodyOptions.feeRecipientPartyId` and `DEFAULT_FEE_RECIPIENTS`: the parties the platform
  fee may be paid to, pinned per network, added to the defaults.
- `SelfCustodyOptions.maxSettlementWindowMs` (default 3 hours): how far ahead a proposal's or an
  allocation's deadline may lie.
- `SelfCustodyOptions.trustedPackages` and `DEFAULT_TRUSTED_PACKAGES`: the package ids of the
  swap package the proposal steps may run, added to the defaults.
- `SelfCustodyOptions.instrumentAdmins` and `DEFAULT_INSTRUMENT_ADMINS`: the instrument admins an
  allocation may run under (the factory must be signed by one), pinned per network and
  instrument, added to the defaults.
- `SelfCustodyOptions.network` and `API_NETWORKS`: the network the account trades on, derived
  from `baseUrl` for the Cancore API hosts. Any other host must pass it, or no admin is trusted.
  CC on testnet has no pinned admin yet: pass the testnet DSO party with `instrumentAdmins`.
- Refusal codes `DVP_NOT_ALLOWED` and `DVP_FEE_HOLDING_REQUIRED` (`refusalOf`: `dvpNotAllowed`,
  `feeHoldingRequired`).
- `splitForFee(tokenId, feeAmount)` (`./selfcustody`): gives the platform fee a holding of its
  own by sending `feeAmount` to the account itself, after checking the balance covers it plus the
  send's cost (network fee and any fee debt the API collects, within `maxSplitCost`). The send's
  transactions are verified from their bytes before signing (`verified: true`); without bytes the
  split is refused unless `{ allowUnverified: true }`, and a partly readable send never signs. CC
  only: the API refuses a registry-token (CBTC, USDCx) send to oneself, so those are a
  `SettleError`.
- `SettleOptions.autoSplitForFee` (default `false`): `take` heals `DVP_FEE_HOLDING_REQUIRED`
  naming this account as the payer — it splits the fee off once and takes once more, after
  holding the named fee to the order × `maxFeeRate` and checking the change still covers the
  trade leg. A failed split, or a second refusal, is a `SettleError`; a refusal naming another
  payer splits nothing. `SettleOptions.allowUnverifiedSplit` (default `false`) lets it split blind.
- `SelfCustodyOptions.maxSplitCost` (default `'2'` CC), `SelfCustodyOptions.networkFeeRecipients`
  and `DEFAULT_NETWORK_FEE_RECIPIENTS`: the ceiling on a split's quoted cost and the pinned
  parties its network-fee leg may pay. The signed send may cost a holding-fee margin on top of
  `maxSplitCost` (1% of the fee, at least 0.1 CC, at most 1 CC). A send from a single holding is
  the transfer alone (the API defers its network fee), and verifies as such.
- `SdkErrorCode` (and `SDK_ERROR_CODES`) gains the five codes of the agent mandate: `NO_ACTIVE_MANDATE`,
  `MANDATE_EXISTS`, `MANDATE_AMBIGUOUS`, `IDEMPOTENCY_KEY_REUSED`, `MANDATE_NOT_YET_VISIBLE`. The spec
  snapshot gains the `/agent/mandate*` routes. No client method calls them yet; `refusalForCode` maps
  all five to `other`. **A program that switches on `SdkErrorCode` exhaustively stops compiling until
  the five have a branch** — which is what the exhaustive switch is for.
- `withdrawAllocation(swapId)` on the self-custody account releases this account's own DvP
  allocation(s) of a trade that ended `dvp_expired` when the venue's recovery could not (the abort
  was refused or the trade was already archived). Until now such a leg stayed locked and the only
  way out was Cancore support. Same prepare → verify → sign → submit path as the other DvP steps,
  new operation `dvpWithdrawAllocation`, one signature per locked leg. Requires the matching gateway
  (BUG-1291).
- `dvp-verify` holds a withdraw to its own expected tree before the key signs: exactly one consuming
  `Allocation_Withdraw` on an allocation of this trade, sent by this account, signed by the instrument
  admin and settled by the venue; only this account's allocation and holdings archived; the holding
  returned to this account, unlocked and exactly the amount the allocation locked; no party outside the
  trade. A withdraw is held to the trade alone, never to the stand's current fee configuration.
- `SettleOptions.autoWithdraw`: `make` / `take` withdraw before throwing when the trade expired with
  this account's allocation still locked. Off by default. The trade's `SettleError` is kept and carries
  `withdrawal` (`withdrawn` / `gone` / `failed` per leg); `withdrawAllocation` attempts every leg and reports each.
- `SettleError.withdrawable` is true when the expiry left this account's allocation locked.
  `SwapInfo.legs[]` carries `legId` and `userActionRequired`, `HtlcSwap` carries `orderId`.

### Migrating from 0.6.x

- **Finish open HTLC swaps with 0.6.x.** A swap 0.6.x opened as HTLC is refused by 0.7.0
  (`SettleError`, "is an HTLC swap") on both sides. Run `make` / `take` from 0.6.x until it is
  settled or refunded, then upgrade.
- An order placed without `dvp: true` (by 0.6.x, or by hand) is refused by `make`: cancel it
  and place it again with `acct.swap.create` / `createForPair`.
- Code that branched on `delivery === 'accepted' | 'pending'` after `make` / `take` can drop
  those branches.
- Use against a live stand needs the stand to open DvP to self-custody accounts and to enable
  the pair for DvP.
