// Example frames and records of filler protocol v1, built on the golden
// vectors so every hash in them is the real one (gen-protocol-docs.mjs).
// Signatures (`sig` of the gateway, `msgSig` and inner `sig` of the filler)
// are a zero placeholder: this package holds no keys.
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { keccak256, toUtf8Bytes } from 'ethers';
import { CANTON_DELIVERY_ORDER_CID } from './protocol-fixtures.mjs';

// r = s = 0, v = 27: the shape of a signature, and no key signs it.
export const PLACEHOLDER_SIG = `0x${'00'.repeat(64)}1b`;
const S = { fillerId: 'acme-markets', sig: PLACEHOLDER_SIG };
/** The filler envelope of protocol §3.4: id, fillerId, sentAt, msgSig. */
const F = (id, sentAt) => ({ id, fillerId: 'acme-markets', sentAt, msgSig: PLACEHOLDER_SIG });
const tx = (label) => keccak256(toUtf8Bytes(label));
const REQ = 'req-7f3a9c21-4d88-4e5b-9a1e-0c2f6b8d4e31';
const MESSAGE_KEY = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';
/** The filler's Canton party (§3.19): its Ed25519 key, a placeholder signature of that key, the party id the key yields. */
const PARTY_KEY = `0x${'11'.repeat(32)}`;
const PARTY_SIG = `0x${'00'.repeat(64)}`;
const FILLER_PARTY = 'acme-markets::1220a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const RECIPIENT_PARTY = 'alice::1220f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';
const CNRX = { admin: 'cancore-registry::1220aa', id: 'CNRX' };

/** Epoch containing the fixture t0; leaves reproduce the weights of auction-and-draw §3.7. */
export function epochRecord() {
  const leaves = [
    { fillerId: 'acme-markets', base: '100', tier: 1, reliabilityBps: 10000 },
    { fillerId: 'cancore-reserve', base: '100', tier: 0, reliabilityBps: 9000 },
    { fillerId: 'zeta-liquidity', base: '100', tier: 0, reliabilityBps: 10000 },
  ];
  const tree = StandardMerkleTree.of(leaves.map((l) => [l.fillerId, l.base, l.tier, l.reliabilityBps]), ['string', 'uint256', 'uint8', 'uint16']);
  return {
    epochId: '20717',
    startsAt: '1789948800',
    endsAt: '1790035200',
    weightsRoot: tree.root,
    leaves,
    stakeSteps: [
      { tier: 0, minStake: '0', step: '0' },
      { tier: 1, minStake: '100000000000000000000000', step: '50' },
    ],
    rMinBps: 5000,
    snapshotBlocks: { 'eip155:1': '23456789', 'eip155:56': '61234567' },
  };
}

/** Draw record of the fixture order while attempt 0 is open. */
export function drawRecord(draw) {
  return {
    orderHash: draw.orderHash,
    source: 'eip155:11155111',
    openRef: tx('cancore:test-kit:fixture-open-tx'),
    t0: draw.t0,
    epochId: '20717',
    deltaDrand: draw.deltaDrand,
    attempts: [
      {
        attempt: draw.attempt, tBase: draw.t0, closedBy: null, drandRound: String(draw.round), drandRandomness: draw.randomness,
        drandSignature: draw.signature, candidates: draw.candidates, r: draw.r, winnerFillerId: draw.winnerFillerId, fallbackReason: null,
      },
    ],
  };
}

/** One or more valid examples per frame type, keyed by type. */
export function messageExamples({ order, orderHash, ticket, ticketHash, quoteHash, intentHash, receiptSigHash, offerBody, epoch }) {
  const t = { orderHash, attempt: 0 };
  return {
    'auth.challenge': [{ type: 'auth.challenge', id: 'g-1', fillerId: 'acme-markets', sentAt: 1789999980000, nonce: tx('cancore:test:auth-nonce:1'), expiresAt: '1790000030', sig: PLACEHOLDER_SIG }],
    'auth.response': [
      { type: 'auth.response', ...F('a-1', 1789999980100), keyAddress: MESSAGE_KEY, protocolVersion: '1', sig: PLACEHOLDER_SIG },
      { type: 'auth.response', ...F('a-2', 1789999980100), keyAddress: MESSAGE_KEY, protocolVersion: '1', nonce: tx('cancore:test:auth-nonce:1'), sig: PLACEHOLDER_SIG },
    ],
    'auth.ok': [{ type: 'auth.ok', id: 'g-2', ...S, sentAt: 1789999980200, re: 'a-1', heartbeatIntervalMs: 15000 }],
    ping: [{ type: 'ping', ...F('p-1', 1789999994000) }, { type: 'ping', ...S, sentAt: 1789999995000, id: 'gp-1' }],
    pong: [{ type: 'pong', ...F('po-1', 1789999995100), re: 'gp-1' }, { type: 'pong', id: 'g-3', ...S, sentAt: 1789999994100, re: 'p-1' }],
    error: [
      { type: 'error', id: 'g-4', ...S, sentAt: 1790000023500, re: 'i-2', code: 'TICKET_CLOSED', message: 'ticket.intent after acceptBy' },
      { type: 'error', id: 'g-5', sentAt: 1789999980150, sig: PLACEHOLDER_SIG, re: 'a-2', code: 'UNAUTHENTICATED', message: 'no live challenge of this fillerId with this nonce' },
      { type: 'error', id: 'g-6', ...S, sentAt: 1790000021500, re: 'i-3', code: 'TICKET_REFUSED', reason: 'REPAY_TO_BLOCKLISTED', message: 'repayTo is blocklisted by the input token' },
      { type: 'error', ...F('e-1', 1790000030000), re: 'g-77', code: 'UNKNOWN_TICKET', message: 'no ticket for this orderHash' },
      { type: 'error', id: 'g-18', ...S, sentAt: 1789999991500, re: 'q-2', code: 'RATE_LIMITED', message: 'quote rate class over its limit', retryAfterMs: 850 },
    ],
    'epoch.weights': [{ type: 'epoch.weights', id: 'g-7', ...S, sentAt: 1789999980300, epochId: epoch.epochId, startsAt: epoch.startsAt, endsAt: epoch.endsAt, weightsRoot: epoch.weightsRoot }],
    'quote.request': [
      {
        type: 'quote.request', id: 'g-8', ...S, sentAt: 1789999990000, requestId: REQ, route: { src: 'eip155:11155111', dst: 'eip155:421614' },
        inputToken: order.inputToken, inputAmount: order.inputAmount, outputAsset: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', feeBps: 30,
        fillDeadlineHint: order.fillDeadline, windowCloseAt: 1789999992000, quoteTtlMs: 60000,
        imbalanceHint: { dstAsset: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', netFlow24hUsd: '-12500.50' },
      },
    ],
    quote: [{ type: 'quote', ...F('q-1', 1789999991000), requestId: REQ, amountOut: '999000000', validUntil: '1790000060', nonce: '1', sig: PLACEHOLDER_SIG }],
    'quote.ack': [{ type: 'quote.ack', id: 'g-9', ...S, sentAt: 1789999991001, re: 'q-1', requestId: REQ, quoteHash, receivedAt: 1789999991000, status: 'COUNTED' }],
    'quote.reconfirm': [{ type: 'quote.reconfirm', id: 'g-10', ...S, sentAt: 1790000013000, orderHash, requestId: REQ, order, amountOut: order.minReceived, ticketTtl: 360, replyBy: 1790000016000 }],
    'quote.reconfirm.reply': [
      { type: 'quote.reconfirm.reply', ...F('r-1', 1790000014000), orderHash, accept: true, validUntil: '1790000400', nonce: '2', sig: PLACEHOLDER_SIG },
      { type: 'quote.reconfirm.reply', ...F('r-2', 1790000014000), orderHash, accept: false },
    ],
    'ticket.offer': [offerBody],
    'ticket.intent': [
      { type: 'ticket.intent', ...F('i-1', 1790000021000), ...t, validFrom: ticket.validFrom, validUntil: ticket.validUntil, deliveryKey: ticket.deliveryKey, repayTo: ticket.repayTo, sig: PLACEHOLDER_SIG },
      { type: 'ticket.intent', ...F('i-4', 1790000021000), ...t, attempt: 2, validFrom: ticket.validFrom, validUntil: ticket.validUntil, deliveryKey: `0x${'00'.repeat(20)}`, repayTo: ticket.repayTo, sig: PLACEHOLDER_SIG },
    ],
    'ticket.decline': [{ type: 'ticket.decline', ...F('d-1', 1790000027001), ...t, reason: 'TICKET_ISSUED_LATE', detail: 'ticket.issued 3001 ms after acceptBy' }],
    'ticket.intent.ack': [{ type: 'ticket.intent.ack', id: 'g-11', ...S, sentAt: 1790000021001, re: 'i-1', ...t, intentHash, receivedAt: 1790000021000 }],
    'ticket.issued': [
      { type: 'ticket.issued', id: 'g-12', ...S, sentAt: 1790000024000, form: 'evm', ...t, ticket, ticketSig: PLACEHOLDER_SIG },
      { type: 'ticket.issued', id: 'g-13', ...S, sentAt: 1790000024000, form: 'canton', ...t, attempt: 2, deliveryOrderCid: CANTON_DELIVERY_ORDER_CID, validUntil: ticket.validUntil, repayTo: ticket.repayTo },
    ],
    'ticket.receipt': [
      { type: 'ticket.receipt', ...F('rc-1', 1790000025000), ...t, ticketHash, ticketSigHash: receiptSigHash, sig: PLACEHOLDER_SIG },
      { type: 'ticket.receipt', ...F('rc-2', 1790000025000), form: 'canton', ...t, attempt: 2, deliveryOrderCid: CANTON_DELIVERY_ORDER_CID, validUntil: ticket.validUntil, sig: PLACEHOLDER_SIG },
    ],
    'fill.reported': [{ type: 'fill.reported', ...F('f-1', 1790000060000), ...t, txRef: tx('cancore:test-kit:fixture-fill-tx') }],
    'ticket.expired': [
      { type: 'ticket.expired', id: 'g-14', ...S, sentAt: 1790000460000, ...t, result: 'FILLED' },
      { type: 'ticket.expired', id: 'g-15', ...S, sentAt: 1790000460000, ...t, result: 'EXEMPT', exemptReason: 'DESTINATION_HALTED' },
    ],
    'order.settled': [{ type: 'order.settled', id: 'g-16', ...S, sentAt: 1790000900000, orderHash, payout: '1000000000', fee: '3000000', penaltyWithheld: '0', txRef: tx('cancore:test-kit:fixture-settle-tx') }],
    'penalty.applied': [{ type: 'penalty.applied', id: 'g-17', ...S, sentAt: 1790001000000, violationId: 'v-1', code: 'NO_SHOW', step: 'RECORDED', details: { orderHash, attempt: 0 } }],
    'canton.prepare': [
      { type: 'canton.prepare', ...F('cp-1', 1789990000000), op: 'party.allocate', params: { publicKey: PARTY_KEY } },
      { type: 'canton.prepare', ...F('cp-2', 1789990100000), op: 'registry.accept', params: {} },
      { type: 'canton.prepare', ...F('cp-3', 1790000026000), op: 'delivery.fill', params: { ...t, attempt: 2 } },
      { type: 'canton.prepare', ...F('cp-4', 1790000700000), op: 'intent.settle', params: { orderHash } },
      { type: 'canton.prepare', ...F('cp-5', 1790001000000), op: 'holdings.transfer', params: { asset: CNRX, amount: '250.5', toParty: RECIPIENT_PARTY } },
    ],
    'canton.prepared': [
      {
        type: 'canton.prepared', id: 'g-19', ...S, sentAt: 1789990000200, re: 'cp-1', operationId: 'op-1', op: 'party.allocate',
        legs: [{ legId: 'topology-0', kind: 'topology', hash: `0x1220${tx('cancore:test:topology').slice(2)}`, topologyTransactions: ['CgMyLjESBTAuMC4x', 'CgMyLjESBTAuMC4y'] }],
        summary: { partyId: FILLER_PARTY, publicKey: PARTY_KEY, hosting: { participantUid: 'PAR::cancore::1220c0ffee', permission: 'CONFIRMATION', threshold: 1 } }, expiresAt: 1789990300200,
      },
      {
        type: 'canton.prepared', id: 'g-20', ...S, sentAt: 1790000026300, re: 'cp-3', operationId: 'op-3', op: 'delivery.fill',
        legs: [{ legId: 'delivery-fill-0', kind: 'transaction', hash: tx('cancore:test:prepared-delivery-fill'), preparedTransaction: 'CgMyLjESBTAuMC4x', hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V2' }],
        summary: {
          ...t, attempt: 2, deliveryOrderCid: CANTON_DELIVERY_ORDER_CID, recipient: RECIPIENT_PARTY, asset: CNRX, amount: '999.0',
          repayTo: ticket.repayTo, validUntil: ticket.validUntil, inputHoldingCids: ['00h1', '00h2'], executeBefore: ticket.validUntil,
          transferFactoryCid: '00tf',
        },
        expiresAt: 1790000326300,
      },
    ],
    'canton.submit': [{ type: 'canton.submit', ...F('cs-3', 1790000027000), operationId: 'op-3', signatures: [{ legId: 'delivery-fill-0', signature: PARTY_SIG }] }],
    'canton.submitted': [
      { type: 'canton.submitted', id: 'g-21', ...S, sentAt: 1790000029000, re: 'cs-3', operationId: 'op-3', op: 'delivery.fill', updateId: '1220ab0c', result: { receiptCid: '00c1d2' } },
      { type: 'canton.submitted', id: 'g-22', ...S, sentAt: 1789990002000, re: 'cs-1', operationId: 'op-1', op: 'party.allocate', result: { partyId: FILLER_PARTY } },
      { type: 'canton.submitted', id: 'g-23', ...S, sentAt: 1790001002000, re: 'cs-5', operationId: 'op-5', op: 'holdings.transfer', updateId: '1220ab0d', result: { outcome: 'PENDING', transferInstructionCid: '00ti' } },
    ],
    'routes.set': [{ type: 'routes.set', ...F('rs-1', 1789995000000), routes: [{ src: 'eip155:56', dst: 'eip155:1' }, { src: 'eip155:1', dst: 'canton:devnet' }] }],
    'routes.state': [
      {
        type: 'routes.state', id: 'g-24', ...S, sentAt: 1789995000200, re: 'rs-1',
        routes: [{ src: 'eip155:56', dst: 'eip155:1', active: true }, { src: 'eip155:1', dst: 'canton:devnet', active: true }, { src: 'canton:devnet', dst: 'eip155:1', active: false }],
      },
    ],
  };
}
