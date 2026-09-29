/**
 * The ticket of one attempt (protocol §3.5 Tickets, §4 S-1…S-11): the draw
 * and the offer, the signed intent ack, `ticket.issued`, `ticket.expired`
 * and `order.settled` — and, per scenario, the one rule the mock breaks.
 */
import type { Order, OrderJson } from '@cancore/contracts';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { drawAttempt, weightOf } from './draws';
import type { Candidate } from './draws';
import { orderAt, SOURCE, STAKE_STEPS } from './fixtures';
import type { Body, DrawRecordBody, MockGateway, Signed } from './gateway';
import { sign, TEST_KEYS } from './keys';
import type { Hex } from './keys';
import { fillTicketDigest, orderHash, sigHash, ticketIntentDigest, ticketReceiptDigest } from './protocol';
import { fail } from './quotes';
import type { Failure } from './quotes';
import { signer } from './session';
import { payout } from './tickets';
import type { OfferTerms, TicketRecord, TicketRef } from './tickets';

export type Outcome = { ok: true; reply?: Body } | Failure;

export interface OrderDraft {
  order: OrderJson;
  /** Open time of the order (s): tBase of attempt 0. */
  t0: number;
  candidates: Candidate[];
  /** Offer to this taker; default the winner of the draw. */
  target?: string;
}

const keccakHex = (s: string): Hex => `0x${bytesToHex(keccak_256(utf8ToBytes(s)))}`;
const ticketKey = (orderHash: string, attempt: number) => `${orderHash}/${attempt}`;
const issuing = new WeakSet<TicketRecord>();

/** A taker's draw weight from the session's epoch (A-11). */
export function candidateOf(gw: MockGateway, fillerId: string): Candidate {
  const leaf = gw.epoch.leaves.find((l) => l.fillerId === fillerId);
  if (!leaf) throw new Error(`${fillerId} has no leaf in epoch ${gw.epoch.epochId}`);
  return { fillerId, weight: weightOf(leaf, STAKE_STEPS).toString() };
}

/**
 * The published draw names the offered taker (S-11) — except in WRONG_DRAW,
 * where the record is drawn among everybody else. When the requested target
 * does not win the honest draw, the record is drawn among the target alone,
 * so it still verifies.
 */
function drawFor(gw: MockGateway, hash: Hex, attempt: number, tBase: number, draft: OrderDraft) {
  const draw = (candidates: Candidate[]) => drawAttempt({ orderHash: hash, attempt, tBase, deltaDrand: gw.cfg.deltaDrand, candidates });
  const honest = draw(draft.candidates);
  const target = draft.target ?? honest.winnerFillerId;
  if (gw.mode === 'WRONG_DRAW') return { target, attempt: draw(gw.epoch.leaves.filter((l) => l.fillerId !== target).map((l) => candidateOf(gw, l.fillerId))) };
  return { target, attempt: honest.winnerFillerId === target ? honest : draw([candidateOf(gw, target)]) };
}

function termsOf(gw: MockGateway, order: OrderJson): Pick<OfferTerms, 'validFrom' | 'validUntil' | 'acceptBy'> {
  const validFrom = gw.nowS();
  const deadline = Number(order.fillDeadline);
  const byMode: Partial<Record<string, number>> = { SHORT_TTL: validFrom + gw.cfg.minTicketTtlS - 1, BEYOND_DEADLINE: deadline };
  const validUntil = byMode[gw.mode] ?? Math.min(validFrom + gw.cfg.ticketTtlS, deadline - 1);
  return { validFrom: String(validFrom), validUntil: String(validUntil), acceptBy: gw.now() + gw.cfg.acceptByMs };
}

/** Draw the next attempt of an order and offer it. */
export function offerOrder(gw: MockGateway, draft: OrderDraft): Signed {
  const hash = orderHash(draft.order as Order, SOURCE.chainId, SOURCE.router);
  const attempt = gw.tickets.nextAttempt(hash);
  const { target, attempt: drawn } = drawFor(gw, hash, attempt, attempt === 0 ? draft.t0 : gw.nowS(), draft);
  const record: DrawRecordBody = gw.draws.get(hash) ?? {
    orderHash: hash,
    source: SOURCE.caip2,
    openRef: keccakHex(`cancore:test-kit:open:${hash}`),
    t0: String(draft.t0),
    epochId: gw.epoch.epochId,
    deltaDrand: gw.cfg.deltaDrand,
    attempts: [],
  };
  record.attempts.push(drawn);
  gw.draws.set(hash, record);
  const terms: OfferTerms = { orderHash: hash, attempt, order: { ...draft.order }, amountOut: draft.order.minReceived, ...termsOf(gw, draft.order) };
  gw.tickets.offer(target, terms);
  const unknown = gw.mode === 'UNKNOWN_S2F_TYPE';
  if (unknown) gw.emit({ fillerId: target }, { type: 'future.info', note: 'an informational frame of a later v1.x; a v1 taker ignores it (V-2)' });
  const body: Body = { type: 'ticket.offer', ...terms, ...(unknown ? { x: 'an unknown field (V-2)' } : {}) };
  const signed = gw.emit({ fillerId: target }, body, { badSig: gw.mode === 'BAD_GATEWAY_SIG' });
  gw.offers.set(ticketKey(hash, attempt), signed);
  if (gw.mode === 'DROP_CONNECTION') gw.live.get(target)?.close(1001, 'mock: DROP_CONNECTION');
  return signed;
}

/** `POST /__mock/offer`: the session's fixture order, next attempt, to `fillerId`. */
export function offerFixture(gw: MockGateway, fillerId: string): Signed {
  if (!gw.fillers.has(fillerId)) throw new Error(`unknown filler ${fillerId}; registered: ${[...gw.fillers.keys()].join(', ')}`);
  const t0 = Math.floor(gw.baseMs / 1000);
  const candidates = gw.epoch.leaves.map((l) => candidateOf(gw, l.fillerId));
  return offerOrder(gw, { order: orderAt(t0, { canton: gw.mode === 'CANTON_DESTINATION' }), t0, candidates, target: fillerId });
}

function closeAttempt(gw: MockGateway, ref: TicketRef, by: string): void {
  const a = gw.draws.get(ref.orderHash)?.attempts.find((x) => x.attempt === ref.attempt);
  if (a && a.closedBy === null) a.closedBy = by;
}

export function onIntent(gw: MockGateway, fillerId: string, msg: Record<string, unknown>): Outcome {
  const intent = { orderHash: msg.orderHash as Hex, attempt: msg.attempt as number, validFrom: String(msg.validFrom), validUntil: String(msg.validUntil) };
  const intentHash = ticketIntentDigest(intent);
  if (signer(intentHash, msg.sig) !== gw.fillers.get(fillerId)?.fillerAddress) return fail('BAD_SIGNATURE', 'TicketIntent does not recover to the filler address');
  const res = gw.tickets.intent(fillerId, intent, gw.now(), intentHash);
  if (!res.ok) return res;
  const t = gw.tickets.find(fillerId, intent.orderHash, intent.attempt)!;
  if (!issuing.has(t)) scheduleIssue(gw, t);
  return { ok: true, reply: { type: 'ticket.intent.ack', ...res.value } };
}

function scheduleIssue(gw: MockGateway, t: TicketRecord): void {
  issuing.add(t);
  const late = t.offer.acceptBy + gw.cfg.issueDelayMs + 1;
  if (gw.mode === 'NO_ISSUED') return void gw.clock.schedule(late, () => reoffer(gw, t));
  gw.clock.schedule(gw.mode === 'LATE_ISSUED' ? late : gw.now(), () => issue(gw, t));
}

/** NO_ISSUED: nothing came by acceptBy + δ_issue; the order goes to its next attempt. */
function reoffer(gw: MockGateway, t: TicketRecord): void {
  gw.tickets.close(t, 'OFFER_TIMEOUT');
  closeAttempt(gw, t.offer, 'OFFER_TIMEOUT');
  const record = gw.draws.get(t.offer.orderHash)!;
  offerOrder(gw, { order: t.offer.order as unknown as OrderJson, t0: Number(record.t0), candidates: [candidateOf(gw, t.fillerId)], target: t.fillerId });
}

function issue(gw: MockGateway, t: TicketRecord): void {
  if (t.state !== 'ACKED') return;
  const { orderHash: hash, attempt, validFrom, validUntil } = t.offer;
  if (gw.mode === 'CANTON_DESTINATION') {
    const body: Body = { type: 'ticket.issued', form: 'canton', orderHash: hash, attempt, deliveryOrderCid: `00${keccakHex(`delivery:${hash}:${attempt}`).slice(2)}`, validUntil };
    gw.tickets.issue(t, gw.emit({ fillerId: t.fillerId }, body));
  } else {
    const ticket = { orderHash: hash as Hex, filler: gw.fillers.get(t.fillerId)!.fillerAddress, attempt, validFrom, validUntil: gw.mode === 'FIELD_MISMATCH' ? String(Number(validUntil) - 1) : validUntil };
    const ticketHash = fillTicketDigest(ticket);
    const ticketSig = sign(ticketHash, (gw.mode === 'FOREIGN_TICKET_SIG' ? TEST_KEYS.foreignSigner : TEST_KEYS.ticketSigner).privateKey);
    const signed = gw.emit({ fillerId: t.fillerId }, { type: 'ticket.issued', form: 'evm', orderHash: hash, attempt, ticket, ticketSig });
    gw.tickets.issue(t, signed, { ticketHash, ticketSigHash: sigHash(ticketSig) });
  }
  gw.clock.schedule((Number(validUntil) + 1) * 1000 + gw.cfg.finalityMs, () => expire(gw, t));
}

const CLOSED_BY: Record<string, string> = { FILLED: 'FILLED', EXEMPT: 'TICKET_DECLINE' };

function expire(gw: MockGateway, t: TicketRecord): void {
  const result = gw.tickets.expire(t);
  const ref = { orderHash: t.offer.orderHash, attempt: t.offer.attempt };
  gw.emit({ fillerId: t.fillerId }, { type: 'ticket.expired', ...ref, ...result });
  closeAttempt(gw, ref, CLOSED_BY[result.result] ?? 'TICKET_EXPIRED');
  if (result.result !== 'FILLED') return;
  const order = t.offer.order;
  const split = payout(String(order.inputAmount), Number(order.feeBps));
  gw.emit({ fillerId: t.fillerId }, { type: 'order.settled', orderHash: ref.orderHash, ...split, penaltyWithheld: '0', txRef: keccakHex(`cancore:test-kit:settle:${ref.orderHash}`) });
}

export function onReceipt(gw: MockGateway, fillerId: string, msg: Record<string, unknown>): Outcome {
  const hashes = { ticketHash: msg.ticketHash as Hex, ticketSigHash: msg.ticketSigHash as Hex };
  if (signer(ticketReceiptDigest(hashes), msg.sig) !== gw.fillers.get(fillerId)?.fillerAddress) return fail('BAD_SIGNATURE', 'TicketReceipt does not recover to the filler address');
  const res = gw.tickets.receipt(fillerId, { orderHash: String(msg.orderHash), attempt: msg.attempt as number, ...hashes }, gw.now());
  return res.ok ? { ok: true } : res;
}

export function onDecline(gw: MockGateway, fillerId: string, msg: Record<string, unknown>): Outcome {
  const ref = { orderHash: String(msg.orderHash), attempt: msg.attempt as number };
  const res = gw.tickets.decline(fillerId, { ...ref, reason: String(msg.reason), ...(typeof msg.detail === 'string' ? { detail: msg.detail } : {}) });
  if (!res.ok) return res;
  if (gw.tickets.find(fillerId, ref.orderHash, ref.attempt)?.decline?.stage === 'offer') closeAttempt(gw, ref, 'OFFER_DECLINE');
  return { ok: true };
}

export function onFill(gw: MockGateway, fillerId: string, msg: Record<string, unknown>): Outcome {
  const res = gw.tickets.fillReported(fillerId, { orderHash: String(msg.orderHash), attempt: msg.attempt as number, txRef: String(msg.txRef) }, gw.now());
  return res.ok ? { ok: true } : res;
}
