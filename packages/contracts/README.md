# `@cancore/contracts`

The Cancore EVM contracts as data: the ABIs of the HTLC, FeeVault and CNRX contracts and of
the intent rail's `CancoreRouter` and `AttestorSet`, their custom-error selectors, where each is deployed per environment, the EIP-712
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
| `@cancore/contracts/abi` | `HTLC_ABI`, `FEE_VAULT_ABI`, `CNRX_ABI`, `IHTLC_ABI`, `IBURN_MINT_ERC20_ABI`, `IPERMIT2_ABI`, `MULTI_BALANCE_CHECKER_ABI`, `CANCORE_ROUTER_ABI`, `ICANCORE_ROUTER_ABI`, `ATTESTOR_SET_ABI`, `CNRX_STAKING_ABI`, `POINTS_CLAIM_ABI`; an `*_ERRORS` table for each contract that declares custom errors | `Cancore-io/evm-contracts/abi/*.json` — the reviewed snapshots that repository keeps in lock-step with its compiled contracts; `CNRX` and `IBurnMintERC20` from `evm-contracts/vendor/*.json`, a build of `cancore-token-evm` vendored there |
| `@cancore/contracts/networks` | `NETWORKS`, `networkOf`, `networkKindOf`, `networkByChainId` | the chain ids the Cancore API uses |
| `@cancore/contracts` (filler protocol v1) | EIP-712 types and domains of the intent rail, `hashTypedData` / `jcs` / `gatewayBodyHash` / `fillerMessageBodyHash` / `requestIdHash`, one digest helper per settlement type (`hashFillTicket`, `hashFillerQuote`, `hashTicketIntent`, `hashFillerMessage`, `hashFillerKeyRegistration`), `fillerIdHash` / `repayToFromEvm` / `repayToFromParty` / `isEvmRepayTo` / `evmAddressFromRepayTo`, `isEoaSignature`, `fillerEnvelopeError`, `drawValue` / `drawWinner` / `firstRoundAtOrAfter`, wire message types and enums, `FILLER_GATEWAYS` | `docs/intents/protocol.md` and `auction-and-draw.md` in Cancore-io/meta; `CancoreRouter.sol` for the code types |
| `@cancore/contracts` | all of the above, plus `DEPLOYMENTS` / `deploymentOf`, `FEE_CLAIM_TYPES` / `feeClaimDomain`, `FILL_PROOF_TYPES` / `fillProofDomain` / `hashFillProof` / `FillProof`, `BUILD_HASHES` (and its deprecated alias `BYTECODE_HASHES`), `CONTRACTS_RELEASE`, `describeRevert` | the contracts repository's `version.json` and bytecode hashes; the FeeVault contract's own struct and domain; `evm-contracts/abi/typed-data/FillProof.json` for the router's `FillProof` |

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

## CancoreRouter and AttestorSet

The intent rail's router, its interface and the k-of-n attestor set it inherits. A taker reads
intents, fills and filler windows off the router and follows its events:

```ts
import { CANCORE_ROUTER_ABI, CANCORE_ROUTER_ERRORS, describeRevert } from '@cancore/contracts';

const [status, refundAfter, openedAt] = await client.readContract({
  address: router, abi: CANCORE_ROUTER_ABI, functionName: 'intents', args: [orderHash],
});
const fills = await client.getContractEvents({ address: router, abi: CANCORE_ROUTER_ABI, eventName: 'Filled' });
describeRevert(revertData, [CANCORE_ROUTER_ERRORS]); // 'AlreadyFilled()' | …
```

`ICANCORE_ROUTER_ABI` is the narrower interface (`fill`, `settle`, `refund`, `openFor`, the hash
helpers, the events); `ATTESTOR_SET_ABI` is the set on its own (`getAttestorSet`,
`currentSetId`, `isMember`, `revokedAttestors`), which `CancoreRouter` inherits. A test pins what
the taker client relies on: those views and calls, the events `IntentOpened`, `Filled`,
`Settled` and `Refunded`, and the 12-field `Order` tuple in the order of `ORDER_TYPES`, whose
type hash is the router's `ORDER_TYPEHASH`. Router addresses are not in this package yet.

### Orders, the Permit2 witness, the fee

Hashing helpers ship from the package root (sdk.md §7, decided: helpers, not data only). They
are what the backend, the filler node, the attestors and the web app use instead of their own
copies:

```ts
import {
  buildCantonSourceOrder, cantonInclusiveFeeSplit, hashOrder, hashPermitWitness, inclusiveFeeSplit,
  MAX_FEE_BPS, MIN_FILL_TTL, sourceOrderHash,
} from '@cancore/contracts';

hashOrder(order, { chainId, verifyingContract: router }); // CancoreRouter.hashOrder: the orderHash
sourceOrderHash(order, sourceRouter);                     // what a destination keys `filled` on; a Canton origin needs no router

// the EVM-form Order of a Canton-source intent (protocol.md §3.7): refuses an inexact amount, fee or time
const { order, domain, orderHash } = buildCantonSourceOrder({
  ownerPartyId, requestId, instrumentAdmin, instrumentId, amount: '1250.5',
  destinationChainId: 1, wantToken, wantDecimals: 6, minReceived: '1200.25', recipient,
  createdAt, fillDeadline, feeRate: '0.003', cantonOriginId: CANTON_ORIGIN_ID.devnet,
  fillerId: 'acme', // the filler the owner picked; the order carries keccak256(utf8(fillerId))
});

// what the maker signs for openFor: Permit2 PermitWitnessTransferFrom, the order as witness (PERMIT_WITNESS_TYPES for the wallet)
const digest = hashPermitWitness({ permitted: { token, amount }, spender: router, nonce, deadline, witness: order }, chainId);

inclusiveFeeSplit(105n, 500);       // { payout: 100n, fee: 5n } — EVM source, CancoreRouter.settle (floor)
cantonInclusiveFeeSplit(total, 30); // Canton source, Daml inclusiveFee (half-even at 10⁻¹⁰)
```

| Constants | Value | Held to |
| --- | --- | --- |
| `BPS`, `MAX_FEE_BPS`, `MIN_FILL_TTL`, `PROOF_KIND_ATTESTATION` | 10 000, 1 000, 60 s, 1 | `CancoreRouter.sol` via `spec/constants.json` |
| `MAX_FILL_TTL`, `MAX_SIG_TTL`, `MAX_PROOF_WINDOW`, `GRACE`, `SET_DELAY` | 24 h, 24 h, 4 h, 28 h, 72 h (seconds) | `AttestorSet.sol` via `spec/constants.json` |
| `CANTON_ORIGIN_ID`, `CANTON_SOURCE_ANCHOR`, `EIP2294_MAX_CHAIN_ID`, `OWNER_LABEL_TAG`, `INSTRUMENT_LABEL_TAG`, `DAML_NUMERIC_SCALE` | protocol.md §3.8 | `spec/vectors/canton-order.json` |

**Canton destination** (protocol.md §3.13). An EVM-source order delivered on Canton, and the
`FillProof` of the delivery, carry Canton values in EVM fields; this is the one encoder for them:

```ts
import {
  cantonNetworkOfDestination, encodeCantonAmount, encodeCantonDestination, encodeCantonOutputAsset, encodeCantonRecipient,
} from '@cancore/contracts';

const destination = encodeCantonDestination('devnet');                  // keccak256(utf8("canton:devnet"))
const outputAsset = encodeCantonOutputAsset({ admin, id: 'USDCX' });   // keccak256(abi.encode("cancore:instrument:v1", admin, id))
const minReceived = encodeCantonAmount('1200.25');                      // Daml Numeric 10 × 10¹⁰, exact or refused
const recipient = encodeCantonRecipient(partyId);                       // keccak256(utf8(partyId))
cantonNetworkOfDestination(order.destination);                          // 'devnet' | 'testnet' | 'mainnet' | undefined
```

`spec/vectors/canton-destination.json` holds such an order (devnet) with its `orderHash` and the
`FillProof` of its delivery with its digest; its instrument, party and amount are those of the
Canton-destination vector of `spec/typed-data/FillProof.json` (`canton:mainnet`), which the
router test computes with `hashFillProof`.

`spec/constants.json` is written by `npm run sync` from the Solidity source of the same
evm-contracts commit as the ABIs (`CONTRACTS_RELEASE.commit`); a test holds every exported
constant to it, fails on a numeric constant the package does not export, and checks the router's
type hashes and `WITNESS_TYPE_STRING` against the package's type strings. Vectors:
`spec/vectors/evm-order.json`, `permit-witness.json` and `fee-split.json` (both rails; each EVM
case names the router test that pins it, each Canton case carries the Daml values), generated with
ethers by `scripts/gen-router-vectors.mjs`.

## FillProof: what attestors sign

`CancoreRouter.settle(order, proof, sigs)` pays a filler out only against k attestor
signatures over one EIP-712 `FillProof`, in the domain of the order's **source** router, and
pays `proof.repayTo`. Twelve fields: `fillerId` (`keccak256(utf8(fillerId))`) and `repayTo`
(encoded for the source chain) come from the delivery — `Filled` on an EVM destination, the
`DeliveryReceipt` on a Canton one — and sit before `attempt` and `setId`.

```ts
import { FILL_PROOF_TYPES, fillProofDomain, hashFillProof, PROOF_KIND_ATTESTATION } from '@cancore/contracts';

const signature = await wallet.signTypedData({
  domain: fillProofDomain(sourceChainId, sourceRouter),
  types: FILL_PROOF_TYPES,
  primaryType: 'FillProof',
  message: proof, // setId: attestationSetFor(orderHash), never currentSetId
});
```

This repository keeps golden vectors for the schema in `spec/typed-data/FillProof.json` (shipped
in the package since 0.2.0, under `@cancore/contracts/spec/*`), each with its `domainSeparator`,
`structHash` and digest, and the file's `typeHash`. The twelve-field schema and vectors are
synced from `evm-contracts/abi/typed-data/FillProof.json` at `CONTRACTS_RELEASE.commit`; the
router tests check every vector against its own `hashFillProof` (CAN-2140). Sync only from a
variant A checkout: an older eleven-field struct would overwrite this file with the old one.
The Canton-source verifier and its rollout remain a separate compatibility gate.

## Filler protocol v1 (RC)

The wire protocol between a taker and the Cancore filler gateway, frozen as a release
candidate in `0.2.0-rc.1` (npm dist-tag `next`). In `0.x` protocol v1 is the `0.2.x` line; a
breaking protocol change is `0.3`.

```ts
import {
  cantonTicketReceipt, gatewayBodyHash, hashCantonTicketReceipt, hashFillerMessage, hashTicketIntent, repayToFromEvm, fillerIdHash,
} from '@cancore/contracts';

// what the filler's message key signs to take an offered ticket: its delivery key and payout address
const intentDigest = hashTicketIntent({
  orderHash, attempt, validFrom, validUntil,
  fillerId: 'acme',
  deliveryKey,                     // the address that will send fill (zero for a Canton destination)
  repayTo: repayToFromEvm(payout), // EVM source; repayToFromParty(partyId) for a Canton source
});

// what msgSig of EVERY filler → filler-gateway message is over: FillerMessage{bodyHash}
const msgDigest = hashFillerMessage(message); // bodyHash = keccak256(JCS(message without msgSig))

// what every S→F frame's `sig` is over: GatewayMessage{bodyHash} in the same domain
const bodyHash = gatewayBodyHash(frame); // keccak256(JCS(frame without sig))

fillerIdHash('acme'); // the on-chain fillerId of FillTicket, Filled, FillProof, Settled

// the receipt of a Canton-form ticket (no FillTicket, no ticketSig): built from ticket.issued
const receiptDigest = hashCantonTicketReceipt(cantonTicketReceipt(issued)); // orderHash, attempt, keccak256(cid), validUntil
```

`hashTypedData` encodes flat structs (address, bool, bytes, bytesN, string, uintN) and throws on
anything else; it takes wire values as they come — decimal strings, numbers or bigints. There
is no signing in this package: hand the digest to your own secp256k1 key. The filler signs
everything with one message key, an EOA: 65 bytes `r ‖ s ‖ v`, low-s, `v ∈ {27, 28}`, no
EIP-1271 — `isEoaSignature` checks that shape before recovery. A message key is registered
with `FillerKeyRegistration` signed by that key, at onboarding and, with the new key, at a
manual key change by Cancore staff; there is no key-rotation type or message.

| Types | Domain | Status |
| --- | --- | --- |
| `TicketReceipt`, `StakeBinding`, `FillerAuth`, `GatewayMessage` | `CancoreFillerProtocol` v1 | v1 RC — vectors in `spec/protocol/typed-data/` |
| `FillerQuote` (`string fillerId`), `TicketIntent` (with `fillerId`, `deliveryKey`, `repayTo`), `FillerMessage`, `FillerKeyRegistration` | `CancoreFillerProtocol` v1 | variant A — vectors in `spec/protocol/typed-data/` |
| `CantonTicketReceipt` (`orderHash`, `attempt`, `deliveryOrderCidHash`, `validUntil`) | `CancoreFillerProtocol` v1 | receipt of a Canton-form ticket (§10 D-O), additive — vectors in `spec/protocol/typed-data/` |
| `Order` (12 fields, with `createdAt`; `fillerId` last), `Quote` | `CancoreRouter` v1, source router | `abi/typed-data/` in evm-contracts, synced byte for byte to `spec/typed-data/` |
| `FillTicket` (`orderHash`, `fillerId`, `deliveryKey`, `repayTo`, `attempt`, `validFrom`, `validUntil`) | `CancoreFillTicket` v1 | variant A, synced from the router (CAN-2140) |
| `FillProof` (twelve fields) | `CancoreRouter` v1, source router | variant A, synced from the router (above) |

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
| `messages.schema.json` | one `$def` per frame type (23), `x-direction` S2F / F2S / both, `x-rest-only` on the two login types, and the primitives they share |
| `rest.schema.json` | REST bodies; `x-endpoints` (method, path, auth, query, request/response, `errorBody` where a refusal may be unsigned), `x-error-status` |
| `records.schema.json` | the draw record, the epoch record, `GET /v1/gateway` |
| `asyncapi.json` | AsyncAPI 3.0: channel `/v1` (the upgrade's subprotocols, its HTTP refusals `x-upgrade-refusals`, the close codes `x-close-codes`), the gateway's send/receive operations, examples |
| `vectors/messages.json`, `vectors/records.json` | valid example frames and fixture records (hashes real, `sig` a placeholder: r = s = 0, v = 27) |
| `vectors/settle-attestations.json` | `settle.attestations` golden vectors: EVM and Canton source, real TEST-key signatures, the pushed frame and the REST body with one payload, and schema-valid payloads a filler must refuse |

The same objects are exported as `PROTOCOL_SCHEMAS`, `ASYNCAPI`, `MESSAGE_DIRECTIONS`,
`REST_ONLY_TYPES` and `REST_ENDPOINTS`, with TypeScript shapes of every frame (`TicketOffer`, `QuoteAck`, …) and the
enums (`DECLINE_REASONS`, `ERROR_CODES`, …) a test holds to the schemas.

```ts
import Ajv2020 from 'ajv/dist/2020';
import { PROTOCOL_SCHEMAS, SCHEMA_VOCABULARY, messageSchemaRef } from '@cancore/contracts';

const ajv = new Ajv2020({ strict: true });
ajv.addVocabulary([...SCHEMA_VOCABULARY]);
for (const schema of Object.values(PROTOCOL_SCHEMAS)) ajv.addSchema(schema);
ajv.validate(messageSchemaRef(frame.type, 'S2F'), frame); // errors name the field: instancePath "/amountOut"
```

The schemas describe what a v1 **sender** emits: lowercase hex, uint64 and wider as decimal
strings, times in milliseconds, every frame with `id`, `fillerId` and `sentAt`, every S→F frame
signed with `sig` and every F→S frame — `ticket.decline`, a declining `quote.reconfirm.reply`,
`fill.reported`, `pong` and `error` included — with `msgSig` (`f2sEnvelope`); REST request
bodies carry the same envelope. `fillerEnvelopeError` runs the key-free checks of §3.4 (shape of
`msgSig`, the session's `fillerId`, freshness, `id`); recovering `msgSig` against the registered
message key and refusing a replayed `id` stay with the receiver, which keeps an accepted `id` until
`messageIdRetainUntil(sentAt, receivedAt, maxMessageAgeMs)` — freshness is symmetric, so a sender
clock running ahead keeps a message fresh past `receivedAt + maxMessageAgeMs`. The `repayToEvm` definition
refuses a `repayTo` with non-zero top 12 bytes, for a receiver that knows the source is EVM. No
object is closed: a receiver ignores unknown fields and a taker ignores unknown S→F types
(V-2), so check a frame of an unknown type against `s2fEnvelope` and skip it. Every enum is
open the same way: the known values, or any UPPER_SNAKE value added within v1, which a receiver
treats as `OTHER`/generic; a `ticket.issued` of an unknown `form` is checked on its common fields
only. `ping`, `pong` and `error` go both ways: the gateway's copy carries `sig` (`pingS2F`), the
filler's `msgSig` (`pingF2S`); the second argument of `messageSchemaRef` picks one.
`scripts/gen-protocol-docs.mjs` derives the examples, records and the AsyncAPI document from
the schemas and the vectors.

### Login and connect

A filler logs in over REST and only then opens the WebSocket:

1. `GET /v1/filler/auth/challenge?fillerId=<fillerId>` → a signed `auth.challenge` addressed to that
   `fillerId`. Check its `sig` against the published gateway key and that `fillerId` is yours.
   Refusals of this anonymous route are unsigned (`unsignedErrorBody`): 400 `BAD_REQUEST`, 404
   `UNKNOWN_REQUEST` (unknown or not `ACTIVE`), 429 `RATE_LIMITED` with `retryAfterMs`.
2. `POST /v1/filler/auth` with `auth.response` (`FillerAuth` by the message key, `nonce` = the
   challenge's) → `{token, expiresAt}`, bound to `(fillerId, message key)`. Refusals decided before
   any signature check are unsigned too: 400 `BAD_REQUEST`, 404 `UNKNOWN_REQUEST`, 401
   `UNAUTHENTICATED` (no live challenge for the fillerId: start again from step 1), 429; refusals after
   the signature checks are the signed `error`.
3. Upgrade `/v1` offering `fillerWsProtocols(token)` = `['cancore-filler.v1', 'bearer.<token>']`
   (`FILLER_WS_SUBPROTOCOL`, `FILLER_WS_BEARER_PREFIX`) as `Sec-WebSocket-Protocol`; the gateway
   answers `cancore-filler.v1` and sends a signed `auth.ok` first. It refuses with plain HTTP
   (`FILLER_UPGRADE_REFUSALS`: 400, 401, 403, 429 with `Retry-After`, 503) and closes a session
   with one of `FILLER_CLOSE_CODES` (4029: rate-limit cooldown, preceded by `error RATE_LIMITED`
   whose `retryAfterMs` is the remaining cooldown).

The same token authenticates REST (`Authorization: Bearer`). `auth.challenge` and
`auth.response` never travel on the socket (`REST_ONLY_TYPES`). Over a per-fillerId rate limit
the gateway answers `error RATE_LIMITED` with `retryAfterMs` (on REST: 429, always unsigned, with
`retryAfterMs` and `Retry-After`); send nothing of that rate class before it has passed. The
classes: `quote`, `ticket` (ticket and fill messages), `service` (ping, pong, error), `read` (every
bearer GET), `login`, and two for §3.19, whose Canton traffic Cancore pays: `cantonPrepare` —
`canton.prepare`, an hourly budget per filler (60 by default, staff may change it per filler;
operator decision A2-1) — and `canton` — `canton.submit`. A spent prepare budget pauses new
prepares only: the submit of an operation already prepared keeps its own class.

### Attestation signatures for `settle`

Once filler-gateway holds at least `threshold` verified attestor signatures over a filler's
`FillProof`, it pushes `settle.attestations` to that filler and serves the same payload on
`GET /v1/filler/attestations/{orderHash}` (404 `ATTESTATIONS_NOT_READY` before that, 404
`UNKNOWN_TICKET` when the filler holds no ticket on the order); the filler node submits `settle`
itself (protocol §3.5, §3.6, §10 D-N). `proof` is the `FillProof` the source router hashes,
field for field (`FILL_PROOF_TYPES`), including variant A's `fillerId` and `repayTo`
(protocol §3.3). A signature entry follows `sourceChainId`: `{signer, signature}` with a
65-byte signature on an EVM source, `{signer, pubKey, signature}` with the DER public key and a
minimal DER signature on a Canton source, as `SwapIntent_SettleWithProof` takes them.

```ts
import { settleAttestationsErrors, settleAttestationsPayload, settleAttestationsPayloadHash, settleSigs } from '@cancore/contracts';

const payload = settleAttestationsPayload(frame); // the same from WebSocket and REST
settleAttestationsErrors(payload); // [] or what the schema cannot state: threshold, signer order, ids
settleAttestationsPayloadHash(frame); // dedupe the two channels
settleSigs(payload); // EVM: the sigs of settle(order, proof, sigs); Canton: cantonSigEntries(payload)
```

Recover every signer and check it against `attestationSetFor(orderHash)` with your own
secp256k1 library (T-7). `scripts/gen-settle-attestations.mjs` writes the vectors.

### Canton operations of the filler party

A filler's Canton party is an external party on the Cancore participant; its Ed25519 key stays
in the node, and the node never talks to a Ledger API (protocol §3.19). Cancore prepares each
transaction, the node signs the prepared hash with its party key, Cancore submits it and pays
the Canton traffic. Two messages, on the WebSocket or as REST bodies:

| Op (`CANTON_OPS`) | `params` | What it does |
|---|---|---|
| `party.allocate` | `publicKey` | creates the party (topology legs, `kind: 'topology'`) |
| `registry.accept` | — | accepts the `FillerRegistryEntryProposal` of the fillerId |
| `delivery.fill` | `orderHash`, `attempt` | `DeliveryOrder_Fill` of a Canton ticket issued to the filler |
| `intent.settle` | `orderHash` | `SwapIntent_SettleWithProof` of a Canton-source order the filler delivered |
| `holdings.transfer` | `asset`, `amount`, `toParty` | `TransferFactory_Transfer` of its own holdings to a party it names; what its open delivery orders need stays |
| `preapproval.create` | `admin` | the party's transfer preapproval with the registry of the instrument admin `admin` (CNRX: `CnrxTransferPreapproval`, signed by the party), so a transfer to the party completes at once instead of waiting for it to accept |

`canton.prepare` → `canton.prepared` (`operationId`, `legs`, `summary`, `expiresAt`);
`canton.submit` (one Ed25519 signature per leg) → `canton.submitted`.

**The node never signs blind.** What its party key signs is what Cancore assembled, and `summary`
is only what Cancore says about it, so before signing a leg the node MUST:

- `kind: 'transaction'` — recompute `hash` from `preparedTransaction` with the participant's
  prepared-transaction hashing of `hashingSchemeVersion`, decode the transaction and check it
  against `summary` for the op: template and choice, acting and receiving parties, instrument,
  amount;
  for `preapproval.create` the one created preapproval — of the pinned registry package, receiver
  its own party, the asked admin, nothing else in the transaction;
- `kind: 'topology'` (only in `party.allocate`; the schema refuses it in any other op) — recompute
  the multihash over `topologyTransactions` and check that they create `summary.partyId` with
  `summary.publicKey` as its only signing key, hosted on the Cancore participant.

Checking against `summary` means the economics too, decoded from the transaction's child nodes,
never taken from `summary` alone: for `delivery.fill` the `TransferFactory_Transfer` under
`DeliveryOrder_Fill` — sender (its party), receiver, instrument, amount, the `inputHoldingCids`,
`executeBefore`, the pinned factory — against the order the node itself accepted; for
`intent.settle` the settlement's legs — the payee is its party and receives `amount`, the only
other leg is the fee to the operator — against the intent it delivered for.

On any difference it does not sign. The kind of a leg is closed: an unknown kind is refused. Submit is idempotent per `operationId`. REST: `POST /v1/filler/canton/prepare`,
`POST /v1/filler/canton/submit`; reads of the own party: `GET /v1/filler/canton/party` (with
`preapprovals`, the party's live transfer preapprovals),
`/holdings`, `/delivery-orders`, and `/intents/{orderHash}` — the live Canton-source `SwapIntent`
naming the party as its filler, with its committed allocation, which the node checks before
`ticket.receipt` (V-C1…V-C6; 404 `UNKNOWN_TICKET` when none names it). Refusals: `CANTON_NOT_READY` (409), `CANTON_REFUSED` (422),
`CANTON_UNAVAILABLE` (503, retry), `OPERATION_EXPIRED` (410, prepare again), plus
`UNKNOWN_TICKET`, `TICKET_CLOSED` and `NOT_ELIGIBLE` for an operation on someone else's ticket or party.

The filler's own routes (§3.20): Cancore staff approve the routes a filler may serve; the
filler switches each approved route on or off itself. `GET /v1/filler/routes` answers
`routes.state` — every approved route with `active`; `POST /v1/filler/routes` takes `routes.set`
— the full list the filler serves from now on, sealed by its message key — applies it at once and
answers the new `routes.state`. A listed route that is not approved refuses the whole request
`ROUTE_NOT_APPROVED` (403) and nothing changes. Both are REST only, rate class `service`.

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
import { DEPLOYMENTS, deploymentOf, BUILD_HASHES } from '@cancore/contracts';

const { htlc, htlcBlock } = deploymentOf('mainnet', 'arbitrum')!;
```

Three environments, three independent deployments: what is on Sepolia for the dev stand is
not what is on Sepolia for testnet. `htlcBlock` is the floor for an event scan.

`BUILD_HASHES` pins the build each release was made from, as `evm-contracts` records it in
`scripts/tools/check-bytecode-match.mjs`: `creationHexSha256` and `runtimeHexSha256` are sha256
of the UTF-8 text of the artifact's `0x`-prefixed hex (creation and runtime code) — not
keccak256, and not of the bytes — and `creationHexLength` / `runtimeHexLength` are the length
of that text, `0x` included. `BYTECODE_HASHES` is the same data under the old field names
(`bytecodeHash`, `deployedBytecodeHash`, `bytecodeLength`, `deployedBytecodeLength`); it is
deprecated and goes before `0.2.0`. It is not a hash of `eth_getCode`: a contract with
immutables (`CancoreRouter`, `FeeVault`) never matches one, so checking a live deployment
against it means rebuilding the release, not hashing the address. `CONTRACTS_RELEASE` names the
release.

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

`npm run sync` is two scripts: `scripts/sync.mjs` (ABIs, error tables, release identity, the
router and AttestorSet constants in `spec/constants.json`) and
`scripts/sync-typed-data.mjs` (all four `abi/typed-data/*.json` schemas). Use the
full command above: the standalone typed-data script does not validate or stamp
source provenance.

`EVM_CONTRACTS_DIR` must be the root of a clean git checkout of `evm-contracts`: the sync records
its `HEAD` as `CONTRACTS_RELEASE.commit` and refuses a directory that is not a checkout root or
has uncommitted changes, so the release cannot name a commit its data did not come from.

This snapshot is fully synced from the clean, merged EVM `main` commit
[`2f681b9`](https://github.com/Cancore-io/evm-contracts/commit/2f681b9bb74db55c0fe9fec31282bca54b997985)
(EVM [#120](https://github.com/Cancore-io/evm-contracts/pull/120), the dev router records), as recorded
by `CONTRACTS_RELEASE.commit` and `spec/constants.json`. For every subsequent upstream change, run
the full sync from a clean checkout of the
actual merged `main` commit, commit the resulting pins, and rerun the checks before
publishing. This resync is mandatory for merge, squash and rebase alike.

It reads `abi/*.json` except the two manifests (`bytecode-hashes.json`, `versions.json`) and
`vendor/*.json` (the `.abi` field), and refuses to run when `spec/abi/` holds a snapshot the
source no longer has — dropping a published ABI is a decision, not a side effect of a sync.

A contract change is a release of this package. `CONTRACTS_RELEASE.version` says which
`evm-contracts` version the data was taken from.

Full documentation: <https://docs.cancore.io/sdk/contracts>

## Changes

- `0.2.0-rc.19` — `preapproval.create` (CAN-2931): optional `summary.provider` for a Splice (CC)
  registry, whose party signs a `TransferPreapprovalProposal` its provider accepts and pays for;
  such a summary states `requestedAt` and `executeBefore` null and no allowances. Additive.
- `0.2.0-rc.17` — Canton op `preapproval.create` (CAN-2904): `params {admin}`, `summary {party,
  admin, instrumentAllowances, requestedAt, executeBefore}`, `result {preapprovalCid}` — the filler's
  external party signs its own transfer preapproval with a registry, the one way it can be credited
  directly (a CNRX mint or a transfer to it otherwise needs its signature to accept). `CantonParty`
  gains optional `preapprovals` (`CantonPreapproval {admin, contractId, instrumentAllowances,
  executeBefore}`). Additive.
- `0.2.0-rc.16` — the filler's own routes (CAN-2793, protocol §3.20): REST-only frames
  `routes.set` (F→S, the full list of routes the filler serves, sealed by its message key) and
  `routes.state` (S→F, every route approved for the filler with `active`); `GET` and
  `POST /v1/filler/routes`; error code `ROUTE_NOT_APPROVED` (403); types `RouteRef`, `RoutesSet`,
  `RoutesState`. Additive.
- `0.2.0-rc.15` — REST read `GET /v1/filler/canton/intents/{orderHash}` (CAN-1863): the live
  Canton-source `SwapIntent` naming the filler's party, with its committed allocation by its
  AllocationV2 view (`CantonIntent`, `CantonAllocation`, `CantonAllocationLeg`; `$defs`
  `cantonIntent`, `cantonAllocation`). What a filler node checks before `ticket.receipt` on a Canton
  source (V-C1…V-C6). Additive.

- `0.2.0-rc.14` — `CANTON_PARTICIPANTS`: the Cancore participant per environment, next to
  `FILLER_GATEWAYS` (decision Ын-1, CAN-2352). A filler node checks its party's hosting against it
  when it signs `party.allocate`. Devnet `Cancore-devnet-1::1220…524b`; testnet and mainnet `null`.
  Additive.

- `0.2.0-rc.13` — `spec/protocol/vectors/settle-attestations.json` rebuilt on the 12-field
  `Order` (CAN-2643): in both cases `proof.orderHash` is the hash of `order`, `proof.fillerId` is
  `order.fillerId` and the frame is addressed to that filler (the Canton case: `acme`, was
  `cancore-reserve`). `npm run vectors` now runs `gen-settle-attestations.mjs`, so CI catches a
  stale copy. The `settle.attestations` examples in `messages.json` and `asyncapi.json` follow.
  No API change.
- `0.2.0-rc.12` — Canton operations of the filler party through Cancore (CAN-2649, operator
  decision T-1). Additive.
  - Frames `canton.prepare`, `canton.prepared`, `canton.submit`, `canton.submitted` (27 frame
    types); REST `POST /v1/filler/canton/{prepare,submit}`, `GET /v1/filler/canton/{party,holdings,delivery-orders}`.
  - Error codes `CANTON_NOT_READY`, `CANTON_REFUSED`, `CANTON_UNAVAILABLE`, `OPERATION_EXPIRED`.
  - `CANTON_OPS`, `CANTON_LEG_KINDS`, `CANTON_REGISTRY_STATES` and their types.
  - Legs carry what they are over and are verified before signing: `CantonLegTransaction`
    (`preparedTransaction` and `hashingSchemeVersion` required), `CantonLegTopology`
    (`topologyTransactions`, `party.allocate` only); the leg kind is closed.
  - Fifth op `holdings.transfer` (operator decision Yu-1); `party.allocate` states its `hosting`
    (Cancore participant, Confirmation, threshold 1); rate class `cantonPrepare`, the hourly budget
    of `canton.prepare` (A2-1), apart from `canton` of `canton.submit`.
  - Rate classes `canton` (`canton.submit`, operator decision Sh-2) and `cantonPrepare`; the trader
    SDK pauses each on a 429 like the other classes.
- `0.2.0-rc.11` — dev intent routers (CAN-2331). Additive.
  - `EvmDeployment` gains `router` and `routerBlock`; `DEPLOYMENTS.devnet` names the router of
    Sepolia, BNB testnet, Arbitrum Sepolia and Robinhood testnet as recorded and verified in
    `evm-contracts` `deployments/router/dev/` (#120, CAN-2327).
  - `FILLER_GATEWAYS.devnet.ticketSigners` is the ticket signer those routers register; the
    gateway key stays `null` until the gateway release publishes it.

- `0.2.0-rc.10` — the order names its filler (OD-1, OD-6; CAN-2496). **Breaking**: every order
  hash changes.
  - `Order` gains a twelfth and last field, `bytes32 fillerId` = `fillerIdHash(fillerId)` of the
    filler the user picked: `ORDER_TYPES`, `Order`, `OrderJson` (and the `order` of
    `messages.schema.json`), `ORDER_TYPEHASH` `0xf68105de…9d22`, `PERMIT2_WITNESS_TYPE_STRING`.
    The router fills an order only on a ticket naming that filler and settles it only on a proof
    naming it (`WrongFiller`); it refuses to open an order whose `fillerId` is zero
    (`ZeroFillerId`).
  - `buildCantonSourceOrder` takes a required `fillerId` and refuses an empty or malformed one;
    the Canton-source form carries it too (OD-6), so the Daml hash changes with it.
  - ABIs and typed data synced from evm-contracts `496c12a` (evm-contracts#108): `WrongFiller`,
    `ZeroFillerId`, `UnknownOrder`, `NotOrderUser`, `InvalidRefundRecipient`; `Refunded(orderHash, recipient,
    amount)`.
  - Vectors: `canton-order.json` is evm-contracts#108's (orderHash `0x22e3a53a…e79a`, equal to
    canton-contracts#216's Daml `orderHashOf`); `evm-order.json`, `permit-witness.json`,
    `canton-destination.json`, `Order.json`, `Quote.json` and the protocol vectors built on the
    fixture order are regenerated. The fixture order names `acme-markets`; the Canton-source
    ticket and proof name `acme`, the filler `canton-order.json` picked.

`0.2.0-rc.9` follows `0.2.0-rc.7`: no `0.2.0-rc.8` was published. Its four entries below ship
together; the first is breaking within the RC line for a filler and for filler-gateway, the other
three are additive.

- `0.2.0-rc.9` — connect only after login, limits per fillerId (CAN-2232). **Breaking within the
  RC line** for a filler and for filler-gateway:
  - The login is REST only: `GET /v1/filler/auth/challenge` takes a required `fillerId` query
    (`challengeQuery`), and `auth.challenge` is addressed (envelope `s2fBase`, `fillerId`
    required). The refusals of the login routes decided before a signature check, and every 429,
    are unsigned (`unsignedErrorBody`; `errorBody` of the two login endpoints).
    `auth.challenge` and `auth.response` carry `x-rest-only` (a new annotation keyword in
    `SCHEMA_VOCABULARY`; `REST_ONLY_TYPES`) and leave the AsyncAPI channel.
  - The WebSocket upgrade offers `cancore-filler.v1` and `bearer.<token>`:
    `FILLER_WS_SUBPROTOCOL`, `FILLER_WS_BEARER_PREFIX`, `fillerWsProtocols`; its refusals
    `FILLER_UPGRADE_REFUSALS` and the session close codes `FILLER_CLOSE_CODES`, also in
    `asyncapi.json` (`bindings.ws`, `x-upgrade-refusals`, `x-close-codes`).
  - `error` gains optional `retryAfterMs` (an integer ≥ 1, with `RATE_LIMITED`);
    `ErrorMessage.retryAfterMs`, `UnsignedErrorBody`, `ChallengeQuery`, `RestEndpoint.errorBody`.
  - The `auth.challenge` example and its `GatewayMessage` vector carry `fillerId` (that vector's
    digest changes); a `RATE_LIMITED` example; no other digest changes.
- `0.2.0-rc.9` — router constants and order hashing helpers (CAN-1934). Additive only:
  no existing export, type or digest changes.
  - Constants `BPS`, `MAX_FEE_BPS`, `MIN_FILL_TTL`, `MAX_FILL_TTL`, `MAX_SIG_TTL`,
    `MAX_PROOF_WINDOW`, `GRACE`, `SET_DELAY`, `CANTON_ORIGIN_ID`, `CANTON_SOURCE_ANCHOR`,
    `EIP2294_MAX_CHAIN_ID`, `OWNER_LABEL_TAG`, `INSTRUMENT_LABEL_TAG`, `DAML_NUMERIC_SCALE`;
    `spec/constants.json`, synced from the Solidity source, pins them (SDK-6).
  - Helpers `hashOrder`, `sourceOrderHash`, `isCantonOriginId`, `buildCantonSourceOrder` (port of
    evm-contracts `test/helpers/cantonOrder.ts`, EVM destinations), `PERMIT_WITNESS_TYPES`,
    `PERMIT2_WITNESS_TYPE_STRING`, `permit2Domain`, `hashPermitWitness`, `inclusiveFeeSplit` (EVM
    source) and `cantonInclusiveFeeSplit` (Canton source).
  - Vectors `spec/vectors/evm-order.json`, `permit-witness.json`, `fee-split.json`.
- `0.2.0-rc.9` — the Canton-destination encoder (protocol.md §3.13; CAN-1935). Additive only.
  - `encodeCantonDestination(network)`, `cantonNetworkOfDestination(destination)`,
    `encodeCantonOutputAsset({admin, id})`, `encodeCantonRecipient(partyId)`,
    `encodeCantonAmount(amount)`, type `CantonNetwork`.
  - Vector `spec/vectors/canton-destination.json`: an EVM-source order to Canton devnet and the
    `FillProof` of its delivery.
- `0.2.0-rc.9` — `CantonTicketReceipt`, the receipt of a Canton-form ticket (protocol.md
  §3.3, §3.5, §10 D-O; CAN-2062). Additive only (V-2): no existing type, digest or vector changes.
  - Type `CantonTicketReceipt(bytes32 orderHash,uint32 attempt,bytes32 deliveryOrderCidHash,uint64 validUntil)`
    in the `CancoreFillerProtocol` domain, signed by the message key; `fillerId` and `repayTo` are
    not part of it (they travel in `ticket.issued`). Golden vectors in
    `spec/protocol/typed-data/CantonTicketReceipt.json`.
  - Helpers `CANTON_TICKET_RECEIPT_TYPES`, `hashCantonTicketReceipt`, `cantonTicketReceipt` (the
    struct from a Canton-form `ticket.issued` or `ticket.receipt`) and `deliveryOrderCidHash`.
  - `ticket.receipt` gains the Canton form: `form: "canton"`, `deliveryOrderCid`, `validUntil`,
    `sig`; the EVM form (`form` absent or `"evm"`) is unchanged. The same body is the REST
    `POST /v1/filler/tickets/{orderHash}/{attempt}/receipt`; AsyncAPI carries both examples.
    `TicketReceiptMessage` is now the union `TicketReceiptEvm | TicketReceiptCanton`.
- `0.2.0-rc.7` — sync the variant A `CancoreRouter` and `ICancoreRouter` ABIs from
  evm-contracts commit `c214f56f6fe5a62097833c5f1335b0cb5351b225` (CAN-2140).
  - Both the package root and `/abi`, and the shipped `spec/abi/` JSON, expose
    `Filled(orderHash, fillerId, deliveryKey, repayTo, received, recipient, filledAt, attempt)`
    and `Settled(orderHash, fillerId, repayTo, payout, fee)`. Both events index `orderHash` and
    `fillerId`. **Breaking within the RC line**: consumers must decode the new event topics
    and fields; the published `0.2.0-rc.6` still has the old router ABIs.
  - The router's `FillTicket` and `FillProof` tuples now match the variant A typed data
    already shipped in `0.2.0-rc.6`. No typed-data digest changes from `rc.6` to `rc.7`.
    The generated typed-data snapshot now also includes `FillTicket` from the synced schema.
  - Remove the old on-router filler registry views, `setFiller` and `FillerSet`;
    `WrongDeliveryKey` replaces `WrongTicketFiller` and `NotFiller`. Refresh
    `CONTRACTS_RELEASE.commit` and the router build hashes.
  - This package does not deploy a router or complete the Canton/backend/trader rollout.
- `0.2.0-rc.6` (CAN-2139; previously listed as unreleased) — the settlement design of variant A (protocol.md §3.3, §3.4, §3.15,
  §3.16; CAN-2139). **Breaking within the RC line**: every digest of the changed types changes.
  - `FillTicket` is `(orderHash, bytes32 fillerId, address deliveryKey, bytes32 repayTo, attempt,
    validFrom, validUntil)`; `FillProof` has twelve fields, `fillerId` and `repayTo` in place of
    `address filler`; `TicketIntent` adds `string fillerId`, `deliveryKey`, `repayTo`;
    `FillerQuote` names `string fillerId` instead of `address filler`. Type hashes:
    `FillTicket` `0x3b13cc38…73ec82`, `FillProof` `0xc37e18cd…2419ae`.
  - New types `FillerMessage(bytes32 bodyHash)` (the envelope signature `msgSig` of every filler
    message) and `FillerKeyRegistration(string fillerId,address messageKey,uint64 issuedAt)`
    (proof of possession of the message key, also for a manual key change by staff). No
    key-rotation type, no `key.rotate` message, no refund-redirect type.
  - Helpers: `hashFillTicket`, `hashFillProof`, `hashFillerQuote`, `hashTicketIntent`,
    `hashFillerMessage`, `hashFillerKeyRegistration`, `fillerMessageBodyHash`, `fillerIdHash`,
    `repayToFromEvm`, `repayToFromParty`, `isEvmRepayTo`, `evmAddressFromRepayTo`,
    `isEoaSignature`, `fillerEnvelopeError`, `messageIdRetainUntil`.
  - Schemas: every F→S frame carries `id`, `fillerId`, `sentAt`, `msgSig` (`f2sEnvelope`), as does
    the stake-binding REST body; every S→F frame carries `id`; `error` goes both ways
    (`errorS2F`, `errorF2S`); `quote` drops `filler`; `ticket.intent` adds `deliveryKey`,
    `repayTo`; the issued EVM ticket is the seven-field `FillTicket` and the Canton form adds
    `repayTo`; error codes `STALE_MESSAGE`, `REPLAYED_MESSAGE`, `TICKET_REFUSED` with
    `reason` (`TICKET_REFUSED_REASONS`); `repayToEvm`, `fillerKeyRegistration` definitions;
    `sig65` refuses an `s` with its top bit set; `GET /v1/gateway` returns `maxMessageAgeMs`.
  - Vectors for every new and changed type; the router ABI catches up with these types in
    `0.2.0-rc.7` (see «FillProof: what attestors sign»).
- `0.2.0-rc.6` (CAN-2018; previously listed as unreleased) — filler-gateway → filler `settle.attestations` and `GET /v1/filler/attestations/{orderHash}`
  (protocol §3.5, §3.6, §10 D-N): the frame schema with the router's `FillProof` and the EVM and
  Canton signature entries, the REST endpoint, the error code `ATTESTATIONS_NOT_READY` (404), an
  AsyncAPI message, golden vectors (`spec/protocol/vectors/settle-attestations.json`), the
  `SettleAttestations` types and the helpers `settleAttestationsPayload`,
  `settleAttestationsPayloadHash`, `settleAttestationsErrors`, `settleSigs`, `cantonSigEntries`.
  Additive only (V-2): no existing frame, type or vector changes.
- `0.2.0-rc.6` — `auth.response` gains an optional `nonce` (bytes32): the `auth.challenge` nonce it
  answers, so filler-gateway's REST login (`POST /v1/filler/auth`) finds the challenge without trying
  every live one. Additive only (V-2); the `FillerAuth` type and every digest are unchanged.
- `0.2.0-rc.5` — `CONTRACTS_RELEASE.commit`: the evm-contracts commit the data was synced from.
  The sync takes it from the checkout's `HEAD` and refuses a directory that is not a clean
  checkout root. Additive only.
- `0.2.0-rc.4` — adds `BUILD_HASHES`: the release's build hashes under names that say what they
  are (`creationHexSha256`, `runtimeHexSha256`, `creationHexLength`, `runtimeHexLength`).
  `BYTECODE_HASHES` keeps the same values under the old names, deprecated, and is removed before
  `0.2.0`. Additive only.
- `0.2.0-rc.3` — adds the `CNRXStaking` and `PointsClaim` ABIs with their error tables
  (`CNRX_STAKING_ABI`, `CNRX_STAKING_ERRORS`, `POINTS_CLAIM_ABI`, `POINTS_CLAIM_ERRORS`). The
  generator now splits an acronym of two or more capitals from the word after it, which renames
  nothing already exported. Additive only. Neither contract has an address in `DEPLOYMENTS`
  yet; addresses come in a later release.
- `0.2.0-rc.2` — adds the `CancoreRouter`, `ICancoreRouter` and `AttestorSet` ABIs with their error
  tables; `FeeVault` gains the `TransferFailed()` error and `IPermit2` gains
  `permitWitnessTransferFrom`; CNRX and IBurnMintERC20 are now read from `evm-contracts/vendor/`.
  Additive only. Documentation correction: `BYTECODE_HASHES` values have always been sha256 of
  the artifact's hex text, never keccak256 or a hash of `eth_getCode`, as the `0.1.x` README
  said; the values' meaning is unchanged.
- `0.2.0-rc.1` — filler protocol v1 release candidate: EIP-712 types, hashing helpers, JSON
  Schemas, AsyncAPI, golden vectors; the `FillProof` schema.

## License

Apache-2.0.
