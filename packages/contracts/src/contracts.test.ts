import { keccak_256 } from '@noble/hashes/sha3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as abi from './abi';
import { FEE_CLAIM_TYPES } from './eip712';
import { BYTECODE_HASHES, CONTRACTS_RELEASE, describeRevert } from './index';
import { DEPLOYMENTS, deploymentOf } from './deployments';
import { NETWORKS, NETWORK_ALIASES, networkByChainId, networkKindOf, networkOf } from './networks';

const specDir = join(__dirname, '..', 'spec', 'abi');
const snapshots = readdirSync(specDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
const constName = (name: string) => `${name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_ABI`;

// The TypeScript is generated from the JSON; if someone edits one and not the
// other, the package ships an ABI nobody reviewed.
test.each(snapshots)('%s: the exported ABI equals the reviewed JSON snapshot', (name) => {
  const json = JSON.parse(readFileSync(join(specDir, `${name}.json`), 'utf8'));
  const exported = (abi as unknown as Record<string, unknown>)[constName(name)];
  expect(exported).toBeDefined();
  expect(exported).toEqual(json);
});

test('the snapshot set is the whole contracts surface, not a sample of it', () => {
  expect(snapshots).toEqual(['CNRX', 'FeeVault', 'HTLC', 'IBurnMintERC20', 'IHTLC', 'IPermit2', 'MultiBalanceChecker']);
});

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
type Input = { type: string; components?: Input[] };
const canonical = (i: Input): string =>
  i.type.startsWith('tuple') ? `(${(i.components ?? []).map(canonical).join(',')})${i.type.slice(5)}` : i.type;

// The selector tables are data an integrator decodes reverts with; a wrong
// selector is a revert that reads as "unknown". Recompute every one.
test.each(['HTLC', 'FeeVault', 'CNRX'])('%s: every custom error has its keccak selector, and nothing else is in the table', (name) => {
  const json = JSON.parse(readFileSync(join(specDir, `${name}.json`), 'utf8')) as Array<{ type: string; name: string; inputs: Input[] }>;
  const table = (abi as unknown as Record<string, Readonly<Record<string, string>>>)[`${name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_ERRORS`];
  const expected: Record<string, string> = {};
  for (const e of json.filter((x) => x.type === 'error')) {
    const sig = `${e.name}(${e.inputs.map(canonical).join(',')})`;
    expected[`0x${hex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4))}`] = sig;
  }
  expect(table).toEqual(expected);
});

// The Cancore app kept this table by hand (CAN-1042). The generated one must
// agree on every pair it lists — that is the proof the generator computes what
// the hand table meant, and it is what lets the app delete its copy.
test('the HTLC selectors agree with the table the app maintained by hand', () => {
  const handWritten: Record<string, string> = {
    '0xd92e233d': 'ZeroAddress()',
    '0x1f2a2005': 'ZeroAmount()',
    '0xe4280dc5': 'InvalidPreImage()',
    '0xbb53f262': 'ClaimTimeExpired()',
    '0x91624fbf': 'RetakeTimeNotReached()',
    '0x700925ab': 'UnauthorizedClaim()',
    '0xc2103d62': 'UnauthorizedRetake()',
    '0x748d1509': 'LockAlreadyExists()',
    '0xc10ddcde': 'LockNotFound()',
    '0x90b8ec18': 'TransferFailed()',
    '0x9e23841f': 'SenderEqualsReceiver()',
    '0x56d69198': 'InvalidFeeRate()',
    '0xa5574da6': 'InvalidUnlockTime()',
  };
  for (const [selector, sig] of Object.entries(handWritten)) expect(abi.HTLC_ERRORS[selector]).toBe(sig);
  expect(describeRevert('0xc10ddcde000000', [abi.HTLC_ERRORS])).toBe('LockNotFound()');
  expect(describeRevert('0x00000000', [abi.HTLC_ERRORS, abi.FEE_VAULT_ERRORS])).toBeUndefined();
});

test('the release identity names the contracts version and a hash per deployed contract', () => {
  expect(CONTRACTS_RELEASE.version).toMatch(/^\d+\.\d+\.\d+/);
  for (const name of ['HTLC', 'FeeVault', 'CNRX', 'MultiBalanceChecker']) {
    expect(BYTECODE_HASHES[name as keyof typeof BYTECODE_HASHES].deployedBytecodeHash).toMatch(/^[0-9a-f]{64}$/);
  }
});

describe('networks', () => {
  test('ids are the keys, chain ids are unique, and every EVM chain has one', () => {
    for (const [id, n] of Object.entries(NETWORKS)) expect(n.id).toBe(id);
    const chainIds = Object.values(NETWORKS).filter((n) => n.chainId !== undefined).map((n) => n.chainId);
    expect(new Set(chainIds).size).toBe(chainIds.length);
    for (const n of Object.values(NETWORKS)) expect(n.kind === 'evm').toBe(n.chainId !== undefined);
  });

  test('aliases resolve, kinds branch, chain ids look up', () => {
    expect(networkOf('eth')?.id).toBe('ethereum');
    expect(networkKindOf('tron_nile')).toBe('tron');
    expect(networkKindOf('canton')).toBe('canton');
    expect(networkKindOf('nope')).toBeUndefined();
    expect(networkByChainId(11155111)?.id).toBe('sepolia');
    for (const alias of Object.keys(NETWORK_ALIASES)) expect(networkOf(alias)).toBeDefined();
  });
});

describe('deployments', () => {
  test('every deployment names a registered network with the same chain id, and a checksummed-looking address', () => {
    for (const rows of Object.values(DEPLOYMENTS)) {
      for (const d of rows) {
        expect(NETWORKS[d.network]?.chainId).toBe(d.chainId);
        expect(d.htlc).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
    expect(deploymentOf('mainnet', 'ethereum')?.htlc).toBe('0xB3f8BD762fa2a895Ba8Cd35142b7b82b8b413F76');
    expect(deploymentOf('devnet', 'ethereum')).toBeUndefined();
  });
});

test('the FeeClaim struct is the contract’s, field for field, in order', () => {
  expect(FEE_CLAIM_TYPES.FeeClaim.map((f) => `${f.type} ${f.name}`)).toEqual([
    'address token', 'address to', 'uint256 amount', 'uint256 nonce', 'uint256 deadline',
  ]);
});
