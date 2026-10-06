/**
 * The checks before `ticket.receipt` for an EVM source and an EVM-form ticket
 * (fillers.md §4.5, INV-10: advance funds only against escrow you verified
 * yourself). A ticket is Cancore's word, not a fact: every chain fact is read
 * with the node's own RPC from the pinned routers, and nothing filler-gateway
 * says is taken as true beyond what the checks below confirm.
 *
 * | Check | What | Refusal |
 * |---|---|---|
 * | V-T4 | `ticket.issued` arrived by `acceptBy + δ_issue` | `TICKET_ISSUED_LATE` |
 * | V-T2 | the ticket repeats the offer and names this filler: its `fillerId`, and the `deliveryKey` and `repayTo` of its signed `ticket.intent` (T-15) | `TICKET_MISMATCH` |
 * | V-T3 | `validUntil < fillDeadline`; `validUntil − validFrom ≥ MIN_TICKET_TTL[dst]`; `sendGuard` left | `TICKET_BEYOND_DEADLINE`, `TICKET_TTL_TOO_SHORT` |
 * | V-E1 | `orderHash` = the order's digest in the source router's domain | `ESCROW_MISMATCH` |
 * | V-E2 | `intents(orderHash).status == Opened` at `openConfirmations` depth | `ESCROW_NOT_OPEN` |
 * | V-E3 | `refundAfter − fillDeadline ≥` the filler's own proof window for the destination | `PROOF_WINDOW_TOO_SHORT` |
 * | V-T1 | the ticket signer is pinned and `ticketSigners(signer)` on the destination router | `TICKET_SIGNER_UNKNOWN` |
 * | V-E4 | `repayTo` will be paid: the input token's blocklist view on the source is false for it | not read yet (CAN-2151); that `repayTo` is the node's own padded address is held by V-T2 |
 * | V-E5 | `filled == false`; balance, allowance, gas at the delivery address | `OTHER` / `NO_INVENTORY` |
 *
 * V-E5 has no code of its own in protocol §3.5: an order already filled is
 * declined `OTHER` (detail `already-filled`), a filler short of balance,
 * allowance or gas `NO_INVENTORY` (detail names which) — existing codes,
 * no protocol change (CAN-1941, option a).
 *
 * The checks stop at the first failure. A fact that cannot be read is a
 * failure of the check that needed it (N-12): the decline names that check's
 * code with detail `unverifiable: …`. No setting turns a check off (N-11).
 * Every check's result — `passed`, `failed` or `skipped` — is reported to
 * the `EventSink` as stage `ticket.checked`.
 *
 * Not here: a Canton source (V-C1…V-C6, CAN-1863) and a Canton-form ticket
 * (CAN-1867) are declined `OTHER`; the draw (V-T5) is V2 (CAN-1848).
 */
import type { DeclineReason, Hex, TicketIntentMessage, TicketIssued, TicketIssuedEvm, TicketOffer } from '@cancore/contracts';
import type { FillerChains } from '../chain';
import { ChainReadError } from '../chain/client';
import { erc20Allowance, erc20BalanceOf } from '../chain/erc20';
import { hashOrder, hashTicket } from '../chain/hashes';
import { INTENT_STATUS } from '../chain/router';
import type { EvmChainId } from '../chains';
import type { EventSink } from '../events';
import type { Clock, Logger } from '../runtime';
import { recoverAddress, type FillSigner } from '../signer';
import { chainsOf, fillTicketOf, identityFor, orderOf, ticketMismatch } from './terms';

export type TicketCheckId = 'form' | 'V-T4' | 'V-T2' | 'V-T3' | 'V-E1' | 'V-E2' | 'V-E3' | 'V-T1' | 'V-E4' | 'V-E5';

/**
 * `passed` — the condition holds; `failed` — it does not, or could not be
 * verified; `skipped` — not checked at all (see `detail`): never read as
 * «the condition holds».
 */
export type TicketCheckStatus = 'passed' | 'failed' | 'skipped';

export interface TicketCheckResult {
  check: TicketCheckId;
  status: TicketCheckStatus;
  /** The decline code, when failed. */
  reason?: DeclineReason;
  /** What failed, or why a check was skipped; never a signature or key. */
  detail?: string;
}

/** The verdict on one issued ticket. */
export interface EscrowVerification {
  ok: boolean;
  /** The `ticket.decline` reason, when not ok. */
  reason?: DeclineReason;
  detail?: string;
  /** Every check that ran, in order. */
  checks: readonly TicketCheckResult[];
}

export interface TicketVerifierOptions {
  /** Routers, clients and the per-destination policy (`ChainConfig`). */
  chains: FillerChains;
  fillSigners: { readonly [chain: EvmChainId]: FillSigner };
  /** This filler's id: the ticket must name its hash. */
  fillerId: string;
  /** The filler's Canton party, the payee of a Canton source. */
  cantonParty?: string;
  /** Pinned ticket signers (`FILLER_GATEWAYS[env].ticketSigners`). */
  ticketSigners: readonly Hex[];
  /** δ_issue, ms (V-T4, protocol S-2). */
  deltaIssueMs: number;
  clock: Clock;
  events: EventSink;
  logger: Logger;
}

/** One issued ticket, with the offer and consent it answers. */
export interface TicketCheckInput {
  offer: TicketOffer;
  issued: TicketIssued;
  /** When `ticket.issued` first arrived, unix ms by the process clock. */
  issuedAtMs: number;
  /** The consent sent for this attempt, when one was. */
  intent?: TicketIntentMessage;
}

class Refusal extends Error {
  constructor(
    readonly check: TicketCheckId,
    readonly reason: DeclineReason,
    readonly detail: string,
  ) {
    super(`${check}: ${reason} (${detail})`);
  }
}

const UINT64 = /^(0|[1-9][0-9]*)$/;
const seconds = (value: unknown): bigint | undefined => (typeof value === 'string' && UINT64.test(value) ? BigInt(value) : undefined);

export class TicketVerifier {
  constructor(private readonly options: TicketVerifierOptions) {}

  async verify(input: TicketCheckInput): Promise<EscrowVerification> {
    const checks: TicketCheckResult[] = [];
    const orderHash = String(input.issued?.orderHash ?? '');
    const attempt = Number(input.issued?.attempt);
    const pass = (check: TicketCheckId, detail?: string, status: TicketCheckStatus = 'passed') =>
      this.record(checks, { check, status, ...(detail ? { detail } : {}) }, orderHash, attempt);
    try {
      await this.run(input, pass);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      this.record(checks, { check: error.check, status: 'failed', reason: error.reason, detail: error.detail }, orderHash, attempt);
      this.options.logger.info('tickets: issued ticket refused', { orderHash, attempt, check: error.check, reason: error.reason, detail: error.detail });
      return { ok: false, reason: error.reason, detail: `${error.check}: ${error.detail}`, checks };
    }
    return { ok: true, checks };
  }

  private async run(input: TicketCheckInput, pass: (check: TicketCheckId, detail?: string, status?: TicketCheckStatus) => void): Promise<void> {
    const { offer, issuedAtMs } = input;
    const now = this.options.clock.now();

    // -- The form and the chains ---------------------------------------------
    if (input.issued?.form !== 'evm') throw new Refusal('form', 'OTHER', `form ${String(input.issued?.form)}: a Canton-form ticket is not supported yet (CAN-1867)`);
    const issued = input.issued as TicketIssuedEvm;
    const ticket = issued.ticket;
    const chains = chainsOf(offer.order);
    if (!chains) throw new Refusal('form', 'OTHER', 'the offered order does not parse');
    if (!chains.source) throw new Refusal('form', 'OTHER', 'a Canton source is not supported yet (CAN-1863)');
    if (!chains.destination) throw new Refusal('form', 'OTHER', 'an EVM-form ticket for a non-EVM destination');
    const source = this.options.chains.get(chains.source);
    const destination = this.options.chains.get(chains.destination);
    if (!source) throw new Refusal('form', 'OTHER', `no router configured for the source ${chains.source}`);
    if (!destination) throw new Refusal('form', 'OTHER', `no router configured for the destination ${chains.destination}`);
    const policy = destination.config;
    pass('form');

    // -- V-T4: issued in time ---------------------------------------------------
    if (!(issuedAtMs <= offer.acceptBy + this.options.deltaIssueMs)) {
      throw new Refusal('V-T4', 'TICKET_ISSUED_LATE', `arrived ${issuedAtMs - offer.acceptBy} ms after acceptBy (δ_issue ${this.options.deltaIssueMs} ms)`);
    }
    pass('V-T4');

    // -- V-T2: this offer, this filler ---------------------------------------------
    const identity = identityFor(offer.order, this.options);
    if (!identity) throw new Refusal('V-T2', 'TICKET_MISMATCH', 'no fill key or payee of this filler for the order');
    if (String(issued.orderHash).toLowerCase() !== String(offer.orderHash).toLowerCase() || issued.attempt !== offer.attempt) {
      throw new Refusal('V-T2', 'TICKET_MISMATCH', 'the frame names another order or attempt than the offer');
    }
    const terms = { orderHash: offer.orderHash, attempt: offer.attempt, validFrom: offer.validFrom, validUntil: offer.validUntil };
    const field = ticketMismatch(ticket, terms, identity);
    if (field) throw new Refusal('V-T2', 'TICKET_MISMATCH', `ticket.${field} differs from the offer and this filler`);
    // The filler delivers its own quote, never less than the order lets the router accept (T-19, T-25).
    const amountOut = seconds(offer.amountOut);
    const minReceived = seconds(offer.order.minReceived);
    if (amountOut === undefined || minReceived === undefined || amountOut < minReceived) {
      throw new Refusal('V-T2', 'TICKET_MISMATCH', `offer.amountOut ${String(offer.amountOut)} is below order.minReceived ${String(offer.order.minReceived)}`);
    }
    if (input.intent && (input.intent.validFrom !== ticket.validFrom || input.intent.validUntil !== ticket.validUntil)) {
      throw new Refusal('V-T2', 'TICKET_MISMATCH', 'the ticket window differs from the signed ticket.intent');
    }
    // T-15: the ticket carries the delivery key and the payee this filler named in its signed consent.
    if (input.intent && (input.intent.deliveryKey?.toLowerCase() !== ticket.deliveryKey?.toLowerCase() || input.intent.repayTo?.toLowerCase() !== ticket.repayTo?.toLowerCase())) {
      throw new Refusal('V-T2', 'TICKET_MISMATCH', 'deliveryKey or repayTo differs from the signed ticket.intent');
    }
    pass('V-T2');

    // -- V-T3: a window the filler can meet -----------------------------------------
    const validFrom = seconds(ticket.validFrom);
    const validUntil = seconds(ticket.validUntil);
    const fillDeadline = seconds(offer.order.fillDeadline);
    if (validFrom === undefined || validUntil === undefined || fillDeadline === undefined) throw new Refusal('V-T3', 'TICKET_MISMATCH', 'ticket or order times do not parse');
    if (!(validUntil < fillDeadline)) throw new Refusal('V-T3', 'TICKET_BEYOND_DEADLINE', `validUntil ${validUntil} ≥ fillDeadline ${fillDeadline}`);
    if (validUntil - validFrom < BigInt(policy.minTicketTtlSec)) throw new Refusal('V-T3', 'TICKET_TTL_TOO_SHORT', `validUntil − validFrom = ${validUntil - validFrom} s < MIN_TICKET_TTL ${policy.minTicketTtlSec} s`);
    // The protocol has no own code for a ticket that leaves less than sendGuard: it is a TTL too short for this filler (T-29).
    const leftMs = validUntil * 1000n - BigInt(now);
    if (leftMs < BigInt(policy.sendGuardSec) * 1000n) throw new Refusal('V-T3', 'TICKET_TTL_TOO_SHORT', `send-guard: ${leftMs} ms left < sendGuard ${policy.sendGuardSec} s`);
    pass('V-T3');

    // -- V-E1: the ticket is for this order ---------------------------------------------
    const order = orderOf(offer.order);
    let digest: Hex;
    try {
      digest = hashOrder(order, { chainId: chains.origin, router: source.router.address });
    } catch (error) {
      throw new Refusal('V-E1', 'ESCROW_MISMATCH', `the offered order does not hash: ${String(error)}`);
    }
    if (digest !== ticket.orderHash.toLowerCase()) throw new Refusal('V-E1', 'ESCROW_MISMATCH', 'orderHash is not the order digest in the source router domain');
    pass('V-E1');

    // -- V-E2, V-E3: the escrow, at depth --------------------------------------------------
    const intent = await this.chainRead('V-E2', 'ESCROW_NOT_OPEN', () => source.router.intents(digest, { confirmations: source.config.openConfirmations }));
    if (intent.status !== INTENT_STATUS.Opened) throw new Refusal('V-E2', 'ESCROW_NOT_OPEN', `status ${intent.status} at ${source.config.openConfirmations} confirmations`);
    pass('V-E2');
    const window = intent.refundAfter - fillDeadline;
    if (window < BigInt(policy.requiredProofWindowSec)) throw new Refusal('V-E3', 'PROOF_WINDOW_TOO_SHORT', `refundAfter − fillDeadline = ${window} s < ${policy.requiredProofWindowSec} s`);
    pass('V-E3');

    // -- V-T1: signed by Cancore -------------------------------------------------------------
    let signer: Hex;
    try {
      signer = recoverAddress(hashTicket(fillTicketOf(ticket)), issued.ticketSig);
    } catch {
      throw new Refusal('V-T1', 'TICKET_SIGNER_UNKNOWN', 'ticketSig is not a valid signature over the ticket');
    }
    if (!this.options.ticketSigners.some((s) => s.toLowerCase() === signer)) throw new Refusal('V-T1', 'TICKET_SIGNER_UNKNOWN', `${signer} is not a pinned ticket signer`);
    const registered = await this.chainRead('V-T1', 'TICKET_SIGNER_UNKNOWN', () => destination.router.ticketSigners(signer));
    if (!registered) throw new Refusal('V-T1', 'TICKET_SIGNER_UNKNOWN', `${signer} is not a ticket signer of the destination router`);
    pass('V-T1');

    // -- V-E4: repayTo will be paid ----------------------------------------------------------------
    // V-T2 already holds ticket.repayTo to the node's own padded address; the source token's
    // blocklist view (USDC isBlacklisted, USDT isBlackListed) is not read yet.
    pass('V-E4', 'not checked: the blocklist view of the input token is not read yet (CAN-2151); repayTo is the node\'s own, held by V-T2', 'skipped');

    // -- V-E5: the filler can fill ---------------------------------------------------------------
    const filled = await this.chainRead('V-E5', 'OTHER', () => destination.router.filled(digest));
    if (filled) throw new Refusal('V-E5', 'OTHER', 'already-filled: the destination router has a fill for this order');
    const outputAsset = String(offer.order.outputAsset);
    if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(outputAsset)) throw new Refusal('V-E5', 'OTHER', 'the output asset is not an EVM token');
    const token = `0x${outputAsset.slice(26)}` as Hex;
    const amount = amountOut;
    const delivery = identity.signer.address.toLowerCase() as Hex;
    const [balance, allowance, gas] = await this.chainRead('V-E5', 'OTHER', () =>
      Promise.all([
        erc20BalanceOf(destination.client, token, delivery),
        erc20Allowance(destination.client, token, delivery, destination.router.address),
        destination.client.balance(delivery),
      ]),
    );
    if (balance < amount) throw new Refusal('V-E5', 'NO_INVENTORY', `balance: ${balance} < amountOut ${amount}`);
    if (allowance < amount) throw new Refusal('V-E5', 'NO_INVENTORY', `allowance: ${allowance} < amountOut ${amount}`);
    if (gas < policy.minGasWei) throw new Refusal('V-E5', 'NO_INVENTORY', `gas: ${gas} wei < ${policy.minGasWei} wei`);
    pass('V-E5');
  }

  /** A chain read; any failure to read is a refusal by the check that needed it (N-12). */
  private async chainRead<T>(check: TicketCheckId, reason: DeclineReason, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      const why = error instanceof ChainReadError ? `${error.reason}: ${error.message}` : String(error);
      throw new Refusal(check, reason, `unverifiable: ${why}`);
    }
  }

  private record(checks: TicketCheckResult[], result: TicketCheckResult, orderHash: string, attempt: number): void {
    checks.push(result);
    try {
      const emitted = this.options.events.emit({
        type: 'stage',
        stage: 'ticket.checked',
        atMs: this.options.clock.now(),
        orderHash: orderHash as Hex,
        attempt,
        detail: { check: result.check, status: result.status, ...(result.reason ? { reason: result.reason } : {}), ...(result.detail ? { detail: result.detail } : {}) },
      });
      if (emitted instanceof Promise) emitted.catch(() => undefined);
    } catch {
      // A broken sink never stops the protocol.
    }
  }
}
