# Changelog — `@cancore/client`

## Unreleased (0.7.x)

### Added

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

### Changed

- The `SettleError` for an expired trade with a locked allocation points at `withdrawAllocation`
  instead of at Cancore support.

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

### Deprecated

- `SettleOptions.deliveryWaitMs`: there is no delivery left to wait for.

### Added

- `SelfCustodyOptions.venuePartyId`: pin the venue every allocation must hand settlement to.
- `SelfCustodyOptions.maxFeeRate` (default `'0.015'`, `DEFAULT_MAX_FEE_RATE`, this SDK's default
  ceiling): the highest platform fee rate the account accepts.
- `SelfCustodyOptions.feeRecipientPartyId`: the only party the platform fee may be paid to.
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
