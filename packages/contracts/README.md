# `@cancore/contracts`

The Cancore EVM contracts as data: the ABIs of the deployed HTLC, FeeVault and CNRX
contracts, their custom-error selectors, where each is deployed per environment, the EIP-712
voucher `FeeVault` redeems, and the network registry the API's chain ids refer to.

```bash
npm install @cancore/contracts
```

Everything is `as const`, so viem and wagmi infer function, event and error types from the
ABIs. The only runtime code is a few lookups and the filler protocol's hashing helpers, which
need one dependency, `@noble/hashes`.

## What is here, and where it comes from

| Entry | Holds | Source of truth |
| --- | --- | --- |
| `@cancore/contracts/abi` | `HTLC_ABI`, `FEE_VAULT_ABI`, `CNRX_ABI`, `IHTLC_ABI`, `IBURN_MINT_ERC20_ABI`, `IPERMIT2_ABI`, `MULTI_BALANCE_CHECKER_ABI`; `HTLC_ERRORS`, `FEE_VAULT_ERRORS`, `CNRX_ERRORS` | `Cancore-io/evm-contracts/abi/*.json` — the reviewed snapshots that repository keeps in lock-step with its compiled contracts |
| `@cancore/contracts/networks` | `NETWORKS`, `networkOf`, `networkKindOf`, `networkByChainId` | the chain ids the Cancore API uses |
| `@cancore/contracts` (filler protocol v1) | EIP-712 types and domains of the intent rail, `hashTypedData` / `jcs` / `gatewayBodyHash` / `requestIdHash`, `drawValue` / `drawWinner` / `firstRoundAtOrAfter`, wire message types and enums, `FILLER_GATEWAYS` | `docs/intents/protocol.md` and `auction-and-draw.md` in Cancore-io/meta; `CancoreRouter.sol` for the code types |
| `@cancore/contracts` | all of the above, plus `DEPLOYMENTS` / `deploymentOf`, `FEE_CLAIM_TYPES` / `feeClaimDomain`, `FILL_PROOF_TYPES` / `fillProofDomain` / `FillProof`, `BYTECODE_HASHES`, `CONTRACTS_RELEASE`, `describeRevert` | the contracts repository's `version.json` and bytecode hashes; the FeeVault contract's own struct and domain; `evm-contracts/abi/typed-data/FillProof.json` for the router's `FillProof` |

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

## FillProof: what attestors sign

`CancoreRouter.settle(order, proof, sigs)` pays a filler out only against k attestor
signatures over one EIP-712 `FillProof`, in the domain of the order's **source** router.

```ts
import { FILL_PROOF_TYPES, fillProofDomain, PROOF_KIND_ATTESTATION } from '@cancore/contracts';

const signature = await wallet.signTypedData({
  domain: fillProofDomain(sourceChainId, sourceRouter),
  types: FILL_PROOF_TYPES,
  primaryType: 'FillProof',
  message: proof, // setId: attestationSetFor(orderHash), never currentSetId
});
```

This repository keeps golden vectors for the schema in `spec/typed-data/FillProof.json` (shipped
in the package since 0.2.0, under `@cancore/contracts/spec/*`). `evm-contracts` checks every vector against the router's own
`hashFillProof`, and this package's test checks the same file with an encoder of its own: a
field changed there fails there at once, and here after the next `npm run sync`. The schema is
synced like the ABIs.

## Filler protocol v1 (RC)

The wire protocol between a taker and the Cancore filler gateway, frozen as a release
candidate in `0.2.0-rc.1` (npm dist-tag `next`). In `0.x` protocol v1 is the `0.2.x` line; a
breaking protocol change is `0.3`.

```ts
import {
  FILLER_PROTOCOL_DOMAIN, TICKET_INTENT_TYPES, hashTypedData, gatewayBodyHash, GATEWAY_MESSAGE_TYPES,
} from '@cancore/contracts';

// what the filler address signs to take an offered ticket
const digest = hashTypedData({
  domain: FILLER_PROTOCOL_DOMAIN,
  types: TICKET_INTENT_TYPES,
  primaryType: 'TicketIntent',
  message: { orderHash, attempt, validFrom, validUntil },
});

// what every S→F frame's `sig` is over: GatewayMessage{bodyHash} in the same domain
const bodyHash = gatewayBodyHash(frame); // keccak256(JCS(frame without sig))
```

`hashTypedData` encodes flat structs (address, bool, bytes, bytesN, string, uintN) and throws on
anything else; it takes wire values as they come — decimal strings, numbers or bigints. There
is no signing in this package: hand the digest to your own secp256k1 key.

| Types | Domain | Status |
| --- | --- | --- |
| `FillerQuote`, `TicketIntent`, `TicketReceipt`, `StakeBinding`, `FillerAuth`, `GatewayMessage` | `CancoreFillerProtocol` v1 | frozen v1 (RC) — vectors in `spec/protocol/typed-data/` |
| `Order` (11 fields, with `createdAt`), `Quote` | `CancoreRouter` v1, source router | router code; provisional copies in `spec/typed-data/` until evm-contracts publishes them |
| `FillTicket` | `CancoreFillTicket` v1 | router code; provisional copy, as above |
| `FillProof` | `CancoreRouter` v1, source router | synced from evm-contracts (above) |

Golden vectors are generated with ethers by `scripts/gen-protocol-vectors.mjs` from the literal
inputs in `scripts/protocol-fixtures.mjs`, and checked by this package's own encoder too. The
`canton` Order vector equals `spec/vectors/canton-order.json`, a byte copy of
`evm-contracts/test/vectors/canton-order.json` at `f936594`, which the router's test pins.
`spec/protocol/vectors/jcs.json` holds RFC 8785 cases and `draw.json` the draw of
auction-and-draw §3.7 (r = 417828, acme-markets) plus the test-kit fixture draw, both on real
drand quicknet rounds.

### Schemas, AsyncAPI, examples

| File (`@cancore/contracts/spec/protocol/…`) | Holds |
| --- | --- |
| `messages.schema.json` | one `$def` per WebSocket frame type (22), `x-direction` S2F / F2S / both, and the primitives they share |
| `rest.schema.json` | REST fallback bodies; `x-endpoints` (method, path, auth, request/response), `x-error-status` |
| `records.schema.json` | the draw record, the epoch record, `GET /v1/gateway` |
| `asyncapi.json` | AsyncAPI 3.0: channel `/v1`, the gateway's send/receive operations, examples |
| `vectors/messages.json`, `vectors/records.json` | valid example frames and fixture records (hashes real, `sig` a zero placeholder) |

The same objects are exported as `PROTOCOL_SCHEMAS`, `ASYNCAPI`, `MESSAGE_DIRECTIONS` and
`REST_ENDPOINTS`, with TypeScript shapes of every frame (`TicketOffer`, `QuoteAck`, …) and the
enums (`DECLINE_REASONS`, `ERROR_CODES`, …) a test holds to the schemas.

```ts
import Ajv2020 from 'ajv/dist/2020';
import { PROTOCOL_SCHEMAS, SCHEMA_VOCABULARY, messageSchemaRef } from '@cancore/contracts';

const ajv = new Ajv2020({ strict: true });
ajv.addVocabulary([...SCHEMA_VOCABULARY]);
for (const schema of Object.values(PROTOCOL_SCHEMAS)) ajv.addSchema(schema);
ajv.validate(messageSchemaRef(frame.type), frame); // errors name the field: instancePath "/amountOut"
```

The schemas describe what a v1 **sender** emits: lowercase hex, uint64 and wider as decimal
strings, gateway times in milliseconds, every S→F frame with `fillerId`, `sentAt` and `sig`. No
object is closed: a receiver ignores unknown fields and a taker ignores unknown S→F types
(V-2), so check a frame of an unknown type against `s2fEnvelope` and skip it.
`scripts/gen-protocol-docs.mjs` derives the examples, records and the AsyncAPI document from
the schemas and the vectors.

`FILLER_GATEWAYS` is where the gateway key and the ticket signers of each environment are
published. It is empty in the RC: no gateway key exists yet.

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
