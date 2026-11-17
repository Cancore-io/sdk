# Changelog — `@cancore/wallet`

## Unreleased

### Changed — `@noble/curves` and `@noble/hashes` 2.x (CAN-3207)

- Runtime dependencies `@noble/curves` `^1.9.7` → `^2.4.0` and `@noble/hashes` `^1.8.0` → `^2.4.0`. No public
  type or signature changes: noble stays internal. The 2.x line is ESM-only and needs Node ≥ 20.19, inside the
  package's `engines.node >= 26`. Ed25519 output is unchanged (the RFC 8032 KAT still passes).
- `@scure/bip39` `^1.6.0` → `^2.4.0`, which depends on `@noble/hashes` 2.4.0: the package's runtime tree carries
  one `@noble/hashes` line, not two. Mnemonics, seeds and the wordlists are unchanged.

## 0.4.6

### Added — the Amulet allocation template in the CC pin (CAN-3579)

- The splice-amulet 0.1.24 entry (CC, the DSO's Amulet) pins `Splice.AmuletAllocationV2:AmuletAllocationV2`, the
  template `ExternalPartyAmuletRules`' V2 `AllocationFactory_Allocate` creates, and `openReceipt: true`: a receipt
  allocation needs no funding and nothing of the receiver's, and its settle creates the receiver's `Amulet` with no
  preapproval. A committed CC allocation is recognised as the escrow of a Canton-source intent.

## 0.4.5

### Changed — the DA Utilities 0.9.2 pin takes the registry's event log (CAN-2931)

- The DA Utilities 0.9.2 entry (CBTC) names `Utility.Registry.Holding.V0.Holding:Holding.EventLog_HoldingsChange` in
  `serviceChoices`. From registry 0.14 on, `Holding` (utility-registry-holding-v0 0.3.x) implements Splice's
  TransferEventsV2 `EventLog`, and a transfer reports the sender's holding change through it: a non-consuming choice
  the instrument admin controls, which moves nothing. The 0.8.2 entry keeps no service choice.
- `serviceChoices` documents the rule the transfer check holds it to: a service choice counts only non-consuming and
  on a template of the registry's own package or its holding.

## 0.4.4

### Added — the DA Utilities allocation template in the CBTC pin (CAN-3587)

- `CantonTransferFactory.allocationPackageId`: the package of `allocation` when it is not `packageId`;
  `registriesProblem` takes it only as 64 lowercase hex, like `holdingPackageId` and `preapprovalPackageId`.
- `allocationTemplateOf(f)`: the V2 allocation template of a registry entry, `<package>:<module>:<entity>`, read from
  `allocationPackageId` and falling back to `packageId`; `CANTON_ALLOCATION_TEMPLATES` is built from it.
- The DA Utilities 0.9.2 entry (CBTC) pins `Utility.Registry.V0.Holding.AllocationV2:AllocationV2` of
  utility-registry-v0 0.8.2 (`8c654487d9f5fb195fbcdd7b44cd8e365b1ea39c15ae62ce6c7a48343f1210dd`) and
  `openReceipt: true`, so a committed CBTC allocation is recognised as the escrow of a Canton-source intent.

## 0.4.3

### Changed — a CNRX factory must be signed by the registry's guardian (CAN-3132)

- `CantonTransferFactory.guardian`: G, the guardian of the registrar's `CnrxSupply` (cnrx-registry 0.2.6+), pinned
  per environment; dev's CNRX entries name dev's G. `registriesProblem` takes it only as a party id.
- `REGISTRY_GUARDIANS` / `registryGuardiansOf` and `isRegistryFactory(contract, admin, registries?, guardians?)`: of
  an admin with G, G must sign the factory too. A `CnrxRules` / `CnrxAllocationRules` anchored on another guardian G'
  is admin-signed and of the same package; the intent signing policy now refuses it.
- Fail-closed: a cnrx-registry factory (`Cnrx.Rules:CnrxRules`, `Cnrx.Allocation:CnrxAllocationRules`) of an
  admin with no G is refused; `IntentSigningPolicy.guardians` names G for a wallet with its own CNRX pin, next to
  `registries`. `isCnrxRegistry`: a registry entry whose holding is `Cnrx.Holding:CnrxHolding`; `registriesProblem`
  refuses such an entry without `guardian`.

## 0.4.2

### Changed — intent operations are signed for cancore-intent 0.6.2 only (CAN-2716)

- `INTENT_PACKAGE_IDS` pins 0.6.2
  (`16883f74059616eda07b70764b1160196a5123c5691adccf11062f90176d9d5d`), the version the dev
  participant now vets and prefers; the backend prepares owner-signed Open and Renew against it.
  0.6.2 is an upgrade of 0.4.2–0.6.1, so their roots still run on a ledger that vets them; 0.6.0
  and 0.6.1 accept attestor sets that start on a fractional second, which 0.6.2 refuses.
  A wallet on 0.4.1 refuses every intent operation prepared against 0.6.2.

## 0.4.1

### Changed — intent operations are signed for cancore-intent 0.6.0 only (CAN-3340)

- `INTENT_PACKAGE_IDS` pins the `cancore-intent` package ids whose `IntentFactory_Open` and
  `SwapIntent_RenewSettlementFactory` the wallet signs: 0.6.0
  (`26648cea50d39e2d7110248825bb390df9cbfcfde9aca1f4f8986c33be86b731`). 0.6.0 is an upgrade of
  0.4.2–0.5.2, so their roots still run on a ledger that vets them; those versions open an intent
  without the owner approving the settlement factory, and settle it through the operator's pin.
- `IntentSigningPolicy.intentPackageIds` is optional and defaults to the pin; a package outside
  the pin is refused (`IntentTransactionRefusedError`), so a caller cannot widen it.

## 0.4.0

### Added — intent operations are signed from the prepared transaction (CAN-3340)

The owner of an intent signs the transaction that opens it and, after a registry rotates its
settlement factory, the one that renews it. Both run registry factories with the owner's
authority, so the wallet now reads the transaction before the key signs instead of signing a
32-byte hash on the server's word.

- `signPreparedTransaction(signer, preparedTransactionB64, expectedHashB64, policy)` and
  `verifyPreparedTransaction(...)` (no signature): the recomputed V2 hash must be the expected
  one; the transaction acts as the owner alone; its one root is `IntentFactory_Open` or
  `SwapIntent_RenewSettlementFactory` of an allowed `cancore-intent` package; every action that
  carries the owner's authority is that package's code or `AllocationFactory_Allocate` /
  `SettlementFactory_PublicFetch` on a factory of the policy's registry. Anything else is an
  `IntentTransactionRefusedError` with a `reason` to show, and no signature.
- `OperationLeg.preparedTransaction`. For `intent.open` and `intent.renew-settlement-factory`
  every leg must carry it, `execute` and `signLegs` need an `intentPolicy` and verify every leg
  before `confirm` and before the first signature, and `signPreparedHashBase64(signer, hash,
  operation)` throws for these operations.
- `@cancore/wallet/canton`: the plain view of a prepared transaction, the registry packages by
  instrument admin (`REGISTRY_PACKAGES`, derived from the pinned `CANTON_TRANSFER_FACTORIES`) and
  `isRegistryFactory(contract, admin)` — the admin signs the contract, or its package is in the
  admin's closed list; an admin with no list is refused. One list for the wallet, the filler node
  and the attestor. Its declarations need neither Node nor DOM types.
- `@cancore/wallet/canton/proto`: Canton's V2 prepared-transaction hashing and decoding, moved
  here from `@cancore/trader` (whose `./filler/canton/hashing` subpath re-exports it unchanged).

### What a caller changes

Nothing for the operations that existed before. To sign an intent operation, pass an
`IntentSigningPolicy` — the owner, the instrument admin and the `cancore-intent` package ids the
wallet signs for. The renew choice and its operation name follow the CAN-3340 plan and are
re-checked against `cancore-intent` 0.6.0 once that package is built.

New runtime dependencies: `@canton-network/core-ledger-proto` and `@protobuf-ts/runtime`.

## 0.3.0

### Changed — what the key signs in an envelope ceremony (CAN-2399)

Before this release `./operations` signed whatever the API prepared: a leg the response called
`topology` was signed raw, whatever its bytes were, and every other leg was passed to the signer
as it came. Each of these is a refusal now, an `UnexpectedLegError` raised before the first
signature and before `confirm` is asked:

- A `topology` leg must be a 34-byte sha2-256 multihash (`0x12 0x20` and the digest), must be the
  only leg of its operation, and is prepared only by `wallet.topology`. No other operation may
  carry one. A backend that prepares a party's topology as several legs is refused: it has to be
  one that answers a single leg (Cancore backend `9332b8e67` or later).
- Every other leg's hash must be 32 bytes. Both kinds must be canonical base64 — one message has
  one spelling.
- The whole set is read before the first signature: one leg that does not hold refuses the set,
  with nothing signed.
- `signLegs(signer, legs, { operation })` — pass the `type` you prepared and the legs are held to
  that operation, as `execute` holds them. Without it only the shape of each leg is checked.
- `signPreparedHashBase64` checks the hash is 32 bytes of canonical base64 for every signer, not
  only for one that has no `signPreparedHash` of its own.

### What a caller changes

Nothing, when the legs come from the Cancore API as it is deployed: every leg it prepares already
has this shape. A caller that composes the steps by hand should pass `operation` to `signLegs`.
A caller that catches errors by class gets `UnexpectedLegError` (exported from `./operations`)
where a malformed leg used to reach the signer.
