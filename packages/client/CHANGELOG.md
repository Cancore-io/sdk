# Changelog — `@cancore/client`

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
  tree is walked: trusted packages only (by name and id), the step's own shape, a factory signed
  by the instrument admin, no holding created for or spent from anyone but the signer beyond what
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

### Deprecated

- `SettleOptions.deliveryWaitMs`: there is no delivery left to wait for.

### Added

- `SelfCustodyOptions.venuePartyId`: pin the venue every allocation must hand settlement to.
- `SelfCustodyOptions.maxFeeRate` (default `'0.015'`, `DEFAULT_MAX_FEE_RATE`): the highest
  platform fee rate the account accepts.
- `SelfCustodyOptions.feeRecipientPartyId`: the only party the platform fee may be paid to.
- `SelfCustodyOptions.maxSettlementWindowMs` (default 3 hours): how far ahead a proposal's or an
  allocation's deadline may lie.
- `SelfCustodyOptions.trustedPackages` and `DEFAULT_TRUSTED_PACKAGES`: the Daml packages, by name
  and package id, whose code may run in a transaction the account signs.
- Refusal codes `DVP_NOT_ALLOWED` and `DVP_FEE_HOLDING_REQUIRED` (`refusalOf`: `dvpNotAllowed`,
  `feeHoldingRequired`).

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
