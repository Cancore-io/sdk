/**
 * What the mock trades: the EVM-source fixture order of `@cancore/contracts`
 * (spec/typed-data/Order.json, "EVM-source fixture order of @cancore/test-kit",
 * Sepolia → Arbitrum Sepolia), opened at t0 = 1790000012 — the draw of its
 * attempt 0 is the contracts vector spec/protocol/vectors/draw.json — and the
 * epoch of auction-and-draw §3.7 (acme-markets, cancore-reserve, zeta-liquidity).
 */
import type { OrderJson } from '@cancore/contracts';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { weightsRoot } from './draws';
import type { EpochLeaf, StakeStep } from './draws';
import { TEST_KEYS } from './keys';
import type { Hex } from './keys';

/** The fixture order's open time (s); the default frozen clock starts here. */
export const FIXTURE_T0 = 1790000012;
const FIXTURE_CREATED_AT = 1790000000;
const FILL_WINDOW_S = 600;

export const SOURCE = { caip2: 'eip155:11155111', chainId: '11155111', router: '0x00000000000000000000000000000000cafe0001' as Hex };
export const DESTINATION = { caip2: 'eip155:421614', token: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d' as Hex };

export const FIXTURE_ORDER: Readonly<OrderJson> = {
  user: '0xa11ce00000000000000000000000000000000001',
  originChainId: '11155111',
  inputToken: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  inputAmount: '1003000000',
  destination: '0x0000000000000000000000000000000000000000000000000000000000066eee',
  outputAsset: '0x00000000000000000000000075faf114eafb1bdbe2f0316df893fd58ce46aa4d',
  minReceived: '999000000',
  recipient: '0x000000000000000000000000742d35cc6634c0532925a3b844bc454e4438f44e',
  createdAt: String(FIXTURE_CREATED_AT),
  fillDeadline: String(FIXTURE_CREATED_AT + FILL_WINDOW_S),
  feeBps: '30',
};

/** O-3 is open; the router test's placeholder Canton destination id. */
const CANTON_DESTINATION: Hex = `0x${bytesToHex(keccak_256(utf8ToBytes('canton:devnet')))}`;

/** The fixture order opened at `t0` (s): exact at FIXTURE_T0, re-timed otherwise (real clock). */
export function orderAt(t0: number, opts: { minReceived?: string; canton?: boolean } = {}): OrderJson {
  const createdAt = t0 === FIXTURE_T0 ? FIXTURE_CREATED_AT : t0;
  return {
    ...FIXTURE_ORDER,
    createdAt: String(createdAt),
    fillDeadline: String(createdAt + FILL_WINDOW_S),
    ...(opts.minReceived ? { minReceived: opts.minReceived } : {}),
    ...(opts.canton ? { destination: CANTON_DESTINATION } : {}),
  };
}

export interface FillerConfig {
  fillerId: string;
  /** Signs FillerQuote and FillerAuth. */
  quoteKey: Hex;
  /** Signs TicketIntent and TicketReceipt; `FillTicket.filler`. */
  fillerAddress: Hex;
}

/** The two takers a test can log in as (TEST keys, see keys.ts). */
export const DEFAULT_FILLERS: readonly FillerConfig[] = [
  { fillerId: 'acme-markets', quoteKey: TEST_KEYS.acmeQuote.address, fillerAddress: TEST_KEYS.acmeFiller.address },
  { fillerId: 'zeta-liquidity', quoteKey: TEST_KEYS.zetaQuote.address, fillerAddress: TEST_KEYS.zetaFiller.address },
];

/** auction-and-draw §3.7: weights 1 500 000, 900 000, 1 000 000. The reserve filler is a leaf, not a login. */
export const DEFAULT_LEAVES: readonly EpochLeaf[] = [
  { fillerId: 'acme-markets', base: '100', tier: 1, reliabilityBps: 10000 },
  { fillerId: 'cancore-reserve', base: '100', tier: 0, reliabilityBps: 9000 },
  { fillerId: 'zeta-liquidity', base: '100', tier: 0, reliabilityBps: 10000 },
];

export const STAKE_STEPS: readonly StakeStep[] = [
  { tier: 0, minStake: '0', step: '0' },
  { tier: 1, minStake: '1000000000000000000000', step: '50' },
];

const EPOCH_S = 30 * 86_400;

/** The one epoch of a mock session, containing `nowS`. A taker added by `--filler` gets a default leaf. */
export function epochAt(nowS: number, fillers: readonly FillerConfig[]) {
  const leaves = [...DEFAULT_LEAVES];
  for (const f of fillers) if (!leaves.some((l) => l.fillerId === f.fillerId)) leaves.push({ fillerId: f.fillerId, base: '100', tier: 0, reliabilityBps: 10000 });
  const startsAt = nowS - 3600;
  return {
    epochId: '1',
    startsAt: String(startsAt),
    endsAt: String(startsAt + EPOCH_S),
    weightsRoot: weightsRoot(leaves),
    leaves,
    stakeSteps: [...STAKE_STEPS],
    rMinBps: 5000,
    snapshotBlocks: { [SOURCE.caip2]: '9000000' },
  };
}

export type Epoch = ReturnType<typeof epochAt>;
