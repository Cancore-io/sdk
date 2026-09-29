// Literal inputs of the protocol golden vectors (gen-protocol-vectors.mjs).
// The drand beacons are real quicknet rounds as served by
// https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/<round>
// (fetched 2026-09-29); nothing here is fetched at generation time.
import { toBeHex, zeroPadValue } from 'ethers';

/** The EVM-source order @cancore/test-kit serves: 1000 USDC on Sepolia (plus a 30 bps inclusive fee) for 999 USDC on Arbitrum Sepolia. */
export const EVM_ORDER = {
  user: '0xa11ce00000000000000000000000000000000001',
  originChainId: '11155111',
  inputToken: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  inputAmount: '1003000000',
  destination: zeroPadValue(toBeHex(421614), 32),
  outputAsset: zeroPadValue('0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', 32),
  minReceived: '999000000',
  recipient: zeroPadValue('0x742d35cc6634c0532925a3b844bc454e4438f44e', 32),
  createdAt: '1790000000',
  fillDeadline: '1790000600',
  feeBps: '30',
};

/** Weights of the auction-and-draw §3.7 example: (base + step) × reliabilityBps. */
const CANDIDATES = [
  { fillerId: 'acme-markets', weight: '1500000' },
  { fillerId: 'cancore-reserve', weight: '900000' },
  { fillerId: 'zeta-liquidity', weight: '1000000' },
];

/** auction-and-draw §3.7 — the orderHash is a fixed bytes32 input (the pre-CAN-1683 golden value), kept so r stays 417828. */
export const WORKED_DRAW = {
  note: 'auction-and-draw §3.7 worked example: quicknet round 1000, fixed bytes32 orderHash',
  round: 1000,
  time: 1692806364,
  signature: '0xb44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39',
  randomness: '0xfe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd',
  orderHash: '0xe61e980d40d1a666a509d2296c0d2658a40ff681e290c7646a75a550629ce1ad',
  attempt: 0,
  candidates: CANDIDATES,
};

/** Attempt 0 of the test-kit fixture order: opened at t0, first round at or after t0 + 6 s. */
export const fixtureDraw = (orderHash) => ({
  note: 'test-kit fixture order, attempt 0: t0 1790000012, deltaDrand 6 s → quicknet round 32398885',
  t0: '1790000012',
  deltaDrand: 6,
  round: 32398885,
  time: 1790000019,
  signature: '0x8f6d5ddd520329a4ce9a25db41c0552a5ac04bd56577138cbb0ec2b9326af2b8012c7dc2c5bcddc439d922c93a281d24',
  randomness: '0xb6d412641a7d58b20ef5dded4ae48e9358cc35710f90961d8fe6e99d0e0281ef',
  orderHash,
  attempt: 0,
  candidates: CANDIDATES,
});

export const JCS_CASES = [
  { note: 'key order and whitespace', texts: ['{"b":2,"a":"x"}', '{ "a" : "x",\n  "b" : 2 }'], canonical: '{"a":"x","b":2}' },
  {
    note: 'nested objects, arrays (order kept), null and booleans',
    texts: ['{"z":[3,{"y":null,"x":true}],"a":{"c":false,"b":[]}}', '{"a":{"b":[],"c":false},"z":[3,{"x":true,"y":null}]}'],
    canonical: '{"a":{"b":[],"c":false},"z":[3,{"x":true,"y":null}]}',
  },
  {
    note: 'string escapes: only what JSON requires is escaped, non-ASCII stays raw UTF-8',
    texts: ['{"s":"line\\nbreak \\"q\\" \\u00e9 \\/"}', '{"s":"line\\nbreak \\"q\\" é /"}'],
    canonical: '{"s":"line\\nbreak \\"q\\" é /"}',
  },
  {
    note: 'keys sorted by UTF-16 code units, not code points (RFC 8785 §3.2.3 example)',
    texts: [
      '{"\\u20ac":1,"\\r":2,"\\ufb33":3,"1":4,"\\ud83d\\ude00":5,"\\u0080":6,"\\u00f6":7}',
      '{"1":4,"\\u00f6":7,"\\ufb33":3,"\\ud83d\\ude00":5,"\\r":2,"\\u20ac":1,"\\u0080":6}',
    ],
    canonical: '{"\\r":2,"1":4,"\u0080":6,"\u00f6":7,"\u20ac":1,"\ud83d\ude00":5,"\ufb33":3}',
  },
  { note: 'integers: zero, negative, 2^53 − 1, exponent form in the input', texts: ['{"n":[0,-1,9007199254740991,1e3]}', '{"n":[0,-1,9007199254740991,1000]}'], canonical: '{"n":[0,-1,9007199254740991,1000]}' },
  { note: 'empty object and empty array', texts: ['{"a":{},"b":[]}', '{ "b":[ ], "a":{ } }'], canonical: '{"a":{},"b":[]}' },
];
