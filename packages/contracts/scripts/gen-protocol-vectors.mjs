#!/usr/bin/env node
// Generate the golden vectors of filler protocol v1 with ethers — an encoder
// this package does not ship, so the shipped `hashTypedData` is checked against
// an independent implementation (CAN-1842 A1). Deterministic: every input is a
// literal below, and a re-run rewrites byte-identical files.
//
//   node packages/contracts/scripts/gen-protocol-vectors.mjs
//
// Writes spec/protocol/typed-data/*.json (the six protocol types),
// spec/typed-data/{Order,Quote,FillTicket}.json (provisional copies of the
// router's structs until evm-contracts publishes them, follow-up F-1) and
// spec/protocol/vectors/{jcs,draw}.json.
import { concat, keccak256, toBeHex, toUtf8Bytes, TypedDataEncoder, zeroPadValue } from 'ethers';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVM_ORDER, fixtureDraw, JCS_CASES, WORKED_DRAW } from './protocol-fixtures.mjs';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = (rel, data) => {
  mkdirSync(dirname(join(pkg, rel)), { recursive: true });
  writeFileSync(join(pkg, rel), `${JSON.stringify(data, null, 2)}\n`);
};

const U256 = ((1n << 256n) - 1n).toString();
const U64 = ((1n << 64n) - 1n).toString();
const U32 = 4294967295;
const FF20 = `0x${'ff'.repeat(20)}`;
const FF32 = `0x${'ff'.repeat(32)}`;
const Z20 = `0x${'00'.repeat(20)}`;
const Z32 = `0x${'00'.repeat(32)}`;
const utf8Hash = (s) => keccak256(toUtf8Bytes(s));
/** RFC 8785 for the value subset of the protocol: default sort is by UTF-16 code units. */
const jcs = (v) =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(jcs).join(',')}]`
      : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(',')}}`;

const T = (fields) => fields.map(([type, name]) => ({ name, type }));
const TYPES = {
  Order: T([['address', 'user'], ['uint64', 'originChainId'], ['address', 'inputToken'], ['uint256', 'inputAmount'], ['bytes32', 'destination'], ['bytes32', 'outputAsset'], ['uint256', 'minReceived'], ['bytes32', 'recipient'], ['uint64', 'createdAt'], ['uint64', 'fillDeadline'], ['uint16', 'feeBps']]),
  Quote: T([['bytes32', 'orderHash'], ['uint64', 'quoteDeadline']]),
  FillTicket: T([['bytes32', 'orderHash'], ['address', 'filler'], ['uint32', 'attempt'], ['uint64', 'validFrom'], ['uint64', 'validUntil']]),
  FillerQuote: T([['bytes32', 'requestId'], ['address', 'filler'], ['uint256', 'amountOut'], ['uint64', 'validUntil'], ['uint64', 'nonce']]),
  TicketIntent: T([['bytes32', 'orderHash'], ['uint32', 'attempt'], ['uint64', 'validFrom'], ['uint64', 'validUntil']]),
  TicketReceipt: T([['bytes32', 'ticketHash'], ['bytes32', 'ticketSigHash']]),
  StakeBinding: T([['string', 'partnerId'], ['address', 'stakingAddress'], ['uint256', 'chainId'], ['uint64', 'nonce']]),
  FillerAuth: T([['string', 'fillerId'], ['bytes32', 'nonce'], ['uint64', 'expiresAt']]),
  GatewayMessage: T([['bytes32', 'bodyHash']]),
};
const typeString = (name) => `${name}(${TYPES[name].map((f) => `${f.type} ${f.name}`).join(',')})`;
const PROTOCOL = { name: 'CancoreFillerProtocol', version: '1' };
const TICKET = { name: 'CancoreFillTicket', version: '1' };
const digest = (domain, name, message) => TypedDataEncoder.hash(domain, { [name]: TYPES[name] }, message);

const EVM_DOMAIN = { chainId: '11155111', verifyingContract: '0x00000000000000000000000000000000cafe0001' };
const canton = JSON.parse(readFileSync(join(pkg, 'spec', 'vectors', 'canton-order.json'), 'utf8')).vector;
const lower = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v.toLowerCase() : v]));
const CANTON_DOMAIN = { chainId: canton.domain.chainId, verifyingContract: canton.domain.verifyingContract.toLowerCase() };
const evmOrderHash = digest({ name: 'CancoreRouter', version: '1', ...EVM_DOMAIN }, 'Order', EVM_ORDER);

function file(name, domainMeta, comment, vectors) {
  return { $comment: comment, primaryType: name, domain: domainMeta, typeString: typeString(name), types: { [name]: TYPES[name] }, vectors };
}
function routerVectors(name, rows) {
  return rows.map(({ note, domain, message }) => ({
    note, chainId: domain.chainId, verifyingContract: domain.verifyingContract, message,
    digest: digest({ name: 'CancoreRouter', version: '1', ...domain }, name, message),
  }));
}
const flat = (domain, name) => (rows) => rows.map(({ note, message, ...extra }) => ({ note, ...extra, message, digest: digest(domain, name, message) }));
const PROVISIONAL = 'PROVISIONAL hand copy of the CancoreRouter.sol struct (evm-contracts f936594) until evm-contracts publishes abi/typed-data for it with its own vectors (follow-up F-1); digests by ethers TypedDataEncoder, checked in this package by the shipped encoder as well.';
const ROUTER_META = { name: 'CancoreRouter', version: '1', fields: ['name', 'version', 'chainId', 'verifyingContract'] };
const FROZEN = (what) => `Filler protocol v1 (frozen, RC): ${what} Domain CancoreFillerProtocol v1, no chainId, no verifyingContract. Digests by ethers TypedDataEncoder.`;
const PROTOCOL_META = { ...PROTOCOL, fields: ['name', 'version'] };

// --- Code types (provisional copies)
out('spec/typed-data/Order.json', file('Order', ROUTER_META, `${PROVISIONAL} The canton vector equals spec/vectors/canton-order.json (Solidity-pinned); the sepolia vector is the test-kit fixture order.`, routerVectors('Order', [
  { note: 'canton-source golden order (spec/vectors/canton-order.json)', domain: CANTON_DOMAIN, message: lower(canton.order) },
  { note: 'EVM-source fixture order of @cancore/test-kit (sepolia to arbitrum sepolia)', domain: EVM_DOMAIN, message: EVM_ORDER },
  { note: 'every integer at its maximum', domain: EVM_DOMAIN, message: { user: FF20, originChainId: U64, inputToken: FF20, inputAmount: U256, destination: FF32, outputAsset: FF32, minReceived: U256, recipient: FF32, createdAt: U64, fillDeadline: U64, feeBps: '65535' } },
  { note: 'zero words and the zero address', domain: EVM_DOMAIN, message: { user: Z20, originChainId: '0', inputToken: Z20, inputAmount: '0', destination: Z32, outputAsset: Z32, minReceived: '0', recipient: Z32, createdAt: '0', fillDeadline: '0', feeBps: '0' } },
])));
out('spec/typed-data/Quote.json', file('Quote', ROUTER_META, PROVISIONAL, routerVectors('Quote', [
  { note: 'quote signer approves the fixture order', domain: EVM_DOMAIN, message: { orderHash: evmOrderHash, quoteDeadline: '1790000030' } },
  { note: 'every integer at its maximum', domain: EVM_DOMAIN, message: { orderHash: FF32, quoteDeadline: U64 } },
  { note: 'zero', domain: EVM_DOMAIN, message: { orderHash: Z32, quoteDeadline: '0' } },
  { note: 'canton source domain', domain: CANTON_DOMAIN, message: { orderHash: canton.orderHash, quoteDeadline: '1789999430' } },
])));
const specTicket = { orderHash: WORKED_DRAW.orderHash, filler: '0x742d35cc6634c0532925a3b844bc454e4438f44e', attempt: 0, validFrom: '1789999000', validUntil: '1789999180' };
const fixtureTicket = { orderHash: evmOrderHash, filler: '0x742d35cc6634c0532925a3b844bc454e4438f44e', attempt: 0, validFrom: '1790000040', validUntil: '1790000400' };
const ticketRows = flat(TICKET, 'FillTicket')([
  { note: 'protocol.md §3.3 hashTicket example: a fixed bytes32 orderHash input (the pre-CAN-1683 golden value)', message: specTicket },
  { note: 'ticket for the test-kit fixture order, attempt 0', message: fixtureTicket },
  { note: 'every integer at its maximum', message: { orderHash: FF32, filler: FF20, attempt: U32, validFrom: U64, validUntil: U64 } },
  { note: 'zero', message: { orderHash: Z32, filler: Z20, attempt: 0, validFrom: '0', validUntil: '0' } },
]);
out('spec/typed-data/FillTicket.json', file('FillTicket', { ...TICKET, fields: ['name', 'version'] }, PROVISIONAL, ticketRows));

// --- Protocol types (frozen)
const REQ = 'req-7f3a9c21-4d88-4e5b-9a1e-0c2f6b8d4e31';
const REQ_MAX = '~'.repeat(64);
out('spec/protocol/typed-data/FillerQuote.json', file('FillerQuote', PROTOCOL_META, FROZEN('`requestId` = keccak256(utf8(requestId)); each vector names the string it hashes.'), flat(PROTOCOL, 'FillerQuote')([
  { note: 'typical quote', requestIdString: REQ, message: { requestId: utf8Hash(REQ), filler: '0x742d35cc6634c0532925a3b844bc454e4438f44e', amountOut: '999000000', validUntil: '1790000060', nonce: '1' } },
  { note: 'every integer at its maximum, 64-character request id', requestIdString: REQ_MAX, message: { requestId: utf8Hash(REQ_MAX), filler: FF20, amountOut: U256, validUntil: U64, nonce: U64 } },
  { note: 'zero values, one-character request id', requestIdString: '!', message: { requestId: utf8Hash('!'), filler: Z20, amountOut: '0', validUntil: '0', nonce: '0' } },
])));
out('spec/protocol/typed-data/TicketIntent.json', file('TicketIntent', PROTOCOL_META, FROZEN('Field order orderHash, attempt, validFrom, validUntil (CAN-1842 A2).'), flat(PROTOCOL, 'TicketIntent')([
  { note: 'intent on the fixture ticket', message: { orderHash: evmOrderHash, attempt: 0, validFrom: fixtureTicket.validFrom, validUntil: fixtureTicket.validUntil } },
  { note: 'every integer at its maximum', message: { orderHash: FF32, attempt: U32, validFrom: U64, validUntil: U64 } },
  { note: 'zero', message: { orderHash: Z32, attempt: 0, validFrom: '0', validUntil: '0' } },
])));
const sigHash = keccak256(`0x${'11'.repeat(64)}1b`);
out('spec/protocol/typed-data/TicketReceipt.json', file('TicketReceipt', PROTOCOL_META, FROZEN('`ticketHash` = FillTicket digest, `ticketSigHash` = keccak256 of the 65 raw signature bytes.'), flat(PROTOCOL, 'TicketReceipt')([
  { note: 'receipt of the fixture ticket (illustrative signature 0x11…11 ‖ 0x1b)', message: { ticketHash: ticketRows[1].digest, ticketSigHash: sigHash } },
  { note: 'all ones', message: { ticketHash: FF32, ticketSigHash: FF32 } },
  { note: 'zero', message: { ticketHash: Z32, ticketSigHash: Z32 } },
])));
out('spec/protocol/typed-data/StakeBinding.json', file('StakeBinding', PROTOCOL_META, FROZEN('`chainId` = EVM chain id of the CNRXStaking deployment; `nonce` strictly increasing per staking address.'), flat(PROTOCOL, 'StakeBinding')([
  { note: 'binding on Ethereum', message: { partnerId: 'acme-markets', stakingAddress: '0x742d35cc6634c0532925a3b844bc454e4438f44e', chainId: '1', nonce: '1' } },
  { note: 'binding on BNB Chain, non-ASCII partner id (UTF-8 hashed)', message: { partnerId: 'zéta-liquidity', stakingAddress: '0x742d35cc6634c0532925a3b844bc454e4438f44e', chainId: '56', nonce: '2' } },
  { note: 'every integer at its maximum', message: { partnerId: 'x'.repeat(63), stakingAddress: FF20, chainId: U256, nonce: U64 } },
  { note: 'zero values, empty string', message: { partnerId: '', stakingAddress: Z20, chainId: '0', nonce: '0' } },
])));
out('spec/protocol/typed-data/FillerAuth.json', file('FillerAuth', PROTOCOL_META, FROZEN('Signed by the quote key in answer to auth.challenge.'), flat(PROTOCOL, 'FillerAuth')([
  { note: 'answer to a challenge', message: { fillerId: 'acme-markets', nonce: utf8Hash('cancore:test:auth-nonce:1'), expiresAt: '1790000030' } },
  { note: 'every integer at its maximum', message: { fillerId: 'z'.repeat(63), nonce: FF32, expiresAt: U64 } },
  { note: 'zero values, empty string', message: { fillerId: '', nonce: Z32, expiresAt: '0' } },
])));
const SIG = `0x${'00'.repeat(65)}`;
const bodies = [
  ['ticket.offer of the fixture order; `sig` is excluded from the body', { type: 'ticket.offer', fillerId: 'acme-markets', sentAt: 1790000013000, orderHash: evmOrderHash, attempt: 0, order: EVM_ORDER, amountOut: EVM_ORDER.minReceived, validFrom: fixtureTicket.validFrom, validUntil: fixtureTicket.validUntil, acceptBy: 1790000016000, sig: SIG }],
  ['quote.ack', { type: 'quote.ack', fillerId: 'acme-markets', sentAt: 1790000001500, re: 'q-1', requestId: REQ, quoteHash: FF32, receivedAt: 1790000001499, status: 'COUNTED', sig: SIG }],
  ['auth.challenge: the one frame without fillerId', { type: 'auth.challenge', sentAt: 1790000000000, nonce: utf8Hash('cancore:test:auth-nonce:1'), expiresAt: '1790000030', sig: SIG }],
];
out('spec/protocol/typed-data/GatewayMessage.json', file('GatewayMessage', PROTOCOL_META, FROZEN('`bodyHash` = keccak256(utf8(JCS(message without "sig"))), JCS = RFC 8785. Each vector carries the S→F body, its canonical text and the hash.'), bodies.map(([note, body]) => {
  const { sig: _sig, ...unsigned } = body;
  const text = jcs(unsigned);
  const message = { bodyHash: utf8Hash(text) };
  return { note, body, jcs: text, message, digest: digest(PROTOCOL, 'GatewayMessage', message) };
})));

// --- JCS and the draw
out('spec/protocol/vectors/jcs.json', {
  $comment: 'RFC 8785 canonical JSON of the values the protocol puts on the wire. Every text of a case parses to the same value; its canonical text and keccak256(utf8(canonical)) follow.',
  cases: JCS_CASES.map(({ note, texts, canonical }) => {
    for (const t of texts) if (jcs(JSON.parse(t)) !== canonical) throw new Error(`jcs case "${note}": ${jcs(JSON.parse(t))}`);
    return { note, texts, canonical, keccak256: utf8Hash(canonical) };
  }),
});
const drawRow = (d) => {
  const h = BigInt(keccak256(concat([d.randomness, d.orderHash, zeroPadValue(toBeHex(d.attempt), 4)])));
  const total = d.candidates.reduce((s, c) => s + BigInt(c.weight), 0n);
  const r = h % total;
  let acc = 0n;
  const winner = d.candidates.find((c) => (acc += BigInt(c.weight)) > r);
  return { ...d, h: toBeHex(h, 32), totalWeight: total.toString(), r: r.toString(), winnerFillerId: winner.fillerId };
};
out('spec/protocol/vectors/draw.json', {
  $comment: 'auction-and-draw §3.6 A-21/A-22: h = keccak256(randomness ‖ orderHash ‖ uint32be(attempt)), r = h mod Σw, winner = first candidate (sorted by UTF-8 bytes of fillerId) whose cumulative weight exceeds r. Real drand quicknet rounds (signature and randomness as served by api.drand.sh).',
  vectors: [drawRow(WORKED_DRAW), drawRow(fixtureDraw(evmOrderHash))],
});
console.log(`vectors written; fixture orderHash ${evmOrderHash}`);
