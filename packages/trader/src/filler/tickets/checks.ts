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
 * | V-E2 | `intents(orderHash).status == Opened` at `openConfirmations` depth: N confirmations, or the `safe` / `finalized` block | `ESCROW_NOT_OPEN` |
 * | V-E3 | `refundAfter − fillDeadline ≥` the filler's own proof window for the destination | `PROOF_WINDOW_TOO_SHORT` |
 * | V-T1 | the ticket signer is pinned and `ticketSigners(signer)` on the destination router | `TICKET_SIGNER_UNKNOWN` |
 * | V-E4 | `repayTo` will be paid: the input token's blocklist view on the source (USDC `isBlacklisted`, USDT `isBlackListed`) is false for it; that it is the node's own padded address is held by V-T2 | `OTHER` (detail `repayTo-blocklisted`) |
 * | V-E5 | `filled == false`; balance, allowance, gas at the delivery address | `OTHER` / `NO_INVENTORY` |
 *
 * V-E4 has no code of its own in protocol §3.5 either: a blocklisted payout
 * address is declined `OTHER` (detail `repayTo-blocklisted`) — the filler
 * names another `repayTo` in its next tickets (T-45).
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
 * A Canton-form ticket (a Canton destination) is checked in `canton-ticket.ts`
 * (CAN-1867). A Canton source runs V-C1…V-C6 (`canton-source.ts`, CAN-1863)
 * in place of V-E1…V-E4: there is no escrow on a router, the give is a
 * committed allocation on Canton; V-T1 and V-E5 are read on the EVM
 * destination for both sources. Not here: the draw (V-T5) is V2 (CAN-1848).
 */
import type { DeclineReason, Hex, TicketIntentMessage, TicketIssued, TicketIssuedEvm, TicketOffer } from '@cancore/contracts';
import { describeDepth, readAtDepth, type ChainReaders, type FillerChains } from '../chain';
import { erc20Allowance, erc20BalanceOf, erc20Blocklisted } from '../chain/erc20';
import { hashOrder, hashTicket } from '../chain/hashes';
import { INTENT_STATUS } from '../chain/router';
import type { EvmChainId } from '../chains';
import type { EventSink } from '../events';
import type { Clock, Logger } from '../runtime';
import { recoverAddress, type FillSigner } from '../signer';
import { checkCantonSource, type CantonSourceReader } from './canton-source';
import { verifyCantonTicket, type CantonTicketOptions } from './canton-ticket';
import { readFor, TicketRefusal, type TicketCheckId } from './refusal';
import { CANTON_ORIGIN_FLOOR, chainsOf, fillTicketOf, identityFor, orderOf, ticketMismatch } from './terms';

export type { TicketCheckId } from './refusal';

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
  /** The Canton-source reads through Cancore (V-C1…V-C6); without it a Canton source is declined. */
  cantonSource?: CantonSourceReader;
  /** Pinned ticket signers (`FILLER_GATEWAYS[env].ticketSigners`). */
  ticketSigners: readonly Hex[];
  /** δ_issue, ms (V-T4, protocol S-2). */
  deltaIssueMs: number;
  clock: Clock;
  events: EventSink;
  logger: Logger;
  /** The filler's Canton party and what it reads through filler-gateway: required for a Canton-form ticket (CAN-1867). */
  canton?: CantonTicketOptions;
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
      if (!(error instanceof TicketRefusal)) throw error;
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
    if (input.issued?.form === 'canton') {
      if (!this.options.canton) throw new TicketRefusal('form', 'OTHER', 'a Canton-form ticket, and no Canton party configured (canton)');
      return verifyCantonTicket({ ...this.options, canton: this.options.canton }, input, pass);
    }
    if (input.issued?.form !== 'evm') throw new TicketRefusal('form', 'OTHER', `form ${String((input.issued as { form?: unknown } | undefined)?.form)}: an unknown ticket form`);
    const issued = input.issued as TicketIssuedEvm;
    const ticket = issued.ticket;
    const chains = chainsOf(offer.order);
    if (!chains) throw new TicketRefusal('form', 'OTHER', 'the offered order does not parse');
    if (!chains.destination) throw new TicketRefusal('form', 'OTHER', 'an EVM-form ticket for a non-EVM destination');
    const canton = chains.source ? undefined : this.cantonSourceOf(chains.origin);
    const source = chains.source ? this.options.chains.get(chains.source) : undefined;
    const destination = this.options.chains.get(chains.destination);
    if (chains.source && !source) throw new TicketRefusal('form', 'OTHER', `no router configured for the source ${chains.source}`);
    if (!destination) throw new TicketRefusal('form', 'OTHER', `no router configured for the destination ${chains.destination}`);
    const policy = destination.config;
    pass('form');

    // -- V-T4: issued in time ---------------------------------------------------
    if (!(issuedAtMs <= offer.acceptBy + this.options.deltaIssueMs)) {
      throw new TicketRefusal('V-T4', 'TICKET_ISSUED_LATE', `arrived ${issuedAtMs - offer.acceptBy} ms after acceptBy (δ_issue ${this.options.deltaIssueMs} ms)`);
    }
    pass('V-T4');

    // -- V-T2: this offer, this filler ---------------------------------------------
    const identity = identityFor(offer.order, this.options);
    if (!identity) throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', 'no fill key or payee of this filler for the order');
    if (String(issued.orderHash).toLowerCase() !== String(offer.orderHash).toLowerCase() || issued.attempt !== offer.attempt) {
      throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', 'the frame names another order or attempt than the offer');
    }
    const terms = { orderHash: offer.orderHash, attempt: offer.attempt, validFrom: offer.validFrom, validUntil: offer.validUntil };
    const field = ticketMismatch(ticket, terms, identity);
    if (field) throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', `ticket.${field} differs from the offer and this filler`);
    // The filler delivers its own quote, never less than the order lets the router accept (T-19, T-25).
    const amountOut = seconds(offer.amountOut);
    const minReceived = seconds(offer.order.minReceived);
    if (amountOut === undefined || minReceived === undefined || amountOut < minReceived) {
      throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', `offer.amountOut ${String(offer.amountOut)} is below order.minReceived ${String(offer.order.minReceived)}`);
    }
    if (input.intent && (input.intent.validFrom !== ticket.validFrom || input.intent.validUntil !== ticket.validUntil)) {
      throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', 'the ticket window differs from the signed ticket.intent');
    }
    // T-15: the ticket carries the delivery key and the payee this filler named in its signed consent.
    if (input.intent && (input.intent.deliveryKey?.toLowerCase() !== ticket.deliveryKey?.toLowerCase() || input.intent.repayTo?.toLowerCase() !== ticket.repayTo?.toLowerCase())) {
      throw new TicketRefusal('V-T2', 'TICKET_MISMATCH', 'deliveryKey or repayTo differs from the signed ticket.intent');
    }
    pass('V-T2');

    // -- V-T3: a window the filler can meet -----------------------------------------
    const validFrom = seconds(ticket.validFrom);
    const validUntil = seconds(ticket.validUntil);
    const fillDeadline = seconds(offer.order.fillDeadline);
    if (validFrom === undefined || validUntil === undefined || fillDeadline === undefined) throw new TicketRefusal('V-T3', 'TICKET_MISMATCH', 'ticket or order times do not parse');
    if (!(validUntil < fillDeadline)) throw new TicketRefusal('V-T3', 'TICKET_BEYOND_DEADLINE', `validUntil ${validUntil} ≥ fillDeadline ${fillDeadline}`);
    if (validUntil - validFrom < BigInt(policy.minTicketTtlSec)) throw new TicketRefusal('V-T3', 'TICKET_TTL_TOO_SHORT', `validUntil − validFrom = ${validUntil - validFrom} s < MIN_TICKET_TTL ${policy.minTicketTtlSec} s`);
    // The protocol has no own code for a ticket that leaves less than sendGuard: it is a TTL too short for this filler (T-29).
    const leftMs = validUntil * 1000n - BigInt(now);
    if (leftMs < BigInt(policy.sendGuardSec) * 1000n) throw new TicketRefusal('V-T3', 'TICKET_TTL_TOO_SHORT', `send-guard: ${leftMs} ms left < sendGuard ${policy.sendGuardSec} s`);
    pass('V-T3');

    let digest: Hex;
    if (source) {
      // -- V-E1: the ticket is for this order ---------------------------------------------
      const order = orderOf(offer.order);
      try {
        digest = hashOrder(order, { chainId: chains.origin, router: source.router.address });
      } catch (error) {
        throw new TicketRefusal('V-E1', 'ESCROW_MISMATCH', `the offered order does not hash: ${String(error)}`);
      }
      if (digest !== ticket.orderHash.toLowerCase()) throw new TicketRefusal('V-E1', 'ESCROW_MISMATCH', 'orderHash is not the order digest in the source router domain');
      pass('V-E1');

      // -- V-E2, V-E3: the escrow, at depth --------------------------------------------------
      const escrow = digest;
      const intent = await this.chainRead('V-E2', 'ESCROW_NOT_OPEN', () => source.router.intents(escrow, readAtDepth(source.config.openConfirmations)));
      if (intent.status !== INTENT_STATUS.Opened) throw new TicketRefusal('V-E2', 'ESCROW_NOT_OPEN', `status ${intent.status} at ${describeDepth(source.config.openConfirmations)}`);
      pass('V-E2');
      const window = intent.refundAfter - fillDeadline;
      if (window < BigInt(policy.requiredProofWindowSec)) throw new TicketRefusal('V-E3', 'PROOF_WINDOW_TOO_SHORT', `refundAfter − fillDeadline = ${window} s < ${policy.requiredProofWindowSec} s`);
      pass('V-E3');
    } else {
      // -- V-C1…V-C6: the committed give on Canton (canton-source.ts) -------------------------
      const { reader, party } = canton as { reader: CantonSourceReader; party: string };
      await checkCantonSource(
        { order: offer.order, ticket, party, fillerId: this.options.fillerId, requiredProofWindowSec: policy.requiredProofWindowSec, reader },
        (check, detail) => pass(check, detail),
      );
      // V-C3 holds ticket.orderHash to the hash of the intent's own terms.
      digest = ticket.orderHash.toLowerCase() as Hex;
    }

    // -- V-T1: signed by Cancore -------------------------------------------------------------
    let signer: Hex;
    try {
      signer = recoverAddress(hashTicket(fillTicketOf(ticket)), issued.ticketSig);
    } catch {
      throw new TicketRefusal('V-T1', 'TICKET_SIGNER_UNKNOWN', 'ticketSig is not a valid signature over the ticket');
    }
    if (!this.options.ticketSigners.some((s) => s.toLowerCase() === signer)) throw new TicketRefusal('V-T1', 'TICKET_SIGNER_UNKNOWN', `${signer} is not a pinned ticket signer`);
    const registered = await this.chainRead('V-T1', 'TICKET_SIGNER_UNKNOWN', () => destination.router.ticketSigners(signer));
    if (!registered) throw new TicketRefusal('V-T1', 'TICKET_SIGNER_UNKNOWN', `${signer} is not a ticket signer of the destination router`);
    pass('V-T1');

    // -- V-E4: repayTo will be paid ----------------------------------------------------------------
    // V-T2 already holds ticket.repayTo to the node's own padded address: here, that the source
    // token does not blocklist it — a blocklisted payee makes settle revert, and the advance is lost (R-8).
    // A Canton source has no blocklist view: V-C5 held the payee there.
    if (source) {
      await this.checkRepayTo(ticket.repayTo, offer.order.inputToken, source);
      pass('V-E4');
    }

    // -- V-E5: the filler can fill ---------------------------------------------------------------
    await this.checkCapacity(digest, offer.order.outputAsset, amountOut, identity.signer.address, destination, pass);
  }

  /** V-E4 on an EVM source. */
  private async checkRepayTo(repayToValue: Hex, inputTokenValue: unknown, source: ChainReaders): Promise<void> {
    const repayTo = String(repayToValue);
    if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(repayTo)) throw new TicketRefusal('V-E4', 'TICKET_MISMATCH', 'repayTo of an EVM source is not a padded address');
    const inputToken = String(inputTokenValue);
    if (!/^0x[0-9a-fA-F]{40}$/.test(inputToken)) throw new TicketRefusal('V-E4', 'OTHER', 'the input token is not an EVM address');
    const payee = `0x${repayTo.slice(26)}`.toLowerCase() as Hex;
    const blocklisted = await this.chainRead('V-E4', 'OTHER', () => erc20Blocklisted(source.client, inputToken.toLowerCase() as Hex, payee));
    if (blocklisted) throw new TicketRefusal('V-E4', 'OTHER', `repayTo-blocklisted: the input token ${inputToken} blocklists ${payee}`);
  }

  /** V-E5: no fill yet, and balance, allowance and gas at the delivery address. */
  private async checkCapacity(
    digest: Hex,
    outputAssetValue: unknown,
    amount: bigint,
    deliveryAddress: string,
    destination: ChainReaders,
    pass: (check: TicketCheckId, detail?: string, status?: TicketCheckStatus) => void,
  ): Promise<void> {
    const policy = destination.config;
    const filled = await this.chainRead('V-E5', 'OTHER', () => destination.router.filled(digest));
    if (filled) throw new TicketRefusal('V-E5', 'OTHER', 'already-filled: the destination router has a fill for this order');
    const outputAsset = String(outputAssetValue);
    if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(outputAsset)) throw new TicketRefusal('V-E5', 'OTHER', 'the output asset is not an EVM token');
    const token = `0x${outputAsset.slice(26)}` as Hex;
    const delivery = deliveryAddress.toLowerCase() as Hex;
    const [balance, allowance, gas] = await this.chainRead('V-E5', 'OTHER', () =>
      Promise.all([
        erc20BalanceOf(destination.client, token, delivery),
        erc20Allowance(destination.client, token, delivery, destination.router.address),
        destination.client.balance(delivery),
      ]),
    );
    if (balance < amount) throw new TicketRefusal('V-E5', 'NO_INVENTORY', `balance: ${balance} < amountOut ${amount}`);
    if (allowance < amount) throw new TicketRefusal('V-E5', 'NO_INVENTORY', `allowance: ${allowance} < amountOut ${amount}`);
    if (gas < policy.minGasWei) throw new TicketRefusal('V-E5', 'NO_INVENTORY', `gas: ${gas} wei < ${policy.minGasWei} wei`);
    pass('V-E5');
  }

  /** The Canton-source reader and payee, or the refusal of a Canton source the node is not set up for. */
  private cantonSourceOf(origin: bigint): { reader: CantonSourceReader; party: string } {
    if (origin < CANTON_ORIGIN_FLOOR) throw new TicketRefusal('form', 'OTHER', `originChainId ${origin} is neither an EVM chain nor a Canton network`);
    const { cantonSource: reader, cantonParty: party } = this.options;
    if (!reader || !party) throw new TicketRefusal('form', 'OTHER', 'a Canton source, and this node has no Canton party configured');
    return { reader, party };
  }

  /** A chain read; any failure to read is a refusal by the check that needed it (N-12). */
  private chainRead<T>(check: TicketCheckId, reason: DeclineReason, read: () => Promise<T>): Promise<T> {
    return readFor(check, reason, read);
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
