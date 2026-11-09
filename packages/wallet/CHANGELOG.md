# Changelog — `@cancore/wallet`

## 0.4.1

### Changed — intent operations are signed for cancore-intent 0.6.0 only (CAN-3340)

- `INTENT_PACKAGE_IDS` pins the `cancore-intent` package ids whose `IntentFactory_Open` and
  `SwapIntent_RenewSettlementFactory` the wallet signs: 0.6.0
  (`580ee9b8249c0125c24145f3346dba07cc9f516263716265426d8c303dd45ff7`). 0.6.0 is an upgrade of
  0.4.2–0.5.1, so their roots still run on a ledger that vets them; those versions open an intent
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
