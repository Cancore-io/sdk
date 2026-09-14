# `@cancore/contracts`

The Cancore EVM contracts as data: the ABIs of the deployed HTLC, FeeVault and CNRX
contracts, their custom-error selectors, where each is deployed per environment, the EIP-712
voucher `FeeVault` redeems, and the network registry the API's chain ids refer to.

```bash
npm install @cancore/contracts
```

No runtime code beyond three lookups, no dependencies. Everything is `as const`, so viem and
wagmi infer function, event and error types from the ABIs.

## What is here, and where it comes from

| Entry | Holds | Source of truth |
| --- | --- | --- |
| `@cancore/contracts/abi` | `HTLC_ABI`, `FEE_VAULT_ABI`, `CNRX_ABI`, `IHTLC_ABI`, `IBURN_MINT_ERC20_ABI`, `IPERMIT2_ABI`, `MULTI_BALANCE_CHECKER_ABI`; `HTLC_ERRORS`, `FEE_VAULT_ERRORS`, `CNRX_ERRORS` | `Cancore-io/evm-contracts/abi/*.json` — the reviewed snapshots that repository keeps in lock-step with its compiled contracts |
| `@cancore/contracts/networks` | `NETWORKS`, `networkOf`, `networkKindOf`, `networkByChainId` | the chain ids the Cancore API uses |
| `@cancore/contracts` | all of the above, plus `DEPLOYMENTS` / `deploymentOf`, `FEE_CLAIM_TYPES` / `feeClaimDomain`, `BYTECODE_HASHES`, `CONTRACTS_RELEASE`, `describeRevert` | the contracts repository's `version.json` and bytecode hashes; the FeeVault contract's own struct and domain |

The ABIs and selector tables are **generated**, never edited: `npm run sync` reads a checkout
of `evm-contracts` (`EVM_CONTRACTS_DIR`) and rewrites `spec/abi/*.json` and
`src/generated/*`. A test holds the TypeScript to the JSON, recomputes every selector with
keccak-256, and checks the snapshot set is the whole surface.

## ABIs

```ts
import { HTLC_ABI } from '@cancore/contracts/abi';

// with viem: every event and function name below is inferred from the const ABI
const logs = await client.getLogs({ address: htlc, fromBlock: htlcBlock });
const locked = logs.map((log) => decodeEventLog({ abi: HTLC_ABI, ...log })).filter((e) => e.eventName === 'Locked');
```

Why a package and not a copied file: the Cancore app's own copy of the HTLC ABI had drifted
from the deployed contract — its `Claimed` event carried seven parameters where the contract
emits eight — and nothing noticed, because a copied ABI decodes what it describes and
silently misses what it does not. This package is what the app installs now.

## Reverts

```ts
import { describeRevert, HTLC_ERRORS, FEE_VAULT_ERRORS } from '@cancore/contracts';

describeRevert(revertData, [HTLC_ERRORS, FEE_VAULT_ERRORS]); // 'LockNotFound()' | undefined
```

The tables map a 4-byte selector to the error's signature. They are recomputed from the ABI on
every sync and by the test suite; the Tron deployment is the same Solidity, so both chains
decode against the same table.

## Deployments

```ts
import { DEPLOYMENTS, deploymentOf, BYTECODE_HASHES } from '@cancore/contracts';

const { htlc, htlcBlock } = deploymentOf('mainnet', 'arbitrum')!;
```

Three environments, three independent deployments: what is on Sepolia for the dev stand is
not what is on Sepolia for testnet. `htlcBlock` is the floor for an event scan.

An address is a claim; `BYTECODE_HASHES` is the proof. The runtime code at any `htlc`
address hashes to `BYTECODE_HASHES.HTLC.deployedBytecodeHash` for the release it was deployed
from, and `CONTRACTS_RELEASE` names that release.

## The FeeClaim voucher

```ts
import { FEE_CLAIM_TYPES, feeClaimDomain, type FeeClaim } from '@cancore/contracts';

const signature = await wallet.signTypedData({
  domain: feeClaimDomain(chainId, feeVault),
  types: FEE_CLAIM_TYPES,
  primaryType: 'FeeClaim',
  message: claim,
});
```

`FeeClaim(address token, address to, uint256 amount, uint256 nonce, uint256 deadline)` over
the domain `CancoreFeeVault` v1 — the struct and the domain are the contract's, and they are
written here once so that the signer and the redeemer cannot disagree about them.

## Networks

```ts
import { networkKindOf, networkByChainId } from '@cancore/contracts/networks';

networkKindOf('tron_nile');   // 'tron'
networkByChainId(42161)?.id;  // 'arbitrum'
```

Three kinds, because three address formats and three signing models: `evm`, `tron`,
`canton`. A caller that branches on `kind` instead of on the id keeps working when a chain is
added.

## Keeping it current

```bash
EVM_CONTRACTS_DIR=../evm-contracts npm run sync   # then review the diff and release
```

A contract change is a release of this package. `CONTRACTS_RELEASE.version` says which
`evm-contracts` version the data was taken from.

Full documentation: <https://docs.cancore.io/sdk/contracts>

## License

Apache-2.0.
