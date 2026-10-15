/**
 * CAN-2331 against the published package and the dev chains: `@cancore/contracts`
 * installed from the npm registry into a project that is not this repository,
 * its `DEPLOYMENTS.devnet` routers read on their own chains over public RPCs.
 * Read-only: no key, no transaction.
 *
 *   mkdir /tmp/consumer && cd /tmp/consumer && npm init -y && npm install @cancore/contracts@next
 *   CANCORE_CONTRACTS_INSTALLED=/tmp/consumer npm run test:int -- deployments
 *
 * Skipped without CANCORE_CONTRACTS_INSTALLED. In this repository's CI the
 * `deployments` job installs the package and runs this suite.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANCORE_ROUTER_ABI } from './generated/CancoreRouter';
import { DEPLOYMENTS as SOURCE_DEPLOYMENTS, type EvmDeployment } from './deployments';
import { FILLER_GATEWAYS as SOURCE_GATEWAYS } from './protocol/gateway';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

const INSTALLED = process.env.CANCORE_CONTRACTS_INSTALLED;
const live = INSTALLED ? describe : describe.skip;

/** Public RPCs of the dev networks, in order of preference. Read-only. */
const RPCS: Record<string, readonly string[]> = {
  sepolia: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org'],
  bnb_testnet: ['https://bsc-testnet-rpc.publicnode.com', 'https://data-seed-prebsc-1-s1.binance.org:8545'],
  arbitrum_sepolia: ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com'],
  robinhood_testnet: ['https://rpc.testnet.chain.robinhood.com'],
};

interface Installed {
  version: string;
  devnet: EvmDeployment[];
  ticketSigners: string[];
  sepoliaRouter: string | undefined;
}

/** What the installed package exports, read by a plain `node` in the consumer project (ESM, no jest transform). */
const readInstalled = (dir: string): Installed =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { DEPLOYMENTS, FILLER_GATEWAYS, deploymentOf } from '@cancore/contracts';
         import { readFileSync } from 'node:fs';
         const { version } = JSON.parse(readFileSync('node_modules/@cancore/contracts/package.json', 'utf8'));
         console.log(JSON.stringify({ version, devnet: DEPLOYMENTS.devnet, ticketSigners: FILLER_GATEWAYS.devnet.ticketSigners, sepoliaRouter: deploymentOf('devnet', 'sepolia')?.router }));`,
      ],
      { cwd: dir, encoding: 'utf8' },
    ),
  ) as Installed;

async function rpc<T>(network: string, method: string, params: readonly unknown[]): Promise<T> {
  const errors: string[] = [];
  for (const url of RPCS[network] ?? []) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const body = (await response.json()) as { result?: T; error?: { message: string } };
        if (body.error) throw new Error(body.error.message);
        return body.result as T;
      } catch (error) {
        errors.push(`${url}: ${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  throw new Error(`${network} ${method}: no RPC answered (${errors.join('; ')})`);
}

const selector = (signature: string) => `0x${bytesToHex(keccak_256(utf8ToBytes(signature))).slice(0, 8)}`;

live('CAN-2331: dev routers of the installed @cancore/contracts on their chains', () => {
  jest.setTimeout(120_000);
  const installed = INSTALLED ? readInstalled(INSTALLED) : ({} as Installed);
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };

  test('TC-SDK-2331-01: the installed package names a router for every devnet chain; deploymentOf(devnet, sepolia).router answers', () => {
    expect(installed.devnet.length).toBeGreaterThan(0);
    for (const d of installed.devnet) {
      expect(d.router).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(Number.isSafeInteger(d.routerBlock)).toBe(true);
    }
    expect(installed.sepoliaRouter).toBe(installed.devnet.find((d) => d.network === 'sepolia')?.router);
  });

  test('TC-SDK-2331-02: the installed devnet routers are the ones of this source (when the installed version is this manifest)', () => {
    if (installed.version !== manifest.version) {
      // A release PR moves the manifest ahead of the registry; the chain checks below still hold the published data.
      expect(installed.version).toMatch(/^0\.2\.0-rc\.\d+$/);
      return;
    }
    const pick = (rows: readonly EvmDeployment[]) => rows.map(({ network, chainId, router, routerBlock }) => ({ network, chainId, router, routerBlock }));
    expect(pick(installed.devnet)).toEqual(pick(SOURCE_DEPLOYMENTS.devnet));
    expect(installed.ticketSigners).toEqual([...SOURCE_GATEWAYS.devnet.ticketSigners]);
  });

  test('TC-SDK-2331-03: every RPC is on the chain the deployment names, and every router has code there', async () => {
    const lengths: number[] = [];
    for (const d of installed.devnet) {
      expect(BigInt(await rpc<string>(d.network, 'eth_chainId', []))).toBe(BigInt(d.chainId));
      const code = await rpc<string>(d.network, 'eth_getCode', [d.router, 'latest']);
      expect(code.length).toBeGreaterThan(2);
      lengths.push((code.length - 2) / 2);
    }
    // One router build on every chain: immutables differ, the length does not.
    expect(new Set(lengths).size).toBe(1);
  });

  test("TC-SDK-2331-04: the environment's ticket signers are ticket signers of every devnet router", async () => {
    expect(CANCORE_ROUTER_ABI.some((e) => e.type === 'function' && e.name === 'ticketSigners')).toBe(true);
    expect(installed.ticketSigners.length).toBeGreaterThan(0);
    for (const d of installed.devnet) {
      for (const signer of installed.ticketSigners) {
        const data = `${selector('ticketSigners(address)')}${signer.slice(2).toLowerCase().padStart(64, '0')}`;
        const answer = await rpc<string>(d.network, 'eth_call', [{ to: d.router, data }, 'latest']);
        expect(BigInt(answer)).toBe(1n);
      }
    }
  });
});
