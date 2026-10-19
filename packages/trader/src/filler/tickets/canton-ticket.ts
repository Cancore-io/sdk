/**
 * The checks before `ticket.receipt` for a Canton-form ticket: an EVM source,
 * a Canton destination (fillers.md §4.5 «Canton destination — the ticket»,
 * T-22, T-48; CAN-1867). A Canton-form `ticket.issued` has no `ticketSig`: the
 * ticket is the `DeliveryOrder` `deliveryOrderCid` the party observes, read
 * through filler-gateway (`GET /v1/filler/canton/delivery-orders`; operator
 * decision T-1: the node has no Ledger API of its own). What that read cannot
 * prove, the decoded `DeliveryOrder_Fill` transaction proves before the party
 * key signs (`canton/delivery-check.ts`).
 *
 * | Check | What | Refusal |
 * |---|---|---|
 * | form | an EVM source with a router, a Canton destination | `OTHER` |
 * | V-T4 | `ticket.issued` arrived by `acceptBy + δ_issue` | `TICKET_ISSUED_LATE` |
 * | V-T2 | the frame repeats the offer and the signed `ticket.intent` (window, `repayTo`, zero `deliveryKey`); the party's live `DeliveryOrder` `deliveryOrderCid` has this order, attempt, `validUntil` and `repayTo`, the order's `recipient` and `outputAsset`, an amount in `[minReceived, amountOut]` | `TICKET_MISMATCH` |
 * | V-T3 | `validUntil < fillDeadline`; `validUntil − validFrom ≥ MIN_TICKET_TTL[canton]`; `sendGuard` left | `TICKET_BEYOND_DEADLINE`, `TICKET_TTL_TOO_SHORT` |
 * | V-E1 | `orderHash` = the order's digest in the source router's domain | `ESCROW_MISMATCH` |
 * | V-E2 | `intents(orderHash).status == Opened` at `openConfirmations` depth: N confirmations, or the `safe` / `finalized` block | `ESCROW_NOT_OPEN` |
 * | V-E3 | `refundAfter − fillDeadline ≥` the filler's proof window for Canton | `PROOF_WINDOW_TOO_SHORT` |
 * | V-E4 | the source input token does not blocklist `repayTo` | `OTHER` (`repayTo-blocklisted`) |
 * | V-E5 | the party's unlocked holdings of the instrument cover the amount | `NO_INVENTORY` |
 *
 * The `fillerId` of the `DeliveryOrder` is not on the wire read: the decoded
 * fill holds it to the node's own before anything is signed.
 */
import {
  encodeCantonAmount,
  encodeCantonOutputAsset,
  encodeCantonRecipient,
  type CantonDeliveryOrder,
  type CantonHolding,
  type DeclineReason,
  type Hex,
  type TicketIssuedCanton,
} from '@cancore/contracts';
import { describeDepth, readAtDepth, type FillerChains } from '../chain';
import { erc20Blocklisted } from '../chain/erc20';
import { hashOrder } from '../chain/hashes';
import { INTENT_STATUS } from '../chain/router';
import type { EvmChainId } from '../chains';
import type { CantonDestinationPolicy } from '../filler';
import type { Clock } from '../runtime';
import type { FillSigner } from '../signer';
import type { TicketCheckId, TicketCheckInput, TicketCheckStatus } from './checks';
import { readFor, TicketRefusal } from './refusal';
import { chainsOf, identityFor, orderOf } from './terms';

export interface CantonTicketOptions {
  /** The filler's own Canton party: the `DeliveryOrder` must name it. */
  party: string;
  policy: CantonDestinationPolicy;
  /** The party's live `DeliveryOrder`s (filler-gateway). */
  deliveryOrders(): Promise<readonly CantonDeliveryOrder[]>;
  /** The party's holdings (filler-gateway). */
  holdings(): Promise<readonly CantonHolding[]>;
}

type Pass = (check: TicketCheckId, detail?: string, status?: TicketCheckStatus) => void;

interface Context {
  chains: FillerChains;
  fillSigners: { readonly [chain: EvmChainId]: FillSigner };
  fillerId: string;
  cantonParty?: string;
  deltaIssueMs: number;
  clock: Clock;
  canton: CantonTicketOptions;
}

const UINT = /^(0|[1-9][0-9]*)$/;
const uint = (value: unknown): bigint | undefined => (typeof value === 'string' && UINT.test(value) ? BigInt(value) : undefined);
const same = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;

/** Units of a Canton amount in its EVM form (× 10¹⁰), or undefined when it is not one. */
function cantonUnits(amount: unknown): bigint | undefined {
  try {
    return typeof amount === 'string' ? encodeCantonAmount(amount) : undefined;
  } catch {
    return undefined;
  }
}

/** Runs every check of a Canton-form ticket in order; throws `TicketRefusal` at the first failure. */
export async function verifyCantonTicket(ctx: Context, input: TicketCheckInput, pass: Pass): Promise<void> {
  const { offer, issuedAtMs } = input;
  const issued = input.issued as TicketIssuedCanton;
  const now = ctx.clock.now();
  const read = <T>(check: TicketCheckId, reason: DeclineReason, r: () => Promise<T>) => readFor(check, reason, r);

  // -- The form and the chains ---------------------------------------------
  const chains = chainsOf(offer.order);
  if (!chains) throw new TicketRefusal('form', 'OTHER', 'the offered order does not parse');
  if (!chains.source) throw new TicketRefusal('form', 'OTHER', 'a Canton-form ticket for a non-EVM source');
  if (!chains.canton) throw new TicketRefusal('form', 'OTHER', 'a Canton-form ticket for a non-Canton destination');
  const source = ctx.chains.get(chains.source);
  if (!source) throw new TicketRefusal('form', 'OTHER', `no router configured for the source ${chains.source}`);
  if (ctx.cantonParty !== ctx.canton.party) throw new TicketRefusal('form', 'OTHER', 'the Canton party of the identity is not the configured one');
  const policy = ctx.canton.policy;
  pass('form');

  // -- V-T4: issued in time ---------------------------------------------------
  if (!(issuedAtMs <= offer.acceptBy + ctx.deltaIssueMs)) {
    throw new TicketRefusal('V-T4', 'TICKET_ISSUED_LATE', `arrived ${issuedAtMs - offer.acceptBy} ms after acceptBy (δ_issue ${ctx.deltaIssueMs} ms)`);
  }
  pass('V-T4');

  // -- V-T2: this offer, this filler, this DeliveryOrder -------------------------
  const identity = identityFor(offer.order, ctx);
  if (!identity) throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', 'no fill key or payee of this filler for the order');
  if (identity.deliveryKey !== ZERO_ADDRESS) throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', 'a Canton destination is delivered by the party, not a delivery key');
  if (!same(issued.orderHash, offer.orderHash) || issued.attempt !== offer.attempt) throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', 'the frame names another order or attempt than the offer');
  if (issued.validUntil !== offer.validUntil) throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', 'ticket.validUntil differs from the offer');
  if (!same(issued.repayTo, identity.repayTo)) throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', 'ticket.repayTo is not this filler’s payee');
  if (typeof issued.deliveryOrderCid !== 'string' || issued.deliveryOrderCid.length === 0) throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', 'no deliveryOrderCid');
  const amountOut = uint(offer.amountOut);
  const minReceived = uint(offer.order.minReceived);
  if (amountOut === undefined || minReceived === undefined || amountOut < minReceived) {
    throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', `offer.amountOut ${String(offer.amountOut)} is below order.minReceived ${String(offer.order.minReceived)}`);
  }
  if (input.intent) {
    if (input.intent.validFrom !== offer.validFrom || input.intent.validUntil !== issued.validUntil) throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', 'the ticket window differs from the signed ticket.intent');
    // T-15, T-48: the payee the filler named in its signed consent, and no delivery key.
    if (!same(input.intent.repayTo, issued.repayTo) || !same(input.intent.deliveryKey, ZERO_ADDRESS)) {
      throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', 'deliveryKey or repayTo differs from the signed ticket.intent');
    }
  }
  const orders = await read('V-T2', 'TICKET_MISMATCH', () => ctx.canton.deliveryOrders());
  const order = orders.find((o) => o.deliveryOrderCid === issued.deliveryOrderCid);
  if (!order) throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', 'no live DeliveryOrder deliveryOrderCid for this party');
  const mismatch = deliveryOrderMismatch(order, issued, offer.order, { amountOut, minReceived });
  if (mismatch) throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', `DeliveryOrder.${mismatch} differs from the ticket and the order`);
  pass('V-T2');

  // -- V-T3: a window the filler can meet -----------------------------------------
  const validFrom = uint(offer.validFrom);
  const validUntil = uint(issued.validUntil);
  const fillDeadline = uint(offer.order.fillDeadline);
  if (validFrom === undefined || validUntil === undefined || fillDeadline === undefined) throw new TicketRefusal('V-T3', 'TICKET_MISMATCH', 'ticket or order times do not parse');
  if (!(validUntil < fillDeadline)) throw new TicketRefusal('V-T3', 'TICKET_BEYOND_DEADLINE', `validUntil ${validUntil} ≥ fillDeadline ${fillDeadline}`);
  if (validUntil - validFrom < BigInt(policy.minTicketTtlSec)) throw new TicketRefusal('V-T3', 'TICKET_TTL_TOO_SHORT', `validUntil − validFrom = ${validUntil - validFrom} s < MIN_TICKET_TTL ${policy.minTicketTtlSec} s`);
  const leftMs = validUntil * 1000n - BigInt(now);
  if (leftMs < BigInt(policy.sendGuardSec) * 1000n) throw new TicketRefusal('V-T3', 'TICKET_TTL_TOO_SHORT', `send-guard: ${leftMs} ms left < sendGuard ${policy.sendGuardSec} s`);
  pass('V-T3');

  // -- V-E1: the ticket is for this order ---------------------------------------------
  let digest: Hex;
  try {
    digest = hashOrder(orderOf(offer.order), { chainId: chains.origin, router: source.router.address });
  } catch (error) {
    throw new TicketRefusal('V-E1', 'ESCROW_MISMATCH', `the offered order does not hash: ${String(error)}`);
  }
  if (digest !== issued.orderHash.toLowerCase()) throw new TicketRefusal('V-E1', 'ESCROW_MISMATCH', 'orderHash is not the order digest in the source router domain');
  pass('V-E1');

  // -- V-E2, V-E3: the escrow, at depth --------------------------------------------------
  const intent = await read('V-E2', 'ESCROW_NOT_OPEN', () => source.router.intents(digest, readAtDepth(source.config.openConfirmations)));
  if (intent.status !== INTENT_STATUS.Opened) throw new TicketRefusal('V-E2', 'ESCROW_NOT_OPEN', `status ${intent.status} at ${describeDepth(source.config.openConfirmations)}`);
  pass('V-E2');
  const window = intent.refundAfter - fillDeadline;
  if (window < BigInt(policy.requiredProofWindowSec)) throw new TicketRefusal('V-E3', 'PROOF_WINDOW_TOO_SHORT', `refundAfter − fillDeadline = ${window} s < ${policy.requiredProofWindowSec} s`);
  pass('V-E3');

  // -- V-E4: repayTo will be paid ----------------------------------------------------------------
  const repayTo = String(issued.repayTo);
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(repayTo)) throw new TicketRefusal('V-E4', 'TICKET_MISMATCH', 'repayTo of an EVM source is not a padded address');
  const inputToken = String(offer.order.inputToken);
  if (!/^0x[0-9a-fA-F]{40}$/.test(inputToken)) throw new TicketRefusal('V-E4', 'OTHER', 'the input token is not an EVM address');
  const payee = `0x${repayTo.slice(26)}`.toLowerCase() as Hex;
  const blocklisted = await read('V-E4', 'OTHER', () => erc20Blocklisted(source.client, inputToken.toLowerCase() as Hex, payee));
  if (blocklisted) throw new TicketRefusal('V-E4', 'OTHER', `repayTo-blocklisted: the input token ${inputToken} blocklists ${payee}`);
  pass('V-E4');

  // -- V-E5: the party holds what it delivers ------------------------------------------------------
  const needed = cantonUnits(order.amount) as bigint;
  const holdings = await read('V-E5', 'OTHER', () => ctx.canton.holdings());
  const free = holdings
    .filter((h) => !h.locked && h.asset?.admin === order.asset.admin && h.asset?.id === order.asset.id)
    .reduce((sum, h) => sum + (cantonUnits(h.amount) ?? 0n), 0n);
  if (free < needed) throw new TicketRefusal('V-E5', 'NO_INVENTORY', `holdings: ${free} < ${needed} (${order.asset.id}, units of 10⁻¹⁰)`);
  pass('V-E5');
}

/** The first field of the `DeliveryOrder` that is not the ticket's and the order's; undefined when every one is. */
export function deliveryOrderMismatch(
  order: CantonDeliveryOrder,
  issued: Pick<TicketIssuedCanton, 'orderHash' | 'attempt' | 'validUntil' | 'repayTo'>,
  offered: { recipient: string; outputAsset: string },
  bounds: { amountOut: bigint; minReceived: bigint },
): string | undefined {
  if (!same(order.orderHash, issued.orderHash)) return 'orderHash';
  if (order.attempt !== issued.attempt) return 'attempt';
  if (order.validUntil !== issued.validUntil) return 'validUntil';
  if (!same(order.repayTo, issued.repayTo)) return 'repayTo';
  let recipient: string;
  let asset: string;
  try {
    recipient = encodeCantonRecipient(order.recipient);
    asset = encodeCantonOutputAsset(order.asset);
  } catch {
    return 'recipient';
  }
  if (!same(offered.recipient, recipient)) return 'recipient';
  if (!same(offered.outputAsset, asset)) return 'asset';
  const amount = cantonUnits(order.amount);
  if (amount === undefined || amount < bounds.minReceived || amount > bounds.amountOut) return 'amount';
  return undefined;
}
