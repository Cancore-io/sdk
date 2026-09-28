/**
 * The EIP-712 voucher `FeeVault.redeem` accepts: a signer the vault trusts
 * signs `FeeClaim` over this domain, and whoever holds the signature redeems it
 * on-chain. The struct and the domain are the contract's — this file has to
 * stay in lock-step with `FeeVault.sol` and with the backend's signer, which is
 * why both are written here once rather than re-typed by each consumer.
 */

export const FEE_CLAIM_DOMAIN_NAME = 'CancoreFeeVault';
export const FEE_CLAIM_DOMAIN_VERSION = '1';

/** `FeeClaim(address token,address to,uint256 amount,uint256 nonce,uint256 deadline)` */
export const FEE_CLAIM_TYPES = {
  FeeClaim: [
    { name: 'token', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export interface FeeClaim {
  token: `0x${string}`;
  to: `0x${string}`;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
}

/** The typed-data domain for one FeeVault deployment. */
export function feeClaimDomain(chainId: number, verifyingContract: `0x${string}`) {
  return {
    name: FEE_CLAIM_DOMAIN_NAME,
    version: FEE_CLAIM_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  } as const;
}

import { FILL_PROOF_DOMAIN } from './generated/typedData';

export { FILL_PROOF_DOMAIN, FILL_PROOF_TYPES, FILL_PROOF_TYPE_STRING } from './generated/typedData';

/** `FillProof.kind` of v1: k-of-n attestor signatures — the only kind `settle` accepts. */
export const PROOF_KIND_ATTESTATION = 1;

/**
 * What the attestors sign and `CancoreRouter.settle` verifies: the fact of a
 * delivery on the destination chain, for one order. Generated from the
 * contract's schema (`spec/typed-data/FillProof.json`), golden vectors included.
 */
export interface FillProof {
  kind: number;
  orderHash: `0x${string}`;
  /** bytes32: the destination chain id, left-padded. */
  destination: `0x${string}`;
  /** EVM: the delivery transaction hash; Canton: keccak256 of the update id. */
  fillRef: `0x${string}`;
  recipient: `0x${string}`;
  outputAsset: `0x${string}`;
  /** What arrived, not what was sent. */
  amountDelivered: bigint;
  filledAt: bigint;
  /** The filler's payout address on the source chain. */
  filler: `0x${string}`;
  attempt: number;
  /** The attestor set live when the order opened — `attestationSetFor(orderHash)`, never `currentSetId`. */
  setId: number;
}

/**
 * The typed-data domain of a proof: the order's SOURCE router. `settle`
 * recomputes the digest in its own domain, so a proof never verifies on
 * another chain or another router.
 */
export function fillProofDomain(chainId: number, verifyingContract: `0x${string}`) {
  return { ...FILL_PROOF_DOMAIN, chainId, verifyingContract } as const;
}
