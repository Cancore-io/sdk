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
