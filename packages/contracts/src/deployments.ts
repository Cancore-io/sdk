/**
 * Where the contracts are deployed, per environment.
 *
 * Three environments because three independent deployments: what is on Sepolia
 * for the dev stand is not what is on Sepolia for testnet. Pinned here per
 * release of this package, so an integrator on 0.1.x talks to the deployment
 * the backend of that period talks to; `htlcBlock` is where to start an event
 * scan, not before.
 *
 * `BUILD_HASHES` pins the build of each release: sha256 of the UTF-8 text of
 * the artifact's 0x-prefixed hex, not keccak256 and not over `eth_getCode`, so it
 * identifies what was built rather than proving what an address runs
 * (immutables alone change runtime code).
 */

export type DeploymentEnv = 'mainnet' | 'testnet' | 'devnet';

export interface EvmDeployment {
  /** Key into `NETWORKS`. */
  network: string;
  chainId: number;
  htlc: `0x${string}`;
  /** Block the HTLC was deployed in — the floor for an event scan. */
  htlcBlock?: number;
  multiBalanceChecker?: `0x${string}`;
  /** The intent router (`CancoreRouter`) of this environment on this chain; absent where none is deployed. */
  router?: `0x${string}`;
  /** Block the router was deployed in — the floor for an event scan. */
  routerBlock?: number;
}

export const DEPLOYMENTS: Readonly<Record<DeploymentEnv, readonly EvmDeployment[]>> = {
  mainnet: [
    { network: 'ethereum', chainId: 1, htlc: '0xB3f8BD762fa2a895Ba8Cd35142b7b82b8b413F76', htlcBlock: 24699416, multiBalanceChecker: '0xe025CcCDf82F4165633C6033B7F13690B16c8a84' },
    { network: 'bnb', chainId: 56, htlc: '0xB3f8BD762fa2a895Ba8Cd35142b7b82b8b413F76', htlcBlock: 87710517, multiBalanceChecker: '0xe025CcCDf82F4165633C6033B7F13690B16c8a84' },
    { network: 'arbitrum', chainId: 42161, htlc: '0x1794fe17eB780619FAD46BAf80F7628F7495378b', htlcBlock: 443810007, multiBalanceChecker: '0x9ed2e0220e8d069C515972AE369C3FCE3bB29239' },
    { network: 'robinhood', chainId: 4663, htlc: '0xB3f8BD762fa2a895Ba8Cd35142b7b82b8b413F76', htlcBlock: 26837336, multiBalanceChecker: '0x1794fe17eB780619FAD46BAf80F7628F7495378b' },
  ],
  testnet: [
    { network: 'sepolia', chainId: 11155111, htlc: '0xc705C735278AEeF773acb6d1028D8A241D8a9556', htlcBlock: 10334457, multiBalanceChecker: '0x99182E3F18555CFB08e6443e68a11982eF686522' },
    { network: 'bnb_testnet', chainId: 97, htlc: '0x36D7BEBDB5f93b7b926D621E412132dF89628810', htlcBlock: 92435953, multiBalanceChecker: '0x079bDc94B34EC0e905DcfDB516bdE2f292Efcef2' },
    { network: 'arbitrum_sepolia', chainId: 421614, htlc: '0x07a6ccF1f0113e2329Bb2460b28eC0d169f5080E', htlcBlock: 245190705, multiBalanceChecker: '0x555Bef5d2f89Fc81c77b930AB6c0D6734bDE569e' },
    { network: 'robinhood_testnet', chainId: 46630, htlc: '0x5eBf3faAf3a86c37dDf6a46075b8366Ed4D8021A', htlcBlock: 96742769, multiBalanceChecker: '0x9548fd6fA8A3869b215E9D86F6a2628Bf2BEFB74' },
  ],
  devnet: [
    // Routers: evm-contracts deployments/router/dev/*.json (#120, CAN-2327), verified on chain 2026-10-14.
    { network: 'sepolia', chainId: 11155111, htlc: '0xc74469B26206A7b3Aee2781EC21F9F47a1552DD6', htlcBlock: 10469876, router: '0xfd227a0de77807206f4eEF9eE6eDd5795a45EF95', routerBlock: 11913649 },
    { network: 'bnb_testnet', chainId: 97, htlc: '0xC649d578FD0122E2Ce3Bcf6b89E3ef2564d1a30D', htlcBlock: 96439032, router: '0x57A8ad8392C5fF21aF52Fc3Cf246C1a464aCc6B1', routerBlock: 136752813 },
    { network: 'arbitrum_sepolia', chainId: 421614, htlc: '0xE23A046Df3542C4C548162adab4397956b136031', htlcBlock: 251260393, router: '0x7e27831316F7Ee8E44B96056F4354A6D1a22953a', routerBlock: 319105856 },
    { network: 'robinhood_testnet', chainId: 46630, htlc: '0x58D154441Fd7efEd22E49Eda369909DdbE54cC0a', htlcBlock: 96651438, multiBalanceChecker: '0x1b2A32A976F904a1fca87D427239635Ccd97FaFb', router: '0xF833A980ae858fe3cD14a79a9f610525AbB95BF9', routerBlock: 135089078 },
  ],
};

/** Uniswap Permit2 — one canonical address across mainnets. */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

export function deploymentOf(env: DeploymentEnv, network: string): EvmDeployment | undefined {
  return DEPLOYMENTS[env].find((d) => d.network === network);
}
