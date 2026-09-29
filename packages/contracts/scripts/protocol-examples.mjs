// Example frames and records of filler protocol v1, built on the golden
// vectors so every hash in them is the real one (gen-protocol-docs.mjs).
// Signatures are a zero placeholder: this package holds no keys, and
// @cancore/test-kit signs what it serves.
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { keccak256, toUtf8Bytes } from 'ethers';

// r = s = 0, v = 27: the shape of a signature, and no key signs it.
export const PLACEHOLDER_SIG = `0x${'00'.repeat(64)}1b`;
const S = { fillerId: 'acme-markets', sig: PLACEHOLDER_SIG };
const tx = (label) => keccak256(toUtf8Bytes(label));
const REQ = 'req-7f3a9c21-4d88-4e5b-9a1e-0c2f6b8d4e31';
const FILLER = '0x742d35cc6634c0532925a3b844bc454e4438f44e';
const QUOTE_KEY = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';

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
    'auth.challenge': [{ type: 'auth.challenge', sentAt: 1789999980000, nonce: tx('cancore:test:auth-nonce:1'), expiresAt: '1790000030', sig: PLACEHOLDER_SIG }],
    'auth.response': [{ type: 'auth.response', id: 'a-1', fillerId: 'acme-markets', keyAddress: QUOTE_KEY, protocolVersion: '1', sig: PLACEHOLDER_SIG }],
    'auth.ok': [{ type: 'auth.ok', ...S, sentAt: 1789999980200, re: 'a-1', heartbeatIntervalMs: 15000 }],
    ping: [{ type: 'ping', id: 'p-1' }, { type: 'ping', ...S, sentAt: 1789999995000, id: 'gp-1' }],
    pong: [{ type: 'pong', re: 'gp-1' }, { type: 'pong', ...S, sentAt: 1789999995100, re: 'p-1' }],
    error: [
      { type: 'error', ...S, sentAt: 1790000023500, re: 'i-2', code: 'TICKET_CLOSED', message: 'ticket.intent after acceptBy' },
      { type: 'error', sentAt: 1789999980100, sig: PLACEHOLDER_SIG, re: 'q-0', code: 'UNAUTHENTICATED', message: 'quote before auth.ok' },
    ],
    'epoch.weights': [{ type: 'epoch.weights', ...S, sentAt: 1789999980300, epochId: epoch.epochId, startsAt: epoch.startsAt, endsAt: epoch.endsAt, weightsRoot: epoch.weightsRoot }],
    'quote.request': [
      {
        type: 'quote.request', ...S, sentAt: 1789999990000, requestId: REQ, route: { src: 'eip155:11155111', dst: 'eip155:421614' },
        inputToken: order.inputToken, inputAmount: order.inputAmount, outputAsset: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', feeBps: 30,
        fillDeadlineHint: order.fillDeadline, windowCloseAt: 1789999992000, quoteTtlMs: 60000,
        imbalanceHint: { dstAsset: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', netFlow24hUsd: '-12500.50' },
      },
    ],
    quote: [{ type: 'quote', id: 'q-1', requestId: REQ, filler: FILLER, amountOut: '999000000', validUntil: '1790000060', nonce: '1', sig: PLACEHOLDER_SIG }],
    'quote.ack': [{ type: 'quote.ack', ...S, sentAt: 1789999991001, re: 'q-1', requestId: REQ, quoteHash, receivedAt: 1789999991000, status: 'COUNTED' }],
    'quote.reconfirm': [{ type: 'quote.reconfirm', ...S, sentAt: 1790000013000, orderHash, requestId: REQ, order, amountOut: order.minReceived, ticketTtl: 360, replyBy: 1790000016000 }],
    'quote.reconfirm.reply': [
      { type: 'quote.reconfirm.reply', id: 'r-1', orderHash, accept: true, validUntil: '1790000400', nonce: '2', sig: PLACEHOLDER_SIG },
      { type: 'quote.reconfirm.reply', id: 'r-2', orderHash, accept: false },
    ],
    'ticket.offer': [offerBody],
    'ticket.intent': [{ type: 'ticket.intent', id: 'i-1', ...t, validFrom: ticket.validFrom, validUntil: ticket.validUntil, sig: PLACEHOLDER_SIG }],
    'ticket.decline': [{ type: 'ticket.decline', id: 'd-1', ...t, reason: 'TICKET_ISSUED_LATE', detail: 'ticket.issued 3001 ms after acceptBy' }],
    'ticket.intent.ack': [{ type: 'ticket.intent.ack', ...S, sentAt: 1790000021001, re: 'i-1', ...t, intentHash, receivedAt: 1790000021000 }],
    'ticket.issued': [
      { type: 'ticket.issued', ...S, sentAt: 1790000024000, form: 'evm', ...t, ticket, ticketSig: PLACEHOLDER_SIG },
      { type: 'ticket.issued', ...S, sentAt: 1790000024000, form: 'canton', ...t, deliveryOrderCid: '00a1b2c3d4e5f6#fixture-delivery-order', validUntil: ticket.validUntil },
    ],
    'ticket.receipt': [{ type: 'ticket.receipt', id: 'rc-1', ...t, ticketHash, ticketSigHash: receiptSigHash, sig: PLACEHOLDER_SIG }],
    'fill.reported': [{ type: 'fill.reported', id: 'f-1', ...t, txRef: tx('cancore:test-kit:fixture-fill-tx') }],
    'ticket.expired': [
      { type: 'ticket.expired', ...S, sentAt: 1790000460000, ...t, result: 'FILLED' },
      { type: 'ticket.expired', ...S, sentAt: 1790000460000, ...t, result: 'EXEMPT', exemptReason: 'DESTINATION_HALTED' },
    ],
    'order.settled': [{ type: 'order.settled', ...S, sentAt: 1790000900000, orderHash, payout: '1000000000', fee: '3000000', penaltyWithheld: '0', txRef: tx('cancore:test-kit:fixture-settle-tx') }],
    'penalty.applied': [{ type: 'penalty.applied', ...S, sentAt: 1790001000000, violationId: 'v-1', code: 'NO_SHOW', step: 'L1', details: { orderHash, attempt: 0 } }],
  };
}
