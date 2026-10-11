/**
 * The constants of the intent rail: the router's public constants (held to the
 * contract by `spec/constants.json`, which `npm run sync` reads out of the
 * Solidity source — SDK-6) and the constants of the Canton-source encoding
 * (held to `spec/vectors/canton-order.json`, protocol.md §3.8).
 * `PROOF_KIND_ATTESTATION` lives in `./eip712`, next to `FillProof`.
 */

/** `CancoreRouter.BPS`: basis points in one whole. */
export const BPS = 10_000;

/** `CancoreRouter.MAX_FEE_BPS`: the highest `Order.feeBps` `openFor` accepts — 10 % on top of the net, 1/11 of the total. */
export const MAX_FEE_BPS = 1_000;

/** `CancoreRouter.MIN_FILL_TTL`, seconds: `openFor` needs `fillDeadline ≥ now + MIN_FILL_TTL`. */
export const MIN_FILL_TTL = 60;

/** `AttestorSet.MAX_FILL_TTL`, seconds (24 h): `openFor` needs `fillDeadline ≤ now + MAX_FILL_TTL`. */
export const MAX_FILL_TTL = 86_400;

/** `AttestorSet.MAX_SIG_TTL`, seconds (24 h): `openFor` needs `createdAt ≤ now ≤ createdAt + MAX_SIG_TTL`. */
export const MAX_SIG_TTL = 86_400;

/** `AttestorSet.MAX_PROOF_WINDOW`, seconds (4 h): the cap of `proofWindow`, so `refundAfter ≤ fillDeadline + MAX_PROOF_WINDOW`. */
export const MAX_PROOF_WINDOW = 14_400;

/** `AttestorSet.GRACE`, seconds (28 h): the longest intent lifetime; a replaced attestor set keeps verifying this long. */
export const GRACE = MAX_FILL_TTL + MAX_PROOF_WINDOW;

/** `AttestorSet.SET_DELAY`, seconds (72 h): a proposed attestor set activates this late; above `MAX_SIG_TTL + GRACE`. */
export const SET_DELAY = 259_200;

/** ⌊(2⁶⁴ − 1) / 2⌋ − 36, the largest EVM chain id EIP-2294 allows: every Canton origin id is above it. */
export const EIP2294_MAX_CHAIN_ID = 9_223_372_036_854_775_771n;

/** `Order.originChainId` of a Canton-source order, per Canton network: 2⁶³ + n (2⁶³ itself is unassigned). */
export const CANTON_ORIGIN_ID = {
  mainnet: 9_223_372_036_854_775_809n,
  testnet: 9_223_372_036_854_775_810n,
  devnet: 9_223_372_036_854_775_811n,
} as const;

/**
 * `verifyingContract` of the Canton source domain, one for every Canton network:
 * `address(uint160(uint256(keccak256("cancore:canton-source-anchor:v1"))))`, an address no router can be deployed at.
 */
export const CANTON_SOURCE_ANCHOR = '0x2f37b46Ea93001829498b145985fb53028033701' as const;

/** Domain-separation tag of the owner label (`Order.user` of a Canton-source order). */
export const OWNER_LABEL_TAG = 'cancore:owner:v1';

/** Domain-separation tag of the instrument label (`Order.inputToken` of a Canton-source order). */
export const INSTRUMENT_LABEL_TAG = 'cancore:instrument:v1';

/** Daml `Numeric 10`: Canton amounts are exact at 10⁻¹⁰, and their EVM form is the amount × 10¹⁰. */
export const DAML_NUMERIC_SCALE = 10;
