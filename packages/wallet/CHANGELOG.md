# Changelog — `@cancore/wallet`

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
