# Changelog — `@cancore/client`

## 0.12.1

### Fixed

- `bridge.prepareInteractive` and `bridge.executeInteractive` send the body the route takes,
  `{ operationType: 'bridgeMint' | 'bridgeBurn', params }`, built from the same
  `PrepareInteractiveInput` as before (CAN-2937). They sent the input as it was, and the gateway
  refused every call with a 400 before any service ran.

## 0.12.0

### Added

- The bridge's whole lifecycle for a Loop wallet party (CAN-2936). Our participant cannot see a
  Loop party's contracts or transactions, so its mint and burn are submitted by the Loop wallet
  and the outcome is reported back:
  - `bridge.buildLoopCommand({ operationType, params })` builds the command from the contract ids
    the wallet read (`agreementCid`, `attestationCid`, `holdingCids`);
  - `bridge.reportLoopResult(result)` records what the wallet answered; it is the only writer of
    the party's bridge row;
  - `bridge.executeLoop(input, submit, checks?)` runs build, your Loop submitter and the report.
    The report is sent after a failed submit too, and the submit error is then thrown as it was.
    A Loop answer with `status: 'failed'` is a failed submit. A refused report throws
    `LoopReportError`; its `result` is safe to send again when it carries a `transactionId` or
    the refusal was a 4xx, otherwise check history first.
  - `checks` (`LoopSubmitChecks`) read the Loop wallet for it: `isCancelled(err)` marks a
    cancellation in the wallet, thrown without a report; `landed(input)` answers whether a
    rejected submit committed anyway (its consumed contract is gone), and then the submit is
    reported and resolved as a success, without a `transactionId`; a probe that rejects counts as
    "not landed".
- `bridge.registerDeposit({ amount, evmTxHash, sourceChainId })` records the EVM deposit as a
  PENDING mint right after it confirms. Call it once, before the mint: it is idempotent only
  while the deposit is PENDING. The hash is sent lowercase, as the chain recorder stores it.
- `bridge.depositAttestation({ amount? })` finds the DepositAttestation to claim on our
  participant.
- `swap.prices()` (`GET /prices`) and `swap.tradingPairs(query?)` (`GET /trading-pairs`): what a
  market maker quotes from. A price carries the source's `timestamp`; the API serves its newest
  value even when it is stale, so the caller decides how old is too old.
- `swapInfo(swapId)`, `timeoutOptions(orderId)` and `feeConfig(orderId)` on the self-custody account:
  the reads `make` already did, now the program's to make too.
- `CancoreApiError.retryAfterMs` on a 429: the body's `retryAfter` or the `Retry-After` header, in
  ms. The client still does not retry by itself.
- Self-custody HTLC on the account (CAN-2929): `openHtlc(input)` opens a swap (Flow B, the escrow
  request and its deposit), `acceptCounter(swapId, expect)` accepts its counter leg, `refund(swapId)`
  asks the venue to refund the HTLC after its timeout (nothing signed). Both ceremonies are read from
  their bytes before the key signs: the receiver, amount, instrument, hash lock and timeout asked for, the pinned escrow, venue and fee
  party (`DEFAULT_ESCROWS`, option `escrowPartyId`), the account as the only signatory and actor, every
  field, template and choice known (an unknown one is refused), a deposit of exactly the amount to
  exactly that escrow, and an accept that creates the proposal's HTLC and spends nothing of the
  account's. Only the hash lock is sent: no preimage, encrypted or not, leaves the caller.
- `trustedPackages.htlc`: the `htlc-contract-v9` builds a self-custody HTLC may run on, pinned by name
  and id.

### Changed

- The spec snapshot is refreshed from the dev gateway (CAN-2930): the refusal registry grows from
  39 codes to 112, and each new one is decided. `ACCOUNT_STOPPED` reads as the new refusal
  `accountStopped`; `DVP_FEE_BALANCE_INSUFFICIENT` is surfaced and never read as a fee holding to
  split (another split would not help); the rest — the partner Temple desk, intent routes and
  quotes, filler registration, `GEO_RESTRICTED` — are surfaced.
- `serve()` remembers at most 10,000 finished orders; past that the oldest is forgotten, which costs
  one more read of it.

## 0.11.0

### Added

- `preapproval()` on the self-custody account reads `GET /tokens/cc-preapproval`: whether the
  account holds a CC TransferPreapproval, and whether the stand can set one up at all. It throws
  when the ledger cannot be read.
- `enablePreapproval()` creates the account's CC TransferPreapproval (venue-paid) on its own, read
  before it is signed exactly as in `onboard()`; a no-op when it already exists. It needs the party,
  so `onboard()` comes first. `onboard()` now calls it for its preapproval step.
- `serve()` returns `untake(orderId)` and `mayBeTrade(orderId)`:
  - `untake` drops a queued take before its accept is sent and is `false` once the accept has
    started — it is a trade from then on;
  - `mayBeTrade` is `true` once an accept went out and no refusal proved it did not happen (in
    flight, answer lost, or through), or the order is already this account's.
- `take` settle options `beforeAccept`, `onAccepted` and `onAcceptRefused`: asked right before the
  accept request is sent (after every preflight read), told when the order is accepted by this
  account, and told when the venue refused the accept (4xx). `beforeAccept` returning `false` calls
  the take off with the new `TakeCancelledError`.

### Changed

- A take whose accept answer is lost stays in flight until the venue shows the order; a later
  refusal cannot clear an earlier accept whose outcome was never learned (the venue refuses a
  second accept on an order the first one already took).
- A take queued during the order lookup is marked in flight too; a failed accept is no longer in
  flight; a take reported in flight is not called off after its fee split.
- A completed order counts as this account's fill only when the account is its taker; a 409 on
  accept is treated as ambiguous, not as a refusal.
- A fee-holding refusal frees the take.

## 0.10.0

### Changed

- `SettleOptions.autoSplitForFee` now defaults to `true` (CAN-2735): `take` refused with
  `DVP_FEE_HOLDING_REQUIRED` splits the fee off itself and takes once more. Pass
  `{ autoSplitForFee: false }` to keep the old behaviour (a `SettleError` naming the fee).
  `allowUnverifiedSplit` still defaults to `false`, so a split whose send cannot be verified is
  still refused.

## 0.9.0

### Changed

- **Needs `@cancore/wallet` 0.3.0 or later** (the peer range was `>=0.1.0`). An older wallet ignores
  the operation name this client now passes to `signLegs`, and the rule below would silently not
  apply.
- Every envelope ceremony (`onboard`, `send`, `acceptIncoming`, `consolidate`, `splitForFee`) names
  its operation to the wallet, and the legs the API prepared are held to that operation before
  anything is signed (CAN-2399): a `topology` leg — the one kind signed raw — must be a 34-byte
  sha2-256 multihash, alone, and only in `wallet.topology`; no other operation may carry one. A
  refusal is a `CeremonyError` at `prepare` whose `cause` is `UnexpectedLegError`
  (`@cancore/wallet/operations`, re-exported from `./selfcustody`); nothing is signed or submitted.
  DvP steps are unaffected: they were already read before signing.
- Every other leg's hash must be 32 bytes of canonical base64, and the whole set is read before the
  first signature: one leg that is not a hash refuses the set, with nothing signed.
- A signer that has only `signMessage` (no `signChallenge`) is handed a login challenge only when it
  is one — printable ASCII starting with `Welcome to Cancore ` — the rule a `@cancore/wallet`
  provider already holds its own `signChallenge` to. Before, such a signer signed whatever the API
  returned as the challenge, a 32-byte transaction hash included.
- `onboard()` holds the account's party to its key (CAN-2249). The party must be
  `<hint>::<fingerprint of this account's key>`, whole:
  - the one `wallet.topology` proposes, or nothing is signed — a `CeremonyError` at `prepare` whose
    `cause` is the new `ForeignPartyError` (`when: 'proposes'`). `execute('wallet.topology')` is held
    to the same rule;
  - the one the account has, on every call — made just now, earlier, or by the wallet — or
    `onboard()` throws `ForeignPartyError` (`when: 'records'`) before the preapproval. It used to
    return that party as the address to fund. **An account whose party is not its key's is refused
    here now** — one still in custody, or mid-migration to its own key (the API shows the old party
    until cutover). Before, `onboard()` let such an account through, or only the ledger refused it
    later; neither is an account a program holding one key could run.

  This checks the party's name. What else a topology says the key still cannot read (the API sends
  its hash): see the wallet README. The predicate is `isPartyOfKey` in `@cancore/wallet` 0.3.0.

- **`send`, `acceptIncoming` / `accept`, `consolidate` and the preapproval step of `onboard` are read
  before the key signs them** (CAN-2249), as DvP steps and `splitForFee` already were. The
  transactions are decoded from their bytes and held to the call: a send gives the receiver named
  exactly the amount (CC through its preapproval, a registry token as an offer on the admin's own
  factory) and nobody else anything but the network fee; an accept is the accept of the transfer
  chosen and spends nothing of the account; a merge pays nobody; the preapproval is one proposal for
  this account, to the pinned venue or itself, under the pinned DSO, from a pinned `splice-wallet`
  package. A ceremony that does not hold, or came without bytes, is a `CeremonyError` at `prepare`
  whose `cause` is `UnverifiedTransactionError` (now exported from `./selfcustody`); nothing is signed.
  - **Breaking for every caller of `send` and `consolidate`: set `maxFee`** — on the account
    (`createSelfCustody({ ..., maxFee })`) or per call (`TokenCallOptions`). It is the most CC the
    call may cost in network fee, the fee the API defers to a second ceremony included, and the SDK
    ships no default: a stand sets that fee by an admin's rule (fixed, or priced from cost), so any
    number here would be one stand on one day — on 2026-10-12 the dev stand charged about 9.4 CC a
    transfer. A call with no ceiling is refused before the API is asked for anything, with a message
    that says so (`maxSplitCost`, when you set it, serves as the ceiling);
    `GET /tokens/transfer/estimate-fee` quotes the fee. The ceiling is what bounds the fee leg: its
    recipient is pinned, its amount is not.
  - **An accept pays a network fee only out of a budget its own call names.** What is accepted is a
    list the API supplies, so the account's `maxFee` is never spent on it. `accept(transfer, { maxFee })`
    asks for the fee leg and pays at most that; `acceptIncoming(filter, { maxFee })` treats it as the
    budget of the whole call, however long the list and whatever the API answers: a fee counts as
    spent when it is found fit to sign. Each call is a new budget. Without it — and in `serve({ acceptIncoming })`
    and `cashback.collect`, which pass none — no fee leg is asked for or signed, and the accept's fee
    stays the account's debt, as in 0.8.
  - **Also breaking for:** an account on a network the SDK has no pins for (pass `network` or
    `instrumentAdmins`); a registry token whose admin is not pinned; a gateway that returns no
    transaction bytes; a network whose `splice-wallet` is a release after 0.1.25 (pass its package
    id in `trustedPackages.wallet` — taken from Splice's `daml/dars.lock` or from Cancore, never from
    the refusal, which quotes what the API sent). Every released `splice-wallet` up to 0.1.25 is
    pinned, from that file; the dev stand ran 0.1.24 on 2026-10-12, and which release testnet and
    mainnet run was not measured. `send`, `accept`, `acceptIncoming`, `consolidate` and `onboard` take
    `allowUnverified: true`, which signs unread; on a `send` that covers the deferred fee's ceremony
    too. `cashback.collect` and `serve` take no such option.
  - Whatever party `GET /auth/me` names, a ceremony is read — and signed — only for the party of
    this key (`ForeignPartyError` otherwise).
- **The network fee is paid** (CAN-2423). `send` used to ignore a fee the API deferred (a send from
  a single holding) and `accept` never asked for its fee leg, so each left a fee debt. `send` now
  runs the deferred fee's own ceremony right after, read like any fee leg and held to what the send
  left of its `maxFee`; its answer carries `deferredFee`: `'paid'`, `'waived'` (the API asked for
  nothing) or `'owed'` with `feeError` (refused, or a submit that failed and may yet have landed) —
  the send itself has committed in every case and is not an error. `accept` asks for the fee leg
  (`withFeeLeg`) when its call names a budget for it.

### Fixed

- `take`, `swap.create` and `swap.createForPair` turned **any** 403 into a `SettleError` that opens
  with "allocation-DvP is not open to this account" (CAN-2400). Only the refusal the API itself
  names so is rewritten now — the `DVP_NOT_ALLOWED` code, or the DvP door's own words from a gateway
  that serves no codes. Every other 403 (self-trade, documents not accepted, a stopped bot account)
  reaches the caller as the `CancoreApiError` it is.

## 0.8.1

### Security

- `splitForFee` (and `take` with `autoSplitForFee`) verified a CC send without checking that the
  transfer preapproval it goes through is the DSO's (CAN-2249). The preapproval is what the whole
  transaction runs on: its choice acts with this account's authority. A hostile API could disclose
  a contract of its own under the same template name, and its "send" could have this account sign
  a contract that only looks like its holding — one whose author, by Daml's authorization rules,
  can then act as the account. Nothing left the account in the transaction itself, so every amount
  check passed. Now, for each leg, the preapproval must be signed by a pinned CC admin (the DSO) —
  as the disclosed contract says and as the command exercising it says — and be of the template the
  command names (package name, module and entity; the package id may be a newer version). A leg
  that fails either is an `UnverifiedTransactionError` before the key signs.
- A transaction that discloses two contracts under one contract id is refused, for every verified
  step (DvP steps included): the checks read a disclosed contract by its id.

A send this network really prepares is unaffected: checked against ten prepared CC legs from the
dev stand. `allowUnverified` still signs without reading, as it says.

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
  hold no slot; looks at expired swaps the poll lists wait in a lane of their own that gets every
  fourth released slot, the rest going to live trades first, so a live trade's signature waits for the
  looks already holding slots and one backlog look in four, never for a restart's whole expired
  history, and live load
  never starves an expired locked allocation of its withdraw; `/auth/me` is read once per poll, not
  once per expired swap, so a changed party is seen within one poll. Failures are `error` events, never throws; after
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
