#!/usr/bin/env node
// Generate the golden vectors of filler protocol v1 with ethers — an encoder
// this package does not ship, so the shipped `hashTypedData` is checked against
// an independent implementation (CAN-1842 A1). Deterministic: every input is a
// literal below, and a re-run rewrites byte-identical files.
//
//   node packages/contracts/scripts/gen-protocol-vectors.mjs
//
// Writes spec/protocol/typed-data/*.json (the eight protocol types),
// spec/typed-data/{Order,Quote,FillTicket}.json (provisional copies of the
// router's structs until evm-contracts publishes them, follow-up F-1),
// spec/typed-data/FillProof.json (the variant A twelve-field struct, written
// here ahead of the router: CAN-2140 copies it byte for byte into
// evm-contracts abi/typed-data/, after which `npm run sync` owns it again) and
// spec/protocol/vectors/{jcs,draw}.json.
import { AbiCoder, concat, keccak256, toBeHex, toUtf8Bytes, TypedDataEncoder, Wallet, zeroPadValue } from 'ethers';
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
  FillTicket: T([['bytes32', 'orderHash'], ['bytes32', 'fillerId'], ['address', 'deliveryKey'], ['bytes32', 'repayTo'], ['uint32', 'attempt'], ['uint64', 'validFrom'], ['uint64', 'validUntil']]),
  FillProof: T([['uint8', 'kind'], ['bytes32', 'orderHash'], ['bytes32', 'destination'], ['bytes32', 'fillRef'], ['bytes32', 'recipient'], ['bytes32', 'outputAsset'], ['uint256', 'amountDelivered'], ['uint64', 'filledAt'], ['bytes32', 'fillerId'], ['bytes32', 'repayTo'], ['uint32', 'attempt'], ['uint32', 'setId']]),
  FillerQuote: T([['bytes32', 'requestId'], ['string', 'fillerId'], ['uint256', 'amountOut'], ['uint64', 'validUntil'], ['uint64', 'nonce']]),
  TicketIntent: T([['bytes32', 'orderHash'], ['uint32', 'attempt'], ['uint64', 'validFrom'], ['uint64', 'validUntil'], ['string', 'fillerId'], ['address', 'deliveryKey'], ['bytes32', 'repayTo']]),
  TicketReceipt: T([['bytes32', 'ticketHash'], ['bytes32', 'ticketSigHash']]),
  StakeBinding: T([['string', 'partnerId'], ['address', 'stakingAddress'], ['uint256', 'chainId'], ['uint64', 'nonce']]),
  FillerAuth: T([['string', 'fillerId'], ['bytes32', 'nonce'], ['uint64', 'expiresAt']]),
  GatewayMessage: T([['bytes32', 'bodyHash']]),
  FillerMessage: T([['bytes32', 'bodyHash']]),
  FillerKeyRegistration: T([['string', 'fillerId'], ['address', 'messageKey'], ['uint64', 'issuedAt']]),
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
const NEXT_RC = (what) => `Filler protocol v1, settlement design (variant A, CAN-2139; protocol.md §3.3): ${what} Domain CancoreFillerProtocol v1, no chainId, no verifyingContract. Digests by ethers TypedDataEncoder.`;
const PROTOCOL_META = { ...PROTOCOL, fields: ['name', 'version'] };

// --- Identity and payout encoding (protocol.md §3.1, §3.15)
const fillerIdHash = (id) => utf8Hash(id);
const repayEvm = (address) => zeroPadValue(address, 32);
const repayParty = (party) => utf8Hash(party);
const DELIVERY_KEY = '0x742d35cc6634c0532925a3b844bc454e4438f44e';
const PAYOUT = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
/** A filler party on the Canton source, shaped like canton-order.json's party ids; its hash is the Canton-source repayTo. */
const FILLER_PARTY = `acme-markets::1220${'acde'.repeat(16)}`;

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
const specTicket = { orderHash: WORKED_DRAW.orderHash, fillerId: fillerIdHash('acme'), deliveryKey: DELIVERY_KEY, repayTo: repayEvm(DELIVERY_KEY), attempt: 0, validFrom: '1789999000', validUntil: '1789999180' };
const fixtureTicket = { orderHash: evmOrderHash, fillerId: fillerIdHash('acme-markets'), deliveryKey: DELIVERY_KEY, repayTo: repayEvm(PAYOUT), attempt: 0, validFrom: '1790000040', validUntil: '1790000400' };
const cantonSourceTicket = { orderHash: canton.orderHash, fillerId: fillerIdHash('acme-markets'), deliveryKey: DELIVERY_KEY, repayTo: repayParty(FILLER_PARTY), attempt: 1, validFrom: '1789999500', validUntil: '1789999800' };
const ticketRows = flat(TICKET, 'FillTicket')([
  { note: 'protocol.md §3.3 hashTicket example: a fixed bytes32 orderHash input, fillerId keccak256("acme"), repayTo the padded delivery key', message: specTicket },
  { note: 'ticket for the test-kit fixture order, attempt 0: EVM source, repayTo another address than the delivery key', fillerIdString: 'acme-markets', message: fixtureTicket },
  { note: 'Canton source (canton-order.json): repayTo = keccak256(utf8(partyId)) of the filler party', fillerIdString: 'acme-markets', repayToParty: FILLER_PARTY, message: cantonSourceTicket },
  { note: 'every integer at its maximum', message: { orderHash: FF32, fillerId: FF32, deliveryKey: FF20, repayTo: FF32, attempt: U32, validFrom: U64, validUntil: U64 } },
  { note: 'zero', message: { orderHash: Z32, fillerId: Z32, deliveryKey: Z20, repayTo: Z32, attempt: 0, validFrom: '0', validUntil: '0' } },
]);
const TICKET_COMMENT = 'Variant A FillTicket (CAN-2139; protocol.md §3.3): seven fields, written here ahead of CancoreRouter.sol, which takes the same string before its first deployment and pins these vectors with hashTicket (CAN-2140). fillerId = keccak256(utf8(fillerId)); repayTo encoded for the source chain (§3.15). Digests by ethers TypedDataEncoder, checked in this package by the shipped encoder as well.';
out('spec/typed-data/FillTicket.json', file('FillTicket', { ...TICKET, fields: ['name', 'version'] }, TICKET_COMMENT, ticketRows));

// --- FillProof (variant A, twelve fields): the vector file evm-contracts and canton-contracts consume
const coder = AbiCoder.defaultAbiCoder();
const cantonIn = JSON.parse(readFileSync(join(pkg, 'spec', 'vectors', 'canton-order.json'), 'utf8')).vector.input;
const cantonInstrument = keccak256(coder.encode(['string', 'string', 'string'], ['cancore:instrument:v1', cantonIn.instrumentAdmin, cantonIn.instrumentId]));
const proofBase = {
  kind: 1,
  orderHash: `0x${'11'.repeat(32)}`,
  destination: zeroPadValue(toBeHex(11155111), 32),
  fillRef: `0x${'22'.repeat(32)}`,
  recipient: repayEvm(`0x${'33'.repeat(20)}`),
  outputAsset: repayEvm(`0x${'44'.repeat(20)}`),
  amountDelivered: '95000000000000000000',
  filledAt: '1790000000',
  fillerId: fillerIdHash('acme'),
  repayTo: repayEvm(`0x${'55'.repeat(20)}`),
  attempt: 1,
  setId: 1,
};
const HARDHAT = { chainId: 31337, verifyingContract: '0x00000000000000000000000000000000caFe0001' };
const proofRows = [
  { note: 'baseline: EVM source and destination, fillerId keccak256("acme"), repayTo a padded EVM address', domain: HARDHAT, message: proofBase },
  { note: 'every integer at its maximum, every word all ones: no field is narrower than the contract says', domain: HARDHAT, message: { kind: 255, orderHash: FF32, destination: FF32, fillRef: FF32, recipient: FF32, outputAsset: FF32, amountDelivered: U256, filledAt: U64, fillerId: FF32, repayTo: FF32, attempt: U32, setId: U32 } },
  { note: 'zero words', domain: HARDHAT, message: { kind: 0, orderHash: Z32, destination: Z32, fillRef: Z32, recipient: Z32, outputAsset: Z32, amountDelivered: '0', filledAt: '0', fillerId: Z32, repayTo: Z32, attempt: 0, setId: 0 } },
  { note: 'same proof, another router: the digest is bound to verifyingContract', domain: { ...HARDHAT, verifyingContract: '0x00000000000000000000000000000000caFe0002' }, message: proofBase },
  {
    note: 'Canton destination (protocol.md §3.13): destination keccak256("canton:mainnet"), recipient keccak256(party), outputAsset keccak256(abi.encode("cancore:instrument:v1", admin, id)), amount Numeric 10 × 10^10 (1200.25); a later attempt under set 2. The encoder itself is CAN-1935',
    domain: HARDHAT,
    message: { ...proofBase, destination: utf8Hash('canton:mainnet'), recipient: utf8Hash(cantonIn.ownerPartyId), outputAsset: cantonInstrument, amountDelivered: '12002500000000', fillerId: fillerIdHash('acme-markets'), repayTo: repayEvm(PAYOUT), attempt: 3, setId: 2 },
  },
  { note: 'same proof, another chain (11155111) and router', domain: { chainId: 11155111, verifyingContract: '0xa5Ca448044cbF78a8b2a3853598b879e2722ce65' }, message: proofBase },
  {
    note: 'Canton source: the delivery of spec/vectors/canton-order.json\'s order, in the domain Daml settles in — chainId CANTON_ORIGIN_ID = 2^63 + 1 (a string: it does not survive a JSON number), verifyingContract CANTON_SOURCE_ANCHOR; repayTo = keccak256(utf8(partyId)) of the filler party (repayToParty), fillerId keccak256("acme-markets"). Daml FillProofVerify must reproduce typeHash, domainSeparator, structHash and digest',
    domain: { chainId: canton.domain.chainId, verifyingContract: canton.domain.verifyingContract },
    fillerIdString: 'acme-markets',
    repayToParty: FILLER_PARTY,
    message: {
      kind: 1, orderHash: canton.orderHash, destination: canton.order.destination, fillRef: '0xcef5e95eb00bff57a5c6565834f300cdc8c694151245ab062e86822a8819897a',
      recipient: canton.order.recipient, outputAsset: canton.order.outputAsset, amountDelivered: '1246760000', filledAt: '1789999700',
      fillerId: fillerIdHash('acme-markets'), repayTo: repayParty(FILLER_PARTY), attempt: 1, setId: 1,
    },
  },
];
out('spec/typed-data/FillProof.json', {
  $comment: 'EIP-712 schema of the variant A FillProof (twelve fields, CAN-2139; protocol.md §3.3) — the struct attestors sign, CancoreRouter.settle verifies (paying repayTo) and Daml Intent.FillProofVerify verifies on a Canton source — and its golden vectors. Written in @cancore/contracts ahead of the router: CAN-2140 copies this file byte for byte to evm-contracts abi/typed-data/FillProof.json, where test/CancoreRouter.ts checks every vector against FILLPROOF_TYPEHASH and hashFillProof; from then on evm-contracts is the source again and `npm run sync` brings it here. canton-contracts takes the Canton-source vector (typeHash, domainSeparator, structHash, digest) into intent-test AttestationVectors (CAN-2144). Digests by ethers TypedDataEncoder; this package checks them with an encoder of its own.',
  primaryType: 'FillProof',
  domain: { $comment: 'The SOURCE router of the order: settle recomputes the digest in its own domain, so a proof never verifies on another chain or router.', ...ROUTER_META },
  typeString: typeString('FillProof'),
  typeHash: utf8Hash(typeString('FillProof')),
  types: { FillProof: TYPES.FillProof },
  vectors: proofRows.map(({ note, domain, message, ...extra }) => {
    const d = { name: 'CancoreRouter', version: '1', ...domain };
    return {
      note, ...extra, chainId: domain.chainId, verifyingContract: domain.verifyingContract, message,
      domainSeparator: TypedDataEncoder.hashDomain(d),
      structHash: TypedDataEncoder.hashStruct('FillProof', { FillProof: TYPES.FillProof }, message),
      digest: digest(d, 'FillProof', message),
    };
  }),
});

// --- Protocol types (frozen)
const REQ = 'req-7f3a9c21-4d88-4e5b-9a1e-0c2f6b8d4e31';
const REQ_MAX = '~'.repeat(64);
out('spec/protocol/typed-data/FillerQuote.json', file('FillerQuote', PROTOCOL_META, NEXT_RC('`requestId` = keccak256(utf8(requestId)), each vector names the string it hashes; `fillerId` is the quoting filler\'s id as a string. Signed by the message key.'), flat(PROTOCOL, 'FillerQuote')([
  { note: 'typical quote', requestIdString: REQ, message: { requestId: utf8Hash(REQ), fillerId: 'acme-markets', amountOut: '999000000', validUntil: '1790000060', nonce: '1' } },
  { note: 'every integer at its maximum, 64-character request id, 63-character fillerId', requestIdString: REQ_MAX, message: { requestId: utf8Hash(REQ_MAX), fillerId: 'z'.repeat(63), amountOut: U256, validUntil: U64, nonce: U64 } },
  { note: 'zero values, one-character request id, one-character fillerId', requestIdString: '!', message: { requestId: utf8Hash('!'), fillerId: '0', amountOut: '0', validUntil: '0', nonce: '0' } },
])));
out('spec/protocol/typed-data/TicketIntent.json', file('TicketIntent', PROTOCOL_META, NEXT_RC('Field order orderHash, attempt, validFrom, validUntil, fillerId, deliveryKey, repayTo. deliveryKey = the address that sends fill (the zero address for a Canton destination); repayTo = where settle pays, encoded for the source chain (§3.15). Signed by the message key; the issued FillTicket carries the same deliveryKey and repayTo (S-22).'), flat(PROTOCOL, 'TicketIntent')([
  { note: 'intent on the fixture ticket: EVM source and destination', message: { orderHash: evmOrderHash, attempt: 0, validFrom: fixtureTicket.validFrom, validUntil: fixtureTicket.validUntil, fillerId: 'acme-markets', deliveryKey: DELIVERY_KEY, repayTo: repayEvm(PAYOUT) } },
  { note: 'Canton destination: deliveryKey is the zero address, repayTo the padded EVM payout address', message: { orderHash: evmOrderHash, attempt: 2, validFrom: '1790000100', validUntil: '1790000400', fillerId: 'acme-markets', deliveryKey: Z20, repayTo: repayEvm(PAYOUT) } },
  { note: 'Canton source: repayTo = keccak256(utf8(partyId)) of the filler party', repayToParty: FILLER_PARTY, message: { orderHash: canton.orderHash, attempt: 1, validFrom: cantonSourceTicket.validFrom, validUntil: cantonSourceTicket.validUntil, fillerId: 'acme-markets', deliveryKey: DELIVERY_KEY, repayTo: repayParty(FILLER_PARTY) } },
  { note: 'every integer at its maximum', message: { orderHash: FF32, attempt: U32, validFrom: U64, validUntil: U64, fillerId: 'z'.repeat(63), deliveryKey: FF20, repayTo: FF32 } },
  { note: 'zero', message: { orderHash: Z32, attempt: 0, validFrom: '0', validUntil: '0', fillerId: '', deliveryKey: Z20, repayTo: Z32 } },
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
const SIG = `0x${'00'.repeat(64)}1b`; // a placeholder: not part of the body hash
const INNER_SIG = `0x${'11'.repeat(32)}${'22'.repeat(32)}1c`; // an inner typed signature: part of the body hash
const bodies = [
  ['ticket.offer of the fixture order; `sig` is excluded from the body', { type: 'ticket.offer', id: 'g-20', fillerId: 'acme-markets', sentAt: 1790000020000, orderHash: evmOrderHash, attempt: 0, order: EVM_ORDER, amountOut: EVM_ORDER.minReceived, validFrom: fixtureTicket.validFrom, validUntil: fixtureTicket.validUntil, acceptBy: 1790000023000, sig: SIG }],
  ['quote.ack', { type: 'quote.ack', id: 'g-9', fillerId: 'acme-markets', sentAt: 1789999991001, re: 'q-1', requestId: REQ, quoteHash: FF32, receivedAt: 1789999991000, status: 'COUNTED', sig: SIG }],
  ['auth.challenge: the body of GET /v1/filler/auth/challenge?fillerId=, addressed to that fillerId', { type: 'auth.challenge', id: 'g-1', fillerId: 'acme-markets', sentAt: 1789999980000, nonce: utf8Hash('cancore:test:auth-nonce:1'), expiresAt: '1790000030', sig: SIG }],
];
out('spec/protocol/typed-data/GatewayMessage.json', file('GatewayMessage', PROTOCOL_META, FROZEN('`bodyHash` = keccak256(utf8(JCS(message without "sig"))), JCS = RFC 8785. Each vector carries the S→F body, its canonical text and the hash.'), bodies.map(([note, body]) => {
  const { sig: _sig, ...unsigned } = body;
  const text = jcs(unsigned);
  const message = { bodyHash: utf8Hash(text) };
  return { note, body, jcs: text, message, digest: digest(PROTOCOL, 'GatewayMessage', message) };
})));

// --- FillerMessage: the envelope signature of every filler → filler-gateway message (§3.4)
const env = (id, sentAt) => ({ id, fillerId: 'acme-markets', sentAt });
const fillerBodies = [
  ['ticket.intent: the inner TicketIntent sig is in the body, msgSig is not', { type: 'ticket.intent', ...env('i-1', 1790000021000), orderHash: evmOrderHash, attempt: 0, validFrom: fixtureTicket.validFrom, validUntil: fixtureTicket.validUntil, deliveryKey: DELIVERY_KEY, repayTo: repayEvm(PAYOUT), sig: INNER_SIG, msgSig: SIG }],
  ['ticket.decline: no inner signature, the envelope is the only one', { type: 'ticket.decline', ...env('d-1', 1790000027001), orderHash: evmOrderHash, attempt: 0, reason: 'TICKET_ISSUED_LATE', detail: 'ticket.issued 3001 ms after acceptBy', msgSig: SIG }],
  ['quote.reconfirm.reply declining: signed by the envelope only', { type: 'quote.reconfirm.reply', ...env('r-2', 1790000014000), orderHash: evmOrderHash, accept: false, msgSig: SIG }],
  ['pong to a gateway ping', { type: 'pong', ...env('po-1', 1789999995100), re: 'gp-1', msgSig: SIG }],
  ['error from the filler: a frame it cannot handle', { type: 'error', ...env('e-1', 1790000030000), re: 'g-77', code: 'UNKNOWN_TICKET', message: 'no ticket for this orderHash', msgSig: SIG }],
];
out('spec/protocol/typed-data/FillerMessage.json', file('FillerMessage', PROTOCOL_META, NEXT_RC('`bodyHash` = keccak256(utf8(JCS(message without "msgSig"))), JCS = RFC 8785; the body keeps id, fillerId, sentAt and any inner typed sig. Each vector carries the F→S body, its canonical text and the hash. msgSig in a body is a placeholder: the excluded field.'), fillerBodies.map(([note, body]) => {
  const { msgSig: _m, ...unsigned } = body;
  const text = jcs(unsigned);
  const message = { bodyHash: utf8Hash(text) };
  return { note, body, jcs: text, message, digest: digest(PROTOCOL, 'FillerMessage', message) };
})));

// --- FillerKeyRegistration: proof of possession of a message key (§3.16). The test keys are derived
// from a public label: they exist only to show that the signature recovers to messageKey. Never a real key.
const testKey = (label) => new Wallet(utf8Hash(`cancore:test:message-key:${label}`));
const registration = (note, key, fillerId, issuedAt) => {
  const message = { fillerId, messageKey: key.address.toLowerCase(), issuedAt };
  const d = digest(PROTOCOL, 'FillerKeyRegistration', message);
  return { note, message, digest: d, signature: key.signingKey.sign(d).serialized };
};
out('spec/protocol/typed-data/FillerKeyRegistration.json', file('FillerKeyRegistration', PROTOCOL_META, NEXT_RC('Signed by the key being registered (an EOA: 65 bytes, low-s, v ∈ {27, 28}; no EIP-1271) — at onboarding, and with the NEW key at a manual key change by Cancore staff; there is no rotation type. issuedAt in unix seconds. Signed vectors carry `signature` by a test key derived from a public label: it recovers to messageKey.'), [
  registration('onboarding: acme-markets registers its message key', testKey('acme-markets:1'), 'acme-markets', '1789900000'),
  registration('manual key change by Cancore staff: the same registration, signed by the NEW key', testKey('acme-markets:2'), 'acme-markets', '1790100000'),
  ...flat(PROTOCOL, 'FillerKeyRegistration')([
    { note: 'every integer at its maximum (unsigned)', message: { fillerId: 'z'.repeat(63), messageKey: FF20, issuedAt: U64 } },
    { note: 'zero values (unsigned)', message: { fillerId: '', messageKey: Z20, issuedAt: '0' } },
  ]),
]));

// --- JCS and the draw
out('spec/protocol/vectors/jcs.json', {
  $comment: 'RFC 8785 canonical JSON of the values the protocol puts on the wire. Every text of a case parses to the same value; its canonical text and keccak256(utf8(canonical)) follow.',
  cases: JCS_CASES.map(({ note, texts, canonical }) => {
    for (const t of texts) if (jcs(JSON.parse(t)) !== canonical) throw new Error(`jcs case "${note}": ${jcs(JSON.parse(t))}`);
    return { note, texts, canonical, keccak256: utf8Hash(canonical) };
  }),
});
const drawRow = (fixture) => {
  // A-22: candidates ascending by the UTF-8 bytes of fillerId, whatever order the fixture lists them in.
  const candidates = [...fixture.candidates].sort((a, b) => Buffer.compare(Buffer.from(a.fillerId), Buffer.from(b.fillerId)));
  const d = { ...fixture, candidates };
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
