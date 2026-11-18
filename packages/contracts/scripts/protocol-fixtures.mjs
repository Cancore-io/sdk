// Literal inputs of the protocol golden vectors (gen-protocol-vectors.mjs).
import { id, toBeHex, zeroPadValue } from 'ethers';

/** The EVM-source order @cancore/test-kit serves: 1000 USDC on Sepolia (plus a 30 bps inclusive fee) for 999 USDC on Arbitrum Sepolia. */
/** The DeliveryOrder contract id of the Canton-form ticket.issued example; its receipt is the first CantonTicketReceipt vector. */
export const CANTON_DELIVERY_ORDER_CID = '00a1b2c3d4e5f6#fixture-delivery-order';

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
  // the filler its tickets name (acme-markets): the router fills an order only on a ticket of the order's filler
  fillerId: id('acme-markets'),
};

/** protocol.md §3.3 hashTicket example: a fixed bytes32 orderHash input (the pre-CAN-1683 golden value), kept so the FillTicket vector stays byte for byte. */
export const SPEC_TICKET_ORDER_HASH = '0xe61e980d40d1a666a509d2296c0d2658a40ff681e290c7646a75a550629ce1ad';

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
