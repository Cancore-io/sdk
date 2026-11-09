# Changelog — `@cancore/dapp-connector`

## 0.1.2

### Added — `PrepareExecuteResult` (CAN-3340)

`prepareExecute` answers `{ commandId, userUrl }`, plus `preparedTransaction` and
`preparedTransactionHash` (base64, CIP-0103 names) when the wallet sends them. The provider hands
the answer through untouched, and the type now says so: a signer that verifies a transaction
before it signs needs the bytes, not only their hash. No behaviour changed.
