/**
 * The checks before `ticket.receipt` for a Canton source and an EVM-form
 * ticket (fillers.md §4.5 V-C1…V-C6, INV-10). On a Canton source there is no
 * escrow on a router: the owner's give is a committed allocation that only
 * `SwapIntent_SettleWithProof` — this filler's submission — can pay out, and
 * only strictly before `refundAfter`. Before the node advances funds on the
 * EVM destination it makes sure that payout is possible for it.
 *
 * The node has no Ledger API (operator decision T-1): the intent and its
 * allocation come from `GET /v1/filler/canton/intents/{orderHash}` — the
 * intent as the filler's party sees it, the allocation as the operator reads
 * it. What they say is checked here, never taken on trust: the order hash is
 * recomputed from the intent's own fields, the allocation's legs are
 * recomputed from its amount and fee rate with the ledger's rounding.
 *
 * | Check | What | Refusal |
 * |---|---|---|
 * | V-C1 | a live `SwapIntent` with `ticket.orderHash` names this filler: `filler` is the node's party, `fillerId` its own | `ESCROW_NOT_OPEN` (none), `ESCROW_MISMATCH` |
 * | V-C2 | the intent's terms are the offered order: the EVM-form order built from them (protocol §3.7) equals `offer.order` field by field | `ESCROW_MISMATCH` |
 * | V-C3 | the label binds the terms: that order's hash in the Canton source domain is `ticket.orderHash` and the intent's `orderHash` | `ESCROW_MISMATCH` |
 * | V-C4 | the give is committed to this filler: the allocation `allocationCid` is live, of a pinned registry template, `committed`, authorized by the owner, executors exactly operator and owner, `settlementDeadline == refundAfter`, legs exactly `payout` to the node's party and `fee` to the operator | `ESCROW_NOT_OPEN` (not live), `ESCROW_MISMATCH` |
 * | V-C5 | the filler can be paid: its `FillerRegistryEntry` is ACTIVE and `ticket.repayTo == keccak256(utf8(party))` (T-45) | `OTHER` (detail `payout-not-ready`), `TICKET_MISMATCH` |
 * | V-C6 | `refundAfter − fillDeadline ≥` the filler's own proof window for the destination, as V-E3 | `PROOF_WINDOW_TOO_SHORT` |
 *
 * `PAYOUT_NOT_READY` is a `TICKET_REFUSED` reason of filler-gateway, not a
 * decline code: like V-E4, V-C5 declines `OTHER` and names it in the detail.
 * Not checked here: that the party can create a receipt allocation for the
 * instrument (T-9) — no read states it; `SwapIntent_SettleWithProof` refuses
 * then, and the intent stays live.
 */
import {
  buildCantonSourceOrder,
  cantonInclusiveFeeSplit,
  repayToFromParty,
  type CantonAllocation,
  type CantonIntent,
  type CantonParty,
  type Hex,
  type OrderJson,
  type TicketJson,
} from '@cancore/contracts';
import { CANTON_ALLOCATION_TEMPLATES } from '../canton/factories';
import { GatewayError } from '../errors';
import { Refusal, type TicketCheckId } from './refusal';

/** What the Canton-source checks read through Cancore: `CantonOperations` is one. */
export interface CantonSourceReader {
  /** `GET /v1/filler/canton/intents/{orderHash}`. */
  intent(orderHash: Hex): Promise<CantonIntent>;
  /** `GET /v1/filler/canton/party`. */
  party(): Promise<CantonParty>;
}

export interface CantonSourceCheckInput {
  order: OrderJson;
  ticket: TicketJson;
  /** The node's own Canton party: the payee. */
  party: string;
  fillerId: string;
  /** The filler's own proof window for the destination, seconds (V-C6, as V-E3). */
  requiredProofWindowSec: number;
  reader: CantonSourceReader;
  /** The pinned allocation templates by instrument admin; `CANTON_ALLOCATION_TEMPLATES` unless a test names others. */
  allocationTemplates?: Readonly<Record<string, readonly string[]>>;
}

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const SCALE = 10;

/** A Daml Decimal with its trailing fraction zeros dropped: `0.0030000000` → `0.003`. */
function trimmed(value: string, check: TicketCheckId, field: string): string {
  if (!DECIMAL.test(value)) throw new Refusal(check, 'ESCROW_MISMATCH', `${field} ${value} is not a decimal`);
  const [whole, fraction = ''] = value.split('.') as [string, string?];
  const f = fraction.replace(/0+$/, '');
  return f ? `${whole}.${f}` : whole;
}

/** A Daml Decimal (Numeric 10) as an integer count of 10⁻¹⁰. */
function units(value: string, check: TicketCheckId, field: string): bigint {
  const [whole, fraction = ''] = trimmed(value, check, field).split('.') as [string, string?];
  if (fraction.length > SCALE) throw new Refusal(check, 'ESCROW_MISMATCH', `${field} ${value} has more than ${SCALE} decimals`);
  return BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(fraction.padEnd(SCALE, '0'));
}

/** `<module>:<entity>` of a `<package id>:<module>:<entity>` id. */
const qualified = (templateId: string): string => templateId.split(':').slice(1).join(':');
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
const lower = (v: unknown): string => String(v).toLowerCase();

/** The fields of the 12-field `Order` V-C2 compares, in their order. */
const ORDER_FIELDS = ['user', 'originChainId', 'inputToken', 'inputAmount', 'destination', 'outputAsset', 'minReceived', 'recipient', 'createdAt', 'fillDeadline', 'feeBps', 'fillerId'] as const;

/**
 * Runs V-C1…V-C6 in order; throws `Refusal` at the first failure, calls
 * `pass` for each that holds. A read that fails is a failure of the check
 * that needed it (N-12).
 */
export async function checkCantonSource(input: CantonSourceCheckInput, pass: (check: TicketCheckId, detail?: string) => void): Promise<void> {
  const { order, ticket, party, fillerId } = input;
  const orderHash = lower(ticket.orderHash) as Hex;

  // -- V-C1: a live intent names this filler ---------------------------------------------------
  let intent: CantonIntent;
  try {
    intent = await input.reader.intent(orderHash);
  } catch (error) {
    if (error instanceof GatewayError && error.code === 'UNKNOWN_TICKET') throw new Refusal('V-C1', 'ESCROW_NOT_OPEN', 'no live SwapIntent with this orderHash names this filler');
    throw new Refusal('V-C1', 'ESCROW_NOT_OPEN', `unverifiable: ${String(error)}`);
  }
  if (qualified(String(intent?.templateId)) !== 'Intent.SwapIntent:SwapIntent') throw new Refusal('V-C1', 'ESCROW_MISMATCH', `the contract is a ${String(intent?.templateId)}, not a SwapIntent`);
  if (lower(intent.orderHash) !== orderHash) throw new Refusal('V-C1', 'ESCROW_MISMATCH', 'the intent read is for another orderHash');
  if (intent.filler !== party) throw new Refusal('V-C1', 'ESCROW_MISMATCH', `the intent's filler is ${intent.filler}, not this node's party`);
  if (intent.fillerId !== fillerId) throw new Refusal('V-C1', 'ESCROW_MISMATCH', `the intent's fillerId is ${intent.fillerId}, not ${fillerId}`);
  pass('V-C1');

  // -- V-C2: its terms are the offered order -----------------------------------------------------
  let built: ReturnType<typeof buildCantonSourceOrder>;
  try {
    built = buildCantonSourceOrder({
      ownerPartyId: intent.owner,
      requestId: intent.requestId,
      instrumentAdmin: intent.asset.admin,
      instrumentId: intent.asset.id,
      amount: trimmed(intent.amount, 'V-C2', 'amount'),
      destinationChainId: intent.destination.chainId,
      wantToken: intent.destination.token,
      // minReceived is in base units already: built at 0 decimals it stays the same integer.
      wantDecimals: 0,
      minReceived: intent.minReceived.units,
      recipient: intent.destination.recipient,
      createdAt: intent.orderCreatedAt,
      fillDeadline: intent.fillDeadline,
      feeRate: trimmed(intent.feeRate, 'V-C2', 'feeRate'),
      cantonOriginId: order.originChainId,
      fillerId: intent.fillerId,
    });
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal('V-C2', 'ESCROW_MISMATCH', `the intent's terms do not encode as an order: ${String(error)}`);
  }
  const offered = order as unknown as Record<string, unknown>;
  const derived = built.order as unknown as Record<string, unknown>;
  const differs = ORDER_FIELDS.find((f) => lower(derived[f]) !== lower(offered[f]));
  if (differs) throw new Refusal('V-C2', 'ESCROW_MISMATCH', `order.${differs} differs from the intent's terms`);
  pass('V-C2');

  // -- V-C3: the label binds these terms ------------------------------------------------------------
  if (lower(built.orderHash) !== orderHash) throw new Refusal('V-C3', 'ESCROW_MISMATCH', 'the order hash of the intent’s terms is not ticket.orderHash');
  pass('V-C3');

  // -- V-C4: the give is committed to this filler ------------------------------------------------------
  checkAllocation(intent, intent.allocation, party, BigInt(built.order.feeBps as string), input.allocationTemplates ?? CANTON_ALLOCATION_TEMPLATES);
  pass('V-C4');

  // -- V-C5: the filler can be paid -------------------------------------------------------------------
  if (lower(ticket.repayTo) !== repayToFromParty(party)) throw new Refusal('V-C5', 'TICKET_MISMATCH', 'ticket.repayTo is not keccak256(utf8(party)) of this node');
  let registered: CantonParty;
  try {
    registered = await input.reader.party();
  } catch (error) {
    throw new Refusal('V-C5', 'OTHER', `payout-not-ready: unverifiable: ${String(error)}`);
  }
  if (registered?.party !== party) throw new Refusal('V-C5', 'OTHER', `payout-not-ready: the party registered for ${fillerId} is ${String(registered?.party)}`);
  if (registered.registry?.state !== 'ACTIVE' || !registered.registry.entryCid) {
    throw new Refusal('V-C5', 'OTHER', `payout-not-ready: the FillerRegistryEntry is ${String(registered.registry?.state)}`);
  }
  pass('V-C5');

  // -- V-C6: the settlement window ----------------------------------------------------------------------
  const window = BigInt(intent.refundAfter) - BigInt(intent.fillDeadline);
  if (window < BigInt(input.requiredProofWindowSec)) {
    throw new Refusal('V-C6', 'PROOF_WINDOW_TOO_SHORT', `refundAfter − fillDeadline = ${window} s < ${input.requiredProofWindowSec} s`);
  }
  pass('V-C6');
}

/** V-C4: the allocation is exactly the commitment `IntentFactory_Open` makes (`SwapIntent.daml` legsOf, allocationSpec). */
function checkAllocation(intent: CantonIntent, a: CantonAllocation | null, party: string, feeBps: bigint, templates: Readonly<Record<string, readonly string[]>>): void {
  const mismatch = (detail: string): never => {
    throw new Refusal('V-C4', 'ESCROW_MISMATCH', detail);
  };
  if (!a) throw new Refusal('V-C4', 'ESCROW_NOT_OPEN', 'the committed allocation is not live');
  if (a.contractId !== intent.allocationCid) mismatch('the allocation read is not the intent’s allocationCid');
  if (!(templates[intent.asset.admin] ?? []).includes(a.templateId)) mismatch(`the allocation ${a.templateId} is not a pinned allocation of the admin ${intent.asset.admin}`);
  if (a.admin !== intent.asset.admin) mismatch('the allocation is of another instrument admin');
  if (a.committed !== true) mismatch('the allocation is not committed: the owner could withdraw it before refundAfter');
  if (a.authorizer !== intent.owner) mismatch('the allocation is not the owner’s');
  if (a.executors.length !== 2 || !sameSet(a.executors, [intent.operator, intent.owner])) mismatch('the executors are not exactly the operator and the owner');
  if (a.settlementId !== `cancore-intent/${lower(intent.orderHash).slice(2)}`) mismatch('the allocation belongs to another settlement');
  if (a.settlementDeadline !== intent.refundAfter) mismatch(`settlementDeadline ${String(a.settlementDeadline)} is not refundAfter ${intent.refundAfter}`);
  const split = cantonInclusiveFeeSplit(units(intent.amount, 'V-C4', 'amount'), feeBps);
  const want = [{ legId: 'payout', otherside: party, amount: split.payout }, ...(split.fee > 0n ? [{ legId: 'fee', otherside: intent.operator, amount: split.fee }] : [])];
  if (a.legs.length !== want.length) mismatch(`the allocation has ${a.legs.length} legs, not ${want.length}`);
  for (const w of want) {
    const leg = a.legs.find((l) => l.legId === w.legId);
    if (!leg) return mismatch(`no ${w.legId} leg`);
    if (leg.side !== 'SENDER') mismatch(`the ${w.legId} leg is not on the owner's sending side`);
    if (leg.otherside !== w.otherside) mismatch(`the ${w.legId} leg pays ${String(leg.otherside)}, not ${w.otherside}`);
    if (leg.instrumentId !== intent.asset.id) mismatch(`the ${w.legId} leg moves another instrument`);
    if (units(leg.amount, 'V-C4', `${w.legId}.amount`) !== w.amount) mismatch(`the ${w.legId} leg moves ${leg.amount}, not the ledger's split of ${intent.amount} at ${feeBps} bps`);
  }
}
